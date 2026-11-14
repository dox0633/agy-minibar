/**
 * MiniBar sidecar —— 取数 + 注入。
 * 只读本地 transcript 与 Language Server RPC，通过 CDP 往主窗口推一行状态，
 * 不修改 app.asar，不写宿主任何配置。
 */

import { exec, spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_LIMIT_TOKENS, ID_RE, buildSpeedIndex, enrichSummaryWithSpeed,
  parseTranscriptText, readTranscriptFile, resolveTranscriptFile, safeStat,
} from './lib/transcript.mjs';
import {
  loadLibrary, upsertAccount, getAccount, readActiveEmail, readActiveBlob, writeActiveBlobFile,
} from './accounts.mjs';
// IDE 配额桥是 .cjs（node:sqlite 同步），用 createRequire 引入
import { createRequire } from 'node:module';
const ideQuota = createRequire(import.meta.url)('./idequota.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECT_PATH = join(__dirname, 'inject.js');
const LOGFILE = join(__dirname, 'minibar.log');

function log(...a) {
  try {
    appendFileSync(LOGFILE, `[${new Date().toISOString()}] ` + a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ') + '\n');
  } catch {}
}
process.on('uncaughtException', e => log('UNCAUGHT', (e && e.stack) || String(e)));
process.on('unhandledRejection', e => log('UNHANDLED', (e && e.stack) || String(e)));

/** 切换用的临时目录（与 token 库同级，便于收紧权限） */
function LIB_DIR_TEMP() {
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-minibar');
}

/* ---------------- 单实例守卫（见下方实现） ---------------- */
const LOCK_FILE = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-minibar.lock');

function acquireSingletonLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // O_EXCL 语义：文件已存在则抛错
      const fd = openSync(LOCK_FILE, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // 目录不存在等非竞争错误，放行
      try {
        const raw = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
        const holder = Number(raw.pid);
        const age = Date.now() - Number(raw.at || 0);
        // 持有者已死 或 锁超过 30 秒无心跳 → 抢占
        let alive = false;
        try { process.kill(holder, 0); alive = true; } catch {}
        if (!alive || age > 30_000) {
          try { unlinkSync(LOCK_FILE); } catch {}
          continue;
        }
        return false; // 活着的同伴持有，自己退出
      } catch {
        try { unlinkSync(LOCK_FILE); } catch {} // 锁文件损坏，重试
      }
    }
  }
  return false;
}

