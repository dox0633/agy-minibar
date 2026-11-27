/**
 * Antigravity 内核提示词精简、防幻觉护栏与中文会话标题独立引擎 (enhance-core.mjs)
 *
 * 致敬与来源（MIT License）：
 * - 核心 Go embed.FS 系统提示词槽位解析、0~4 档精简架构、v2.29+ applyEdits 绕过及等长中文标题规则
 *   源自 elviscjn-cjn/antigravity-context-viewer 与 GitHub PR #4 (@Jia131313)。
 * - 本模块为 agy-minibar 精简剥离版：移除上下文解锁/代理/外部状态依赖，仅保留纯本地提示词精简与中文标题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isMachO64Buffer,
  parseMachO64,
  getMachODataSearchRanges,
  atomicWriteMachOBinarySync
} = require('./macos-binary-utils.cjs');

// ============================================================================
// 提示词载荷定义（严格控制在 Desktop / CLI / IDE 最小槽位字节上限内）
// ============================================================================

const TIER3_GUIDELINES = [
  'Follow these core engineering mandates at all times:',
  '- **Evidence-First Grounding**: Never treat caller call-sites, comments, summaries, or mocks as proof an API or symbol exists. Before modifying or explaining unfamiliar behavior, inspect the source via `read_file` or `run_command`. If unverified, state it explicitly.',
  '- **Surgical Minimal Scope**: Keep edits tight to the stated task. Reuse existing mechanisms; avoid speculative abstractions or unrequested defensive bloat. Clarify genuine ambiguities with `ask_question`.',
  '- **Boundary Integrity**: Never bypass access controls, permissions, or sandbox limits; if blocked, report and stop.'
].join('\n');

const TIER3_FUNCTION_CALL = [
  '- **Clean Tool Turns**: Emit tool calls directly without filler preambles or trailing colons (do not write "Let me read the file:" before a tool call).',
  '- **Parallel Reads, Sequential Edits**: Batch independent `read_file` or read-only `run_command` calls in one turn; edit a file sequentially across turns after reading the target block.',
  '- **Reactive Wakeup (No Polling)**: Background `run_command` and `invoke_subagent` tasks wake you on completion. NEVER run shell `sleep` or polling loops.'
].join('\n');

const TIER3_COMMUNICATION_STYLE = [
  '## Intent & Execution Discipline',
  '- Distinguish **Inquiries** (questions, reviews, RCA) from **Directives** (requests to change files or run commands):',
  '  - **Inquiries**: Answer cleanly in chat; do NOT edit workspace files.',
  '  - **Directives**: Execute end-to-end (inspect -> edit -> verify with `run_command`) without asking permission on reversible steps.',
  '',
  '## Native Tool Contracts',
  '- **Direct Delivery First**: Deliver explanations, diffs, and short reports directly in chat; create artifacts only when structured long-form reports or user deliverables genuinely benefit.',
  '- **`edit_file` Exactness**: `edit_file` replaces every match of `Target`. Include 3-5 lines of surrounding context so `Target` matches one unique location.',
  '- **Native File Tools First**: Prefer `read_file`, `edit_file`, and `write_file` over shell `cat`, `sed`, `awk`, or redirection.',
  '- **Subagents**: Give `invoke_subagent` open, neutral prompts with clear completion checks, and verify cited paths/lines directly.',
  '',
  '## Verification & Formatting',
  '- Run the narrowest targeted build, typecheck, or test via `run_command` after edits. Never fabricate tool output or report skipped/partial runs as full passes.',
  '- Lead with the direct conclusion in sentence 1. Cite files/symbols as clickable `[name](file:///abs/path#L10-L20)` links (forward slashes on Windows) and escape literal `$` in prose as `\\$`.'
].join('\n');

const TIER4_GUIDELINES = [
  'Follow these behavioral guidelines at all times:',
  '- Maintain documentation integrity: preserve unrelated comments and docstrings. Never bypass access controls, permissions, or sandbox limits.',
  '- **Evidence-First Grounding**: Never guess unread file contents, API signatures, or unexecuted outputs; inspect with `read_file` or `run_command` first and mark anything unverified.',
  '- **Surgical Minimal Scope**: Keep edits scoped to the actual requirement without over-engineering or unrequested abstractions; ask via `ask_question` only when intent is genuinely ambiguous.'
].join('\n');

const TIER4_FUNCTION_CALL = [
  'You support parallel tool calling. Batch independent `read_file` or read-only `run_command` calls in one turn; keep sequential dependencies across turns.',
  '- **Clean Tool Turns**: Call tools directly without filler preambles before tool calls.',
  '- **Reactive Wakeup (No Polling)**: Wait naturally when async `run_command` or `invoke_subagent` runs; never poll with shell `sleep`.'
].join('\n');

const TIER4_COMMUNICATION_STYLE = [
  '- Keep responses concise, structured, and formatted in github-style markdown.',
  '- LaTeX math (KaTeX) is supported: inline \\(...\\) or $...$, display \\[...\\] or $$...$$. Escape literal `$` in prose as `\\$`.',
  '- Cite modified or inspected files/symbols with clickable links: `[symbol](file:///abs/path#L10-L20)` (forward slashes on Windows).',
  '',
  '## Anti-Hallucination & Engineering Guardrails',
  '- **Inquiry vs. Directive**: Treat pure questions/reviews as Inquiries (read-only, no workspace edits). Execute coding requests end-to-end (read -> edit -> targeted `run_command` verification) cleanly.',
  '- **Direct Delivery First**: Deliver concise diffs and explanations in chat; use artifacts selectively when structured long reports are needed.',
  '- **`edit_file` Uniqueness Guard**: Always include 3-5 unique context lines in `Target` so edits apply once and deterministically; inspect before editing.',
  '- **Honest Verification**: Run the narrowest test, lint, or build command that proves your change after the final edit. Never fabricate tool logs, extrapolate unseen fields, or claim skipped/mocked runs as full passes.'
].join('\n');

const AD_SLOTS = [
  'system_prompts/slash_commands.tmpl',
  'system_prompts/plugins.tmpl'
];

const BLOAT_SLOTS = [
  'system_prompts/artifacts.tmpl',
  'system_prompts/persistent_context.tmpl',
  'system_prompts/knowledge_items.tmpl',
  'system_prompts/planning_mode_artifacts.tmpl',
  'system_prompts/conversation_transcript.tmpl',
  'system_prompts/slash_commands.tmpl',
  'system_prompts/plugins.tmpl'
];

export const PROMPT_TIER_META = {
  0: { tier: 0, key: '0', label: '0档 · 官方原版', shortLabel: '0档原版' },
  1: { tier: 1, key: '1', label: '1档 · 仅去推销', shortLabel: '1档去推销' },
  2: { tier: 2, key: '2', label: '2档 · 原版精简', shortLabel: '2档精简' },
  3: { tier: 3, key: '3', label: '3档 · 核心重写', shortLabel: '3档重写' },
  4: { tier: 4, key: '4', label: '4档 · 精简+防幻觉 (推荐)', shortLabel: '4档推荐' }
};

export const CHINESE_TITLE_RULES = [
  {
    id: 'conversation_title',
    name: '会话主标题生成指令',
    oldText: "Respond with ONLY a short conversation title (3-5 words, title-cased, no prefix) describing the USER's intent.",
    newText: "Respond with ONLY a Simplified Chinese title (4-10 Chinese chars, NEVER English) describing the USER's intent."
  },
  {
    id: 'chapter_sentence',
    name: '章节标题生成句式',
    oldText: 'Reply with only a plain 3 to 6 word title in sentence case',
    newText: 'Reply with only a concise Simplified Chinese chapter title'
  },
  {
    id: 'chapter_example',
    name: '章节标题生成示例',
    oldText: 'For example: Fixing the login redirect bug, or Planning the websocket rollout.',
    newText: ' ALWAYS reply in Simplified Chinese (4-10 Chinese chars, NEVER English words).'
  }
];

for (const rule of CHINESE_TITLE_RULES) {
  if (Buffer.byteLength(rule.oldText, 'ascii') !== Buffer.byteLength(rule.newText, 'ascii')) {
    throw new Error(`中文标题等长校验失败: ${rule.id}`);
  }
}

export const CHINESE_TITLE_META = {
  zh: { mode: 'zh', enabled: true, label: '自动中文标题 (4~10字)', shortLabel: '中文标题' },
  en: { mode: 'en', enabled: false, label: '官方英文标题', shortLabel: '英文标题' },
  unsupported: { mode: 'unsupported', enabled: false, label: '当前内核无标题特征', shortLabel: '未匹配' }
};

export function normalizePromptTier(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s === '0' || s === 'restore' || s === 'stock' || s === 'reset') return 0;
  if (s === '1' || s === 'tier1') return 1;
  if (s === '2' || s === 'tier2') return 2;
  if (s === '3' || s === 'tier3') return 3;
  if (s === '4' || s === 'tier4') return 4;
  return undefined;
}

export function normalizeChineseTitleMode(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  if (['true', '1', 'on', 'zh', 'cn', 'zh-cn', 'enable', 'enabled'].includes(s)) return true;
  if (['false', '0', 'off', 'en', 'stock', 'restore', 'reset', 'disable', 'disabled'].includes(s)) return false;
  return undefined;
}

export function isSupportedEnhancePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return true;
  if (platform === 'darwin' && arch === 'arm64') return true;
  return false;
}

function resolveStandaloneAgyPath(localAppData, homeDir, platform = process.platform) {
  const home = homeDir || os.homedir();
  if (platform === 'darwin') {
    const macCandidates = [
      path.join(home, '.local', 'bin', 'agy'),
      path.join(home, '.gemini', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy'
    ];
    return macCandidates.find((c) => fs.existsSync(c)) || macCandidates[0];
  }
  const candidates = [
    path.join(home, '.gemini', 'bin', 'agy.exe'),
    path.join(localAppData, 'agy', 'bin', 'agy.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  if (platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['agy.exe'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      for (const line of String(out || '').split(/\r?\n/)) {
        const cand = line.trim();
        if (cand && fs.existsSync(cand)) return cand;
      }
    } catch {}
  }
  return candidates[0];
}

export function resolveTargetBinaries(options = {}) {
  if (Array.isArray(options.targets)) {
    return options.targets.map((t) => ({
      id: String(t.id || 'custom'),
      label: String(t.label || path.basename(t.path || '')),
      path: path.resolve(t.path)
    }));
  }
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();

  if (platform === 'darwin') {
    const macDesktopCandidates = [
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
      '/Applications/Google Antigravity.app/Contents/Resources/bin/language_server',
      path.join(home, 'Applications', 'Google Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server')
    ];
    const desktopPath = macDesktopCandidates.find((p) => fs.existsSync(p)) || macDesktopCandidates[0];
    const cliPath = resolveStandaloneAgyPath('', home, 'darwin');
    const targets = [{ id: 'desktop', label: 'Antigravity 桌面端内核 (language_server)', path: desktopPath }];
    if (cliPath && fs.existsSync(cliPath)) {
      targets.push({ id: 'cli', label: 'Antigravity 独立 CLI 内核 (agy)', path: cliPath });
    }
    return targets;
  }

  if (platform !== 'win32') return [];

  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const desktopPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
  const cliPath = resolveStandaloneAgyPath(localAppData, home, 'win32');
  const ideExtPath = path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe');

  const targets = [
    { id: 'desktop', label: 'Antigravity 桌面端内核 (language_server)', path: desktopPath },
    { id: 'cli', label: 'Antigravity 独立 CLI 内核 (agy.exe)', path: cliPath }
  ];
  if (fs.existsSync(ideExtPath)) {
    targets.push({ id: 'ide', label: 'Antigravity IDE 扩展语言服务', path: ideExtPath });
  }
  return targets;
}

export function getEnhanceBackupPath(targetPath, options = {}) {
  const key = path.basename(targetPath).replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (options.enhanceBackupDir) {
    fs.mkdirSync(options.enhanceBackupDir, { recursive: true });
    return path.join(options.enhanceBackupDir, `${key}.orig.bak`);
  }
  const home = options.homeDir || os.homedir();
  const localApp = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const preferredDir = path.join(localApp, 'agy-minibar', 'backups', 'enhance');
  const preferredBak = path.join(preferredDir, `${key}.orig.bak`);
  const legacyManagedBak = path.join(localApp, 'AntigravityContextMeter', 'backups', 'context-unlock', 'enhance', `${key}.orig.bak`);
  const legacySiblingBak = `${targetPath}.bak`;

  if (fs.existsSync(preferredBak)) return preferredBak;
  if (fs.existsSync(legacyManagedBak)) return legacyManagedBak;
  if (fs.existsSync(legacySiblingBak)) return legacySiblingBak;

  fs.mkdirSync(preferredDir, { recursive: true });
  return preferredBak;
}

function getEnhanceStatePath(options = {}) {
  if (options.stateFile) return options.stateFile;
  const home = options.homeDir || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'sidecar_data', 'agy-minibar', 'enhance-state.json');
}

function readSavedEnhancePreference(options = {}) {
  try {
    const p = getEnhanceStatePath(options);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw.promptTier === 'number') return raw;
  } catch {}
  return null;
}

function saveSavedEnhancePreference(pref, options = {}) {
  try {
    const p = getEnhanceStatePath(options);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pref, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Go embed.FS 槽位与 PE/Mach-O 解析
// ============================================================================

function computeActiveBytes(rawStr) {
  const match = rawStr.match(/\{\{- \/\*\s*\*\/ -\}\}\s*$/);
  if (match && typeof match.index === 'number') {
    return { activeBytes: Buffer.byteLength(rawStr.slice(0, match.index), 'utf8'), isStripped: match.index === 0 };
  }
  return { activeBytes: Buffer.byteLength(rawStr, 'utf8'), isStripped: false };
}

function parsePeSectionSummary(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null;
  if (isMachO64Buffer(buf)) {
    const macho = parseMachO64(buf);
    if (!macho) return null;
    return { peBuildKey: macho.buildKey, format: 'Mach-O', arch: macho.arch, sections: macho.sections };
  }
  if (buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\x00\x00') return null;
  if (buf.readUInt16LE(peOffset + 4) !== 0x8664) return null;
  const numSections = buf.readUInt16LE(peOffset + 6);
  const timeDateStamp = buf.readUInt32LE(peOffset + 8);
  const optSize = buf.readUInt16LE(peOffset + 20);
  const optStart = peOffset + 24;
  if (optSize < 64 || optStart + optSize > buf.length) return null;
  const sizeOfImage = buf.readUInt32LE(optStart + 56);
  const sectionTableStart = optStart + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = sectionTableStart + i * 40;
    if (off + 40 > buf.length) break;
    sections.push({
      name: buf.subarray(off, off + 8).toString('ascii').replace(/\0.*$/, ''),
      vSize: buf.readUInt32LE(off + 8),
      vAddr: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20),
      characteristics: buf.readUInt32LE(off + 36)
    });
  }
  return { peBuildKey: `${timeDateStamp}:${sizeOfImage}:${buf.length}`, timeDateStamp, sizeOfImage, sections };
}

function getPeDataSearchRanges(buf) {
  if (isMachO64Buffer(buf)) return getMachODataSearchRanges(buf);
  const pe = parsePeSectionSummary(buf);
  if (!pe || !pe.sections.length) return [{ start: 0, end: buf.length }];
  const preferred = [];
  for (const s of pe.sections) {
    if (s.rawSize <= 0 || s.rawPtr <= 0 || s.rawPtr >= buf.length) continue;
    const isCode = Boolean(s.characteristics & 0x00000020) && s.name === '.text';
    if (!isCode && (s.name === '.rdata' || s.name === '.rodata' || s.name === '.data')) {
      preferred.push({ start: s.rawPtr, end: Math.min(buf.length, s.rawPtr + s.rawSize) });
    }
  }
  return preferred.length > 0 ? preferred : [{ start: 0, end: buf.length }];
}

function parsePeEmbedTemplates(buf) {
  let fileOffsetToVA;
  let vaToFileOffset;

  if (isMachO64Buffer(buf)) {
    const macho = parseMachO64(buf);
    if (!macho || macho.arch !== 'arm64') {
      throw new Error('当前 macOS 仅支持 Apple Silicon (arm64) 64 位 Mach-O 文件');
    }
    fileOffsetToVA = macho.fileOffsetToVA;
    vaToFileOffset = macho.vaToFileOffset;
  } else {
    if (!Buffer.isBuffer(buf) || buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('不是有效的 Windows PE64 或 macOS Mach-O 可执行文件');
    }
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 24 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\x00\x00') {
      throw new Error('无效的 PE 文件头');
    }
    if (buf.readUInt16LE(peOffset + 4) !== 0x8664) {
      throw new Error('当前仅支持 x64 (AMD64) PE 二进制文件');
    }
    const numSections = buf.readUInt16LE(peOffset + 6);
    const optSize = buf.readUInt16LE(peOffset + 20);
    const optStart = peOffset + 24;
    if (optSize < 32 || optStart + optSize > buf.length) throw new Error('PE Optional Header 损坏');
    const imageBase = buf.readBigUInt64LE(optStart + 24);
    const sectionTableStart = optStart + optSize;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const off = sectionTableStart + i * 40;
      if (off + 40 > buf.length) break;
      sections.push({
        vSize: buf.readUInt32LE(off + 8),
        vAddr: buf.readUInt32LE(off + 12),
        rawSize: buf.readUInt32LE(off + 16),
        rawPtr: buf.readUInt32LE(off + 20)
      });
    }
    fileOffsetToVA = (foff) => {
      for (const s of sections) {
        if (foff >= s.rawPtr && foff < s.rawPtr + s.rawSize) {
          return imageBase + BigInt(s.vAddr + (foff - s.rawPtr));
        }
      }
      return 0n;
    };
    vaToFileOffset = (va) => {
      if (va < imageBase) return -1;
      const rva = Number(va - imageBase);
      for (const s of sections) {
        const span = Math.max(s.vSize, s.rawSize);
        if (rva >= s.vAddr && rva < s.vAddr + span) {
          const off = s.rawPtr + (rva - s.vAddr);
          return off >= 0 && off <= buf.length ? off : -1;
        }
      }
      return -1;
    };
  }

  const anchorName = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/identity.tmpl';
  const foff = buf.indexOf(anchorName);
  if (foff === -1) throw new Error('未在二进制中找到 identity.tmpl 模板锚点');
  const va = fileOffsetToVA(foff);
  if (va === 0n) throw new Error('无法将 identity.tmpl 偏移映射为虚拟地址');

  const needle = Buffer.alloc(16);
  needle.writeBigUInt64LE(va, 0);
  needle.writeBigUInt64LE(BigInt(anchorName.length), 8);
  const entryOff = buf.indexOf(needle);
  if (entryOff === -1) throw new Error('无法定位 Go embed.FS 的 identity.tmpl 切片入口');

  const basePrefix = 'google3/third_party/jetski/prompt/template_provider/templates/';
  const sysPrefix = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';
  const templates = new Map();

  for (let k = -24; k <= 28; k++) {
    const e = entryOff + k * 48;
    if (e < 0 || e + 48 > buf.length) continue;
    const nVa = buf.readBigUInt64LE(e);
    const nLen = Number(buf.readBigUInt64LE(e + 8));
    const dVa = buf.readBigUInt64LE(e + 16);
    const dLen = Number(buf.readBigUInt64LE(e + 24));
    if (nLen <= 0 || nLen >= 240 || dLen < 0 || dLen > 512 * 1024) continue;
    const nOff = vaToFileOffset(nVa);
    if (nOff <= 0 || nOff + nLen > buf.length) continue;
    const fullName = buf.subarray(nOff, nOff + nLen).toString('utf8');
    if (!fullName.startsWith(sysPrefix) || fullName.endsWith('/')) continue;
    const dOff = dLen > 0 ? vaToFileOffset(dVa) : 0;
    if (dLen > 0 && (dOff <= 0 || dOff + dLen > buf.length)) continue;

    const shortName = fullName.slice(basePrefix.length);
    const rawStr = dLen > 0 ? buf.subarray(dOff, dOff + dLen).toString('utf8') : '';
    const { activeBytes, isStripped } = computeActiveBytes(rawStr);
    templates.set(shortName, {
      shortName,
      fullName,
      entryOffset: e,
      dataOffset: dOff,
      dataLength: dLen,
      activeBytes,
      isStripped,
      isModified: activeBytes !== dLen
    });
  }

  if (templates.size === 0 || !templates.has('system_prompts/identity.tmpl')) {
    throw new Error('解析 Go embed.FS 系统提示词槽位失败');
  }
  return templates;
}

function writePaddedTemplate(buf, slot, newText, dirtyRanges = null) {
  const encoded = Buffer.from(String(newText || ''), 'utf8');
  if (encoded.length > slot.dataLength) {
    throw new Error(`模板 ${slot.shortName} 超出槽位容量上限：${encoded.length}B > ${slot.dataLength}B`);
  }
  const padLen = slot.dataLength - encoded.length;
  const padding = padLen >= 12
    ? Buffer.from('{{- /*' + ' '.repeat(padLen - 12) + '*/ -}}', 'utf8')
    : Buffer.from(' '.repeat(padLen), 'utf8');
  encoded.copy(buf, slot.dataOffset);
  padding.copy(buf, slot.dataOffset + encoded.length);
  if (Array.isArray(dirtyRanges) && slot.dataLength > 0) {
    dirtyRanges.push({ start: slot.dataOffset, length: slot.dataLength });
  }
  return encoded.length;
}

