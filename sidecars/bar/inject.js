// MiniBar v3 —— 输入框下方一行极简状态：圆环上下文 + 图标 + 中文名 + 数值。
//
// 铁律：
//  1. 不碰 React 托管的节点树，宿主挂 document.body 做 position:fixed；
//  2. 全局只允许一个 #agy-minibar-host；
//  3. 只改文本与 SVG 属性，不做结构性增删。
(() => {
  const VER = 23;
  const HOST_ID = 'agy-minibar-host';
  if (window.__AGY_MINIBAR && window.__AGY_MINIBAR.ver === VER) return;

  const CSS = `
    :host { all: initial; }
    .bar {
      position: fixed;
      display: flex; align-items: center; justify-content: center;
      height: 19px; padding: 0 1px;
      font-family: "Google Sans Flex", system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 12.5px; line-height: 1;
      color: var(--c-dim);
      font-variant-numeric: tabular-nums;
      letter-spacing: .2px;
      white-space: nowrap; overflow: hidden;
      pointer-events: none;
      z-index: 2147483000;
    }
    .i { display: inline-flex; align-items: center; gap: 4px; padding: 0 9px; flex: 0 0 auto; }
    .i:first-child { padding-left: 0; }
    .n { color: var(--c-key); font-size: 11.5px; letter-spacing: .2px; }
    .v { color: var(--c-val); font-weight: 600; }
    .v.ok { color: var(--c-ok); }
    .v.warn { color: var(--c-warn); }
    .v.bad { color: var(--c-bad); }
    .ic { width: 13px; height: 13px; flex: 0 0 13px; display: block; opacity: .85; }
    .sep { width: 1px; height: 10px; background: var(--c-sep); flex: 0 0 1px; opacity: .5; }
    .acc { cursor: pointer; pointer-events: auto; }
    .acc:hover .v { text-decoration: underline; }
    .panel {
      position: fixed;
      min-width: 240px; max-width: 320px;
      background: var(--c-panel);
      border: 1px solid var(--c-sep);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.4);
      padding: 8px;
      font-family: "Google Sans Flex", system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      z-index: 2147483100;
      pointer-events: auto;
    }
    .p-head { font-size: 11px; color: var(--c-key); padding: 2px 6px 6px; letter-spacing: .3px; }
    .p-row {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 8px; border-radius: 7px;
      font-size: 12px; color: var(--c-val);
      cursor: pointer;
    }
    .p-row:hover { background: var(--c-hover); }
    .p-row.cur { opacity: .75; cursor: default; }
    .p-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-sep); flex: 0 0 6px; }
    .p-dot.ok { background: var(--c-ok); }
    .p-mail { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-tag { font-size: 9.5px; color: var(--c-key); flex: 0 0 auto; }
    .p-mailwrap { flex: 1 1 auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
    .p-quota { font-size: 9.5px; color: var(--c-ok); background: var(--c-hover); border-radius: 4px; padding: 1px 5px; flex: 0 0 auto; }
    .p-empty { font-size: 11px; color: var(--c-key); padding: 10px 8px; }
    .p-foot { border-top: 1px solid var(--c-sep); margin-top: 5px; padding-top: 5px; }
    .p-add {
      padding: 7px 8px; border-radius: 7px;
      font-size: 11.5px; color: var(--c-blue, #8ab4f8);
      cursor: pointer;
    }
    .p-add:hover { background: var(--c-hover); }
    .p-plus {
      padding: 7px 8px; border-radius: 7px;
      font-size: 11.5px; color: var(--c-blue);
      cursor: pointer;
    }
    .p-plus:hover { background: var(--c-hover); }
    .login-confirm {
      position: fixed;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      background: var(--c-panel);
      border: 1px solid var(--c-blue, #8ab4f8);
      border-radius: 9px;
      font-family: "Google Sans Flex", system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 11.5px;
      color: var(--c-val);
      z-index: 2147483200;
      pointer-events: auto;
      pointer-events: auto;
      box-shadow: 0 6px 22px rgba(0,0,0,.35);
    }
    .lc-btn {
      color: var(--c-blue, #8ab4f8);
      font-weight: 600;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 5px;
    }
    .lc-btn:hover { background: var(--c-hover); }
    .lc-x { color: var(--c-key); cursor: pointer; padding: 0 4px; }
    .ring { width: 18px; height: 18px; flex: 0 0 18px; display: block; }
    .ring .tr { stroke: var(--c-sep); opacity: .5; }
    .ring .fl { stroke-linecap: round; transition: stroke-dashoffset .35s ease, stroke .3s ease; }
  `;

  const P = {
    dark:  { dim: '#8b8b96', key: '#71717d', val: '#dcdce4', ok: '#4ecb8a', warn: '#e0a52a', bad: '#e5646b', sep: '#33333d', panel: '#1c1c22', hover: 'rgba(255,255,255,.07)', blue: '#8ab4f8' },
    light: { dim: '#6b6b76', key: '#8a8a95', val: '#1f1f24', ok: '#1e8e3e', warn: '#b06000', bad: '#c5221f', sep: '#d4d4dc', panel: '#ffffff', hover: 'rgba(0,0,0,.06)', blue: '#1a73e8' },
  };

  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (w, h) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', `0 0 ${w} ${h}`); return s; };
  const pth = d => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    return p;
  };
  const icon = build => { const s = svgEl(24, 24); s.setAttribute('class', 'ic'); build(s); return s; };

  const I_CACHE = () => icon(s => {
    s.appendChild(pth('M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z'));
    s.appendChild(pth('M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7'));
    s.appendChild(pth('M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5'));
  });
  const I_BOLT = () => icon(s => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M13 2.5 5.5 13.2h5.2L10 21.5 18.5 10.4h-5.3z');
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
  });
  const I_TIMER = () => icon(s => {
    s.appendChild(pth('M12 8v4l2.5 2'));
    s.appendChild(pth('M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'));
  });
  const I_CLOCK = () => icon(s => {
    s.appendChild(pth('M12 7v5l3 2'));
    s.appendChild(pth('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'));
  });
  const I_CAL = () => icon(s => {
    s.appendChild(pth('M4 6h16v14H4z'));
    s.appendChild(pth('M4 10h16'));
    s.appendChild(pth('M8 3v4M16 3v4'));
  });
  const I_USER = () => icon(s => {
    s.appendChild(pth('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'));
    s.appendChild(pth('M4.5 20a7.5 7.5 0 0 1 15 0'));
  });
  const I_LOOP = () => icon(s => {
    s.appendChild(pth('M17 2.5l3.5 3.5-3.5 3.5'));
    s.appendChild(pth('M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5'));
    s.appendChild(pth('M7 21.5L3.5 18l3.5-3.5'));
    s.appendChild(pth('M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5'));
  });
  const I_TOKEN = () => icon(s => {
    s.appendChild(pth('M5 8.5C5 7.1 8.1 6 12 6s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5z'));
    s.appendChild(pth('M5 8.5v7c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-7'));
    s.appendChild(pth('M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5'));
  });

  function themeOf(el) {
    try {
      let n = el;
      for (let i = 0; i < 7 && n; i++) {
        const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(n).backgroundColor || '');
        if (m && (m[4] === undefined || Number(m[4]) > 0.1)) {
          return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 < 0.5;
        }
        n = n.parentElement;
      }
    } catch (_) {}
    return true;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('translate', 'no');
  host.classList.add('notranslate');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483000;';

  const root = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = CSS;
  root.appendChild(st);

  const bar = document.createElement('div');
  bar.className = 'bar';
  root.appendChild(bar);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.setAttribute('translate', 'no');
    e.classList.add('notranslate');
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---- 上下文圆环 ---- */
  const R = 5.6, C = 2 * Math.PI * R;
  const ring = svgEl(15, 15);
  ring.setAttribute('class', 'ring');
  const rg = document.createElementNS(NS, 'g');
  rg.setAttribute('transform', 'rotate(-90 7.5 7.5)');
  const trk = document.createElementNS(NS, 'circle');
  trk.setAttribute('class', 'tr');
  ['cx:7.5', 'cy:7.5', `r:${R}`].forEach(a => { const [k, v] = a.split(':'); trk.setAttribute(k, v); });
  trk.setAttribute('fill', 'none');
  trk.setAttribute('stroke-width', '1.7');
  const fl = document.createElementNS(NS, 'circle');
  fl.setAttribute('class', 'fl');
  ['cx:7.5', 'cy:7.5', `r:${R}`].forEach(a => { const [k, v] = a.split(':'); fl.setAttribute(k, v); });
  fl.setAttribute('fill', 'none');
  fl.setAttribute('stroke-width', '1.7');
  fl.setAttribute('stroke-dasharray', String(C));
  fl.setAttribute('stroke-dashoffset', String(C));
  rg.appendChild(trk);
  rg.appendChild(fl);
  ring.appendChild(rg);

  const gCtx = el('div', 'i');
  gCtx.appendChild(ring);
  gCtx.appendChild(el('span', 'n', '上下文'));
  const vCtx = el('span', 'v', '—');
  gCtx.appendChild(vCtx);
  // 上下文圆环不在此处入列，等普通项创建完后按目标顺序插入

  function sep() { const s = el('i', 'sep'); bar.appendChild(s); return s; }

  function cell(name, iconFn, cls) {
    const g = el('div', 'i');
    g.appendChild(iconFn());
    g.appendChild(el('span', 'n', name));
    const v = el('span', 'v' + (cls ? ' ' + cls : ''), '—');
    g.appendChild(v);
    bar.appendChild(g);
    return { g, v };
  }

  sep(); const cTok = cell('Token', I_TOKEN, '');
  sep(); const cTurns = cell('轮数', I_LOOP, '');
  sep(); const cTps = cell('TPS', I_BOLT, '');
  // Token → 轮数 → TPS 之后插入上下文圆环，再接其余三项
  sep(); bar.appendChild(gCtx);
  sep(); const cCache = cell('缓存命中', I_CACHE, 'ok');
  sep(); const cH5 = cell('5小时', I_CLOCK, '');
  sep(); const cWk = cell('周额度', I_CAL, '');

  /* ---- 账号项（可点击，弹账号面板）----
   * 免 fetch 通道：accounts 数据由 sidecar 在 payload 下行；点击把
   * pendingSwitch 写到 window.__AGY_MINIBAR.pendingSwitch，由 sidecar 下一轮读走执行。
   */
  let gAcc = null;
  let vAcc = null;
  let accData = null;   // payload.accounts 快照
  let switchState = ''; // '' | 'pending' | 'ok' | 'fail:msg'

  function ensureAccountCell() {
    if (gAcc) return;
    const accBtn = el('div', 'i acc');
    accBtn.appendChild(I_USER());
    accBtn.appendChild(el('span', 'n', '账号'));
    vAcc = el('span', 'v', '—');
    accBtn.appendChild(vAcc);
    const h5 = cH5.g;
    if (h5 && h5.parentNode) h5.parentNode.insertBefore(accBtn, h5);
    else bar.appendChild(accBtn);
    gAcc = accBtn;
    accBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePanel();
    });
  }

  /* ---- 账号弹出面板 ---- */
  let panel = null;
  function renderPanel() {
    if (!panel) return;
    const listEl = panel.querySelector('.p-list');
    listEl.innerHTML = '';
    const accs = Array.isArray(accData) ? accData : [];
    if (!accs.length) {
      listEl.innerHTML = '<div class="p-empty">未发现账号</div>';
      return;
    }
    for (const a of accs) {
      const row = el('div', 'p-row' + (a.isCurrent ? ' cur' : ''));
      const dot = el('span', 'p-dot' + (a.hasToken ? ' ok' : ''));
      const mailWrap = el('span', 'p-mailwrap');
      const mail = el('span', 'p-mail', a.email);
      mailWrap.appendChild(mail);
      if (a.ideQuota && typeof a.ideQuota.geminiWeekly === 'number') {
        const qTag = el('span', 'p-quota', '周' + Math.round(a.ideQuota.geminiWeekly) + '%');
        qTag.title = 'IDE 缓存的 Gemini 周额度剩余';
        mailWrap.appendChild(qTag);
      }
      let tagText = a.isCurrent ? '当前' : (a.hasToken ? '已存' : '需登录');
      if (switchState === 'pending' && switchingTarget === a.email) tagText = '切换中…';
      else if (switchState === 'ok' && switchingTarget === a.email) tagText = '完成';
      else if (switchState.startsWith('fail') && switchingTarget === a.email) tagText = '失败';
      const tag = el('span', 'p-tag', tagText);
      row.appendChild(dot);
      row.appendChild(mailWrap);
      row.appendChild(tag);
      if (!a.isCurrent) {
        row.addEventListener('click', () => {
          switchingTarget = a.email;
          switchState = 'pending';
          // 上行指令：sidecar 下一轮 tick 读走并执行
          window.__AGY_MINIBAR.pendingSwitch = a.email;
          renderPanel();
        });
      }
      listEl.appendChild(row);
    }
  }
  let switchingTarget = '';
  function togglePanel() {
    // DOM 被外部移除而闭包变量未清时（如旧脚本手动 remove），先对齐状态
    if (panel && !panel.isConnected) { panel = null; }
    if (panel) { closePanel(); return; }
    panel = el('div', 'panel');
    panel.innerHTML = '<div class="p-head">切换账号</div><div class="p-list"></div><div class="p-foot"></div>';
    root.appendChild(panel);
    placePanel();          // 面板出现在账号项正上方（锚定状态条）
    renderPanel();
    setTimeout(() => document.addEventListener('mousedown', outsideClose, { once: true }), 0);
  }
  /** 面板定位：右下角对齐账号项，向上展开；贴视口边缘时自动避让 */
  function placePanel() {
    if (!panel) return;
    const acc = gAcc;
    if (!acc) return;
    const pr = acc.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    panel.style.display = 'block';
    // 先渲染再量尺寸
    requestAnimationFrame(() => {
      if (!panel) return;
      const pw = panel.offsetWidth || 260;
      const ph = panel.offsetHeight || 160;
      // 面板底边贴在账号项上方 6px；水平右对齐账号项
      let left = pr.right - pw;
      let top = pr.top - ph - 6;
      // 视口避让：上方放不下则放到输入框下方
      if (top < 8) top = pr.bottom + 6;
      if (left < 8) left = 8;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
      if (top + ph > window.innerHeight - 8) top = window.innerHeight - 8 - ph;
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      panel.style.visibility = 'visible';
    });
  }
  function outsideClose(e) {
    if (panel && !host.contains(e.target)) closePanel();
    else if (panel) document.addEventListener('mousedown', outsideClose, { once: true });
  }
  function closePanel() {
    if (panel) { try { panel.remove(); } catch (_) {} panel = null; }
  }
  function shortEmail(e) { return String(e || '').split('@')[0]; }

  function tone(node, t) {
    const want = 'v' + (t ? ' ' + t : '');
    if (node.className !== want) node.className = want;
  }
  const pct = n => (typeof n === 'number' && isFinite(n) ? Math.round(n) + '%' : '—');

  function setRing(v, t) {
    const p = typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    // 极小占比也留一点可见弧，避免看起来像空环
    const draw = p > 0 && p < 2 ? 2 : p;
    fl.setAttribute('stroke-dashoffset', String(C * (1 - draw / 100)));
    fl.setAttribute('stroke', t === 'bad' ? 'var(--c-bad)' : t === 'warn' ? 'var(--c-warn)' : 'var(--c-ok)');
  }

  let themed = null;
  function anchor() {
    const box = document.querySelector('[data-testid="agent-input-box"]');
    if (!box) return null;
    return box.querySelector('.surface-composer') || box;
  }

  function place() {
    const a = anchor();
    if (!a) { bar.style.visibility = 'hidden'; return false; }
    const r = a.getBoundingClientRect();
    if (!r || r.width < 80) { bar.style.visibility = 'hidden'; return false; }

    const dark = themeOf(a);
    if (themed !== dark) {
      themed = dark;
      const p = dark ? P.dark : P.light;
      for (const k in p) host.style.setProperty('--c-' + k, p[k]);
    }

    const H = 19;
    let top = r.bottom + 2;
    if (top + H > window.innerHeight) top = r.bottom - H - 2;
    bar.style.visibility = 'visible';
    bar.style.left = Math.round(r.left + 3) + 'px';
    bar.style.top = Math.round(top) + 'px';
    bar.style.width = Math.round(r.width - 6) + 'px';
    return true;
  }

  function dedupe() {
    const all = document.querySelectorAll('#' + HOST_ID);
    if (all.length > 1) for (const n of all) if (n !== host) { try { n.remove(); } catch (_) {} }
  }

  function mount() {
    dedupe();
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    place();
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });

  function update(d) {
    if (window.__AGY_MINIBAR && window.__AGY_MINIBAR.frozen) return { ok: true, frozen: true, mounted: host.isConnected, convId: typeof d.convId === 'string' ? d.convId : '' };
    const x = d || {};
    dedupe();
    if (!host.isConnected) mount(); else place();

    const phys = typeof x.ctxPct === 'number' && isFinite(x.ctxPct) ? x.ctxPct : null;
    const comp = typeof x.compactPct === 'number' && isFinite(x.compactPct) ? x.compactPct : null;
    const t = comp === null ? '' : comp >= 92 ? 'bad' : comp >= 80 ? 'warn' : '';
    setRing(phys, t);
    vCtx.textContent = pct(phys);
    tone(vCtx, t);

    cCache.v.textContent = pct(x.cachePct);
    // Token 合计：本会话累计 (input + cache_read + output)，M 单位
    cTok.v.textContent = typeof x.tokensM === 'number' && isFinite(x.tokensM) && x.tokensM > 0
      ? (x.tokensM >= 10 ? x.tokensM.toFixed(1) : x.tokensM.toFixed(2)) + 'M'
      : '—';
    // TPS = 纯解码速度（output_tokens / streaming_seconds），与 DSH 下方 tok/s 同口径
    cTps.v.textContent = typeof x.tps === 'number' && isFinite(x.tps) && x.tps > 0 ? x.tps.toFixed(0) : '—';
    cTurns.v.textContent = typeof x.turns === 'number' && isFinite(x.turns) && x.turns > 0 ? String(Math.round(x.turns)) : '—';
    // 账号项：显示 payload 下行的账号与账号列表快照
    ensureAccountCell();
    if (x.account) vAcc.textContent = shortEmail(x.account);
    else vAcc.textContent = '—';
    accData = Array.isArray(x.accounts) ? x.accounts : null;
    if (x.switchResult) {
      // sidecar 回填的切换结果
      switchState = x.switchResult.ok ? 'ok' : 'fail:' + (x.switchResult.error || '');
      if (x.switchResult.ok) vAcc.textContent = shortEmail(x.switchResult.email);
      switchingTarget = x.switchResult.email || switchingTarget;
      // 3 秒后清除结果态
      setTimeout(() => { switchState = ''; if (panel) renderPanel(); }, 3000);
    }
    if (x.captureResult) {
      // sidecar 回填的抓取结果（登录确认条场景）
      const lc = root.querySelector('.login-confirm');
      if (lc) {
        const btn = lc.querySelector('.lc-btn');
        if (x.captureResult.ok) {
          if (btn) btn.textContent = '已保存 ' + shortEmail(x.captureResult.email);
          setTimeout(() => { try { lc.remove(); } catch (_) {} }, 900);
        } else {
          if (btn) btn.textContent = '抓取失败，稍后再试';
          setTimeout(() => { if (btn) btn.textContent = '我已登录'; }, 1500);
        }
      }
    }
    if (panel) renderPanel();
    cH5.v.textContent = pct(x.h5);
    tone(cH5.v, typeof x.h5 === 'number' && x.h5 < 20 ? 'bad' : '');
    cWk.v.textContent = pct(x.wk);

    // 上行：pending 指令回传给 sidecar（含消费标记，避免 sidecar 重复执行）
    return {
      ok: true,
      mounted: host.isConnected,
      convId: typeof x.convId === 'string' ? x.convId : '',
      pendingSwitch: window.__AGY_MINIBAR.pendingSwitch || null,
      pendingCapture: window.__AGY_MINIBAR.pendingCapture === true,
    };
  }

  window.__AGY_MINIBAR = {
    ver: VER, update, mount,
    pendingSwitch: null,     // 页面 → sidecar：切换指令
    pendingCapture: false,   // 页面 → sidecar：抓取当前凭据入库
    unmount() { try { host.remove(); } catch (_) {} },
    /* OAuth 登录确认条：登录完成后显示，点击抓取 token 入库（免 fetch 通道） */
    showLoginConfirm() {
      try {
        let bar = root.querySelector('.login-confirm');
        if (bar) { return; }
        bar = el('div', 'login-confirm');
        bar.innerHTML = '<span class="lc-txt">完成 Google 登录后点此保存账号</span>';
        const okBtn = el('span', 'lc-btn', '我已登录');
        okBtn.addEventListener('click', () => {
          okBtn.textContent = '保存中…';
          window.__AGY_MINIBAR.pendingCapture = true;
          // 状态由 sidecar 下一轮 tick 处理后经 switchResult/captureResult 回填
        });
        const closeX = el('span', 'lc-x', '×');
        closeX.addEventListener('click', () => { try { bar.remove(); } catch (_) {} });
        bar.appendChild(okBtn);
        bar.appendChild(closeX);
        root.appendChild(bar);
        // 30 秒无操作自动收起
        setTimeout(() => { if (root.querySelector('.login-confirm')) { try { bar.remove(); } catch (_) {} } }, 30000);
      } catch (_) {}
    },
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