if (!acquireSingletonLock()) {
  log('SINGLETON_YIELD', `pid=${process.pid} -> another instance holds the lock`);
  process.exit(0);
}
log('SINGLETON_ACQUIRE', `pid=${process.pid}`);
setInterval(() => {
  try { writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
}, 10_000);

let SRC = readFileSync(INJECT_PATH, 'utf-8');
let srcMtime = 0;
try { srcMtime = statSync(INJECT_PATH).mtimeMs; } catch {}
function src() {
  try {
    const m = statSync(INJECT_PATH).mtimeMs;
    if (m !== srcMtime) { SRC = readFileSync(INJECT_PATH, 'utf-8'); srcMtime = m; }
  } catch {}
  return SRC;
}
function srcVer() {
  const m = src().match(/const VER = (\d+)/);
  return m ? Number(m[1]) : 0;
}

const TICK = 1000;
const S = { convId: '', last: {}, err: '', q: { d: null, at: 0 }, ts: new Map(), turns: new Map(), logged: 0, panelApi: 0, panelPort: 0 };

/* 只读文件尾部（保留给需要尾部的场景；stats 已统一走全量） */
function readTail(file, maxBytes = 262144) {
  try {
    const st = statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

/* 轮数 / Token 合计：transcript 是追加写的，按字节偏移增量统计，避免每次全量扫描 */
function scanIncrement(file) {
  try {
    const st = statSync(file);
    let c = S.turns.get(file);
    if (!c) { c = { offset: 0, count: 0, tokens: 0 }; S.turns.set(file, c); }
    if (st.size < c.offset) { c.offset = 0; c.count = 0; c.tokens = 0; } // 文件被轮转/重写，重计
    if (st.size <= c.offset) return c;

    const len = st.size - c.offset;
    const fd = openSync(file, 'r');
    let text = '';
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, c.offset);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }

    // 只处理到最后一个换行，半行留到下一轮，避免重复计数
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return c;
    const complete = text.slice(0, cut + 1);
    const hit = complete.match(/"type"\s*:\s*"USER_INPUT"/g);
    if (hit) c.count += hit.length;
    for (const m of complete.matchAll(/"input_tokens"\s*:\s*(\d+)|"cache_read_tokens"\s*:\s*(\d+)|"output_tokens"\s*:\s*(\d+)/g)) {
      c.tokens += Number(m[1] || 0) + Number(m[2] || 0) + Number(m[3] || 0);
    }
    c.offset += Buffer.byteLength(complete, 'utf8');
    return c;
  } catch { return null; }
}

/* ---------------- Language Server RPC ---------------- */

function bases() {
  const raw = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim().replace(/\/$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  const out = [`https://${raw}`, `http://${raw}`];
  const port = raw.includes(':') ? raw.split(':').pop() : '';
  if (/^\d+$/.test(port)) out.push(`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`);
  return out;
}

function post(base, method, body, timeout) {
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '');
  const mod = base.startsWith('https://') ? https : http;
  let payload;
  try { payload = JSON.stringify(body || {}); } catch { return Promise.resolve(null); }
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    const req = mod.request(`${base}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = '';
      let n = 0;
      res.on('data', c => { n += c.length; if (n > 8e6) { req.destroy(); return fin(null); } text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return fin(null);
        try { fin(JSON.parse(text)); } catch { fin(null); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
    req.end(payload);
  });
}

async function rpc(method, body, timeout = 4000) {
  for (const b of bases()) {
    const r = await post(b, method, body, timeout);
    if (r) return r;
  }
  return null;
}

/* ---------------- 额度 ---------------- */

function frac(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let f = null;
  if (Number.isFinite(Number(raw.remainingFraction))) f = Math.max(0, Math.min(1, Number(raw.remainingFraction)));
  else if (typeof raw.resetTime === 'string' && Date.parse(raw.resetTime) > Date.now()) f = 0;
  return f === null ? null : +(f * 100).toFixed(1);
}

function winOf(b) {
  const w = String(b && b.window || '').toLowerCase();
  if (w === '5h' || w === 'weekly') return w;
  const id = String(b && b.bucketId || '');
  if (/5h/i.test(id)) return '5h';
  if (/week|wtu|wk/i.test(id)) return 'weekly';
  return '';
}

async function quota() {
  const now = Date.now();
  if (S.q.d && now - S.q.at < 15000) return S.q.d;
  const r = await rpc('RetrieveUserQuotaSummary', { forceRefresh: false }, 5000);
  const p = r && r.response !== undefined ? r.response : r;
  if (!p || typeof p !== 'object') return S.q.d || { h5: null, wk: null };

  const groups = Array.isArray(p.groups) ? p.groups : [];
  let buckets = [];
  for (const g of groups) for (const b of (Array.isArray(g && g.buckets) ? g.buckets : [])) buckets.push({ ...b, _g: String(g && g.displayName || '') });
  if (!buckets.length && Array.isArray(p.buckets)) buckets = p.buckets;

  const gem = buckets.filter(b => /gemini/i.test(b._g));
  const pool = gem.length ? gem : buckets;
  const pick = w => {
    const hit = pool.find(b => winOf(b) === w);
    return hit ? frac(hit) : null;
  };
  const d = { h5: pick('5h'), wk: pick('weekly') };
  S.q = { d, at: now };
  return d;
}

/* ---------------- 会话统计 ---------------- */

/** 官方模型物理上下文窗口：Gemini 3/4 = 1M，Claude = 200K，GPT-OSS = 128K。 */
function modelWindow(name) {
  const s = String(name || '');
  if (/claude/i.test(s)) return 200000;
  if (/gpt|oss/i.test(s)) return 131072;
  return 1048576;
}

async function stats(convId) {
  const o = { convId, ctxPct: null, compactPct: null, cachePct: null, tps: null, ttft: null, turns: 0, model: '', h5: null, wk: null, live: false };
  if (!convId || !ID_RE.test(convId)) return o;

  const loc = resolveTranscriptFile(convId);
  if (!loc) return o;
  const st = safeStat(loc.path);
  if (!st) return o;

  let c = S.ts.get(loc.path);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
    // 统一走全量解析：尾部快读在不同时刻会解析出不同的最新步骤，
    // 是状态条数值在「有/无 TPS」之间反复横跳的直接原因。
    // 全量解析一次成型后缓存，直到文件变化前输出完全稳定。
    let sum = null;
    try { sum = parseTranscriptText(readTranscriptFile(loc.path)); } catch { sum = null; }
    if (!sum) return o;

    const gm = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: convId, generatorMetadataOffset: 0, includeMessages: false });
    if (gm && Array.isArray(gm.generatorMetadata)) {
      try { sum = enrichSummaryWithSpeed(sum, buildSpeedIndex(gm.generatorMetadata)); } catch {}
    }
    c = { mtime: st.mtimeMs, size: st.size, sum };
    if (S.ts.size > 64) S.ts.clear();
    S.ts.set(loc.path, c);
  }

  const inc = scanIncrement(loc.path);
  o.turns = inc ? inc.count : 0;
  o.tokensM = inc && inc.tokens > 0 ? inc.tokens / 1e6 : null;

  const latest = c.sum && c.sum.latest;
  if (latest) {
    const used = Number(latest.contextUsed) || 0;
    const sp = latest.speed || null;
    const model = (sp && sp.model) || c.sum.modelHint || '';
    o.model = model;
    // 圆环百分比按官方模型窗口算；颜色风险按 256K 自动压缩线算
    o.ctxPct = Math.min(100, used / modelWindow(model) * 100);
    o.compactPct = Math.min(100, used / FIXED_LIMIT_TOKENS * 100);
    o.cachePct = (Number(latest.cacheHitRate) || 0) * 100;
    if (sp) {
      o.tps = Number.isFinite(sp.streamingTps) ? sp.streamingTps : (Number.isFinite(sp.tps) ? sp.tps : null);
      o.ttft = Number.isFinite(sp.ttftSec) ? sp.ttftSec : null;
    }
  }
  o.live = Date.now() - (st.mtimeMs || 0) < 20000;
  return o;
}

/* ---------------- CDP ---------------- */

function devPort() {
  const cands = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Antigravity', 'DevToolsActivePort') : '',
  ].filter(Boolean);
  for (const f of cands) {
    try {
      const t = readFileSync(f, 'utf-8').split(/\r?\n/)[0].trim();
      if (/^\d+$/.test(t)) return Number(t);
    } catch {}
  }
  return null;
}

async function findPage(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const l = await r.json();
    if (!Array.isArray(l)) return null;
    return l.find(t => t.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\/c\//.test(String(t.url || '')))
        || l.find(t => t.type === 'page' && /^https:\/\/127\.0\.0\.1/.test(String(t.url || '')))
        || null;
  } catch { return null; }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.i = 0; this.p = new Map(); this.url = ''; this.dead = false; }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => rej(new Error('ws timeout')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        const c = new Cdp(ws);
        ws.addEventListener('message', e => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.id && c.p.has(m.id)) { c.p.get(m.id)(m); c.p.delete(m.id); }
        });
        ws.addEventListener('close', () => { c.dead = true; });
        c.url = url;
        res(c);
      }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
  }
  send(method, params) {
    const id = ++this.i;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.p.delete(id); rej(new Error('timeout')); }, 8000);
      this.p.set(id, v => { clearTimeout(t); res(v); });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); rej(e); }
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.result && r.result.exceptionDetails) return null;
    return r && r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { this.dead = true; try { this.ws.close(); } catch {} }
}

/* ---------------- 本地实时配额记录 ----------------
 * 每次账号成为"当前"时，把它的 LS 实时配额写入本地 JSON。
 * 非当前账号的卡片优先展示这份记录（比 IDE 缓存新鲜），
 * 7 天后视为过期（周额度按周重置，过期即无意义）。
 */
const LQ_FILE = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-minibar', 'live-quota.json');

function loadLiveQuota() {
  try { return JSON.parse(readFileSync(LQ_FILE, 'utf-8')); } catch { return {}; }
}

function saveLiveQuota(email, h5, wk) {
  try {
    const store = loadLiveQuota();
    store[String(email).toLowerCase()] = { h5, wk, at: Date.now() };
    const tmp = LQ_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, LQ_FILE);
  } catch { /* 记录失败不影响主流程 */ }
}

function liveQuotaRecord(email) {
  try {
    const store = loadLiveQuota();
    const hit = store[String(email).toLowerCase()];
    if (!hit) return null;
    // 超过 7 天的记录视为过期（周额度已重置，数值不可信）
    if (Date.now() - hit.at > 7 * 86400000) return null;
    return hit;
  } catch { return null; }
}

let cdp = null;

/** 账号列表快照：库内 + google_accounts.json + 当前活跃 + IDE 配额缓存（Kite）
 *  realtime: { h5, wk } —— 当前账号的 LS 实时配额（与状态条同源）
 */
function accountsSnapshot(realtime) {
  const emails = new Set();
  if (SW.activeEmail) emails.add(SW.activeEmail);
  for (const a of loadLibrary().accounts) emails.add(a.email);
  try {
    const ga = JSON.parse(readFileSync(join(homedir(), '.gemini', 'google_accounts.json'), 'utf-8'));
    if (ga.active) emails.add(ga.active);
    for (const e of (Array.isArray(ga.old) ? ga.old : [])) emails.add(e);
  } catch { /* 指针文件缺失则只显示已知账号 */ }
  // IDE 侧 Kite 缓存的各账号配额（有则带出，帮用户决定切哪个）
  let ideQuotas = {};
  try { ideQuotas = ideQuota.readIdeQuotaCache() || {}; } catch { ideQuotas = {}; }
  const activeLower = String(SW.activeEmail || '').toLowerCase();
  return [...emails].map(e => {
    const lower = String(e).toLowerCase();
    const isCur = lower === activeLower;
    const q = ideQuotas[lower] || null;
    // 配额来源优先级：
    //   当前账号 → LS 实时（与状态条同源）
    //   其它账号 → 本地实时记录（切换时捕获，最多 7 天有效期）→ IDE 缓存 → 无
    let geminiWeekly = null;
    let gemini5h = null;
    let quotaSource = 'none';
    let quotaUpdatedAt = 0;
    if (isCur && realtime && typeof realtime.wk === 'number') {
      geminiWeekly = realtime.wk;
      gemini5h = typeof realtime.h5 === 'number' ? realtime.h5 : null;
      quotaSource = 'live';
      quotaUpdatedAt = Date.now();
    } else {
      const local = liveQuotaRecord(lower);
      if (local) {
        geminiWeekly = local.wk;
        gemini5h = local.h5;
        quotaSource = 'captured';
        quotaUpdatedAt = local.at;
      } else if (q) {
        geminiWeekly = q.models['gemini:weekly']?.remaining ?? null;
        gemini5h = q.models['gemini:5h']?.remaining ?? null;
        quotaSource = 'cache';
        quotaUpdatedAt = q.updatedAt || 0;
      }
    }
    return {
      email: e,
      hasToken: Boolean(getAccount(e)),
      isCurrent: isCur,
      geminiWeekly,
      gemini5h,
      quotaSource,
      quotaUpdatedAt,
      tier: q ? q.tier : '',
    };
  });
}

async function tick() {
  try {
    const port = devPort();
    if (!port) return;
    const page = await findPage(port);
    if (!page) { if (cdp) { cdp.close(); cdp = null; } return; }
    if (!cdp || cdp.dead || cdp.url !== page.webSocketDebuggerUrl) {
      if (cdp) cdp.close();
      cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    }

    // 每轮都从页面 URL 取当前会话，切换对话立刻跟随，绝不再沿用旧 ID
    const liveConv = await cdp.eval("(location.pathname.match(/\\/c\\/([0-9a-f-]{8,})/i)||[])[1]||''");
    if (liveConv && liveConv !== S.convId) {
      S.convId = liveConv;
      S.last = {};           // 切换瞬间先丢掉旧会话的展示值，避免闪现别人的数据
      S.turns.clear();       // 增量计数器按文件路径存，切换后旧会话不再增长，清掉省内存
      log('CONV_SWITCH', liveConv);
    } else if (liveConv) {
      S.convId = liveConv;
    }

    const st = await stats(S.convId);
    let q = { h5: null, wk: null };
    try { q = (await quota()) || q; } catch {}

    const payload = {
      convId: S.convId,
      ctxPct: st.ctxPct,
      compactPct: st.compactPct,
      cachePct: st.cachePct,
      tps: st.tps,
      ttft: st.ttft,
      turns: st.turns,
      tokensM: st.tokensM,
      account: SW.activeEmail || '',
      accounts: accountsSnapshot(q),
      switchResult: SW.switchResult || null,
      captureResult: SW.captureResult || null,
      h5: q.h5,
      wk: q.wk,
      live: st.live,
    };

    // 记录当前账号的实时配额（幂等：值不变时磁盘写入由调用方规避——这里直接写，每分钟一次成本低）
    if (typeof payload.wk === 'number' && payload.account) {
      saveLiveQuota(payload.account, payload.h5, payload.wk);
    }

    const ver = srcVer();
    // 通信桥：让页面端状态条能调 sidecar API（账号列表 / 切换 / 打开登录）
    const bridgeCfg = JSON.stringify({
      base: `http://127.0.0.1:${S.panelPort || 0}`,
      hasApi: S.panelApi > 0,
    });
    // 自愈：每轮无条件清掉旧插件残留（agy-composer-hud-host / __AGY_HUD），
    // 版本不符时再重建本插件。历史上多份叠加会把输入区撑高导致整页滚动。
    const pre = `(function(){try{
      document.querySelectorAll('#agy-composer-hud-host').forEach(function(e){try{e.remove();}catch(_){}});
      try{ if(window.__AGY_HUD) delete window.__AGY_HUD; }catch(_){}
      window.__AGY_MINIBAR_BRIDGE = (window.__AGY_MINIBAR && window.__AGY_MINIBAR.__bridge) || window.__AGY_MINIBAR_BRIDGE || null;
      if(!window.__AGY_MINIBAR||window.__AGY_MINIBAR.ver!==${ver}){
        document.querySelectorAll('#agy-minibar-host').forEach(function(e){try{e.remove();}catch(_){}});
        try{delete window.__AGY_MINIBAR;}catch(_){}
      }
    }catch(_){}})();`;
    const r = await cdp.eval(`${pre}${src()};window.__AGY_MINIBAR&&window.__AGY_MINIBAR.update(${JSON.stringify(payload)})`);

    if (r && r.convId && r.convId !== S.convId) S.convId = r.convId;

    // 上行指令通道（update 返回值带回 pending，单次 eval 完成，无竞态窗口）
    SW.pendingLive = Boolean(st.live);
    // 上轮遗留的延迟重启：生成已结束，现在执行
    if (SW.deferredLsRestart && !SW.pendingLive && !SW.switching) {
      SW.deferredLsRestart = false;
      log('LS_RESTART_DEFERRED_EXEC');
      try {
        exec('taskkill /F /IM language_server.exe', { timeout: 8000, windowsHide: true }, () => {});
        log('LS_RESTARTED', 'deferred kill issued');
      } catch (e) { log('LS_RESTART_FAIL', e.message); }
    }
    if (r && r.pendingSwitch) {
      const target = String(r.pendingSwitch);
      log('SWITCH_REQUEST', target);
      const res = await switchToAccount(target);
      SW.switchResult = { ok: Boolean(res.ok), email: res.email || target, error: res.error || '', at: Date.now() };
      log('SWITCH_RESULT', JSON.stringify(SW.switchResult));
    }
    if (r && r.pendingCapture === true) {
      try {
        const blob = readActiveBlob();
        const o = blob ? JSON.parse(blob) : null;
        if (o && o.id_token_email && o.token) {
          upsertAccount({ email: o.id_token_email, token: o.token, auth_method: o.auth_method, writer_id: o.writer_id });
          SW.activeEmail = o.id_token_email;
          SW.captureResult = { ok: true, email: o.id_token_email, at: Date.now() };
          log('CAPTURED', o.id_token_email);
        } else {
          SW.captureResult = { ok: false, error: 'credential incomplete — finish Google sign-in first', at: Date.now() };
        }
      } catch (e) {
        SW.captureResult = { ok: false, error: String(e.message || e), at: Date.now() };
      }
      // 立即把结果推给页面（下一轮 payload）
      try {
        const payload2 = { ...payload, captureResult: SW.captureResult, account: SW.activeEmail };
        await cdp.eval(`window.__AGY_MINIBAR && window.__AGY_MINIBAR.update(${JSON.stringify(payload2)})`);
      } catch { /* 页面下一轮也会收到 */ }
    }
    if (SW.switchResult && Date.now() - SW.switchResult.at > 6000) SW.switchResult = null;
    if (SW.captureResult && Date.now() - SW.captureResult.at > 6000) SW.captureResult = null;

    S.last = { ok: !!(r && r.ok), mounted: !!(r && r.mounted), payload };
    S.err = '';
    if (!S.logged || Date.now() - S.logged > 60000) { S.logged = Date.now(); log('TICK', payload); }
  } catch (e) {
    S.err = String(e && e.message || e);
    if (cdp) { cdp.close(); cdp = null; }
  }
}