function detectPromptTier(templates, buf) {
  const slashSlot = templates.get('system_prompts/slash_commands.tmpl');
  const artSlot = templates.get('system_prompts/artifacts.tmpl');
  const slashStripped = Boolean(slashSlot && slashSlot.isStripped);
  const artStripped = Boolean(artSlot && artSlot.isStripped);
  if (slashStripped && !artStripped) return 1;
  if (artStripped) {
    const guideSlot = templates.get('system_prompts/guidelines.tmpl');
    const styleSlot = templates.get('system_prompts/communication_style.tmpl');
    const gTxt = (guideSlot && guideSlot.dataLength > 0)
      ? buf.subarray(guideSlot.dataOffset, guideSlot.dataOffset + guideSlot.dataLength).toString('utf8')
      : '';
    const cTxt = (styleSlot && styleSlot.dataLength > 0)
      ? buf.subarray(styleSlot.dataOffset, styleSlot.dataOffset + styleSlot.dataLength).toString('utf8')
      : '';
    if (gTxt.includes('core engineering mandates')) return 3;
    if (cTxt.includes('Anti-Hallucination')) return 4;
    return 2;
  }
  return 0;
}

function applyPromptTierToBuffer(buf, bakBuf, tierNum, dirtyRanges = null) {
  const curTemplates = parsePeEmbedTemplates(buf);
  const bakTemplates = parsePeEmbedTemplates(bakBuf);

  for (const [name, bakSlot] of bakTemplates.entries()) {
    const curSlot = curTemplates.get(name);
    if (curSlot && bakSlot.dataOffset === curSlot.dataOffset && bakSlot.dataLength === curSlot.dataLength && bakSlot.dataLength > 0) {
      const dstSlice = buf.subarray(curSlot.dataOffset, curSlot.dataOffset + curSlot.dataLength);
      const srcSlice = bakBuf.subarray(bakSlot.dataOffset, bakSlot.dataOffset + bakSlot.dataLength);
      if (!dstSlice.equals(srcSlice)) {
        srcSlice.copy(buf, curSlot.dataOffset);
        if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: curSlot.dataOffset, length: bakSlot.dataLength });
      }
    }
  }

  const applyEditsPrefix = Buffer.from('488b71104889742458488b711848897424384889d1', 'hex');
  const applyEditsTailStock = Buffer.from('4883f8010f8474ffffff', 'hex');
  const applyEditsTailBypass = Buffer.from('4883f801e975ffffff90', 'hex');
  const prefixOff = bakBuf.indexOf(applyEditsPrefix);

  let strippedBytes = 0;
  let strippedCount = 0;

  if (tierNum === 0) {
    if (prefixOff !== -1) {
      const tailOff = prefixOff + applyEditsPrefix.length + 5;
      if (tailOff + 10 <= bakBuf.length) {
        const curTail = bakBuf.subarray(tailOff, tailOff + 10);
        if (curTail.equals(applyEditsTailStock) || curTail.equals(applyEditsTailBypass)) {
          applyEditsTailStock.copy(buf, tailOff);
          if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: tailOff, length: 10 });
        }
      }
    }
  } else if (tierNum === 1) {
    for (const name of AD_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '', dirtyRanges);
        strippedBytes += slot.dataLength;
        strippedCount++;
      }
    }
  } else if (tierNum === 2 || tierNum === 3 || tierNum === 4) {
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataLength > 0) {
        writePaddedTemplate(buf, slot, '', dirtyRanges);
        strippedBytes += slot.dataLength;
        strippedCount++;
      }
    }
    if (tierNum === 3 || tierNum === 4) {
      const gSlot = curTemplates.get('system_prompts/guidelines.tmpl');
      const fSlot = curTemplates.get('system_prompts/function_call.tmpl');
      const cSlot = curTemplates.get('system_prompts/communication_style.tmpl');
      if (!gSlot || !fSlot || !cSlot) {
        throw new Error('核心提示词槽位缺失（guidelines / function_call / communication_style）');
      }
      writePaddedTemplate(buf, gSlot, tierNum === 3 ? TIER3_GUIDELINES : TIER4_GUIDELINES, dirtyRanges);
      writePaddedTemplate(buf, fSlot, tierNum === 3 ? TIER3_FUNCTION_CALL : TIER4_FUNCTION_CALL, dirtyRanges);
      writePaddedTemplate(buf, cSlot, tierNum === 3 ? TIER3_COMMUNICATION_STYLE : TIER4_COMMUNICATION_STYLE, dirtyRanges);
    }
  } else {
    throw new Error(`不支持的提示词档位: ${tierNum}`);
  }

  if (tierNum !== 0 && prefixOff !== -1) {
    const tailOff = prefixOff + applyEditsPrefix.length + 5;
    if (tailOff + 10 <= bakBuf.length) {
      const curTail = bakBuf.subarray(tailOff, tailOff + 10);
      if (curTail.equals(applyEditsTailStock) || curTail.equals(applyEditsTailBypass)) {
        applyEditsTailBypass.copy(buf, tailOff);
        if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: tailOff, length: 10 });
      }
    }
  }

  const idSlot = curTemplates.get('system_prompts/identity.tmpl');
  if (!idSlot || !buf.subarray(idSlot.dataOffset, idSlot.dataOffset + idSlot.dataLength).toString('utf8').includes('You are Antigravity')) {
    throw new Error('安全校验失败：identity.tmpl 完整性异常，已中止写入');
  }

  return { tier: tierNum, label: PROMPT_TIER_META[tierNum].label, strippedCount, strippedBytes };
}

