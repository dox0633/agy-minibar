/**
 * 纯 Node.js ASAR 解析、打包与桌面端汉化注入引擎
 * 零第三方 npm 依赖；仅修改 dist/preload.js，其余文件逐一比对 SHA-256 确保原样无损。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLKIT_DIR = path.resolve(__dirname, '..');

const TAG_START = '// === AGY_MINIBAR_I18N_START ===';
const TAG_END = '// === AGY_MINIBAR_I18N_END ===';
const LEGACY_PATTERNS = [
  /\/\/ === AGY_MINIBAR_I18N_START ===[\s\S]*?\/\/ === AGY_MINIBAR_I18N_END ===\r?\n?/g,
  /\/\/ --- Antigravity Chinese Localization Injection Start ---[\s\S]*?\/\/ --- Antigravity Chinese Localization Injection End ---\r?\n?/g,
  /\/\/ === CONTEXT_METER_CHINESE_START ===[\s\S]*?\/\/ === CONTEXT_METER_CHINESE_END ===\r?\n?/g
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    fs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, baseOffset: 16 + jsonSize + padding };
  } finally {
    fs.closeSync(fd);
  }
}

function getNode(header, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`ASAR 内找不到文件: ${relPath}`);
    }
    cur = cur.files[part];
  }
  return cur;
}

export const builtinAsar = {
  extractFile(archivePath, relPath) {
    const { header, baseOffset } = readHeader(archivePath);
    const node = getNode(header, relPath);
    if (node.unpacked) {
      const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
      return fs.existsSync(unpackedSrc) ? fs.readFileSync(unpackedSrc) : Buffer.alloc(node.size || 0);
    }
    const buf = Buffer.alloc(node.size);
    const fd = fs.openSync(archivePath, 'r');
    try {
      fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  },

  statFile(archivePath, relPath) {
    const { header } = readHeader(archivePath);
    return getNode(header, relPath);
  },

  listPackage(archivePath) {
    const { header } = readHeader(archivePath);
    const list = [];
    function walk(tree, prefix) {
      for (const [name, info] of Object.entries(tree.files || {})) {
        const cur = prefix + '/' + name;
        list.push(cur);
        if (info.files) walk(info, cur);
      }
    }
    walk(header, '');
    return list;
  },

  extractAll(archivePath, destDir) {
    const { header, baseOffset } = readHeader(archivePath);
    const fd = fs.openSync(archivePath, 'r');
    try {
      function walk(tree, currentDir, relDir) {
        fs.mkdirSync(currentDir, { recursive: true });
        for (const [name, info] of Object.entries(tree.files || {})) {
          const targetPath = path.join(currentDir, name);
          const relPath = relDir ? path.join(relDir, name) : name;
          if (info.files) {
            walk(info, targetPath, relPath);
          } else if (info.unpacked) {
            const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            if (fs.existsSync(unpackedSrc)) {
              fs.copyFileSync(unpackedSrc, targetPath);
            } else {
              fs.writeFileSync(targetPath, Buffer.alloc(0));
            }
          } else {
            const buf = Buffer.alloc(info.size);
            fs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
            fs.writeFileSync(targetPath, buf);
          }
        }
      }
      walk(header, destDir, '');
    } finally {
      fs.closeSync(fd);
    }
  },

  createPackageWithOptions(srcDir, destAsar, options = {}) {
    let offset = 0;
    const chunks = [];
    const unpackedSet = options.unpackedPaths instanceof Set ? options.unpackedPaths : null;
    const unpackMatcher = unpackedSet ? (relPosix) => unpackedSet.has(relPosix) : () => false;

    function build(currentDir, relPosix) {
      const files = {};
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const childPosix = relPosix ? `${relPosix}/${entry.name}` : entry.name;
        const isUnpacked = unpackMatcher(childPosix);
        if (entry.isDirectory()) {
          const node = { files: build(fullPath, childPosix) };
          if (isUnpacked) node.unpacked = true;
          files[entry.name] = node;
        } else if (entry.isFile()) {
          const buf = fs.readFileSync(fullPath);
          const hash = sha256(buf);
          const blockSize = 4 * 1024 * 1024;
          const blockHashes = [];
          for (let i = 0; i < buf.length; i += blockSize) {
            blockHashes.push(sha256(buf.subarray(i, i + blockSize)));
          }
          if (blockHashes.length === 0) {
            blockHashes.push(sha256(Buffer.alloc(0)));
          }
          const integrity = { algorithm: 'SHA256', hash, blockSize, blocks: blockHashes };
          if (isUnpacked) {
            const unpackedTarget = path.join(destAsar + '.unpacked', childPosix);
            fs.mkdirSync(path.dirname(unpackedTarget), { recursive: true });
            fs.copyFileSync(fullPath, unpackedTarget);
            files[entry.name] = { size: buf.length, unpacked: true, integrity };
          } else {
            files[entry.name] = { size: buf.length, offset: String(offset), integrity };
            offset += buf.length;
            chunks.push(buf);
          }
        }
      }
      return files;
    }

    const headerObj = { files: build(srcDir, '') };
    const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const jsonSize = jsonBuf.length;
    const padding = (4 - (jsonSize % 4)) % 4;
    const alignedSize = jsonSize + padding;
    const headerBuf = Buffer.alloc(16 + alignedSize);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(8 + alignedSize, 4);
    headerBuf.writeUInt32LE(4 + alignedSize, 8);
    headerBuf.writeUInt32LE(jsonSize, 12);
    jsonBuf.copy(headerBuf, 16);

    const fd = fs.openSync(destAsar, 'w');
    try {
      fs.writeSync(fd, headerBuf);
      for (const chunk of chunks) {
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
};

export function collectUnpackedPaths(archivePath) {
  const unpacked = new Set();
  try {
    const entries = builtinAsar.listPackage(archivePath);
    for (const file of entries) {
      const relWin = file.startsWith('/') || file.startsWith('\\') ? file.slice(1) : file;
      const stat = builtinAsar.statFile(archivePath, relWin);
      if (stat && stat.unpacked) {
        unpacked.add(relWin.replace(/\\/g, '/'));
      }
    }
  } catch {}
  return unpacked;
}

export function findAsarPath(customPath = null, env = process.env, platform = process.platform, homeDir = os.homedir()) {
  const explicit = customPath || (env.AG_ASAR_PATH ? String(env.AG_ASAR_PATH).trim() : '');
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      for (const rel of [
        path.join('Contents', 'Resources', 'app.asar'),
        path.join('resources', 'app.asar'),
        'app.asar'
      ]) {
        const cand = path.join(resolved, rel);
        if (fs.existsSync(cand)) return cand;
      }
    }
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`未在指定路径找到 app.asar: ${explicit}`);
  }

  const candidates = [];
  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const progFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localApp, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(progFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(progFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(homeDir, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Google Antigravity.app/Contents/Resources/app.asar',
      path.join(homeDir, 'Applications', 'Google Antigravity.app', 'Contents', 'Resources', 'app.asar')
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(homeDir, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

export function cleanPreloadChinese(content) {
  let out = String(content || '');
  for (const re of LEGACY_PATTERNS) {
    out = out.replace(re, '');
  }
  return out.replace(/\n{3,}$/, '\n');
}

export function hasChineseInjection(content) {
  const s = String(content || '');
  return s.includes(TAG_START) ||
    s.includes('__AGY_I18N_DATA__') ||
    s.includes('Antigravity Chinese Localization Injection Start');
}

function buildChinesePreloadBlock(dictContent, runtimeContent, brandTitle = 'english') {
  const cfg = { enabled: true, language: 'zh-CN', brandTitle: brandTitle || 'english' };
  return `\n${TAG_START}
(function() {
  try {
    var _i18nConfig = ${JSON.stringify(cfg)};
    var _dictData = ${dictContent.trim()};
    if (typeof window !== 'undefined') {
      window.__AGY_I18N_CONFIG__ = _i18nConfig;
      window.__AGY_I18N_DATA__ = _dictData;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_I18N_CONFIG__ = _i18nConfig;
      globalThis.__AGY_I18N_DATA__ = _dictData;
    }
${runtimeContent.trim()}
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[agy-minibar/i18n] Injection Error:', e);
    }
  }
})();
${TAG_END}\n`;
}

function validateJsSyntax(code, filename) {
  try {
    new vm.Script(code, { filename });
    return true;
  } catch (err) {
    return err;
  }
}

function verifyArchiveIntegrity(sourceArchive, packedArchive, allowedRelNormSet) {
  const entries = builtinAsar.listPackage(sourceArchive);
  let checked = 0;
  for (const entry of entries) {
    const rel = path.normalize(entry.replace(/^[\\/]+/, ''));
    let before = null;
    let after = null;
    try { before = builtinAsar.statFile(sourceArchive, rel); } catch {}
    try { after = builtinAsar.statFile(packedArchive, rel); } catch {}
    if (!before || before.files || before.link) continue;
    if (!after) throw new Error(`重打包后缺失文件: ${rel}`);
    if (Boolean(before.unpacked) !== Boolean(after.unpacked)) {
      throw new Error(`unpacked 标志异常变更: ${rel}`);
    }
    if (!allowedRelNormSet.has(rel) && !before.unpacked) {
      const hBefore = sha256(builtinAsar.extractFile(sourceArchive, rel));
      const hAfter = sha256(builtinAsar.extractFile(packedArchive, rel));
      if (hBefore !== hAfter) {
        throw new Error(`非预期文件变更: ${rel}`);
      }
      checked++;
    }
  }
  return checked;
}

function replaceFileSafely(packedPath, targetPath) {
  const tmpDest = `${targetPath}.tmp_${process.pid}_${Date.now()}`;
  try {
    fs.copyFileSync(packedPath, tmpDest);
    fs.renameSync(tmpDest, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest); } catch {}
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      throw new Error(`无法写入 ${path.basename(targetPath)}（可能被运行中的 Antigravity 占用），请完全退出客户端后重试: ${err.message}`);
    }
    throw err;
  }
}

export function inspectAsarChinese(options = {}) {
  const asarPath = findAsarPath(options.asarPath, options.env, options.platform, options.homeDir);
  if (!asarPath) {
    return { ok: true, found: false, asarPath: null, injected: false, isMinibarTag: false, bakExists: false };
  }
  const bakPath = `${asarPath}.bak`;
  const preload = builtinAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
  const injected = hasChineseInjection(preload);
  const isMinibarTag = preload.includes(TAG_START);
  const stat = fs.statSync(asarPath);
  return {
    ok: true,
    found: true,
    asarPath,
    bakPath,
    bakExists: fs.existsSync(bakPath),
    injected,
    isMinibarTag,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

export function patchAsarChinese(options = {}) {
  const asarPath = findAsarPath(options.asarPath, options.env, options.platform, options.homeDir);
  if (!asarPath) {
    throw new Error('未检测到本机 Antigravity 客户端 (app.asar)，可通过 --asar <路径> 手动指定。');
  }
  const dictPath = options.dictPath || path.join(TOOLKIT_DIR, 'i18n', 'zh-CN.json');
  const runtimePath = options.runtimePath || path.join(TOOLKIT_DIR, 'i18n', 'i18n-runtime.js');
  if (!fs.existsSync(dictPath) || !fs.existsSync(runtimePath)) {
    throw new Error(`缺少汉化资源文件: ${dictPath} 或 ${runtimePath}`);
  }

  const preloadOrig = builtinAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
  if (!options.force && preloadOrig.includes(TAG_START)) {
    return { ok: true, changed: false, asarPath, message: 'app.asar 已注入当前版本汉化，无需重复写入' };
  }

  const dictContent = fs.readFileSync(dictPath, 'utf8');
  const runtimeContent = fs.readFileSync(runtimePath, 'utf8');
  const cleanedPreload = cleanPreloadChinese(preloadOrig);
  const nextPreload = cleanedPreload + buildChinesePreloadBlock(dictContent, runtimeContent, options.brandTitle);
  const syntaxRes = validateJsSyntax(nextPreload, 'dist/preload.js');
  if (syntaxRes !== true) {
    throw new Error(`注入后 dist/preload.js 语法校验失败: ${syntaxRes.message}`);
  }

  const bakPath = `${asarPath}.bak`;
  if (!fs.existsSync(bakPath) && !hasChineseInjection(preloadOrig)) {
    fs.copyFileSync(asarPath, bakPath);
  }

  const stamp = `${process.pid}_${Date.now()}`;
  const staging = path.join(os.tmpdir(), `agy-minibar-asar-${stamp}`);
  const packed = path.join(os.tmpdir(), `agy-minibar-asar-${stamp}.asar`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    builtinAsar.extractAll(asarPath, staging);
    fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), nextPreload, 'utf8');
    const unpackedPaths = collectUnpackedPaths(asarPath);
    builtinAsar.createPackageWithOptions(staging, packed, unpackedPaths.size > 0 ? { unpackedPaths } : {});
    const verifiedCount = verifyArchiveIntegrity(asarPath, packed, new Set([path.normalize('dist/preload.js')]));
    replaceFileSafely(packed, asarPath);
    return {
      ok: true,
      changed: true,
      asarPath,
      bakPath: fs.existsSync(bakPath) ? bakPath : null,
      verifiedUnchangedFiles: verifiedCount,
      message: `已完成 app.asar 汉化注入 (校验 ${verifiedCount} 个原文件 SHA-256 无损)`
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(packed)) fs.unlinkSync(packed); } catch {}
    try { if (fs.existsSync(`${packed}.unpacked`)) fs.rmSync(`${packed}.unpacked`, { recursive: true, force: true }); } catch {}
  }
}

export function restoreAsarChinese(options = {}) {
  const asarPath = findAsarPath(options.asarPath, options.env, options.platform, options.homeDir);
  if (!asarPath) {
    throw new Error('未检测到本机 Antigravity 客户端 (app.asar)。');
  }
  const preloadOrig = builtinAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
  if (!hasChineseInjection(preloadOrig)) {
    return { ok: true, changed: false, asarPath, message: 'app.asar 当前为未汉化状态，无需还原' };
  }

  const nextPreload = cleanPreloadChinese(preloadOrig);
  const syntaxRes = validateJsSyntax(nextPreload, 'dist/preload.js');
  if (syntaxRes !== true) {
    throw new Error(`剥离汉化后 dist/preload.js 语法校验失败: ${syntaxRes.message}`);
  }

  const stamp = `${process.pid}_${Date.now()}`;
  const staging = path.join(os.tmpdir(), `agy-minibar-restore-${stamp}`);
  const packed = path.join(os.tmpdir(), `agy-minibar-restore-${stamp}.asar`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    builtinAsar.extractAll(asarPath, staging);
    fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), nextPreload, 'utf8');
    const unpackedPaths = collectUnpackedPaths(asarPath);
    builtinAsar.createPackageWithOptions(staging, packed, unpackedPaths.size > 0 ? { unpackedPaths } : {});
    const verifiedCount = verifyArchiveIntegrity(asarPath, packed, new Set([path.normalize('dist/preload.js')]));
    replaceFileSafely(packed, asarPath);
    return {
      ok: true,
      changed: true,
      asarPath,
      verifiedUnchangedFiles: verifiedCount,
      message: `已移除 app.asar 汉化注入并还原英文原版 (校验 ${verifiedCount} 个原文件 SHA-256 无损)`
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(packed)) fs.unlinkSync(packed); } catch {}
    try { if (fs.existsSync(`${packed}.unpacked`)) fs.rmSync(`${packed}.unpacked`, { recursive: true, force: true }); } catch {}
  }
}
