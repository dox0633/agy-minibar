/**
 * MiniBar IDE 配额桥 —— 从 Antigravity IDE 的 state.vscdb 读取 Kite 扩展
 * 缓存的各账号配额数据（Gemini/Claude 的 5h 与周额度剩余）。
 * 用途：账号面板里显示每个账号的额度概况。只读。
 * 本文件为 CommonJS（.cjs），因 node:sqlite 在 .mjs 顶层 import 会触发
 * ExperimentalWarning 且模块类型与插件目录（无 package.json type 字段）冲突。
 */

const { homedir } = require('node:os');
const { join } = require('node:path');
const { existsSync } = require('node:fs');

let cached = { at: 0, data: null };

function vscdbPath() {
  const home = homedir();
  const cands = [
    join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    join(home, '.antigravity-ide', 'globalStorage', 'state.vscdb'),
  ];
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

function readIdeQuotaCache() {
  const now = Date.now();
  if (cached.data && now - cached.at < 60_000) return cached.data;

  const dbPath = vscdbPath();
  if (!dbPath) { cached = { at: now, data: {} }; return cached.data; }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'soulvon.antigravity-kite'").get();
    db.close();
    if (!row) { cached = { at: now, data: cached.data || {} }; return cached.data; }
    const kite = JSON.parse(String(row.value));
    const uc = kite.usageCache || {};
    const out = {};
    for (const [k, v] of Object.entries(uc)) {
      if (!v || typeof v !== 'object' || !Array.isArray(v.models)) continue;
      // 键即完整邮箱（如 "user@gmail.com"）；去掉可能的 "usageCache." 前缀
      const email = String(k.replace(/^usageCache\./, '')).toLowerCase();
      const models = {};
      for (const m of v.models) {
        if (m.modelId) models[m.modelId] = { remaining: m.remainingPercent, resetTime: m.resetTime, label: m.label };
      }
      out[email] = { tier: v.tierId || '', updatedAt: v.updatedAt || 0, models };
    }
    cached = { at: now, data: out };
    return out;
  } catch {
    // IDE 数据库被锁或 Kite 数据缺失：保留旧缓存
    cached = { at: now, data: cached.data || {} };
    return cached.data;
  }
}

module.exports = { readIdeQuotaCache };