function isSamePeBuild(bufA, bufB) {
  try {
    if (!Buffer.isBuffer(bufA) || !Buffer.isBuffer(bufB)) return false;
    if (isMachO64Buffer(bufA) && isMachO64Buffer(bufB)) {
      const mA = parseMachO64(bufA);
      const mB = parseMachO64(bufB);
      if (!mA || !mB || mA.buildKey !== mB.buildKey) return false;
    } else {
      if (bufA.length !== bufB.length || bufA.length < 0x100) return false;
      const peA = bufA.readUInt32LE(0x3c);
      const peB = bufB.readUInt32LE(0x3c);
      if (peA !== peB || peA + 24 + 64 > bufA.length) return false;
      if (bufA.readUInt32LE(peA + 8) !== bufB.readUInt32LE(peB + 8)) return false;
      if (bufA.readUInt32LE(peA + 24 + 56) !== bufB.readUInt32LE(peB + 24 + 56)) return false;
    }
    const idA = parsePeEmbedTemplates(bufA).get('system_prompts/identity.tmpl');
    const idB = parsePeEmbedTemplates(bufB).get('system_prompts/identity.tmpl');
    return Boolean(idA && idB && idA.dataOffset === idB.dataOffset && idA.dataLength === idB.dataLength);
  } catch {
    return false;
  }
}

