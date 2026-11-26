/**
 * MiniBar sidecar —— 取数 + 注入。
 * 只读本地 transcript 与 Language Server RPC，通过 CDP 往主窗口推一行状态，
 * 不修改 app.asar，不写宿主任何配置。
 */

import { exec, execSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_LIMIT_TOKENS, ID_RE, buildSpeedIndex, enrichSummaryWithSpeed,
  parseTranscriptText, readTranscriptFile, resolveTranscriptFile, safeStat, findAllBrainDirs,
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
process.on('uncaughtException', e => {
  if (e && e.code === 'EPIPE') return;
  log('UNCAUGHT', (e && e.stack) || String(e));
});
process.on('unhandledRejection', e => {
  if (e && e.code === 'EPIPE') return;
  log('UNHANDLED', (e && e.stack) || String(e));
});
process.stdout?.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', err => { if (err.code !== 'EPIPE') throw err; });

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
        return false; // 活着的同伴持有，自己进入待命
      } catch {
        try { unlinkSync(LOCK_FILE); } catch {} // 锁文件损坏，重试
      }
    }
  }
  return false;
}

// 待命模式：若同伴持有锁，绝不直接 process.exit(0)（否则 restart_policy: always 会导致死循环狂刷拉起）
if (!acquireSingletonLock()) {
  log('SINGLETON_STANDBY', `pid=${process.pid} -> standby waiting for lock`);
  let standbyTicks = 0;
  while (!acquireSingletonLock()) {
    await new Promise(r => setTimeout(r, 5000));
    standbyTicks++;
    // 每 20 秒检查自己关联的 LS 是否还在监听；若自身所属的 LS 早已死亡，主动退出避免无意义待命堆积
    if (standbyTicks % 4 === 0 && process.env.ANTIGRAVITY_LS_ADDRESS) {
      try {
        const ping = await postHttp(`http://${process.env.ANTIGRAVITY_LS_ADDRESS}`, 'RetrieveUserQuotaSummary', {}, process.env.ANTIGRAVITY_CSRF_TOKEN, 800);
        if (!ping.ok && (ping.err || ping.status === 401)) {
          log('STANDBY_DEAD_EXIT', `creator LS is gone; exiting pid=${process.pid}`);
          process.exit(0);
        }
      } catch {}
    }
  }
  log('SINGLETON_PROMOTED', `pid=${process.pid} -> promoted to active`);
} else {
  log('SINGLETON_ACQUIRE', `pid=${process.pid}`);
}
setInterval(() => {
  try { writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
  // 父进程存活看门狗：父进程若已终止，主动退出杜绝孤儿进程堆积
  try {
    if (process.ppid) {
      process.kill(process.ppid, 0);
    }
  } catch (e) {
    if (e.code === 'ESRCH') {
      try { unlinkSync(LOCK_FILE); } catch {}
      process.exit(0);
    }
  }
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

/* ---------------- Token 用量统计（日 / 周 / 月） ---------------- */

let tokenAggCache = {
  day: 0,
  week: 0,
  month: 0,
  scannedAt: 0,
  fileCache: new Map(),
};

function getTokenUsage() {
  const now = new Date();
  const nowMs = now.getTime();

  // 缓存 4 秒，避免高频 tick 重复扫描
  if (nowMs - tokenAggCache.scannedAt < 4000 && tokenAggCache.scannedAt > 0) {
    return {
      day: tokenAggCache.day,
      week: tokenAggCache.week,
      month: tokenAggCache.month,
    };
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let totalDay = 0;
  let totalWeek = 0;
  let totalMonth = 0;

  try {
    const brainDirs = findAllBrainDirs();
    for (const bDir of brainDirs) {
      let convs = [];
      try { convs = readdirSync(bDir); } catch { continue; }
      for (const c of convs) {
        const p = join(bDir, c, '.system_generated', 'logs', 'transcript.jsonl');
        let st;
        try { st = statSync(p); } catch { continue; }
        // 修改时间早于本月 1 号 0 点的文件不可能包含本月 Token，直接跳过
        if (st.mtimeMs < startOfMonth) continue;

        let cached = tokenAggCache.fileCache.get(p);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.startOfMonth === startOfMonth && cached.startOfWeek === startOfWeek && cached.startOfToday === startOfToday) {
          totalDay += cached.day;
          totalWeek += cached.week;
          totalMonth += cached.month;
          continue;
        }

        let dTok = 0, wTok = 0, mTok = 0;
        try {
          const text = readFileSync(p, 'utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.includes('PLANNER_RESPONSE')) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type !== 'PLANNER_RESPONSE') continue;
              const ts = Date.parse(obj.created_at);
              if (isNaN(ts) || ts < startOfMonth) continue;
              const t = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0) + (Number(obj.output_tokens) || 0);
              mTok += t;
              if (ts >= startOfWeek) wTok += t;
              if (ts >= startOfToday) dTok += t;
            } catch (_) {}
          }
        } catch (_) {}

        tokenAggCache.fileCache.set(p, {
          mtimeMs: st.mtimeMs,
          day: dTok,
          week: wTok,
          month: mTok,
          startOfToday,
          startOfWeek,
          startOfMonth,
        });

        totalDay += dTok;
        totalWeek += wTok;
        totalMonth += mTok;
      }
    }
    tokenAggCache.day = totalDay;
    tokenAggCache.week = totalWeek;
    tokenAggCache.month = totalMonth;
    tokenAggCache.scannedAt = nowMs;
  } catch (err) {
    log('TOKEN_AGG_ERR', err.message);
  }

  return { day: tokenAggCache.day, week: tokenAggCache.week, month: tokenAggCache.month };
}

/* ---------------- Language Server RPC & 动态发现 ---------------- */

let lsConn = { at: 0, base: '', csrf: '', pid: 0 };

async function discoverLsConnection(force = false) {
  const now = Date.now();
  if (!force && lsConn.base && (now - lsConn.at < 30_000)) {
    return lsConn;
  }

  // 0) 极速直连通道（环境变量注入，仅需 ~20ms）：App 刚启动或更新自启时秒级挂载
  const envAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '');
  const envCsrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '');
  if (envAddr && envCsrf) {
    for (const proto of ['http', 'https']) {
      const fastBase = `${proto}://${envAddr}`;
      const r = await postHttp(fastBase, 'RetrieveUserQuotaSummary', { forceRefresh: false }, envCsrf, 800);
      if (r && r.ok) {
        lsConn = { at: Date.now(), base: fastBase, csrf: envCsrf, pid: 0 };
        log('LS_DISCOVERED', `fast-path base=${fastBase} csrf=...${envCsrf.slice(-6)}`);
        return lsConn;
      }
    }
  }

  let pid = null;
  let csrf = null;
  // 1) 通过 wmic 获取 language_server.exe 的命令行（提取当前活跃的 --csrf_token）
  try {
    const csv = execSync('wmic process where "name=\'language_server.exe\'" get ProcessId,CommandLine /format:csv', {
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    });
    for (const line of csv.split(/\r?\n/)) {
      if (!line.includes('language_server.exe')) continue;
      const parts = line.split(',');
      const cmd = parts[1] || '';
      const p = parts[2] || '';
      if (p.trim()) pid = Number(p.trim());
      const m = cmd.match(/--csrf_token\s+([0-9a-f-]+)/i);
      if (m) {
        csrf = m[1];
        break;
      }
    }
  } catch (e) {
    log('WMIC_ERR', e.message);
  }

  if (!csrf) csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '');

  // 2) 通过 netstat 快速提取监听端口
  const ports = [];
  try {
    const netstat = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    for (const line of netstat.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const linePid = Number(parts[4]);
        if (!pid || linePid === pid) {
          const port = Number(parts[1].split(':').pop());
          if (port > 0 && port < 65536 && !ports.includes(port)) ports.push(port);
        }
      }
    }
  } catch (e) {
    log('NETSTAT_ERR', e.message);
  }

  // 环境变量中预设端口作为最高优先级候选
  const envPort = Number(envAddr.split(':').pop());
  if (envPort > 0 && !ports.includes(envPort)) ports.unshift(envPort);

  // 3) 并发快速探测候选端口（限制最多探测前 8 个候选，防止阻塞主循环）
  const candidates = ports.slice(0, 8);
  const tasks = [];
  for (const port of candidates) {
    for (const host of ['127.0.0.1', 'localhost']) {
      for (const proto of ['http', 'https']) {
        const base = `${proto}://${host}:${port}`;
        tasks.push(
          postHttp(base, 'RetrieveUserQuotaSummary', { forceRefresh: false }, csrf, 1000)
            .then(res => (res.ok ? { base, csrf, pid } : null))
            .catch(() => null)
        );
      }
    }
  }

  try {
    const results = await Promise.all(tasks);
    const found = results.find(Boolean);
    if (found) {
      lsConn = { at: Date.now(), base: found.base, csrf: found.csrf, pid: found.pid };
      log('LS_DISCOVERED', `parallel base=${found.base} pid=${found.pid} csrf=...${found.csrf.slice(-6)}`);
      return lsConn;
    }
  } catch {}

  return lsConn.base ? lsConn : null;
}