async function loop() { for (;;) { await tick(); await new Promise(r => setTimeout(r, TICK)); } }

/* ---------------- 账号热切换 ---------------- */

const SW = { activeEmail: '', switching: false, panelApi: 0, lastError: '', pendingLive: false, deferredLsRestart: false };

/** 初始化：读当前凭据邮箱，并把当前账号备份进库 */
function initAccount() {
  try {
    const blob = readActiveBlob();
    if (blob) {
      const o = JSON.parse(blob);
      SW.activeEmail = o.id_token_email || readActiveEmail() || '';
      if (SW.activeEmail && o.token) {
        upsertAccount({ email: SW.activeEmail, token: o.token, auth_method: o.auth_method, writer_id: o.writer_id });
        log('ACCOUNT_BACKED_UP', SW.activeEmail);
      }
    }
  } catch (e) { log('ACCOUNT_INIT_FAIL', e.message); }
}

/** 热切换核心：写凭据 blob → 让宿主重新读账号 */
async function switchToAccount(email) {
  if (SW.switching) return { ok: false, error: 'switch in progress' };
  // 输入校验：必须是合法邮箱格式，防注入/误触
  const target = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return { ok: false, error: 'invalid email: ' + email };
  if (target === String(SW.activeEmail || '').toLowerCase()) return { ok: true, email: target, note: 'already active' };
  SW.switching = true;
  let credBackup = null;
  try {
    // 1) 先把当前活跃凭据备份（切换前的现场保护）
    try {
      const cur = readActiveBlob();
      if (cur) {
        const o = JSON.parse(cur);
        if (o.id_token_email && o.token) {
          upsertAccount({ email: o.id_token_email, token: o.token, auth_method: o.auth_method, writer_id: o.writer_id });
          credBackup = o.id_token_email;
        }
      }
    } catch { /* 备份失败不阻塞切换 */ }

    // 2) 从库里取目标账号 token
    const acc = getAccount(target);
    if (!acc || !acc.token) return { ok: false, error: 'no token for ' + target + ' — need OAuth login first' };

    // 3) 写凭据 blob（CredWriteW）——先写临时文件再让 PS 读，避免命令行长度与转义问题
    const blobJson = JSON.stringify({
      token: acc.token,
      auth_method: acc.auth_method || 'consumer',
      id_token_email: target,
      writer_id: acc.writer_id || '',
    });
    const blobDir = LIB_DIR_TEMP();
    mkdirSync(blobDir, { recursive: true });
    const blobFile = join(blobDir, 'pending-cred.json');
    writeFileSync(blobFile, blobJson, 'utf-8');
    try {
      writeActiveBlobFile(blobFile);
    } finally {
      try { unlinkSync(blobFile); } catch { /* 清理失败不影响 */ }
    }
    log('CRED_SWAPPED', target);

    // 4) 同步 ~/.gemini/google_accounts.json 的 active 指针
    try {
      const gaPath = join(homedir(), '.gemini', 'google_accounts.json');
      let ga = { active: target, old: [] };
      try { ga = JSON.parse(readFileSync(gaPath, 'utf-8')); } catch { /* 首次创建 */ }
      ga.active = target;
      const old = Array.isArray(ga.old) ? ga.old.filter(e => String(e).toLowerCase() !== target) : [];
      const prev = String(SW.activeEmail || '');
      if (prev && prev.toLowerCase() !== target && !old.some(e => String(e).toLowerCase() === prev.toLowerCase())) old.push(prev);
      ga.old = old;
      writeFileSync(gaPath, JSON.stringify(ga, null, 2), 'utf-8');
    } catch (e) { log('GA_POINTER_FAIL', e.message); }

    // 5) 同步 active-account.json
    try {
      writeFileSync(join(homedir(), '.gemini', 'antigravity', 'active-account.json'),
        JSON.stringify({ email: target, updatedAt: Date.now() }), 'utf-8');
    } catch { /* 非关键 */ }

    // 6) 重启 language_server 进程：LS 启动时从凭据管理器读 token，
    //    不重启则内存中仍是旧账号（UI 显示不会变）。宿主会自动拉起新 LS。
    //    若当前会话正在生成回复（transcript 20 秒内有写入），延迟到生成结束后
    //    下一轮 tick 再重启，避免打断输出。
    if (SW.pendingLive) {
      log('LS_RESTART_DEFERRED', 'generation in progress; will retry next tick');
      SW.deferredLsRestart = true;
      SW.activeEmail = target;
      return { ok: true, email: target, deferred: true, note: 'credential swapped; LS restart deferred until generation completes' };
    }
    try {
      const killed = [];
      const procs = await new Promise((resolve) => {
        exec('tasklist /FI "IMAGENAME eq language_server.exe" /FO CSV /NH',
          { encoding: 'utf8', timeout: 8000, windowsHide: true },
          (err, stdout) => resolve(err ? [] : String(stdout || '')));
      });
      for (const line of procs.split(/\r?\n/)) {
        const m = line.match(/"language_server\.exe","(\d+)"/);
        if (m) {
          const lpid = Number(m[1]);
          try { process.kill(lpid); killed.push(lpid); } catch { /* 可能已退出 */ }
        }
      }
      log('LS_RESTARTED', `killed=[${killed.join(',')}] -> host will respawn`);
      // 补写一次凭据（best-effort，借鉴 Antigravity-Manager）：旧 LS 被杀前可能
      // 把旧 token 回写进凭据管理器，这次写入覆盖"写凭据→杀子进程"窗口内的回写，
      // 确保宿主约 2 秒后拉起的新 LS 读到的一定是目标账号凭据。
      try {
        const acc2 = getAccount(target);
        if (acc2 && acc2.token) {
          const blobJson2 = JSON.stringify({
            token: acc2.token,
            auth_method: acc2.auth_method || 'consumer',
            id_token_email: target,
            writer_id: acc2.writer_id || '',
          });
          const blobDir2 = LIB_DIR_TEMP();
          mkdirSync(blobDir2, { recursive: true });
          const blobFile2 = join(blobDir2, 'pending-cred.json');
          writeFileSync(blobFile2, blobJson2, 'utf-8');
          writeActiveBlobFile(blobFile2);
          try { unlinkSync(blobFile2); } catch {}
          log('CRED_RE_ASSERT', target);
        }
      } catch (e) { log('CRED_RE_ASSERT_FAIL', e.message); }
    } catch (e) { log('LS_RESTART_FAIL', e.message); }

    SW.activeEmail = target;
    return { ok: true, email: target, note: 'credential swapped + language_server restarted; new session uses ' + target };
  } catch (e) {
    log('SWITCH_FAIL', e.message);
    // 凭据写失败时严禁留下半状态：确认活跃凭据仍指向原账号
    try {
      const now = JSON.parse(readActiveBlob() || '{}');
      if (now.id_token_email && credBackup && now.id_token_email !== credBackup) {
        log('SWITCH_INCONSISTENT', `cred=${now.id_token_email} expected=${credBackup}`);
      }
    } catch { /* 校验失败仅记日志 */ }
    return { ok: false, error: String(e.message || e) };
  } finally { SW.switching = false; }
}

