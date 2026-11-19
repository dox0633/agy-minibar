// MiniBar v3 —— 输入框下方一行极简状态：圆环上下文 + 图标 + 中文名 + 数值。
//
// 铁律：
//  1. 不碰 React 托管的节点树，宿主挂 document.body 做 position:fixed；
//  2. 全局只允许一个 #agy-minibar-host；
//  3. 只改文本与 SVG 属性，不做结构性增删。
(() => {
  const VER = 50;
  const HOST_ID = 'agy-minibar-host';
  if (window.__AGY_MINIBAR && window.__AGY_MINIBAR.ver === VER) return;

  const CSS = `
    :host { all: initial; }
    .bar {
      position: fixed;
      display: flex; align-items: center; justify-content: center;
      height: 19px; padding: 0 1px;
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      font-size: 12.5px; line-height: 1;
      color: var(--c-dim);
      white-space: nowrap; overflow: hidden;
      pointer-events: none;
      z-index: 2147483000;
    }
    .i { display: inline-flex; align-items: center; gap: 4px; padding: 0 9px; flex: 0 0 auto; }
    .i:first-child { padding-left: 0; }
    .n {
      color: var(--c-key);
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      font-size: 11.5px;
      font-weight: 550;
      letter-spacing: 0.5px;
    }
    .v {
      color: var(--c-val);
      font-family: "JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.2px;
      font-variant-numeric: tabular-nums;
    }
    .v.ok { color: var(--c-ok); }
    .v.warn { color: var(--c-warn); }
    .v.bad { color: var(--c-bad); }
    .q-slash { opacity: .35; font-weight: normal; margin: 0 1px; }
    .quota-cell { cursor: pointer; pointer-events: auto; }
    .q-dot { color: var(--c-sep); opacity: .7; font-size: 11px; margin: 0 1px; user-select: none; }
    .q-bar-wrap {
      position: relative;
      width: 52px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      margin-left: 2px;
      user-select: none;
    }
    .q-track {
      width: 100%;
      height: 3px;
      background: var(--c-sep);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .q-fill {
      height: 100%;
      background: rgba(255, 255, 255, 0.18);
      border-radius: 2px;
      transition: width .3s ease;
    }
    .q-ptr-h5 {
      position: absolute;
      top: 0px;
      width: 0;
      height: 0;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-top: 4.5px solid #38bdf8;
      filter: drop-shadow(0 0 2px #38bdf8);
      transition: left .3s ease, border-top-color .3s ease;
    }
    .q-ptr-wk {
      position: absolute;
      bottom: 0px;
      width: 0;
      height: 0;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-bottom: 4.5px solid #34d399;
      filter: drop-shadow(0 0 2px #34d399);
      transition: left .3s ease, border-bottom-color .3s ease;
    }
    .quota-card {
      position: fixed;
      width: 250px;
      background: var(--c-panel);
      border: 1px solid var(--c-sep);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.55);
      padding: 10px 12px;
      font-family: "Google Sans Flex", system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      z-index: 2147483150;
      pointer-events: auto;
      color: var(--c-val);
      animation: qc-pop .18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes qc-pop {
      from { opacity: 0; transform: translateY(4px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .qc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--c-sep); margin-bottom: 8px; }
    .qc-title { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; color: var(--c-val); }
    .qc-dot { width: 6px; height: 6px; border-radius: 50%; }
    .qc-pool { font-size: 10px; color: var(--c-key); background: var(--c-hover); padding: 1px 6px; border-radius: 4px; font-family: monospace; }
    .qc-row { margin-bottom: 8px; }
    .qc-row:last-child { margin-bottom: 0; }
    .qc-lbl-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; margin-bottom: 2px; }
    .qc-lbl { color: var(--c-val); font-weight: 500; }
    .qc-val-wrap { display: flex; align-items: baseline; }
    .qc-val { font-family: monospace; font-weight: bold; }
    .qc-track-wrap {
      position: relative;
      width: 100%;
      height: 14px;
      display: flex;
      align-items: center;
      margin: 1px 0 3px;
    }
    .qc-track-groove {
      width: 100%;
      height: 4px;
      background: var(--c-hover);
      border-radius: 2px;
      overflow: hidden;
    }
    .qc-track-fill {
      height: 100%;
      border-radius: 2px;
      transition: width .25s ease;
    }
    .qc-ptr-top {
      position: absolute;
      top: 0px;
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 5px solid #38bdf8;
      filter: drop-shadow(0 0 2px #38bdf8);
      transition: left .25s ease;
    }
    .qc-ptr-btm {
      position: absolute;
      bottom: 0px;
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-bottom: 5px solid #34d399;
      filter: drop-shadow(0 0 2px #34d399);
      transition: left .25s ease;
    }
    .qc-time { font-size: 10px; color: var(--c-key); display: flex; justify-content: space-between; margin-top: 1px; }
    .qc-foot { border-top: 1px solid var(--c-sep); margin-top: 8px; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--c-dim); }
    .token-cell { cursor: pointer; pointer-events: auto; }
    .token-cell:hover .v { text-decoration: underline; }
    .token-card {
      position: fixed;
      width: 250px;
      background: var(--c-panel);
      border: 1px solid var(--c-sep);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.55);
      padding: 10px 12px;
      font-family: "Google Sans Flex", system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      z-index: 2147483150;
      pointer-events: auto;
      color: var(--c-val);
      animation: qc-pop .18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--c-sep); margin-bottom: 8px; }
    .tc-title { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; color: var(--c-val); }
    .tc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-ok); }
    .tc-sess { font-size: 10px; color: var(--c-key); background: var(--c-hover); padding: 1px 6px; border-radius: 4px; font-family: monospace; }
    .tc-row { margin-bottom: 6px; padding: 5px 8px; background: var(--c-hover); border-radius: 6px; }
    .tc-row:last-child { margin-bottom: 0; }
    .tc-lbl-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; margin-bottom: 1px; }
    .tc-lbl { color: var(--c-val); font-weight: 500; display: flex; align-items: center; gap: 4px; }
    .tc-val { font-family: monospace; font-weight: bold; color: var(--c-ok); }
    .tc-time { font-size: 9.5px; color: var(--c-dim); }
    .tc-foot { border-top: 1px solid var(--c-sep); margin-top: 8px; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--c-dim); }
    .ic-bolt {
      color: var(--c-ok);
      transform-origin: center;
      transition: all .25s ease;
    }
    .ic-bolt.generating {
      animation: agy-bolt-pulse 1.3s infinite ease-in-out;
    }
    .ic-bolt.fast {
      color: #34a853;
      filter: drop-shadow(0 0 3px rgba(52, 168, 83, 0.6));
    }
    .ic-bolt.medium {
      color: #fbbc04;
      filter: drop-shadow(0 0 3px rgba(251, 188, 4, 0.6));
    }
    .ic-bolt.slow {
      color: #ea4335;
      filter: drop-shadow(0 0 3px rgba(234, 67, 53, 0.6));
    }
    @keyframes agy-bolt-pulse {
      0% { transform: scale(0.92); opacity: 0.65; filter: drop-shadow(0 0 1px currentColor); }
      50% { transform: scale(1.22); opacity: 1; filter: drop-shadow(0 0 5px currentColor); }
      100% { transform: scale(0.92); opacity: 0.65; filter: drop-shadow(0 0 1px currentColor); }
    }
    .err-badge {
      display: none; align-items: center; gap: 4px;
      font-size: 10px; padding: 1px 6px; border-radius: 4px;
      background: rgba(234, 67, 53, 0.18);
      color: #ea4335;
      border: 1px solid rgba(234, 67, 53, 0.35);
      cursor: default; pointer-events: auto;
      margin-left: 5px;
      animation: agy-pulse 1.8s infinite ease-in-out;
    }
    @keyframes agy-pulse {
      0% { transform: scale(0.85); opacity: 0.5; }
      50% { transform: scale(1.35); opacity: 1; filter: drop-shadow(0 0 3px currentColor); }
      100% { transform: scale(0.85); opacity: 0.5; }
    }
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
    .ring { width: 18px; height: 18px; flex: 0 0 18px; display: inline-block; vertical-align: middle; }
    .ring .tr { stroke: var(--c-sep); opacity: .55; }
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
  const I_QUOTA = () => icon(s => {
    s.appendChild(pth('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'));
    s.appendChild(pth('M12 7v5l3 2'));
    s.appendChild(pth('M8 17h8'));
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
  const I_LAYERS = () => icon(s => {
    s.appendChild(pth('M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'));
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

  /* ---- 通用圆环生成器 (统一 18x18px, R=5.4, 粗细 2.6px 加粗) ---- */
  const R = 5.4, C = 2 * Math.PI * R;
  function makeRing() {
    const ring = svgEl(16, 16);
    ring.setAttribute('class', 'ring');
    const rg = document.createElementNS(NS, 'g');
    rg.setAttribute('transform', 'rotate(-90 8 8)');
    const trk = document.createElementNS(NS, 'circle');
    trk.setAttribute('class', 'tr');
    ['cx:8', 'cy:8', `r:${R}`].forEach(a => { const [k, v] = a.split(':'); trk.setAttribute(k, v); });
    trk.setAttribute('fill', 'none');
    trk.setAttribute('stroke-width', '2.6');
    const fl = document.createElementNS(NS, 'circle');
    fl.setAttribute('class', 'fl');
    ['cx:8', 'cy:8', `r:${R}`].forEach(a => { const [k, v] = a.split(':'); fl.setAttribute(k, v); });
    fl.setAttribute('fill', 'none');
    fl.setAttribute('stroke-width', '2.6');
    fl.setAttribute('stroke-dasharray', String(C));
    fl.setAttribute('stroke-dashoffset', String(C));
    fl.setAttribute('stroke', 'var(--c-ok)');
    rg.appendChild(trk);
    rg.appendChild(fl);
    ring.appendChild(rg);
    return { ring, trk, fl };
  }

  function setRingProgress(flNode, v, t) {
    if (v === null || v === undefined) {
      flNode.setAttribute('stroke-dashoffset', String(C));
      flNode.setAttribute('stroke', 'var(--c-sep)');
      return;
    }
    const p = Math.max(0, Math.min(100, v));
    const draw = p > 0 && p < 2 ? 2 : p;
    flNode.setAttribute('stroke-dashoffset', String(C * (1 - draw / 100)));
    flNode.setAttribute('stroke', t === 'bad' ? 'var(--c-bad)' : t === 'warn' ? 'var(--c-warn)' : 'var(--c-ok)');
  }

  function sep() { const s = el('i', 'sep'); bar.appendChild(s); return s; }

  function cell(name, iconFn, cls) {
    const g = el('div', 'i');
    const ic = iconFn();
    g.appendChild(ic);
    g.appendChild(el('span', 'n', name));
    const v = el('span', 'v' + (cls ? ' ' + cls : ''), '—');
    g.appendChild(v);
    bar.appendChild(g);
    return { g, v, ic };
  }

  sep(); const cTok = cell('TOK', I_TOKEN, '');
  cTok.g.classList.add('token-cell');
  cTok.g.addEventListener('mouseenter', showTokenCard);
  cTok.g.addEventListener('mouseleave', scheduleCloseTokenCard);

  sep(); const cTps = cell('TPS', I_BOLT, '');
  cTps.ic.classList.add('ic-bolt');

  sep(); const cCtx = cell('CTX', I_LAYERS, '');

  sep(); const cCache = cell('HIT', I_CACHE, 'ok');

  /* ---- 账号切换项 (放置在 5小时额度左侧) ---- */
  sep();
  const gAcc = el('div', 'i acc');
  gAcc.appendChild(I_USER());
  gAcc.appendChild(el('span', 'n', 'ACC'));
  const vAcc = el('span', 'v', '—');
  gAcc.appendChild(vAcc);
  gAcc.addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePanel();
  });
  bar.appendChild(gAcc);

  /* ---- 额度单元格 (Scheme B: 5H+环+数值 · WK+环+数值，统一规格与颜色) ---- */
  sep();
  const cQuota = el('div', 'i quota-cell');
  cQuota.addEventListener('mouseenter', showQuotaCard);
  cQuota.addEventListener('mouseleave', scheduleCloseQuotaCard);

  const lblH5 = el('span', 'n', '5H');
  const ringH5 = makeRing();
  const vH5 = el('span', 'v', '—');

  const qSep = el('span', 'q-dot', '·');

  const lblWk = el('span', 'n', 'WK');
  const ringWk = makeRing();
  const vWk = el('span', 'v', '—');

  cQuota.appendChild(lblH5);
  cQuota.appendChild(ringH5.ring);
  cQuota.appendChild(vH5);
  cQuota.appendChild(qSep);
  cQuota.appendChild(lblWk);
  cQuota.appendChild(ringWk.ring);
  cQuota.appendChild(vWk);
  bar.appendChild(cQuota);

  const cErr = el('span', 'err-badge');
  bar.appendChild(cErr);

  /* ---- 额度悬停卡片与通用颜色 ---- */
  const COLOR_DEF = '#4ecb8a'; // 统一翡翠绿 (与上下文圆环及系统 ok 色统一)

  function getQuotaColor(val) {
    if (typeof val !== 'number' || !isFinite(val)) return COLOR_DEF;
    if (val < 20) return '#ef4444';
    if (val < 40) return '#f59e0b';
    return COLOR_DEF;
  }

  let quotaCard = null;
  let qcNodes = null;
  let cardTimer = null;
  let lastQuotaData = null;
  let lastH5Reset = '';
  let lastWkReset = '';

  function showQuotaCard() {
    if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; }
    if (!quotaCard || !quotaCard.isConnected) {
      quotaCard = el('div', 'quota-card');
      quotaCard.innerHTML = `
        <div class="qc-head">
          <div class="qc-title">
            <span class="qc-dot"></span>
            <span>配额使用明细</span>
          </div>
          <span class="qc-pool"></span>
        </div>
        <div class="qc-row">
          <div class="qc-lbl-row">
            <span class="qc-lbl">5 小时额度</span>
            <div class="qc-val-wrap">
              <span class="qc-h5-val qc-val"></span>
              <span class="qc-h5-used" style="font-size:9.5px;color:var(--c-dim);margin-left:4px;"></span>
            </div>
          </div>
          <div class="qc-track-wrap">
            <div class="qc-track-groove"><div class="qc-h5-fill qc-track-fill"></div></div>
            <div class="qc-h5-ptr qc-ptr-top"></div>
          </div>
          <div class="qc-time"><span>重置周期</span><span class="qc-h5-time"></span></div>
        </div>
        <div class="qc-row">
          <div class="qc-lbl-row">
            <span class="qc-lbl">每周额度</span>
            <div class="qc-val-wrap">
              <span class="qc-wk-val qc-val"></span>
              <span class="qc-wk-used" style="font-size:9.5px;color:var(--c-dim);margin-left:4px;"></span>
            </div>
          </div>
          <div class="qc-track-wrap">
            <div class="qc-track-groove"><div class="qc-wk-fill qc-track-fill"></div></div>
            <div class="qc-wk-ptr qc-ptr-btm"></div>
          </div>
          <div class="qc-time"><span>重置周期</span><span class="qc-wk-time"></span></div>
        </div>
        <div class="qc-foot">
          <span>状态: <strong class="qc-status"></strong></span>
          <span class="qc-acc"></span>
        </div>
      `;
      qcNodes = {
        dot: quotaCard.querySelector('.qc-dot'),
        pool: quotaCard.querySelector('.qc-pool'),
        h5Val: quotaCard.querySelector('.qc-h5-val'),
        h5Used: quotaCard.querySelector('.qc-h5-used'),
        h5Fill: quotaCard.querySelector('.qc-h5-fill'),
        h5Ptr: quotaCard.querySelector('.qc-h5-ptr'),
        h5Time: quotaCard.querySelector('.qc-h5-time'),
        wkVal: quotaCard.querySelector('.qc-wk-val'),
        wkUsed: quotaCard.querySelector('.qc-wk-used'),
        wkFill: quotaCard.querySelector('.qc-wk-fill'),
        wkPtr: quotaCard.querySelector('.qc-wk-ptr'),
        wkTime: quotaCard.querySelector('.qc-wk-time'),
        status: quotaCard.querySelector('.qc-status'),
        acc: quotaCard.querySelector('.qc-acc'),
      };
      root.appendChild(quotaCard);
      quotaCard.addEventListener('mouseenter', () => {
        if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; }
      });
      quotaCard.addEventListener('mouseleave', () => {
        scheduleCloseQuotaCard();
      });
    }
    renderQuotaCard();
    placeQuotaCard();
  }

  function scheduleCloseQuotaCard() {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => {
      closeQuotaCard();
    }, 150);
  }

  function closeQuotaCard() {
    if (quotaCard) {
      try { quotaCard.remove(); } catch (_) {}
      quotaCard = null;
      qcNodes = null;
    }
  }

  function placeQuotaCard() {
    if (!quotaCard || !cQuota) return;
    const r = cQuota.getBoundingClientRect();
    quotaCard.style.visibility = 'hidden';
    quotaCard.style.display = 'block';
    requestAnimationFrame(() => {
      if (!quotaCard) return;
      const cw = quotaCard.offsetWidth || 250;
      const ch = quotaCard.offsetHeight || 150;
      let left = r.left + r.width / 2 - cw / 2;
      let top = r.top - ch - 8;
      if (top < 8) top = r.bottom + 8;
      if (left < 8) left = 8;
      if (left + cw > window.innerWidth - 8) left = window.innerWidth - 8 - cw;
      quotaCard.style.left = Math.round(left) + 'px';
      quotaCard.style.top = Math.round(top) + 'px';
      quotaCard.style.visibility = 'visible';
    });
  }

  function renderQuotaCard() {
    if (!quotaCard || !qcNodes || !lastQuotaData) return;
    const x = lastQuotaData;
    const h5Val = typeof x.h5 === 'number' && isFinite(x.h5) ? Math.round(x.h5) : null;
    const wkVal = typeof x.wk === 'number' && isFinite(x.wk) ? Math.round(x.wk) : null;
    const colH5 = getQuotaColor(h5Val);
    const colWk = getQuotaColor(wkVal);

    qcNodes.dot.style.background = colH5;
    qcNodes.pool.textContent = x.model ? (x.model.length > 18 ? x.model.slice(0, 16) + '…' : x.model) : '当前配额池';

    // 5h 游标：精准骑在对应刻度百分比处，杜绝 0 像素假游标
    if (h5Val !== null) {
      qcNodes.h5Val.textContent = h5Val + '% 剩余';
      qcNodes.h5Val.style.color = colH5;
      qcNodes.h5Used.textContent = `(已用 ${100 - h5Val}%)`;
      qcNodes.h5Fill.style.width = h5Val + '%';
      qcNodes.h5Fill.style.backgroundColor = colH5;
      qcNodes.h5Ptr.style.display = 'block';
      qcNodes.h5Ptr.style.left = `calc(${h5Val}% - 3.5px)`;
      qcNodes.h5Ptr.style.borderTopColor = colH5;
      qcNodes.h5Ptr.style.filter = `drop-shadow(0 0 2px ${colH5})`;
    } else {
      qcNodes.h5Val.textContent = '无限制';
      qcNodes.h5Val.style.color = colH5;
      qcNodes.h5Used.textContent = '';
      qcNodes.h5Fill.style.width = '100%';
      qcNodes.h5Fill.style.backgroundColor = colH5;
      qcNodes.h5Ptr.style.display = 'none';
    }

    // Weekly 游标：精准骑在对应刻度百分比处
    if (wkVal !== null) {
      qcNodes.wkVal.textContent = wkVal + '% 剩余';
      qcNodes.wkVal.style.color = colWk;
      qcNodes.wkUsed.textContent = `(已用 ${100 - wkVal}%)`;
      qcNodes.wkFill.style.width = wkVal + '%';
      qcNodes.wkFill.style.backgroundColor = colWk;
      qcNodes.wkPtr.style.display = 'block';
      qcNodes.wkPtr.style.left = `calc(${wkVal}% - 3.5px)`;
      qcNodes.wkPtr.style.borderBottomColor = colWk;
      qcNodes.wkPtr.style.filter = `drop-shadow(0 0 2px ${colWk})`;
    } else {
      qcNodes.wkVal.textContent = '无限制';
      qcNodes.wkVal.style.color = colWk;
      qcNodes.wkUsed.textContent = '';
      qcNodes.wkFill.style.width = '100%';
      qcNodes.wkFill.style.backgroundColor = colWk;
      qcNodes.wkPtr.style.display = 'none';
    }

    // 缓存最新非空倒计时，防止交替 tick 时闪现「暂无」
    if (x.h5Reset) lastH5Reset = x.h5Reset;
    if (x.wkReset) lastWkReset = x.wkReset;
    qcNodes.h5Time.textContent = lastH5Reset ? `约 ${lastH5Reset} 后充值` : '充值倒计时暂无';
    qcNodes.wkTime.textContent = lastWkReset ? `约 ${lastWkReset} 后重置` : '重置倒计时暂无';

    let minVal = 100;
    if (h5Val !== null) minVal = Math.min(minVal, h5Val);
    if (wkVal !== null) minVal = Math.min(minVal, wkVal);
    if (minVal < 20) {
      qcNodes.status.textContent = '额度紧张';
      qcNodes.status.style.color = '#ef4444';
    } else if (minVal < 40) {
      qcNodes.status.textContent = '注意消耗';
      qcNodes.status.style.color = '#f59e0b';
    } else {
      qcNodes.status.textContent = '充裕可用';
      qcNodes.status.style.color = '#34d399';
    }
    qcNodes.acc.textContent = '账号: ' + (x.account ? shortEmail(x.account) : '—');
  }

  /* ---- Token 用量悬浮卡片 ---- */
  let tokenCard = null;
  let tcNodes = null;
  let tokenCardTimer = null;
  let lastTokenData = null;

  function formatTokenCount(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function showTokenCard() {
    if (tokenCardTimer) { clearTimeout(tokenCardTimer); tokenCardTimer = null; }
    if (!tokenCard || !tokenCard.isConnected) {
      tokenCard = el('div', 'token-card');
      tokenCard.innerHTML = `
        <div class="tc-head">
          <div class="tc-title">
            <span class="tc-dot"></span>
            <span>Token 用量统计</span>
          </div>
          <span class="tc-sess">多会话累计</span>
        </div>
        <div class="tc-row">
          <div class="tc-lbl-row">
            <span class="tc-lbl">月用量</span>
            <span class="tc-month-val tc-val">—</span>
          </div>
          <div class="tc-time">每月1号0点刷新统计</div>
        </div>
        <div class="tc-row">
          <div class="tc-lbl-row">
            <span class="tc-lbl">周用量</span>
            <span class="tc-week-val tc-val">—</span>
          </div>
          <div class="tc-time">周一0点刷新统计</div>
        </div>
        <div class="tc-row">
          <div class="tc-lbl-row">
            <span class="tc-lbl">日用量</span>
            <span class="tc-day-val tc-val">—</span>
          </div>
          <div class="tc-time">每日0点刷新统计</div>
        </div>
        <div class="tc-foot">
          <span>当前会话: <strong class="tc-cur-val" style="color:var(--c-val);font-family:monospace;">—</strong></span>
          <span>全量 Brain 汇总</span>
        </div>
      `;
      tcNodes = {
        monthVal: tokenCard.querySelector('.tc-month-val'),
        weekVal: tokenCard.querySelector('.tc-week-val'),
        dayVal: tokenCard.querySelector('.tc-day-val'),
        curVal: tokenCard.querySelector('.tc-cur-val'),
      };
      root.appendChild(tokenCard);
      tokenCard.addEventListener('mouseenter', () => {
        if (tokenCardTimer) { clearTimeout(tokenCardTimer); tokenCardTimer = null; }
      });
      tokenCard.addEventListener('mouseleave', () => {
        scheduleCloseTokenCard();
      });
    }
    renderTokenCard();
    placeTokenCard();
  }

  function scheduleCloseTokenCard() {
    if (tokenCardTimer) clearTimeout(tokenCardTimer);
    tokenCardTimer = setTimeout(() => {
      closeTokenCard();
    }, 150);
  }

  function closeTokenCard() {
    if (tokenCard) {
      try { tokenCard.remove(); } catch (_) {}
      tokenCard = null;
      tcNodes = null;
    }
  }

  function placeTokenCard() {
    if (!tokenCard || !cTok || !cTok.g) return;
    const r = cTok.g.getBoundingClientRect();
    tokenCard.style.visibility = 'hidden';
    tokenCard.style.display = 'block';
    requestAnimationFrame(() => {
      if (!tokenCard) return;
      const cw = tokenCard.offsetWidth || 250;
      const ch = tokenCard.offsetHeight || 180;
      let left = r.left + r.width / 2 - cw / 2;
      let top = r.top - ch - 8;
      if (top < 8) top = r.bottom + 8;
      if (left < 8) left = 8;
      if (left + cw > window.innerWidth - 8) left = window.innerWidth - 8 - cw;
      tokenCard.style.left = Math.round(left) + 'px';
      tokenCard.style.top = Math.round(top) + 'px';
      tokenCard.style.visibility = 'visible';
    });
  }

  function renderTokenCard() {
    if (!tokenCard || !tcNodes || !lastTokenData) return;
    const u = lastTokenData.tokenUsage || {};
    tcNodes.monthVal.textContent = formatTokenCount(u.month);
    tcNodes.weekVal.textContent = formatTokenCount(u.week);
    tcNodes.dayVal.textContent = formatTokenCount(u.day);
    tcNodes.curVal.textContent = cTok.v.textContent || '—';
  }

  /* ---- 数据平滑记忆与切号防抖 ---- */
  let lastValidH5 = null;
  let lastValidWk = null;
  let lastValidTps = null;
  let lastValidTtft = null;
  let lastValidTpsAt = 0;

  /* ---- 账号项（可点击，弹账号面板）----
   * 免 fetch 通道：accounts 数据由 sidecar 在 payload 下行；点击把
   * pendingSwitch 写到 window.__AGY_MINIBAR.pendingSwitch，由 sidecar 下一轮读走执行。
   */
  let accData = null;   // payload.accounts 快照
  let switchState = ''; // '' | 'pending' | 'ok' | 'fail:msg'
  function ensureAccountCell() {} // 账号项已在主布局中于 5h 额度左侧静态就位

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
      const dot = el('span', 'p-dot' + (a.isCurrent ? ' ok' : ''));
      const mailWrap = el('span', 'p-mailwrap');
      const mail = el('span', 'p-mail', a.email);
      mailWrap.appendChild(mail);
      if (typeof a.geminiWeekly === 'number') {
        const qTag = el('span', 'p-quota', '周' + Math.round(a.geminiWeekly) + '%');
        if (a.quotaSource === 'captured') {
          const ageDays = a.quotaUpdatedAt ? Math.floor((Date.now() - a.quotaUpdatedAt) / 86400000) : null;
          qTag.title = '切换时捕获的实时配额' + (ageDays !== null && ageDays > 0 ? '（' + (ageDays === 0 ? '今天' : ageDays + ' 天前') + '）' : '') + '；周额度 7 天重置';
        } else if (a.quotaSource === 'cache') {
          const ageDays = a.quotaUpdatedAt ? Math.floor((Date.now() - a.quotaUpdatedAt) / 86400000) : null;
          qTag.title = 'IDE 缓存快照' + (ageDays !== null && ageDays > 0 ? '（' + ageDays + ' 天前）' : '') + '，非实时；周额度通常 7 天重置';
        } else {
          qTag.title = '实时配额（当前账号）';
        }
        qTag.title = 'IDE 缓存的 Gemini 周额度剩余';
        mailWrap.appendChild(qTag);
      }
      let tagText = a.isCurrent ? '当前' : '切号';
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
          vAcc.textContent = shortEmail(a.email) + '…';
          vAcc.style.opacity = '0.75';
          // 若点击的目标账号有缓存额度，立即平滑预填圆环，杜绝数据跳变
          if (typeof a.gemini5h === 'number' && typeof a.geminiWeekly === 'number') {
            lastValidH5 = Math.round(a.gemini5h);
            lastValidWk = Math.round(a.geminiWeekly);
            const tH5 = lastValidH5 < 20 ? 'bad' : lastValidH5 < 40 ? 'warn' : '';
            const tWk = lastValidWk < 20 ? 'bad' : lastValidWk < 40 ? 'warn' : '';
            setRingProgress(ringH5.fl, lastValidH5, tH5);
            setRingProgress(ringWk.fl, lastValidWk, tWk);
            vH5.textContent = pct(lastValidH5);
            tone(vH5, tH5);
            vWk.textContent = pct(lastValidWk);
            tone(vWk, tWk);
          }
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
    if (quotaCard && !host.contains(e.target)) closeQuotaCard();
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

  function setRing() {}

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
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); if (quotaCard) placeQuotaCard(); if (tokenCard) placeTokenCard(); }); };
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });

  function update(d) {
    if (window.__AGY_MINIBAR && window.__AGY_MINIBAR.frozen) return { ok: true, frozen: true, mounted: host.isConnected, convId: typeof d.convId === 'string' ? d.convId : '' };
    const x = d || {};
    dedupe();
    if (!host.isConnected) mount(); else place();

    // 缓存上游有效数据，用于瞬态平滑锁定
    if (typeof x.h5 === 'number' && isFinite(x.h5)) lastValidH5 = Math.round(x.h5);
    if (typeof x.wk === 'number' && isFinite(x.wk)) lastValidWk = Math.round(x.wk);
    if (typeof x.tps === 'number' && isFinite(x.tps) && x.tps > 0) {
      lastValidTps = x.tps;
      lastValidTpsAt = Date.now();
      if (x.ttft) lastValidTtft = x.ttft;
    }

    // 上下文展示（[图层图标] + "上下文" + 百分比数值，按 256k 压缩线分级预警变色）
    const comp = typeof x.compactPct === 'number' && isFinite(x.compactPct) ? x.compactPct : null;
    const t = comp === null ? '' : comp >= 92 ? 'bad' : comp >= 80 ? 'warn' : '';
    const usedTok = x.contextUsed || 0;
    const limitTok = x.modelLimit || 1048576;
    const usedStr = (usedTok >= 1e6 ? (usedTok / 1e6).toFixed(2) + 'M' : (usedTok >= 1000 ? (usedTok / 1000).toFixed(0) + 'k' : (usedTok > 0 ? String(usedTok) : '—')));
    cCtx.v.textContent = pct(x.ctxPct);
    tone(cCtx.v, t);
    const limitStr = (limitTok >= 1e6 ? (limitTok / 1e6).toFixed(1) + 'M' : (limitTok / 1000).toFixed(0) + 'k');
    cCtx.g.title = `上下文窗口: ${usedStr} / ${limitStr} (${pct(x.ctxPct)}) | 自动压缩线: 256k (${pct(x.compactPct)})`;

    // 缓存时效颜色预警（距上一轮对话时长）
    cCache.v.textContent = pct(x.cachePct);
    const ageSec = typeof x.cacheAgeSec === 'number' ? x.cacheAgeSec : 0;
    if (ageSec >= 240) {
      cCache.v.className = 'v bad';
      cCache.g.title = `缓存命中率 ${pct(x.cachePct)} | 缓存已过期 (距上一轮 ${Math.floor(ageSec / 60)} 分钟，下一次提问将全量Prefill)`;
    } else if (ageSec >= 180) {
      cCache.v.className = 'v warn';
      cCache.g.title = `缓存命中率 ${pct(x.cachePct)} | 缓存即将失效 (距上一轮 ${Math.floor(ageSec / 60)} 分钟，满4分钟失效)`;
    } else {
      cCache.v.className = 'v ok';
      cCache.g.title = `缓存命中率 ${pct(x.cachePct)} | 缓存处于新鲜期`;
    }
    // Token 合计：本会话累计 (input + cache_read + output)，M 单位
    cTok.v.textContent = typeof x.tokensM === 'number' && isFinite(x.tokensM) && x.tokensM > 0
      ? (x.tokensM >= 10 ? x.tokensM.toFixed(1) + 'M' : (x.tokensM < 0.01 ? (x.tokensM * 1000).toFixed(0) + 'k' : x.tokensM.toFixed(2) + 'M'))
      : '—';
    lastTokenData = x;
    if (tokenCard && tokenCard.isConnected) renderTokenCard();

    // TPS 呼吸图标动效与状态（闪电图标直接呼吸，去除中间冗余圆点）
    const isGen = Boolean(x.isGenerating);
    let tpsVal = typeof x.tps === 'number' && isFinite(x.tps) ? x.tps : 0;
    const isSwitching = switchState === 'pending' || Boolean(switchingTarget);
    // 切号或瞬态波动（12秒内）继承上一轮有效 TPS，防止瞬间掉成「—」
    if (tpsVal <= 0 && (isSwitching || (Date.now() - lastValidTpsAt < 12000)) && lastValidTps > 0) {
      tpsVal = lastValidTps;
    }

    let speedTier = 'fast';
    if (tpsVal > 0 && tpsVal < 12) speedTier = 'slow';
    else if (tpsVal >= 12 && tpsVal < 30) speedTier = 'medium';

    if (isGen) {
      cTps.ic.setAttribute('class', `ic ic-bolt generating ${speedTier}`);
    } else if (tpsVal > 0) {
      cTps.ic.setAttribute('class', `ic ic-bolt ${speedTier}`);
    } else {
      cTps.ic.setAttribute('class', 'ic ic-bolt');
    }

    // TPS = 纯解码速度（output_tokens / streaming_seconds），与 DSH 下方 tok/s 同口径
    cTps.v.textContent = tpsVal > 0 ? tpsVal.toFixed(0) : '—';
    const statusText = isGen ? '正在生成... ' : '';
    const effTtft = x.ttft || lastValidTtft;
    if (effTtft) cTps.g.title = statusText + '纯生成速度 ' + (tpsVal > 0 ? tpsVal.toFixed(1) : '—') + ' tok/s | 首字响应 ' + effTtft.toFixed(2) + 's' + (x.model ? ' (' + x.model + ')' : '');
    else if (x.model) cTps.g.title = statusText + '模型: ' + x.model + (tpsVal > 0 ? ' (' + tpsVal.toFixed(1) + ' tok/s)' : '');

    // 账号项：显示 payload 下行的账号与账号列表快照
    ensureAccountCell();
    if (switchState === 'pending' && switchingTarget) {
      vAcc.textContent = shortEmail(switchingTarget) + '…';
      vAcc.style.opacity = '0.75';
    } else if (x.account) {
      vAcc.textContent = shortEmail(x.account);
      vAcc.style.opacity = '1';
    } else {
      vAcc.textContent = '—';
      vAcc.style.opacity = '1';
    }
    accData = Array.isArray(x.accounts) ? x.accounts : null;
    if (x.switchResult) {
      // sidecar 回填的切换结果
      switchState = x.switchResult.ok ? 'ok' : 'fail:' + (x.switchResult.error || '');
      if (x.switchResult.ok) {
        vAcc.textContent = shortEmail(x.switchResult.email);
        vAcc.style.opacity = '1';
        switchingTarget = '';
        if (window.__AGY_MINIBAR) window.__AGY_MINIBAR.pendingSwitch = null;
      } else {
        vAcc.style.opacity = '1';
      }
      // 3 秒后清除结果态
      setTimeout(() => { switchState = ''; switchingTarget = ''; if (panel) renderPanel(); }, 3000);
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
    lastQuotaData = x;
    if (quotaCard) renderQuotaCard();

    // 整合额度展示：Scheme B (5h+加粗环+数值 · 周+加粗环+数值，统一翡翠绿与阈值变色)
    let h5Val = typeof x.h5 === 'number' && isFinite(x.h5) ? Math.round(x.h5) : null;
    let wkVal = typeof x.wk === 'number' && isFinite(x.wk) ? Math.round(x.wk) : null;
    // 切号或 LS 重启瞬态为 null 时无缝继承上一轮有效额度，杜绝圆环归零/闪烁
    if (h5Val === null && lastValidH5 !== null) h5Val = lastValidH5;
    if (wkVal === null && lastValidWk !== null) wkVal = lastValidWk;

    const tH5 = h5Val === null ? '' : h5Val < 20 ? 'bad' : h5Val < 40 ? 'warn' : '';
    const tWk = wkVal === null ? '' : wkVal < 20 ? 'bad' : wkVal < 40 ? 'warn' : '';

    setRingProgress(ringH5.fl, h5Val, tH5);
    setRingProgress(ringWk.fl, wkVal, tWk);

    vH5.textContent = pct(h5Val);
    tone(vH5, tH5);

    vWk.textContent = pct(wkVal);
    tone(vWk, tWk);
    cQuota.removeAttribute('title');

    // 异常主动捕获与轻量报警 Badge
    if (x.errorNotice && x.errorNotice.badge) {
      cErr.style.display = 'inline-flex';
      cErr.textContent = '⚠️ ' + x.errorNotice.badge;
      cErr.title = x.errorNotice.detail || x.errorNotice.badge;
    } else {
      cErr.style.display = 'none';
    }

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
    unmount() { closeQuotaCard(); closeTokenCard(); try { host.remove(); } catch (_) {} },
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