let lastRpcError = { code: 0, text: '', at: 0 };

function postHttp(base, method, body, csrf, timeout = 4000) {
  let payload;
  try { payload = JSON.stringify(body || {}); } catch { return Promise.resolve({ ok: false }); }
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    const mod = base.startsWith('https://') ? https : http;
    const req = mod.request(`${base}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf || '',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout,
    }, res => {
      let text = '';
      let n = 0;
      res.on('data', c => { n += c.length; if (n > 32e6) { req.destroy(); return fin({ ok: false, status: res.statusCode }); } text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          if (res.statusCode === 429) lastRpcError = { code: 429, text: '请求限流 (429)', at: Date.now() };
          else if (res.statusCode === 401) lastRpcError = { code: 401, text: '鉴权失效 (401)', at: Date.now() };
          return fin({ ok: false, status: res.statusCode });
        }
        lastRpcError = { code: 0, text: '', at: 0 };
        try { fin({ ok: true, data: JSON.parse(text) }); } catch { fin({ ok: false, status: 200, parseErr: true }); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); fin({ ok: false, timeout: true }); });
    req.on('error', (e) => fin({ ok: false, err: e.message }));
    req.end(payload);
  });
}

let lsFailureCount = 0;

async function rpc(method, body, timeout = 4000) {
  let conn = await discoverLsConnection();
  if (conn && conn.base) {
    const res = await postHttp(conn.base, method, body, conn.csrf, timeout);
    if (res.ok) {
      lsFailureCount = 0;
      return res.data;
    }
    if (res.status === 401 || res.err || res.timeout) {
      // 鉴权失败或连接断开（例如切号后 LS 重启），强制重新探测
      conn = await discoverLsConnection(true);
      if (conn && conn.base) {
        const retryRes = await postHttp(conn.base, method, body, conn.csrf, timeout);
        if (retryRes.ok) {
          lsFailureCount = 0;
          return retryRes.data;
        }
      }
    }
  }
  lsFailureCount++;
  // 如果与 Language Server 连续失联超过 6 次（约 15~20 秒），说明 LS 已重启或被更换，自身作为旧侧载已无法获得新 Token
  // 主动解除单例锁并优雅退出，让宿主拉起的新侧载（带有最新 CSRF Token 与端口）接管
  if (lsFailureCount >= 6) {
    log('LS_LOST_AUTO_EXIT', `consecutive failures=${lsFailureCount}; yielding lock for fresh host sidecar`);
    try { unlinkSync(LOCK_FILE); } catch {}
    process.exit(0);
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

function formatResetTime(iso) {
  if (!iso) return '';
  const diffMs = Date.parse(iso) - Date.now();
  if (isNaN(diffMs) || diffMs <= 0) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

async function quota(model = '', force = false) {
  const now = Date.now();
  // 缓存 8 秒（模型改变或显式触发强刷时立即刷新）
  if (!force && S.q.d && now - S.q.at < 8000 && S.q.model === model) return S.q.d;

  // 定期带 forceRefresh: true 向上游 Google 查询最新配额，避免 LS 返回内部陈旧快照
  const shouldForce = force || !S.q.at || (now - S.q.at >= 8000);
  const r = await rpc('RetrieveUserQuotaSummary', { forceRefresh: shouldForce }, 5000);
  const p = r && r.response !== undefined ? r.response : r;
  if (!p || typeof p !== 'object') return S.q.d || { h5: null, wk: null };

  const groups = Array.isArray(p.groups) ? p.groups : [];
  let buckets = [];
  for (const g of groups) {
    for (const b of (Array.isArray(g && g.buckets) ? g.buckets : [])) {
      buckets.push({ ...b, _g: String(g && g.displayName || '') });
    }
  }
  if (!buckets.length && Array.isArray(p.buckets)) buckets = p.buckets;

  // 根据当前会话实际使用的模型动态匹配额度池：
  // 若使用 Claude 或 GPT 系列，匹配 3p 组；否则默认匹配 Gemini 组
  const is3p = /claude|gpt|oss/i.test(model);
  let pool = [];
  if (is3p) {
    pool = buckets.filter(b => /claude|gpt/i.test(b._g));
  } else {
    pool = buckets.filter(b => /gemini/i.test(b._g));
  }
  if (!pool.length) pool = buckets;

  const pick = w => {
    const hit = pool.find(b => winOf(b) === w);
    return hit ? { pct: frac(hit), reset: formatResetTime(hit.resetTime), resetIso: hit.resetTime || '' } : null;
  };
  const h5Obj = pick('5h');
  const wkObj = pick('weekly');
  const d = {
    h5: h5Obj ? h5Obj.pct : null,
    h5Reset: h5Obj ? h5Obj.reset : '',
    h5ResetIso: h5Obj ? h5Obj.resetIso : '',
    wk: wkObj ? wkObj.pct : null,
    wkReset: wkObj ? wkObj.reset : '',
    wkResetIso: wkObj ? wkObj.resetIso : '',
  };
  S.q = { d, at: now, model };
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
  const o = { convId, ctxPct: null, compactPct: null, cachePct: null, tps: null, ttft: null, turns: 0, model: '', h5: null, wk: null, live: false, cacheAgeSec: 0, isGenerating: false, contextUsed: 0, modelLimit: 1048576 };
  if (!convId || !ID_RE.test(convId)) return o;

  const loc = resolveTranscriptFile(convId);
  if (!loc) return o;
  const st = safeStat(loc.path);
  if (!st) return o;

  let c = S.ts.get(loc.path);
  const needsSpeedRetry = c && (!c.sum?.latest?.speed) && (c.speedRetries || 0) < 6;
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size || needsSpeedRetry) {
    // 统一走全量解析：尾部快读在不同时刻会解析出不同的最新步骤，
    // 是状态条数值在「有/无 TPS」之间反复横跳的直接原因。
    // 全量解析一次成型后缓存，直到文件变化前输出完全稳定。
    let sum = null;
    try { sum = parseTranscriptText(readTranscriptFile(loc.path)); } catch { sum = null; }
    if (!sum) return o;

    const gm = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: convId, generatorMetadataOffset: 0, includeMessages: false });
    if (gm && Array.isArray(gm.generatorMetadata)) {
      try { sum = enrichSummaryWithSpeed(sum, buildSpeedIndex(gm.generatorMetadata)); } catch {}
    } else if (c && c.sum && c.sum.latest && c.sum.latest.speed) {
      // 当 LS 重启暂不可用时，继承上一轮成功的 speed 数据，杜绝切号时 TPS 瞬间掉成「—」
      if (sum && sum.latest) sum.latest.speed = c.sum.latest.speed;
    }
    const speedRetries = (c && c.mtime === st.mtimeMs && c.size === st.size) ? ((c.speedRetries || 0) + 1) : 0;
    c = { mtime: st.mtimeMs, size: st.size, sum, speedRetries };
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
    o.contextUsed = used;
    o.modelLimit = modelWindow(model);
    // 圆环百分比按官方模型窗口算；颜色风险按 256K 自动压缩线算
    if (used > 0) {
      o.ctxPct = Math.min(100, used / modelWindow(model) * 100);
      o.compactPct = Math.min(100, used / FIXED_LIMIT_TOKENS * 100);
      o.cachePct = (Number(latest.cacheHitRate) || 0) * 100;
    } else {
      o.ctxPct = null;
      o.compactPct = null;
      o.cachePct = null;
    }
    if (sp) {
      o.tps = Number.isFinite(sp.calibratedTps)
        ? sp.calibratedTps
        : (Number.isFinite(sp.streamingTps) ? sp.streamingTps : (Number.isFinite(sp.tps) ? sp.tps : null));
      o.ttft = Number.isFinite(sp.ttftSec) ? sp.ttftSec : null;
    }
  }
  const ageSec = Math.max(0, Math.round((Date.now() - (st.mtimeMs || 0)) / 1000));
  o.cacheAgeSec = ageSec;
  o.isGenerating = (Date.now() - (st.mtimeMs || 0)) < 3500 && (o.tps !== null || o.turns > 0);
  o.live = ageSec < 20;
  return o;
}

/* ---------------- CDP ---------------- */

function devPort() {
  const dirs = ['antigravity', 'Antigravity', 'Antigravity IDE'];
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [];
  for (const b of bases) {
    for (const d of dirs) {
      cands.push(join(b, d, 'DevToolsActivePort'));
    }
  }
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
        || l.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
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
 * 每次账号成为"当前"时，把它的 LS 实时配额与重置时间写入本地 JSON。
 * 非当前账号的卡片优先展示这份记录，并引入「时间窗口自动过期重置推演」：
 *   - 5H 额度：距上次记录超过 5 小时或超过 resetTime，自动回满为 100%
 *   - 周额度：跨越周 resetTime，自动回满为 100%
 */
const LQ_FILE = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-minibar', 'live-quota.json');

function loadLiveQuota() {
  try { return JSON.parse(readFileSync(LQ_FILE, 'utf-8')); } catch { return {}; }
}

function saveLiveQuota(email, h5, wk, h5ResetIso = '', wkResetIso = '') {
  try {
    const store = loadLiveQuota();
    const existing = store[String(email).toLowerCase()] || {};
    store[String(email).toLowerCase()] = {
      h5,
      wk,
      h5ResetIso: h5ResetIso || existing.h5ResetIso || '',
      wkResetIso: wkResetIso || existing.wkResetIso || '',
      at: Date.now()
    };
    const tmp = LQ_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, LQ_FILE);
  } catch { /* 记录失败不影响主流程 */ }
}

function resetAllQuotasTo100() {
  try {
    const store = loadLiveQuota();
    const now = Date.now();
    // 同步收录账号库与 google_accounts.json 中的全部已知账号，确保所有离线账号都被校准
    const emails = new Set(Object.keys(store));
    for (const a of loadLibrary().accounts) if (a && a.email) emails.add(String(a.email).toLowerCase());
    try {
      const ga = JSON.parse(readFileSync(join(homedir(), '.gemini', 'google_accounts.json'), 'utf-8'));
      if (ga.active) emails.add(String(ga.active).toLowerCase());
      for (const e of (Array.isArray(ga.old) ? ga.old : [])) if (e) emails.add(String(e).toLowerCase());
    } catch {}
    for (const k of emails) {
      store[k] = {
        h5: 100,
        wk: 100,
        h5ResetIso: '',
        wkResetIso: '',
        at: now,
        manualReset: true,
      };
    }
    const tmp = LQ_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, LQ_FILE);
    return true;
  } catch { return false; }
}

function liveQuotaRecord(email) {
  try {
    const store = loadLiveQuota();
    const hit = store[String(email).toLowerCase()];
    if (!hit) return null;
    const now = Date.now();
    // 超过 14 天的记录完全失效
    if (now - hit.at > 14 * 86400000) return null;

    let h5 = typeof hit.h5 === 'number' ? hit.h5 : null;
    let wk = typeof hit.wk === 'number' ? hit.wk : null;
    let isAutoReset = Boolean(hit.manualReset);

    // 5H 额度自然重置推演：
    // 若距记录时间已超 5 小时，或已越过 5H 预估重置时刻，云端必然已回满 100%
    if ((hit.h5ResetIso && now >= Date.parse(hit.h5ResetIso)) || (now - hit.at >= 5 * 3600_000)) {
      h5 = 100;
      isAutoReset = true;
    }

    // 周额度自然重置推演：
    // 若已越过周重置时刻，云端必然已回满 100%
    if (hit.wkResetIso && now >= Date.parse(hit.wkResetIso)) {
      wk = 100;
      isAutoReset = true;
    }

    return { ...hit, h5, wk, isAutoReset };
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
    let isAutoReset = false;
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
        isAutoReset = Boolean(local.isAutoReset);
        quotaSource = isAutoReset ? 'auto-reset' : 'captured';
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
      isAutoReset,
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
    const wasGenerating = !!S.lastGenerating;
    S.lastGenerating = !!st.isGenerating;
    const turnsChanged = typeof S.lastTurns === 'number' && st.turns > S.lastTurns;
    S.lastTurns = st.turns;
    // 当生成刚刚结束，或者轮次增加（有新消息输出完毕）时，立即强刷额度，确保用户看到实时扣减
    const forceQuota = (wasGenerating && !st.isGenerating) || turnsChanged;
    if (forceQuota) S.q.at = 0;

    let q = { h5: null, wk: null };
    try { q = (await quota(st.model, forceQuota)) || q; } catch {}

    let errorNotice = null;
    const ignoreRpc = SW.ignoreRpcErrorUntil && Date.now() < SW.ignoreRpcErrorUntil;
    if (!ignoreRpc && lastRpcError.code && (Date.now() - lastRpcError.at < 15000)) {
      errorNotice = { badge: lastRpcError.text, detail: `Language Server: ${lastRpcError.text}` };
    } else if (q && q.h5 === 0) {
      errorNotice = { badge: '5h额度耗尽', detail: '当前模型 5 小时额度已耗尽 (0%)' };
    } else if (q && q.wk === 0) {
      errorNotice = { badge: '周额度耗尽', detail: '当前模型每周额度已耗尽 (0%)' };
    }

    if (!SW.activeEmail && !SW.switching) {
      initAccount();
    }

    const payload = {
      convId: S.convId,
      model: st.model || '',
      ctxPct: st.ctxPct,
      compactPct: st.compactPct,
      cachePct: st.cachePct,
      cacheAgeSec: st.cacheAgeSec || 0,
      isGenerating: st.isGenerating || false,
      contextUsed: st.contextUsed || 0,
      modelLimit: st.modelLimit || 1048576,
      tps: st.tps,
      ttft: st.ttft,
      turns: st.turns,
      tokensM: st.tokensM,
      tokenUsage: getTokenUsage(),
      account: SW.activeEmail || '',
      accounts: accountsSnapshot(q),
      switchResult: SW.switchResult || null,
      captureResult: SW.captureResult || null,
      h5: q.h5,
      h5Reset: q.h5Reset || '',
      wk: q.wk,
      wkReset: q.wkReset || '',
      errorNotice,
      live: st.live,
    };

    // 记录当前账号的实时配额（幂等：值不变时磁盘写入由调用方规避——这里直接写，每分钟一次成本低）
    if (typeof payload.wk === 'number' && payload.account) {
      saveLiveQuota(payload.account, payload.h5, payload.wk, q.h5ResetIso, q.wkResetIso);
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
      // 切换完成后立即主动向前台推送最新账号状态与平滑配额，无需等下一轮 tick 循环
      try {
        const immPayload = {
          ...payload,
          account: SW.activeEmail || target,
          accounts: accountsSnapshot(S.q.d || q),
          switchResult: SW.switchResult,
          h5: S.q.d ? S.q.d.h5 : q.h5,
          wk: S.q.d ? S.q.d.wk : q.wk,
        };
        await cdp.eval(`window.__AGY_MINIBAR && window.__AGY_MINIBAR.update(${JSON.stringify(immPayload)})`);
      } catch {}
    }
    if (r && r.pendingResetQuotas === true) {
      resetAllQuotasTo100();
      S.q.at = 0;
      let freshQ = q;
      try { freshQ = (await quota(st.model, true)) || q; } catch {}
      log('QUOTAS_RESET_ALL_100');
      try {
        const resetPayload = {
          ...payload,
          accounts: accountsSnapshot(freshQ),
          h5: freshQ.h5,
          h5Reset: freshQ.h5Reset || '',
          wk: freshQ.wk,
          wkReset: freshQ.wkReset || '',
        };
        await cdp.eval(`window.__AGY_MINIBAR && window.__AGY_MINIBAR.update(${JSON.stringify(resetPayload)})`);
      } catch {}
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

/** 初始化与自愈：多级容错读取当前账号（解析 blob、PowerShell 直接读取、google_accounts.json 及本地库多重兜底） */
function initAccount() {
  if (SW.switching) return;
  try {
    // 1. 优先尝试解析 active blob 获得完整凭据
    try {
      const blob = readActiveBlob();
      if (blob && typeof blob === 'string') {
        const trimmed = blob.trim();
        const jsonStart = trimmed.indexOf('{');
        const jsonEnd = trimmed.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const o = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
          if (o && o.id_token_email) {
            SW.activeEmail = o.id_token_email;
            if (o.token) {
              upsertAccount({ email: o.id_token_email, token: o.token, auth_method: o.auth_method, writer_id: o.writer_id });
              log('ACCOUNT_BACKED_UP', SW.activeEmail);
            }
            return;
          }
        }
      }
    } catch (_) {}

    // 2. 降级：直接通过 PowerShell 读 email 模式
    try {
      const em = readActiveEmail();
      if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.trim())) {
        SW.activeEmail = em.trim();
        log('ACCOUNT_RECOVERED_PS', SW.activeEmail);
        return;
      }
    } catch (_) {}

    // 3. 降级：读 .gemini/google_accounts.json 中的 active 字段
    try {
      const gaPath = join(homedir(), '.gemini', 'google_accounts.json');
      const ga = JSON.parse(readFileSync(gaPath, 'utf-8'));
      if (ga && ga.active && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ga.active.trim())) {
        SW.activeEmail = ga.active.trim();
        log('ACCOUNT_RECOVERED_GA', SW.activeEmail);
        return;
      }
    } catch (_) {}

    // 4. 降级：读本地凭据库中的第一个可用账号
    try {
      const lib = loadLibrary();
      if (lib && Array.isArray(lib.accounts) && lib.accounts.length > 0) {
        SW.activeEmail = lib.accounts[0].email;
        log('ACCOUNT_RECOVERED_LIB', SW.activeEmail);
        return;
      }
    } catch (_) {}
  } catch (e) {
    log('ACCOUNT_INIT_FAIL', e.message);
  }
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

    // 3) 写凭据 blob（CredWriteW）——动态临时文件名防竞争
    const blobJson = JSON.stringify({
      token: acc.token,
      auth_method: acc.auth_method || 'consumer',
      id_token_email: target,
      writer_id: acc.writer_id || '',
    });
    const blobDir = LIB_DIR_TEMP();
    mkdirSync(blobDir, { recursive: true });
    const blobFile = join(blobDir, `pending-cred-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
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
    // 切号重启 LS 期间抑制 8 秒内的 RPC 瞬态错误提示，防界面闪报红标
    SW.ignoreRpcErrorUntil = Date.now() + 8000;
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
          const blobFile2 = join(blobDir2, `pending-cred-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
          writeFileSync(blobFile2, blobJson2, 'utf-8');
          writeActiveBlobFile(blobFile2);
          try { unlinkSync(blobFile2); } catch {}
          log('CRED_RE_ASSERT', target);
        }
      } catch (e) { log('CRED_RE_ASSERT_FAIL', e.message); }

      // 额度平滑：绝不置空 S.q.d 为 null！优先继承目标账号的历史快照，无快照则保留现有额度
      const targetCached = liveQuotaRecord(target);
      if (targetCached && typeof targetCached.h5 === 'number' && typeof targetCached.wk === 'number') {
        S.q.d = { h5: targetCached.h5, wk: targetCached.wk, h5Reset: '—', wkReset: '—' };
      } else {
        try {
          const ideQuotas = ideQuota.readIdeQuotaCache() || {};
          const iq = ideQuotas[target.toLowerCase()];
          if (iq && iq.models) {
            S.q.d = {
              h5: iq.models['gemini:5h']?.remaining ?? (S.q.d ? S.q.d.h5 : null),
              wk: iq.models['gemini:weekly']?.remaining ?? (S.q.d ? S.q.d.wk : null),
              h5Reset: '—',
              wkReset: '—',
            };
          }
        } catch {}
      }
      // 清空时间戳使新 LS 拉起后第一时间拉取最新真实额度，但在此之前 S.q.d 始终保持有效数值
      S.q.at = 0;
      S.q.model = '';
      log('SWITCH_YIELD_LOCK', `credential swapped to ${target}; exiting to let fresh host sidecar take over with new CSRF token`);
      try { unlinkSync(LOCK_FILE); } catch {}
      setTimeout(() => { process.exit(0); }, 1500);
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