/* ---------------- 辅助栏（状态 + 账号面板） ---------------- */

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>MiniBar</title>
<script src="/preload.js"></script><style>
body{margin:0;padding:14px;font-family:"Google Sans Flex",system-ui,sans-serif;font-size:12px;
background:var(--background,#131316);color:var(--foreground,#e3e3e8)}
.r{display:flex;justify-content:space-between;padding:4px 0;color:#9a9aa5}
.r b{color:#e8e8ee;font-variant-numeric:tabular-nums}
.c{background:var(--card,#191920);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;margin-bottom:8px}
button{width:100%;padding:8px;border-radius:8px;border:1px solid rgba(138,180,248,.4);
background:rgba(138,180,248,.14);color:#8ab4f8;font-size:12px;cursor:pointer}
.m{color:#6f6f7b;font-size:11px;line-height:1.6}
</style></head><body>
<div class="c">
<div class="r"><span>状态</span><b id="s">—</b></div>
<div class="r"><span>会话</span><b id="c">—</b></div>
<div class="r"><span>上下文</span><b id="ctx">—</b></div>
<div class="r"><span>缓存</span><b id="ca">—</b></div>
<div class="r"><span>TPS</span><b id="t">—</b></div>
<div class="r"><span>5h / 周</span><b id="q">—</b></div>
</div>
<div class="c"><button id="b">停用状态行</button></div>
<div class="m">状态行贴在输入框正下方，不占位。停用后立即消失。</div>
<script>
async function r(){try{const j=await (await fetch('/api/status')).json();const p=j.payload||{};
document.getElementById('s').textContent=j.mounted?'运行中':'未挂载';
document.getElementById('c').textContent=(j.convId||'').slice(0,8)||'—';
document.getElementById('ctx').textContent=p.ctxPct==null?'—':Math.round(p.ctxPct)+'%';
document.getElementById('ca').textContent=p.cachePct==null?'—':Math.round(p.cachePct)+'%';
document.getElementById('t').textContent=p.tps==null?'—':p.tps.toFixed(1);
document.getElementById('q').textContent=(p.h5==null?'—':Math.round(p.h5))+'% / '+(p.wk==null?'—':Math.round(p.wk))+'%';
document.getElementById('b').textContent=j.disabled?'重新启用':'停用状态行';}catch(e){}}
document.getElementById('b').onclick=async()=>{await fetch('/api/toggle',{method:'POST',body:'{}'});r();};
r();setInterval(r,1500);
</script></body></html>`;

async function serve() {
  let App, Res;
  try { const sdk = await import('sidecar_sdk'); App = sdk.SidecarApp; Res = sdk.Response; } catch (e) { log('SDK_UNAVAILABLE', e.message); return; }
  try {
    const app = new App();
    app.page('/', () => new Res(PAGE, { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } }));
    app.api('/api/status', () => ({
      mounted: !!S.last.mounted, disabled: false, convId: S.convId,
      payload: S.last.payload || null, error: S.err || null,
      account: SW.activeEmail, switching: SW.switching,
    }), 'GET');
    app.api('/api/toggle', () => { S.convId = ''; return { ok: true }; }, 'POST');
    // 账号列表与切换主通道走 payload/pending（免 fetch）；HTTP API 保留给辅助栏调试用
    app.api('/api/accounts', () => ({
      active: SW.activeEmail,
      switching: SW.switching,
      accounts: accountsSnapshot(S.last.payload && S.last.payload.h5 !== undefined ? { h5: S.last.payload.h5, wk: S.last.payload.wk } : null),
    }), 'GET');
    app.api('/api/switch', (d) => switchToAccount(String(d.email || '')), 'POST');
    // 打开 Google OAuth 登录窗口（浏览器）
    app.api('/api/open-login', () => {
      try {
        spawn('cmd', ['/c', 'start', '', 'https://accounts.google.com/signin'], { detached: true, windowsHide: true }).unref();
        return { ok: true, note: 'login page opened; after signing in, click 我已登录 on the bar to capture token' };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }, 'POST');
    await app.run();
    S.panelApi = 1;
    // app.run() resolve 后 server.address() 已就绪；从 sidecar_sdk 拿不到端口时退化为读 env
    try { S.panelPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10) || 0; } catch { S.panelPort = 0; }
    log('SERVER_OK', `port=${S.panelPort}`);
  } catch (e) { log('SERVER_FAIL', e.message); }
}

log('BOOT', `node=${process.version}`, `ls=${process.env.ANTIGRAVITY_LS_ADDRESS || ''}`, `ver=${srcVer()}`, `pid=${process.pid}`);
initAccount();
serve();
loop();