function findInRanges(buf, needleBuf, ranges) {
  for (const r of ranges) {
    const idx = buf.indexOf(needleBuf, r.start);
    if (idx !== -1 && idx + needleBuf.length <= r.end) return idx;
  }
  return -1;
}

function inspectChineseTitleRules(buf) {
  const ranges = getPeDataSearchRanges(buf);
  const fullFallback = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === buf.length;
  let enCount = 0;
  let zhCount = 0;
  const scan = (scanRanges) => {
    enCount = 0;
    zhCount = 0;
    for (const rule of CHINESE_TITLE_RULES) {
      const newOff = findInRanges(buf, Buffer.from(rule.newText, 'ascii'), scanRanges);
      const oldOff = newOff === -1 ? findInRanges(buf, Buffer.from(rule.oldText, 'ascii'), scanRanges) : -1;
      if (newOff !== -1) zhCount++;
      else if (oldOff !== -1) enCount++;
    }
  };
  scan(ranges);
  if (!fullFallback && zhCount + enCount === 0) scan([{ start: 0, end: buf.length }]);
  let mode = 'unsupported';
  if (zhCount > 0 && enCount === 0) mode = 'zh';
  else if (zhCount > 0 && enCount > 0) mode = 'mixed';
  else if (enCount > 0) mode = 'en';
  return { mode, enabled: mode === 'zh', matchedCount: zhCount + enCount, zhCount, enCount };
}

