#!/usr/bin/env node
/**
 * Antigravity MiniBar 一站式部署与升级自检修复工具 (setup.mjs)
 *
 * 覆盖四项能力（全部零第三方 npm 依赖）：
 * 1. 插件本体部署与启用 (agy-minibar -> ~/.gemini/config/plugins/agy-minibar)
 * 2. 全局规则配置       (toolkit/rules/global-rules.md -> ~/.gemini/config/rules/global-rules.md)
 * 3. 桌面端中文汉化     (app.asar dist/preload.js 独立注入，可随时卸载还原)
 * 4. 系统增强中心       (language_server / agy 0~4 档提示词精简 + 自动中文标题)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  inspectAsarChinese,
  patchAsarChinese,
  restoreAsarChinese
} from './lib/asar-engine.mjs';
import {
  applyEnhancePatch,
  getEnhanceStatus,
  isSupportedEnhancePlatform,
  restoreAllEnhance
} from './lib/enhance-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    mode: 'auto', // 'auto' (--all) | 'status' | 'restore' | 'selective' | 'menu'
    plugin: false,
    rules: false,
    i18n: false,
    enhance: false,
    tier: '4',
    title: 'on',
    brand: 'english',
    asarPath: null,
    force: false,
    removeRules: false,
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--menu') opts.mode = 'menu';
    else if (a === '--status') opts.mode = 'status';
    else if (a === '--restore' || a === '--uninstall') opts.mode = 'restore';
    else if (a === '--all') opts.mode = 'all';
    else if (a === '--plugin') { opts.plugin = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--rules') { opts.rules = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--i18n' || a === '--chinese') { opts.i18n = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--enhance') { opts.enhance = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--tier' && i + 1 < argv.length) { opts.tier = argv[++i]; opts.enhance = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--title' && i + 1 < argv.length) { opts.title = argv[++i]; opts.enhance = true; if (opts.mode === 'auto') opts.mode = 'selective'; }
    else if (a === '--brand' && i + 1 < argv.length) opts.brand = argv[++i];
    else if (a === '--asar' && i + 1 < argv.length) opts.asarPath = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--remove-rules') opts.removeRules = true;
    else if (a === '--json') opts.json = true;
  }

  if (opts.mode === 'auto' || opts.mode === 'all') {
    opts.mode = 'all';
    opts.plugin = true;
    opts.rules = true;
    opts.i18n = true;
    opts.enhance = true;
  }
  return opts;
}

function printHelp() {
  console.log(`Antigravity MiniBar 一站式工具包 (toolkit/setup.mjs)

用法:
  node toolkit/setup.mjs [选项]

常用模式:
  (默认 / --all)       一键部署与修复: MiniBar 插件 + 全局规则 + 界面汉化 + 4档提示词&中文标题
  --status             查看插件、全局规则、汉化与内核增强状态（支持识别客户端升级覆盖）
  --restore            还原客户端改动（卸载 app.asar 汉化 + 内核退回 0 档英文标题）

按需单项执行:
  --plugin             仅部署/同步 agy-minibar 插件并确保在 config.json 中启用
  --rules              仅部署 toolkit/rules/global-rules.md 到 ~/.gemini/config/rules/
  --i18n               仅向 Antigravity app.asar 注入桌面端汉化
  --enhance            仅应用系统增强（可搭配 --tier <0|1|2|3|4> 和 --title <on|off>）

附加选项:
  --tier <0..4>        指定提示词档位（默认 4：精简+防幻觉推荐）
  --title <on|off>     开启/关闭自动中文会话与章节标题（默认 on）
  --asar <path>        手动指定 app.asar 路径
  --force              强制重写已有汉化或覆盖已修改的 global-rules.md
  --remove-rules       配合 --restore 一并移除 global-rules.md
  --json               配合 --status 输出 JSON
  -h, --help           显示此帮助
`);
}

function getGeminiConfigDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'config');
}

function copyDirFiltered(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const skipNames = new Set(['.git', 'node_modules', 'minibar.log', 'accounts.json', 'accounts.json.tmp', 'live-quota.json']);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name) || entry.name.endsWith('.log') || entry.name.endsWith('.lock') || entry.name.endsWith('.tmp')) {
      continue;
    }
    const srcP = path.join(srcDir, entry.name);
    const dstP = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(srcP, dstP);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcP, dstP);
    }
  }
}

export function deployPlugin(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const cfgDir = getGeminiConfigDir(homeDir);
  const targetPluginDir = path.join(cfgDir, 'plugins', 'agy-minibar');
  const srcRoot = options.repoRoot || REPO_ROOT;

  const normSrc = path.resolve(srcRoot).toLowerCase();
  const normDst = path.resolve(targetPluginDir).toLowerCase();
  let filesCopied = false;

  if (normSrc !== normDst) {
    fs.mkdirSync(targetPluginDir, { recursive: true });
    const manifestSrc = path.join(srcRoot, 'plugin.json');
    if (fs.existsSync(manifestSrc)) {
      fs.copyFileSync(manifestSrc, path.join(targetPluginDir, 'plugin.json'));
    }
    const sidecarsSrc = path.join(srcRoot, 'sidecars');
    if (fs.existsSync(sidecarsSrc)) {
      copyDirFiltered(sidecarsSrc, path.join(targetPluginDir, 'sidecars'));
    }
    const toolkitSrc = path.join(srcRoot, 'toolkit');
    if (fs.existsSync(toolkitSrc)) {
      copyDirFiltered(toolkitSrc, path.join(targetPluginDir, 'toolkit'));
    }
    filesCopied = true;
  }

  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};

  const prevEnabled = cfg.plugins['agy-minibar']?.enabled === true;
  if (!prevEnabled) {
    cfg.plugins['agy-minibar'] = { ...(cfg.plugins['agy-minibar'] || {}), enabled: true };
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }

  return {
    ok: true,
    targetPluginDir,
    filesCopied,
    configUpdated: !prevEnabled,
    message: filesCopied
      ? `已同步插件到 ${targetPluginDir}${!prevEnabled ? ' 并启用' : ''}`
      : `插件已在目标目录运行${!prevEnabled ? '，已写入启用标记' : '（已启用）'}`
  };
}

export function deployGlobalRules(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const srcRule = options.rulesSource || path.join(__dirname, 'rules', 'global-rules.md');
  const dstRule = path.join(getGeminiConfigDir(homeDir), 'rules', 'global-rules.md');
  if (!fs.existsSync(srcRule)) {
    throw new Error(`未找到全局规则模板: ${srcRule}`);
  }
  const srcText = fs.readFileSync(srcRule, 'utf8');
  if (fs.existsSync(dstRule)) {
    const curText = fs.readFileSync(dstRule, 'utf8');
    if (curText === srcText) {
      return { ok: true, changed: false, path: dstRule, message: '全局规则已存在且内容一致（无需更新）' };
    }
    if (!options.force) {
      return {
        ok: true,
        changed: false,
        skippedCustom: true,
        path: dstRule,
        message: '检测到已存在自定义 global-rules.md，已保留当前文件（如需覆盖请加 --force）'
      };
    }
  }
  fs.mkdirSync(path.dirname(dstRule), { recursive: true });
  fs.writeFileSync(dstRule, srcText, 'utf8');
  return { ok: true, changed: true, path: dstRule, message: `已写入全局规则: ${dstRule}` };
}

export function collectFullStatus(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const cfgDir = getGeminiConfigDir(homeDir);
  const pluginDir = path.join(cfgDir, 'plugins', 'agy-minibar');
  const pluginManifest = path.join(pluginDir, 'plugin.json');
  const cfgPath = path.join(cfgDir, 'config.json');
  let pluginEnabled = false;
  let pluginVersion = null;
  if (fs.existsSync(pluginManifest)) {
    try { pluginVersion = JSON.parse(fs.readFileSync(pluginManifest, 'utf8')).version || null; } catch {}
  }
  if (fs.existsSync(cfgPath)) {
    try { pluginEnabled = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.plugins?.['agy-minibar']?.enabled === true; } catch {}
  }

  const rulePath = path.join(cfgDir, 'rules', 'global-rules.md');
  const asar = inspectAsarChinese({ asarPath: options.asarPath, homeDir });
  const enhance = getEnhanceStatus({ homeDir });

  return {
    ok: true,
    plugin: {
      installed: fs.existsSync(pluginManifest),
      enabled: pluginEnabled,
      version: pluginVersion,
      dir: pluginDir
    },
    rules: {
      installed: fs.existsSync(rulePath),
      path: rulePath
    },
    i18n: asar,
    enhance
  };
}

function printHumanStatus(st) {
  console.log('=== Antigravity MiniBar 一站式环境状态 ===');
  console.log(`1. MiniBar 插件 : ${st.plugin.installed ? `已安装 (v${st.plugin.version || '?'})` : '未安装'} · ${st.plugin.enabled ? '已启用' : '未启用'} (${st.plugin.dir})`);
  console.log(`2. 全局规则     : ${st.rules.installed ? '已部署' : '未部署'} (${st.rules.path})`);
  if (!st.i18n.found) {
    console.log('3. 桌面端汉化   : 未检测到 app.asar');
  } else {
    console.log(`3. 桌面端汉化   : ${st.i18n.injected ? '已汉化' : '未汉化 (可能被官方升级覆盖)'} · 备份=${st.i18n.bakExists ? '有' : '无'} (${st.i18n.asarPath})`);
  }
  if (!st.enhance.supported) {
    console.log(`4. 系统增强中心 : ${st.enhance.reason}`);
  } else {
    const s = st.enhance.summary;
    console.log(`4. 系统增强中心 : ${s.promptLabel} | ${s.chineseTitleLabel} | 备份=${s.allBackedUp ? '完整' : '缺失'}${s.clientUpdatedSinceSave ? ' | ⚠ 检测到客户端已升级' : ''}`);
    for (const b of st.enhance.binaries) {
      if (!b.exists) continue;
      console.log(`   - ${b.label}: ${b.error ? `异常(${b.error})` : `${b.promptLabel} · ${b.chineseTitleLabel} (节省 ${b.savedBytes}B)`}`);
    }
  }
}

function isAntigravityRunningWin() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.toLowerCase().includes('antigravity.exe');
  } catch {
    return false;
  }
}

async function askQuestion(rl, promptText) {
  return new Promise((resolve) => rl.question(promptText, resolve));
}

async function runInteractiveMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('============================================================');
    console.log('  Antigravity MiniBar 一站式安装与升级修复工具');
    console.log('  包含：MiniBar插件 / 全局规则 / 界面汉化 / 4档增强与中文标题');
    console.log('============================================================');
    console.log('');
    console.log('  [1] 一键安装 / 升级后全量修复 (推荐)');
    console.log('  [2] 仅查看当前状态');
    console.log('  [3] 仅修复界面汉化与内核增强 (升级后常用)');
    console.log('  [4] 还原客户端英文界面与 0 档原版内核');
    console.log('  [0] 退出');
    console.log('');
    const raw = await askQuestion(rl, '请输入选项 [默认 1]: ');
    const choice = (raw || '').trim() || '1';
    if (choice === '0') return 0;

    let targetArgs = null;
    if (choice === '1') targetArgs = ['--all'];
    else if (choice === '2') targetArgs = ['--status'];
    else if (choice === '3') targetArgs = ['--i18n', '--enhance'];
    else if (choice === '4') targetArgs = ['--restore'];
    else {
      console.log('[提示] 无效选项，已退出。');
      return 1;
    }

    if (choice !== '2' && isAntigravityRunningWin()) {
      console.log('');
      console.log('[提示] 检测到 Antigravity.exe 仍在运行（包含后台/托盘进程），这会锁定 app.asar 导致汉化写入失败。');
      const ans = await askQuestion(rl, '是否现在关闭 Antigravity.exe 后继续？[y/N]: ');
      if (['y', 'yes'].includes(ans.trim().toLowerCase())) {
        try {
          execFileSync('taskkill', ['/IM', 'Antigravity.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
          await new Promise((r) => setTimeout(r, 800));
          console.log('[完成] 已关闭 Antigravity.exe，继续执行...');
        } catch (err) {
          console.warn(`[警告] 关闭进程未完全成功: ${err.message}`);
        }
      }
    }

    console.log('');
    return await runCli(targetArgs);
  } finally {
    rl.close();
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.mode === 'menu') {
    return await runInteractiveMenu();
  }

  if (opts.mode === 'status') {
    const st = collectFullStatus(opts);
    if (opts.json) console.log(JSON.stringify(st, null, 2));
    else printHumanStatus(st);
    return 0;
  }

  if (opts.mode === 'restore') {
    console.log('=== 开始还原 Antigravity 客户端修改 ===');
    let hasError = false;
    try {
      const asarRes = restoreAsarChinese({ asarPath: opts.asarPath });
      console.log(`[汉化还原] ${asarRes.message}`);
    } catch (err) {
      hasError = true;
      console.error(`[汉化还原失败] ${err.message}`);
    }
    if (isSupportedEnhancePlatform()) {
      const enhRes = restoreAllEnhance();
      if (!enhRes.ok) {
        hasError = true;
        console.error(`[内核还原失败] ${enhRes.error}`);
      } else {
        for (const l of enhRes.logs) console.log(l);
      }
    }
    if (opts.removeRules) {
      const rp = path.join(getGeminiConfigDir(), 'rules', 'global-rules.md');
      if (fs.existsSync(rp)) {
        fs.unlinkSync(rp);
        console.log(`[全局规则] 已删除 ${rp}`);
      }
    }
    console.log(hasError ? '⚠ 还原过程存在错误，请查看上方提示。' : '✅ 还原完成，请重启 Antigravity 客户端生效。');
    return hasError ? 1 : 0;
  }

  console.log('=== Antigravity MiniBar 一站式安装与修复 ===');
  let hasError = false;

  if (opts.plugin) {
    try {
      const res = deployPlugin();
      console.log(`[插件] ${res.message}`);
    } catch (err) {
      hasError = true;
      console.error(`[插件失败] ${err.message}`);
    }
  }

  if (opts.rules) {
    try {
      const res = deployGlobalRules({ force: opts.force });
      console.log(`[规则] ${res.message}`);
    } catch (err) {
      hasError = true;
      console.error(`[规则失败] ${err.message}`);
    }
  }

  if (opts.i18n) {
    try {
      const res = patchAsarChinese({ asarPath: opts.asarPath, brandTitle: opts.brand, force: opts.force });
      console.log(`[汉化] ${res.message}`);
    } catch (err) {
      hasError = true;
      console.error(`[汉化失败] ${err.message}`);
    }
  }

  if (opts.enhance) {
    if (!isSupportedEnhancePlatform()) {
      console.log('[增强] 当前系统平台暂不支持内核二进制补丁，已跳过。');
    } else {
      const res = applyEnhancePatch({ promptTier: opts.tier, chineseTitle: opts.title });
      if (!res.ok) {
        hasError = true;
        console.error(`[增强失败] ${res.error}`);
      } else {
        for (const l of res.logs) console.log(l);
      }
    }
  }

  console.log(hasError
    ? '⚠ 部分步骤未完成（若提示文件被占用，请先完全退出 Antigravity 后重试）。'
    : '✅ 全部选定项目处理完成！如改动了汉化或内核，请重启一次 Antigravity 生效。');
  return hasError ? 1 : 0;
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  runCli().then((code) => { process.exitCode = code; });
}