function applyChineseTitlePatchToBuffer(buf, enableZh, dirtyRanges = null) {
  const ranges = getPeDataSearchRanges(buf);
  const fullFallback = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === buf.length;
  const applyOnRanges = (scanRanges) => {
    const matched = [];
    for (const rule of CHINESE_TITLE_RULES) {
      const oldBuf = Buffer.from(rule.oldText, 'ascii');
      const newBuf = Buffer.from(rule.newText, 'ascii');
      const src = enableZh ? oldBuf : newBuf;
      const dst = enableZh ? newBuf : oldBuf;
      for (const r of scanRanges) {
        let pos = r.start;
        while (pos < r.end) {
          const idx = buf.indexOf(src, pos);
          if (idx === -1 || idx + src.length > r.end) break;
          dst.copy(buf, idx);
          if (Array.isArray(dirtyRanges)) dirtyRanges.push({ start: idx, length: dst.length });
          matched.push({ id: rule.id, offset: idx });
          pos = idx + dst.length;
        }
      }
      if (!matched.some((m) => m.id === rule.id)) {
        const dstIdx = findInRanges(buf, dst, scanRanges);
        if (dstIdx !== -1) matched.push({ id: rule.id, offset: dstIdx });
      }
    }
    return matched;
  };
  let matched = applyOnRanges(ranges);
  if (!fullFallback && matched.length === 0) matched = applyOnRanges([{ start: 0, end: buf.length }]);
  return matched;
}

// ============================================================================
// 增量原位写入与 Windows 运行期安全替换
// ============================================================================

function mergeDirtyRanges(dirtyRanges, totalLen) {
  if (!Array.isArray(dirtyRanges) || dirtyRanges.length === 0) return [];
  const norm = dirtyRanges
    .map((r) => {
      const s = Math.max(0, Number(r.start) || 0);
      const e = Math.min(totalLen, s + Math.max(0, Number(r.length) || 0));
      return s < e ? { start: s, end: e } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  if (norm.length === 0) return [];
  const merged = [norm[0]];
  for (let i = 1; i < norm.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = norm[i];
    if (cur.start <= prev.end + 64) prev.end = Math.max(prev.end, cur.end);
    else merged.push(cur);
  }
  return merged;
}

function getEffectiveDiffRanges(oldBuf, newBuf, dirtyRanges = null) {
  if (!Array.isArray(dirtyRanges)) return null;
  const diffs = [];
  for (const r of mergeDirtyRanges(dirtyRanges, newBuf.length)) {
    if (!oldBuf.subarray(r.start, r.end).equals(newBuf.subarray(r.start, r.end))) {
      let s = r.start;
      let e = r.end;
      while (s < e && oldBuf[s] === newBuf[s]) s++;
      while (e > s && oldBuf[e - 1] === newBuf[e - 1]) e--;
      if (s < e) diffs.push({ start: s, end: e });
    }
  }
  return diffs;
}

function countChangedBytes(oldBuf, newBuf, diffs = null) {
  if (Array.isArray(diffs)) {
    let diff = 0;
    for (const r of diffs) {
      for (let i = r.start; i < r.end; i++) if (oldBuf[i] !== newBuf[i]) diff++;
    }
    return diff;
  }
  const len = Math.min(oldBuf.length, newBuf.length);
  let diff = Math.abs(oldBuf.length - newBuf.length);
  for (let i = 0; i < len; i++) if (oldBuf[i] !== newBuf[i]) diff++;
  return diff;
}

function writeChangedRangesInPlace(targetPath, oldBuf, newBuf, precomputedDiffs = null) {
  if (oldBuf.length !== newBuf.length) throw new Error('原位补丁要求前后二进制字节长度严格一致');
  const fd = fs.openSync(targetPath, 'r+');
  let totalWritten = 0;
  try {
    if (Array.isArray(precomputedDiffs)) {
      for (const r of precomputedDiffs) {
        const slice = newBuf.subarray(r.start, r.end);
        fs.writeSync(fd, slice, 0, slice.length, r.start);
        totalWritten += slice.length;
      }
    } else {
      let i = 0;
      while (i < newBuf.length) {
        if (oldBuf[i] !== newBuf[i]) {
          const start = i++;
          while (i < newBuf.length && oldBuf[i] !== newBuf[i]) i++;
          const slice = newBuf.subarray(start, i);
          fs.writeSync(fd, slice, 0, slice.length, start);
          totalWritten += slice.length;
        } else i++;
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return totalWritten;
}

function writeBinarySafely(targetPath, oldBuf, newBuf, dirtyRanges = null, writeOpts = {}) {
  let diffs = null;
  if (Array.isArray(dirtyRanges) && oldBuf.length === newBuf.length) {
    diffs = getEffectiveDiffRanges(oldBuf, newBuf, dirtyRanges);
    if (diffs.length === 0) return { writtenBytes: 0, method: 'unchanged' };
  } else if (Buffer.compare(oldBuf, newBuf) === 0) {
    return { writtenBytes: 0, method: 'unchanged' };
  }

  if (isMachO64Buffer(newBuf)) {
    atomicWriteMachOBinarySync(targetPath, newBuf, {
      entitlementsSourcePath: writeOpts.entitlementsSourcePath || targetPath,
      skipCodesign: writeOpts.skipCodesign === true
    });
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
  }

  try {
    const writtenBytes = writeChangedRangesInPlace(targetPath, oldBuf, newBuf, diffs);
    return { writtenBytes, method: 'in-place' };
  } catch (inPlaceErr) {
    if (process.platform !== 'win32') throw inPlaceErr;
  }

  const stalePath = `${targetPath}.old_run`;
  const tmpNewPath = `${targetPath}.new_${process.pid}`;
  try { if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath); } catch {}
  let renamedOld = false;
  try {
    fs.writeFileSync(tmpNewPath, newBuf);
    fs.renameSync(targetPath, stalePath);
    renamedOld = true;
    fs.renameSync(tmpNewPath, targetPath);
    try { fs.unlinkSync(stalePath); } catch {}
    return { writtenBytes: countChangedBytes(oldBuf, newBuf, diffs), method: 'rename-swap' };
  } catch (swapErr) {
    try { if (fs.existsSync(tmpNewPath)) fs.unlinkSync(tmpNewPath); } catch {}
    if (renamedOld && !fs.existsSync(targetPath) && fs.existsSync(stalePath)) {
      try { fs.renameSync(stalePath, targetPath); } catch {}
    }
    throw new Error(`文件正被运行中的后台服务锁定且重命名替换失败（请退出客户端后重试）: ${swapErr.message}`);
  }
}

// ============================================================================
// 状态查询与统一应用 / 还原
// ============================================================================

function inspectSingleBinary(target, options = {}) {
  const bakPath = getEnhanceBackupPath(target.path, options);
  const bakExists = fs.existsSync(bakPath);
  if (!fs.existsSync(target.path)) {
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: false,
      bakExists,
      bakPath,
      promptTier: 0,
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false
    };
  }
  try {
    const buf = fs.readFileSync(target.path);
    const st = fs.statSync(target.path);
    const peSum = parsePeSectionSummary(buf);
    const templates = parsePeEmbedTemplates(buf);
    const promptTier = detectPromptTier(templates, buf);
    const titleInfo = inspectChineseTitleRules(buf);

    let totalCapacityBytes = 0;
    let activeSlotBytes = 0;
    for (const s of templates.values()) {
      totalCapacityBytes += s.dataLength;
      activeSlotBytes += s.activeBytes;
    }

    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      bakExists,
      bakPath,
      fileSizeMb: Number((st.size / (1024 * 1024)).toFixed(1)),
      peBuildKey: peSum?.peBuildKey || null,
      promptTier,
      promptLabel: PROMPT_TIER_META[promptTier]?.label || PROMPT_TIER_META[0].label,
      chineseTitleMode: titleInfo.mode,
      chineseTitleEnabled: titleInfo.enabled,
      chineseTitleLabel: (CHINESE_TITLE_META[titleInfo.mode] || CHINESE_TITLE_META.unsupported).label,
      chineseTitleMatched: titleInfo.matchedCount,
      totalCapacityBytes,
      activeSlotBytes,
      savedBytes: Math.max(0, totalCapacityBytes - activeSlotBytes),
      slotCount: templates.size,
      error: null
    };
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      bakExists,
      bakPath,
      promptTier: 0,
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      error: err.message || String(err)
    };
  }
}

export function getEnhanceStatus(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && !isSupportedEnhancePlatform(platform, arch)) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: '系统提示词与中文标题补丁当前仅支持 Windows x64 与 Apple Silicon (macOS arm64)',
      binaries: [],
      summary: null
    };
  }

  const targets = resolveTargetBinaries(options);
  const binaries = targets.map((t) => inspectSingleBinary(t, options));
  const existing = binaries.filter((b) => b.exists && !b.error);
  const primary = existing[0] || null;
  const savedConfig = readSavedEnhancePreference(options);

  let clientUpdatedSinceSave = false;
  if (savedConfig?.targetBuilds) {
    for (const b of existing) {
      if (savedConfig.targetBuilds[b.id] && b.peBuildKey && savedConfig.targetBuilds[b.id] !== b.peBuildKey) {
        clientUpdatedSinceSave = true;
      }
    }
  }

  return {
    ok: true,
    supported: true,
    platform,
    arch,
    binaries,
    savedConfig,
    summary: {
      installedCount: existing.length,
      promptTier: primary ? primary.promptTier : 0,
      promptLabel: primary ? primary.promptLabel : PROMPT_TIER_META[0].label,
      chineseTitleMode: primary ? primary.chineseTitleMode : 'unsupported',
      chineseTitleEnabled: Boolean(primary?.chineseTitleEnabled),
      chineseTitleLabel: primary ? primary.chineseTitleLabel : CHINESE_TITLE_META.unsupported.label,
      savedBytes: primary ? primary.savedBytes : 0,
      totalCapacityBytes: primary ? primary.totalCapacityBytes : 0,
      allBackedUp: existing.length > 0 && existing.every((b) => b.bakExists),
      clientUpdatedSinceSave
    }
  };
}

export function applyEnhancePatch(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && !isSupportedEnhancePlatform(platform, arch)) {
    return { ok: false, error: '当前平台暂不支持内核增强补丁' };
  }

  const promptTier = normalizePromptTier(payload.promptTier);
  if (promptTier === undefined) return { ok: false, error: `无效的提示词档位参数: ${payload.promptTier}` };
  const chineseTitle = normalizeChineseTitleMode(payload.chineseTitle);
  if (chineseTitle === undefined) return { ok: false, error: `无效的中文标题参数: ${payload.chineseTitle}` };
  if (promptTier === null && chineseTitle === null) {
    return { ok: false, error: '请至少指定 promptTier 或 chineseTitle 参数' };
  }

  const targets = resolveTargetBinaries(options).filter((t) => fs.existsSync(t.path));
  if (targets.length === 0) {
    return { ok: false, error: '未检测到本机 Antigravity 内核文件 (language_server / agy)' };
  }

  const logs = [];
  const targetResults = [];
  const targetBuilds = {};
  let changedTargets = 0;

  for (const target of targets) {
    try {
      const bakPath = getEnhanceBackupPath(target.path, options);
      const origDiskBuf = fs.readFileSync(target.path);
      const curTemplates = parsePeEmbedTemplates(origDiskBuf);
      const curTier = detectPromptTier(curTemplates, origDiskBuf);
      const peSum = parsePeSectionSummary(origDiskBuf);
      if (peSum?.peBuildKey) targetBuilds[target.id] = peSum.peBuildKey;

      let bakBuf = null;
      if (!fs.existsSync(bakPath)) {
        const cleanStock = Buffer.from(origDiskBuf);
        if (curTier === 0) applyChineseTitlePatchToBuffer(cleanStock, false);
        fs.mkdirSync(path.dirname(bakPath), { recursive: true });
        fs.writeFileSync(bakPath, cleanStock);
        bakBuf = cleanStock;
        logs.push(`[备份] 已创建原版备份: ${bakPath}`);
      } else {
        const existingBak = fs.readFileSync(bakPath);
        if (isSamePeBuild(origDiskBuf, existingBak)) {
          bakBuf = existingBak;
        } else if (curTier === 0) {
          const cleanStock = Buffer.from(origDiskBuf);
          applyChineseTitlePatchToBuffer(cleanStock, false);
          fs.writeFileSync(bakPath, cleanStock);
          bakBuf = cleanStock;
          logs.push(`[备份刷新] 检测到 ${path.basename(target.path)} 已随客户端更新，已刷新备份`);
        } else if (promptTier !== null && promptTier <= 2) {
          throw new Error(`${target.label} 备份属于旧版本，且当前已修改（${curTier}档），请先更新或重装客户端再还原`);
        } else {
          bakBuf = origDiskBuf;
        }
      }

      const nextBuf = Buffer.from(origDiskBuf);
      const dirtyRanges = [];
      if (promptTier !== null) {
        const pRes = applyPromptTierToBuffer(nextBuf, bakBuf, promptTier, dirtyRanges);
        logs.push(`[提示词] ${target.label} -> ${pRes.label}${pRes.strippedBytes > 0 ? ` (-${pRes.strippedBytes}B)` : ''}`);
      }
      if (chineseTitle !== null) {
        const tMatches = applyChineseTitlePatchToBuffer(nextBuf, chineseTitle, dirtyRanges);
        logs.push(tMatches.length > 0
          ? `[中文标题] ${target.label} -> ${chineseTitle ? '自动中文标题 (4~10字)' : '官方英文标题'} (${tMatches.length} 处)`
          : `[中文标题] ${target.label} 未匹配到标题指令`);
      }

      const writeRes = writeBinarySafely(target.path, origDiskBuf, nextBuf, dirtyRanges, {
        entitlementsSourcePath: bakPath
      });
      if (writeRes.method !== 'unchanged') changedTargets++;
      logs.push(writeRes.method === 'unchanged'
        ? `[无变更] ${path.basename(target.path)} 已处于目标状态`
        : `[写入成功] ${path.basename(target.path)} (${writeRes.method === 'rename-swap' ? '运行期热替换' : '原位写入'} ${writeRes.writtenBytes}B)`);

      targetResults.push({ id: target.id, label: target.label, path: target.path, ok: true, method: writeRes.method });
    } catch (err) {
      targetResults.push({ id: target.id, label: target.label, path: target.path, ok: false, error: err.message || String(err) });
    }
  }

  const failed = targetResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    return { ok: false, error: failed.map((f) => `${f.label}: ${f.error}`).join('；'), targetResults, logs };
  }

  const status = getEnhanceStatus(options);
  saveSavedEnhancePreference({
    promptTier: promptTier ?? status.summary?.promptTier ?? 0,
    chineseTitle: chineseTitle ?? status.summary?.chineseTitleEnabled ?? false,
    lastAppliedAt: new Date().toISOString(),
    targetBuilds
  }, options);

  return {
    ok: true,
    changed: changedTargets > 0,
    changedTargets,
    needsRestart: changedTargets > 0,
    targetResults,
    logs,
    status
  };
}

export function restoreAllEnhance(options = {}) {
  return applyEnhancePatch({ promptTier: 0, chineseTitle: false }, options);
}
