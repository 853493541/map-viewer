/**
 * Static + export API server for the map viewer.
 *
 * Adds:
 * 1) POST /api/export-full -> build self-contained full export on Desktop (sidecar collision only)
 * 2) POST /api/export-full-with-collision -> alias of sidecar-only full export
 * 3) POST /api/export-regional-with-collision -> region-required sidecar-only export
 * 4) GET  /api/full-exports -> list exported packages
 * 5) GET  /full-exports/* -> serve exported package files
 */

import { createServer } from 'http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { spawn, execFileSync } from 'child_process';
import { join, extname, dirname, resolve, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { generateCollisionDataForExport } from './tools/collision-generator.js';
import { createJx3CacheReader } from './tools/jx3-cache-reader.js';
import zlib from 'zlib';
import iconv from 'iconv-lite';

// Trap silent crashes so long sweeps (pss-classkey-sweep etc.) do not kill
// the server without a stack trace. Log and stay up.
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err?.stack || err); } catch { /* noop */ }
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[unhandledRejection]', reason?.stack || reason); } catch { /* noop */ }
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(join(__dirname, 'public'));
const NODE_MODULES_DIR = resolve(join(__dirname, 'node_modules'));
const PORT = Number(process.env.PORT) || 3015;
const DESKTOP_EXPORT_ROOT = resolve(join(os.homedir(), 'Desktop', 'JX3FullExports'));
const MOVIE_EDITOR_ROOT = resolve('C:/SeasunGame/MovieEditor');
const MOVIE_EDITOR_SOURCE_ROOT = join(MOVIE_EDITOR_ROOT, 'source');
const MOVIE_EDITOR_EXPORT_ROOT = join(MOVIE_EDITOR_SOURCE_ROOT, 'fbx');
const REPO_CLIPS_ROOT = resolve(join(PUBLIC_DIR, 'repo-clips'));
const RESOURCE_GROUPS_FILE = resolve(join(__dirname, 'tools', 'actor-resource-groups.json'));
const MOVIE_EDITOR_RESOURCEPACK_ROOT = join(MOVIE_EDITOR_ROOT, 'ResourcePack');
const MOVIE_EDITOR_ANI_TABLE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'AniTable.txt');
const MOVIE_EDITOR_TANI_TABLE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'Tani.rt');
const MOVIE_EDITOR_SFX_TABLE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'Sfx.rt');
const MOVIE_EDITOR_PSS_TABLE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'Pss.rt');
const MOVIE_EDITOR_SOCKET_TABLE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'Socket.tab');
const MOVIE_EDITOR_SOCKET_PARENT_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'SocketToParentBone.ini');
const MOVIE_EDITOR_ACTION_MUSIC_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'PropertyTemplate', 'ActionMusic.tab');
const MOVIE_EDITOR_ACTION_WWISE_PATH = join(MOVIE_EDITOR_RESOURCEPACK_ROOT, 'PropertyTemplate', 'ActionWwiseEvent.tab');
const JX3_CACHE_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat');
const JX3_LZHAM_DLL_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');
const SFX_EXTRACTED_DIR = resolve(join(PUBLIC_DIR, 'map-data', 'sfx-extracted'));
const SFX_PAK_EXTRACT_DIR = resolve(join(PUBLIC_DIR, 'map-data', 'sfx-pak-extract'));
const SFX_PATH_MAPPING_PATH = resolve(join(PUBLIC_DIR, 'map-data', 'sfx-path-mapping.json'));
const PSS_EXTRACT_DIR = resolve(join(__dirname, 'tools', 'pss-cache'));
const PSS_ASSET_EXTRACT_DIR = join(PSS_EXTRACT_DIR, '_assets');
const PSS_MESH_GLB_CACHE_DIR = join(PSS_EXTRACT_DIR, '_mesh-glb');
const PSS_MESH_CONVERTER_SCRIPT = resolve(join(__dirname, 'tools', 'convert_pss_mesh_to_glb.py'));
const QMODEL_EMBEDDED_PYTHON_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qmodeleditor/scriptpython/envs/python310/python.exe');
const BLENDER_EMBEDDED_PYTHON_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qmodeleditor/tools/blender/4.2/python/bin/python.exe');
const PAKV4_EXTRACT_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/bin64/PakV4SfxExtract.exe');
const TGATOOL_CONFIG_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qmodeleditor/tools/texturetoolhd/tgatoolconfig.ini');
const HXB_DECODE_TMP_DIR = join(PSS_EXTRACT_DIR, '_tex', '_decode_tmp');
const ACTOR_PLOT_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/movieeditor/source/plot/actor');
const PLAYER_ANIM_TABLE_DIR = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qmodeleditor/scriptlua/settings/represent/player');
const TANI_RT_PATH = resolve('C:/SeasunGame/MovieEditor/ResourcePack/Tani.rt');
const GB18030_DECODER = new TextDecoder('gb18030');
const GB18030_ENCODER = new TextEncoder(); // Note: TextEncoder only does UTF-8; we need iconv for GBK
// PSS sprite-block module names. Each entry is a Chinese-named module
// marker found in the variable-length section of a type-1 (sprite) block.
// Verified by binary audit of 80 cached PSS files (see tools/audit-parser-
// logic.cjs and tools/audit-candidate-names.cjs in 2026-04-26 audit):
//
//   - "Phantom" names removed (zero matches in any of 80 files):
//     重力 (gravity), 发射率 (emissionRate), 尺寸, 生命, 加速, 起始,
//     扭转曲强度 (typo of 扭曲强度), 境域, 境墟, 韵濡 (decode-error noise).
//     Gravity / emission rate are NOT name-tagged Chinese modules in this
//     PSS format — they are stored as fixed-offset numeric fields elsewhere
//     (or simply not authored at this layer for current skill effects).
//
//   - 20 newly-confirmed names added (each appears in >=5 distinct files,
//     >=13 total occurrences across the 80-file corpus).
const CONFIRMED_PSS_MODULE_NAMES = [
  // Core sprite modules (verified)
  '亮度', '速度', '颜色', '加强', '缩放', '羽化', '羽化颜色',
  '通道', '贴图', '通道贴图', '消散贴图', '颜色贴图',
  '颜色贴图旋转', '颜色贴图单次', '颜色贴图重复', '颜色贴图自定义',
  '特效', '光效', '烟雾', '消散', '消散密度', '四方连续',
  '火焰纹理', '层图', '纹理', '轨迹',
  '勾边', '勾边宽度', '勾边颜色',
  // Newly added 2026-04-26 from binary audit (each appears in >=5 files)
  '扭曲强度', '旋转', '开启深度', '关闭深度', '偏移',
  '颜色贴图缩放', '颜色贴图速度', '其他',
  '消散贴图速度', '消散贴图偏移',
  '扭曲速度', '扭曲贴图', '扭曲缩放',
  '通道贴图缩放', '通道贴图重复',
  '流光', '层雾', '极光', '边缘模糊', '无缝',
  // Issue #4 round-2 additions (2026-04-26 second audit, tools/audit-issue4.cjs)
  // Each name verified by:
  //   (a) appearing as a real Chinese particle-system module word, AND
  //   (b) >=3 distinct PSS files, OR appearing as a clear domain term
  //       (e.g. 法线/normal, 遮罩/mask) with >=2 files.
  '吞探', '沙尘', '波纹', '渐入', '通道贴图单次', '刀光溶解',
  '水纹', '光球', '颜色贴图偏移', '光线', '噪点贴图',
  '纹理烟影', '光点', '星空纹理', '流光颜色', '强度控制',
  '流光区域贴图', '流光亮度', '通道贴图偏移', '烟火',
  '通道贴图旋转', '水波', '流光区域', '法线', '柔光',
  '光圈', '消散贴图旋转', '云烟雾', '轮廓范围幂', '轮廓光强度',
  '条带', '闪电', '羽化强度', '遮罩',
  // Issue #4 round-3 (2026-04-26): discovered via anchored-search audit
  // listing remaining unknownModules with offsets — `方向消失程度` is a
  // real 6-char particle-fade module surfaced at varStart+1040 in jc02
  // block #45 (len=12).
  '方向消失程度',
];
const MODULE_NAME_WHITELIST = new Set(CONFIRMED_PSS_MODULE_NAMES);

// Precomputed GB18030 byte buffer for each whitelist name. Anchored
// byte-search uses these to find module-name occurrences inside a sprite
// block's variable region instead of doing a maximal-Hanzi-pair run scan
// + decode + whitelist lookup. Anchored search has two structural wins:
//   1. Random parameter bytes (floats / ints / struct fields) cannot
//      coincide with a 4+ byte specific GB18030 sequence (probability is
//      effectively zero), so byte-pair coincidence noise is eliminated.
//   2. The implicit prefix-peel salvage from round-2 (e.g. "燖颜色" →
//      "颜色") is automatically handled — if the real name "颜色" exists
//      anywhere in the buffer, anchored search finds its exact bytes
//      regardless of what surrounds them.
const MODULE_NAME_BYTES = (() => {
  const out = [];
  for (const name of CONFIRMED_PSS_MODULE_NAMES) {
    out.push({ name, bytes: iconv.encode(name, 'gb18030') });
  }
  // Sort by descending length so longer names are matched before shorter
  // names that are their suffixes (e.g. `颜色贴图旋转` matched before
  // `颜色`). This guarantees the anchored search reports the longest
  // possible name at any offset.
  out.sort((a, b) => b.bytes.length - a.bytes.length);
  return out;
})();

// Spawn-launcher SHAPE enum recovered by RTTI walk of
// kg3denginedx11ex64.dll. Each KG3D_Launcher{Shape}::GetShape virtual
// (vtable slot 11 in module-launcher classes) returns the file's
// spawnLauncherTypeId byte as a constant. See tools/diag-rtti-launcher.py.
// Empirically validated: across 22 cached PSS files, only values {1,2,3}
// appear (Sphere=40, Cirque=22, Rectangle=1) — exactly the shape enum
// range, not PARSYS_LAUNCHER_TYPE (which would have included 0 for the
// dominant ParticleLauncher case).
const PSS_SPAWN_SHAPE_TYPE_MAP = Object.freeze({
  0: { className: 'KG3D_LauncherPoint',           label: '点',       geometry: 'point (no volume)' },
  1: { className: 'KG3D_LauncherRectangle',       label: '矩形',     geometry: 'box volume (fBoxX/Y/Z)' },
  2: { className: 'KG3D_LauncherCirque',          label: '圆环',     geometry: 'ring/annulus volume' },
  3: { className: 'KG3D_LauncherSphere',          label: '球体',     geometry: 'sphere volume' },
  4: { className: 'KG3D_LauncherCylinder',        label: '圆柱',     geometry: 'cylinder volume' },
  37: { className: 'KG3D_LauncherPolygon',        label: '多边形',   geometry: 'polygon footprint' },
  39: { className: 'KG3D_LauncherCustom',         label: '自定义',   geometry: 'custom mesh' },
  42: { className: 'KG3D_LauncherDynamicTriangle',label: '动态三角形', geometry: 'dynamic triangle' },
  48: { className: 'KG3D_LauncherCurlNoise',      label: '卷曲噪声', geometry: 'curl-noise field' },
  67: { className: 'KG3D_LauncherMapDefine',      label: '地图定义', geometry: 'map-defined region' },
});
const MOVIE_EDITOR_TABLE_CACHE = new Map();
const PLAYER_ANIM_CACHE = new Map();
let JX3_CACHE_READER = null;
let RESOLVED_CRUNCH_EXE_PATH;
const siblingRuntimeTemplateCache = new Map();
let globalPssRenderLog = null; // stores last client PSS render debug POST

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.dds': 'application/octet-stream',
  '.sfx': 'application/octet-stream',
  '.ani': 'application/octet-stream',
  '.actor': 'text/plain; charset=utf-8',
  '.actmtl': 'application/octet-stream',
  '.ico': 'image/x-icon',
  '.lua': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function normalizeExePath(rawPath) {
  if (!rawPath) return '';
  let value = String(rawPath).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function parseCrunchExeFromTgaConfig() {
  if (!existsSync(TGATOOL_CONFIG_PATH)) return '';
  const text = readTextUtf8(TGATOOL_CONFIG_PATH, '');
  if (!text) return '';

  let inSection = false;
  const lines = text.split(/\r?\n/g);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inSection = line.toLowerCase() === '[crunchexeoption]';
      continue;
    }
    if (!inSection) continue;

    const match = line.match(/^path_01\s*=\s*(.+)$/i);
    if (!match) continue;
    return normalizeExePath(match[1]);
  }

  return '';
}

function resolveCrunchExePath() {
  if (RESOLVED_CRUNCH_EXE_PATH !== undefined) return RESOLVED_CRUNCH_EXE_PATH;

  const candidates = [];
  if (process.env.PSS_CRUNCH_EXE) candidates.push(process.env.PSS_CRUNCH_EXE);

  const fromConfig = parseCrunchExeFromTgaConfig();
  if (fromConfig) candidates.push(fromConfig);

  candidates.push(
    resolve(join(__dirname, 'tools', 'third-party', 'crunch.exe')),
    resolve('C:/Temp/npm_crunchitize/crunch.exe'),
    resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qmodeleditor/tools/texturetoolhd/crunch.exe'),
  );

  try {
    const whereOut = execFileSync('where', ['crunch.exe'], {
      timeout: 1500,
      windowsHide: true,
      encoding: 'utf8',
    });
    const first = String(whereOut).split(/\r?\n/g).map((line) => line.trim()).find(Boolean);
    if (first) candidates.push(first);
  } catch {
    // Ignore PATH lookup failures.
  }

  for (const candidateRaw of candidates) {
    const candidate = normalizeExePath(candidateRaw);
    if (!candidate) continue;
    if (existsSync(candidate)) {
      RESOLVED_CRUNCH_EXE_PATH = candidate;
      return candidate;
    }
  }

  RESOLVED_CRUNCH_EXE_PATH = null;
  return null;
}

function isDdsHeader(header) {
  return Buffer.isBuffer(header)
    && header.length >= 4
    && header[0] === 0x44
    && header[1] === 0x44
    && header[2] === 0x53
    && header[3] === 0x20;
}

function isHxHeader(header) {
  return Buffer.isBuffer(header)
    && header.length >= 4
    && header[0] === 0x48
    && header[1] === 0x78
    && header[2] === 0x00
    && (header[3] === 0x62 || header[3] === 0x4a);
}

function tryDecodeHxTextureToDds(extractedPath) {
  if (!extractedPath || !existsSync(extractedPath)) return false;
  const crunchExe = resolveCrunchExePath();
  if (!crunchExe) return false;

  ensureDir(HXB_DECODE_TMP_DIR);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const tempIn = join(HXB_DECODE_TMP_DIR, `${stamp}.crn`);
  const tempOut = join(HXB_DECODE_TMP_DIR, `${stamp}.dds`);

  try {
    // crunch.exe fails on some Unicode paths, so decode via ASCII temp files.
    copyFileSync(extractedPath, tempIn);
    execFileSync(crunchExe, ['-file', tempIn, '-out', tempOut], {
      timeout: 15000,
      windowsHide: true,
    });
    if (!existsSync(tempOut)) return false;

    const decodedHeader = readFileSync(tempOut, { encoding: null }).subarray(0, 4);
    if (!isDdsHeader(decodedHeader)) return false;

    copyFileSync(tempOut, extractedPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (existsSync(tempIn)) unlinkSync(tempIn);
    } catch {
      // Ignore cleanup failures.
    }
    try {
      if (existsSync(tempOut)) unlinkSync(tempOut);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function safePathUnder(root, relPath) {
  const decoded = decodeURIComponent(relPath || '');
  const abs = resolve(join(root, decoded));
  if (!abs.startsWith(root)) return null;
  return abs;
}

function encodeUrlPathSegments(pathLike) {
  return String(pathLike || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function readTextUtf8(filePath, fallback = '') {
  if (!existsSync(filePath)) return fallback;
  return readFileSync(filePath, 'utf8');
}

function readTextDecoded(filePath, encoding = 'utf8', fallback = '') {
  if (!existsSync(filePath)) return fallback;

  const buffer = readFileSync(filePath);
  if (!buffer.length) return '';
  if (encoding === 'gb18030') {
    return GB18030_DECODER.decode(buffer);
  }
  return buffer.toString('utf8');
}

function isGb18030HanziPair(byte1, byte2) {
  return byte1 >= 0x81 && byte1 <= 0xFE && byte2 >= 0x40 && byte2 <= 0xFE && byte2 !== 0x7F;
}

function isHanziOnlyString(value) {
  if (!value) return false;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp < 0x4E00 || cp > 0x9FFF) return false;
  }
  return true;
}
function windowLooksLikeAsciiPath(buffer, start, length, rangeStart, rangeEnd) {
  const prevByte = start > rangeStart ? buffer[start - 1] : 0;
  const nextByte = start + length < rangeEnd ? buffer[start + length] : 0;
  if (prevByte === 0x5c || prevByte === 0x2f || nextByte === 0x5c || nextByte === 0x2f) {
    return true;
  }

  const winStart = Math.max(rangeStart, start - 8);
  const winEnd = Math.min(rangeEnd, start + length + 16);
  let slashCount = 0;
  let asciiCount = 0;
  for (let i = winStart; i < winEnd; i++) {
    const byte = buffer[i];
    if (byte === 0x5c || byte === 0x2f) slashCount++;
    if ((byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5A)
      || (byte >= 0x61 && byte <= 0x7A)
      || byte === 0x2e
      || byte === 0x5f) {
      asciiCount++;
    }
  }

  for (let i = winStart; i + 3 < winEnd; i++) {
    if (buffer[i] !== 0x2e) continue;
    const ext = String.fromCharCode(buffer[i + 1] || 0, buffer[i + 2] || 0, buffer[i + 3] || 0).toLowerCase();
    if (ext === 'tga' || ext === 'dds' || ext === 'png') return true;
  }

  return slashCount >= 1 && asciiCount >= 6;
}

function extractConfirmedSpriteModules(buffer, blockStart, blockEnd) {
  const varStart = blockStart + 856;
  const varEnd = blockEnd - 152;
  const occurrences = [];

  if (varEnd <= varStart) {
    return { validModules: [], unknownModules: [] };
  }

  // Anchored byte-search (Issue #4 round-3, 2026-04-26):
  //   Earlier rounds did a maximal-Hanzi-pair run scan + decode + whitelist
  //   lookup. Two failure modes:
  //     (1) Random parameter bytes (floats / ints / struct fields) sometimes
  //         coincidentally encode as valid GB18030 Hanzi-pairs. Even after
  //         filtering out ASCII-path windows, ~57 nonsense runs (誃罀/絇毦/
  //         鉁箭/etc.) still surfaced for jc02 alone.
  //     (2) Real names with leading upstream-byte contamination (燖颜色 etc.)
  //         needed a peel-salvage hack.
  //   Both go away with anchored search: for each known module name, search
  //   its exact GB18030 byte sequence in the variable region. Random bytes
  //   cannot coincide with a 4+ byte specific sequence, and contaminated
  //   prefixes don't matter because the real name's bytes still appear at
  //   their true offset.
  //
  // Multi-emitter sprite blocks repeat the same module-name set per emitter
  // (e.g. block #15 of t_天策尖刺02.pss has 4 emitters, each declaring its
  // own 通道/速度/缩放 trio). Keep all occurrences; downstream payload
  // extraction uses the next-occurrence offset to compute per-emitter
  // boundaries.
  //
  // To avoid double-counting suffix matches (e.g. `颜色贴图旋转` containing
  // `颜色`), we sort MODULE_NAME_BYTES by descending length and skip any
  // offset already claimed by a longer match.
  const claimed = new Uint8Array(varEnd - varStart);
  for (const { name, bytes } of MODULE_NAME_BYTES) {
    const nameLen = bytes.length;
    if (nameLen < 2) continue;
    let i = varStart;
    while (i <= varEnd - nameLen) {
      // Quick first-byte test before subarray comparison.
      if (buffer[i] !== bytes[0]) { i++; continue; }
      let match = true;
      for (let j = 1; j < nameLen; j++) {
        if (buffer[i + j] !== bytes[j]) { match = false; break; }
      }
      if (match) {
        // Skip if any byte in [i, i+nameLen) is already claimed by a
        // longer name match.
        let blocked = false;
        for (let j = 0; j < nameLen; j++) {
          if (claimed[i - varStart + j]) { blocked = true; break; }
        }
        if (!blocked) {
          // Reject if surrounded by ASCII-path bytes (e.g. embedded inside
          // a texture path like "data/.../特效/xxx.tga"). These are not
          // module-name records.
          if (!windowLooksLikeAsciiPath(buffer, i, nameLen, varStart, varEnd)) {
            occurrences.push({ offset: i - blockStart, name });
            for (let j = 0; j < nameLen; j++) claimed[i - varStart + j] = 1;
          }
        }
        i += nameLen;
      } else {
        i++;
      }
    }
  }

  occurrences.sort((left, right) => left.offset - right.offset);
  return {
    validModules: occurrences,
    // Anchored search has no concept of "unknown candidate runs" — by
    // definition we only find names from the whitelist. Discovery of new
    // module names is handled by the offline tools/audit-issue4.cjs
    // pipeline, which intentionally uses the maximal-Hanzi-pair scan
    // against all 80 PSS files and ranks candidates by frequency.
    unknownModules: [],
  };
}

function getFileStamp(filePath) {
  if (!existsSync(filePath)) return 'missing';
  const stats = statSync(filePath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function getJx3CacheReader() {
  if (JX3_CACHE_READER) return JX3_CACHE_READER;
  JX3_CACHE_READER = createJx3CacheReader({
    cacheRoot: JX3_CACHE_ROOT,
    lzhamDllPath: JX3_LZHAM_DLL_PATH,
  });
  return JX3_CACHE_READER;
}

function getCachedFileData(cacheKey, filePath, loader) {
  const stamp = `${filePath}:${getFileStamp(filePath)}`;
  const cached = MOVIE_EDITOR_TABLE_CACHE.get(cacheKey);
  if (cached?.stamp === stamp) {
    return cached.value;
  }

  const value = loader();
  MOVIE_EDITOR_TABLE_CACHE.set(cacheKey, { stamp, value });
  return value;
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function parseTabbedTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);

  if (!lines.length) return [];

  const headers = lines[0].split('\t').map((value, index) => stripBom(value) || `col${index}`);
  return lines.slice(1)
    .map((line) => {
      const cells = line.split('\t');
      const row = {};
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? '';
      });
      return row;
    })
    .filter((row) => Object.values(row).some((value) => String(value || '').trim().length > 0));
}

function readMovieEditorTable(cacheKey, filePath) {
  return getCachedFileData(cacheKey, filePath, () => parseTabbedTable(readTextDecoded(filePath, 'gb18030', '')));
}

function pickRowValue(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = String(row[key] ?? '').trim();
      if (value) return value;
    }
  }
  return '';
}

function normalizeCatalogPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function basenameFromCatalogPath(value) {
  const normalized = normalizeCatalogPath(value);
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function buildEffectSearchKeys(...values) {
  const keys = new Set();

  for (const rawValue of values.flat(Infinity)) {
    const text = String(rawValue || '').trim();
    if (!text) continue;

    const hasPathSeparator = /[\\/]/.test(text);
    const variants = hasPathSeparator
      ? [basenameFromCatalogPath(text)]
      : [text, basenameFromCatalogPath(text)];
    for (const variant of variants) {
      const compact = String(variant || '')
        .trim()
        .toLowerCase()
        .replace(/\.[^./\\]+$/i, '')
        .replace(/[\\/]/g, ' ')
        .replace(/[_\-\s]+/g, '')
        .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, '');

      if (compact.length >= 2) keys.add(compact);

      const chineseCore = compact.replace(/[a-z]+/g, '').replace(/\d+/g, '');
      if (chineseCore.length >= 2) keys.add(chineseCore);

      const stripped = compact.replace(/^[a-z]+/g, '').replace(/\d+$/g, '');
      if (stripped.length >= 2) keys.add(stripped);
    }
  }

  return [...keys];
}

function scoreRelatedEffectMatch(targetKeys, candidateKeys) {
  let bestScore = 0;

  for (const target of targetKeys) {
    if (!target) continue;
    for (const candidate of candidateKeys) {
      if (!candidate) continue;
      if (target === candidate) {
        bestScore = Math.max(bestScore, 120 + Math.min(target.length, 24));
        continue;
      }
      if (target.includes(candidate) || candidate.includes(target)) {
        bestScore = Math.max(bestScore, 70 + Math.min(target.length, candidate.length));
      }
    }
  }

  return bestScore;
}

// Synthetic preview palette/mode removed — no keyword-based fallback
// previews. Callers must present "not available" when the real .sfx bytes
// are missing.
function buildSyntheticPreviewDescriptor(_resource, _pssResources) {
  return { available: false, reason: 'no-fallback-preview' };
}

function _unusedSyntheticPreviewDescriptorLegacy(resource, pssResources) {
  const resourceKeys = buildEffectSearchKeys(resource.name, resource.sourcePath, resource.shellPath);
  const relatedPss = (pssResources || [])
    .map((candidate) => ({
      candidate,
      score: scoreRelatedEffectMatch(resourceKeys, candidate.searchKeys || []),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return String(left.candidate.name || left.candidate.sourcePath)
        .localeCompare(String(right.candidate.name || right.candidate.sourcePath), undefined, { sensitivity: 'base' });
    })
    .slice(0, 4)
    .map((entry) => ({
      id: entry.candidate.id,
      name: entry.candidate.name,
      sourcePath: entry.candidate.sourcePath,
      shellPath: entry.candidate.shellPath,
      matchScore: entry.score,
    }));

  const descriptorText = [
    resource.name,
    resource.sourcePath,
    resource.shellPath,
    ...relatedPss.map((entry) => [entry.name, entry.sourcePath]),
  ].flat().join(' ');
  const mode = pickSyntheticPreviewMode(descriptorText);

  return {
    available: true,
    mode,
    palette: pickSyntheticPreviewPalette(descriptorText, mode),
    rationale: relatedPss.length
      ? `Exact .sfx bytes are not in local cache. Closest PSS match: ${relatedPss[0].name}.`
      : 'Exact .sfx bytes are not in local cache. Preview is guessed from the SFX name and path.',
    relatedPss,
  };
}

function matchesCatalogQuery(query, values) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;

  return values
    .flat(Infinity)
    .some((value) => String(value || '').toLowerCase().includes(needle));
}

function buildCatalogSearchBlob(values) {
  return values
    .flat(Infinity)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
}

function formatUint64Hex(value) {
  const normalized = BigInt.asUintN(64, BigInt(value || 0));
  return `0x${normalized.toString(16).toUpperCase().padStart(16, '0')}`;
}

function formatHexDump(buffer, byteLimit = 128, rowWidth = 16) {
  const slice = buffer.subarray(0, Math.min(byteLimit, buffer.length));
  const rows = [];
  for (let index = 0; index < slice.length; index += rowWidth) {
    const row = slice.subarray(index, index + rowWidth);
    rows.push(Array.from(row, (value) => value.toString(16).toUpperCase().padStart(2, '0')).join(' '));
  }
  return rows;
}

function scoreTextCandidate(text) {
  const sample = String(text || '').slice(0, 6000);
  if (!sample.trim()) return -Infinity;

  let printable = 0;
  let weird = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) || 0;
    if (char === '\uFFFD' || code === 0) {
      weird += 4;
      continue;
    }

    const isPrintable = code === 9
      || code === 10
      || code === 13
      || (code >= 32 && code < 127)
      || (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0xFF00 && code <= 0xFFEF);

    if (isPrintable) printable += 1;
    else weird += 1;
  }

  return printable / Math.max(1, printable + weird);
}

function detectTextPayload(buffer) {
  const candidates = [
    { encoding: 'utf8', text: buffer.toString('utf8') },
    { encoding: 'utf16le', text: buffer.toString('utf16le') },
    { encoding: 'gb18030', text: GB18030_DECODER.decode(buffer) },
  ].map((candidate) => ({
    ...candidate,
    score: scoreTextCandidate(candidate.text),
  }));

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 0.78) {
    return {
      isLikelyText: false,
      encoding: best?.encoding || 'unknown',
      score: Number.isFinite(best?.score) ? best.score : 0,
      preview: '',
    };
  }

  return {
    isLikelyText: true,
    encoding: best.encoding,
    score: best.score,
    preview: best.text.slice(0, 12000),
  };
}

function extractAsciiStrings(buffer, minLength = 4, maxResults = 120) {
  const matches = buffer.toString('latin1').match(/[ -~]{4,}/g) || [];
  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const value = match.trim();
    if (value.length < minLength) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= maxResults) break;
  }
  return unique;
}

function extractUtf16Strings(buffer, minLength = 4, maxResults = 120) {
  const matches = buffer.toString('utf16le').match(/[\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]{4,}/g) || [];
  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const value = match.replace(/\u0000/g, '').trim();
    if (value.length < minLength) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= maxResults) break;
  }
  return unique;
}

function normalizeLogicalResourcePath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function getLogicalPathVariants(value) {
  const normalized = normalizeLogicalResourcePath(value);
  if (!normalized) return [];

  const variants = [normalized];
  const extension = extname(normalized).toLowerCase();
  if (extension === '.tga') {
    variants.push(`${normalized.slice(0, -4)}.dds`);
  }
  if (extension === '.dds') {
    variants.push(`${normalized.slice(0, -4)}.tga`);
  }

  return [...new Set(variants)];
}

function tryResolveCacheLogicalPath(value) {
  const requestedPath = normalizeLogicalResourcePath(value);
  if (!requestedPath) return null;

  for (const candidate of getLogicalPathVariants(requestedPath)) {
    try {
      const entry = getJx3CacheReader().resolveEntry(candidate);
      return {
        requestedPath,
        resolvedPath: entry.logicalPath,
        rawUrl: `/api/cache-entry/raw?logicalPath=${encodeURIComponent(entry.logicalPath)}`,
        entry,
      };
    } catch {
      // Try extension variants until one resolves.
    }
  }

  return null;
}

function classifyDependencyPath(value) {
  switch (extname(String(value || '')).toLowerCase()) {
    case '.dds':
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.tga':
    case '.bmp':
      return 'image';
    case '.wav':
    case '.wem':
    case '.bnk':
      return 'audio';
    case '.ani':
    case '.tani':
    case '.sfx':
      return 'effect';
    case '.mesh':
    case '.mdl':
      return 'mesh';
    default:
      return 'other';
  }
}

function mergeUniquePaths(pathGroups, maxResults = 120) {
  const results = [];
  const seen = new Set();

  for (const group of pathGroups) {
    for (const value of group || []) {
      const normalized = normalizeLogicalResourcePath(value);
      if (!normalized) continue;

      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(normalized);
      if (results.length >= maxResults) return results;
    }
  }

  return results;
}

function collectDependencyPaths(values, maxResults = 120) {
  const paths = [];
  const seen = new Set();
  const pattern = /(?:data|source|ui)[^\u0000\r\n"']+?\.(?:dds|png|jpg|jpeg|tga|bmp|lua|txt|ini|xml|mesh|mdl|sfx|ani|tani|wav|wem|bnk)/ig;

  for (const value of values) {
    const haystack = String(value || '');
    const matches = haystack.match(pattern) || [];
    for (const match of matches) {
      const normalized = normalizeLogicalResourcePath(match);
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(normalized);
      if (paths.length >= maxResults) return paths;
    }
  }

  return paths;
}

function extractBinaryDependencyPaths(buffer, maxResults = 120) {
  return collectDependencyPaths([
    GB18030_DECODER.decode(buffer),
  ], maxResults);
}

/**
 * Parse SFX binary format to extract per-particle texture layers.
 * SFX header: "SFX\0"(4) + version(4) + totalSize(4) + particleCount(4)
 * TOC: particleCount × (type:u32, offset:u32)
 * Particle types with textures: type 4 (billboard), type 5 (advanced), type 8 (trail)
 */
function parseSfxParticleLayers(buffer) {
  if (!buffer || buffer.length < 16) return null;
  if (buffer[0] !== 0x53 || buffer[1] !== 0x46 || buffer[2] !== 0x58) return null; // "SFX"

  const particleCount = buffer.readUInt32LE(12);
  if (particleCount < 1 || particleCount > 500) return null;

  const tocEnd = 16 + particleCount * 8;
  if (tocEnd > buffer.length) return null;

  const toc = [];
  for (let i = 0; i < particleCount; i++) {
    toc.push({
      type: buffer.readUInt32LE(16 + i * 8),
      offset: buffer.readUInt32LE(16 + i * 8 + 4),
    });
  }

  const textureLayers = [];
  const pathPattern = /data[\\\/][^\x00-\x1f]{4,}?\.(?:dds|tga|png)/gi;

  for (let i = 0; i < toc.length; i++) {
    const start = toc[i].offset;
    const end = i + 1 < toc.length ? toc[i + 1].offset : buffer.length;
    if (start >= buffer.length || end > buffer.length || start >= end) continue;

    const pType = toc[i].type;
    // Types 4, 5, 8 contain texture references
    if (pType !== 4 && pType !== 5 && pType !== 8) continue;

    const data = buffer.subarray(start, end);
    const decoded = GB18030_DECODER.decode(data);
    pathPattern.lastIndex = 0;
    const matches = decoded.match(pathPattern);
    if (!matches || matches.length === 0) continue;

    const texturePath = normalizeLogicalResourcePath(matches[0]);
    const resolved = tryResolveCacheLogicalPath(texturePath);

    // Try .dds variant if .tga not in cache
    let finalPath = texturePath;
    let finalResolved = resolved;
    if (!resolved && /\.tga$/i.test(texturePath)) {
      const ddsPath = texturePath.replace(/\.tga$/i, '.dds');
      const ddsResolved = tryResolveCacheLogicalPath(ddsPath);
      if (ddsResolved) { finalPath = ddsPath; finalResolved = ddsResolved; }
    }

    textureLayers.push({
      index: i,
      particleType: pType,
      texturePath: finalPath,
      rawUrl: finalResolved?.rawUrl || null,
      existsInCache: Boolean(finalResolved),
    });
  }

  return {
    particleCount,
    particleTypes: toc.map((t) => t.type),
    textureLayers,
  };
}

/**
 * Parse TRAC files used by PSS track emitters.
 * Layout observed in live assets: "TRAC" + version:u32 + count:u32 + token:u32 + count * 64-byte transforms.
 */
function parseTrackResourceBuffer(buffer) {
  if (!buffer || buffer.length < 16) return null;
  if (buffer[0] !== 0x54 || buffer[1] !== 0x52 || buffer[2] !== 0x41 || buffer[3] !== 0x43) return null; // "TRAC"

  const version = buffer.readUInt32LE(4);
  const declaredNodeCount = buffer.readUInt32LE(8);
  const sampleToken = buffer.readUInt32LE(12);
  const recordStride = 64;

  if (declaredNodeCount < 1 || declaredNodeCount > 8192) return null;
  const availableNodeCount = Math.floor((buffer.length - 16) / recordStride);
  const nodeCount = Math.min(declaredNodeCount, availableNodeCount);
  if (nodeCount < 1) return null;

  const roundFloat = (value) => Math.round(value * 1000000) / 1000000;
  const nodes = [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalLength = 0;
  let prevPoint = null;

  for (let i = 0; i < nodeCount; i++) {
    const base = 16 + i * recordStride;
    if (base + recordStride > buffer.length) break;

    const right = [
      roundFloat(buffer.readFloatLE(base + 0)),
      roundFloat(buffer.readFloatLE(base + 4)),
      roundFloat(buffer.readFloatLE(base + 8)),
    ];
    const up = [
      roundFloat(buffer.readFloatLE(base + 16)),
      roundFloat(buffer.readFloatLE(base + 20)),
      roundFloat(buffer.readFloatLE(base + 24)),
    ];
    const forward = [
      roundFloat(buffer.readFloatLE(base + 32)),
      roundFloat(buffer.readFloatLE(base + 36)),
      roundFloat(buffer.readFloatLE(base + 40)),
    ];

    const px = buffer.readFloatLE(base + 48);
    const py = buffer.readFloatLE(base + 52);
    const pz = buffer.readFloatLE(base + 56);
    const pw = buffer.readFloatLE(base + 60);

    if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;

    const position = [roundFloat(px), roundFloat(py), roundFloat(pz)];
    const point = { x: px, y: py, z: pz };
    if (prevPoint) {
      const dx = point.x - prevPoint.x;
      const dy = point.y - prevPoint.y;
      const dz = point.z - prevPoint.z;
      totalLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    prevPoint = point;

    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);

    nodes.push({
      index: i,
      position,
      right,
      up,
      forward,
      w: roundFloat(pw),
    });
  }

  if (!nodes.length) return null;

  return {
    format: 'TRAC',
    version,
    sampleToken,
    declaredNodeCount,
    nodeCount: nodes.length,
    recordStride,
    pathLength: roundFloat(totalLength),
    bounds: {
      min: [roundFloat(minX), roundFloat(minY), roundFloat(minZ)],
      max: [roundFloat(maxX), roundFloat(maxY), roundFloat(maxZ)],
    },
    nodes,
  };
}

/**
 * Texture category classification removed — no keyword-based categorization.
 * Callers receive null and must surface "unclassified" rather than guessing.
 */
function classifyEffectTexture(_texPath) {
  return null;
}

/**
 * Simple pseudo-random number generator (deterministic, seeded).
 */
function seededRandom(seed) {
  let s = seed | 0;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

/**
 * 2D value noise for procedural texture generation.
 */
function valueNoise2D(x, y, rng) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const hash = (a, b) => { let h = ((a * 374761393 + b * 668265263 + 1274126177) & 0x7fffffff); return (h >>> 0) / 0x7fffffff; };
  const n00 = hash(ix, iy), n10 = hash(ix + 1, iy), n01 = hash(ix, iy + 1), n11 = hash(ix + 1, iy + 1);
  return n00 * (1 - sx) * (1 - sy) + n10 * sx * (1 - sy) + n01 * (1 - sx) * sy + n11 * sx * sy;
}

function fbmNoise(x, y, octaves = 4) {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) { val += amp * valueNoise2D(x * freq, y * freq); amp *= 0.5; freq *= 2; }
  return val;
}

/**
 * Procedural placeholder PNG generation has been removed. The handler for
 * /api/pss/placeholder-tex now returns 204 No Content; the client must not
 * receive synthetic imagery.
 */
function generatePlaceholderPng() {
  throw new Error('generatePlaceholderPng removed: no synthetic textures');
}

function _unusedGeneratePlaceholderPngLegacy(category, texName = '', options = {}) {
  const SIZE = 128;
  const cx = SIZE / 2, cy = SIZE / 2, maxR = SIZE / 2;
  const name = String(texName).toLowerCase();
  const missingMode = options.missing === true;

  // Detect sub-type from texture filename
  let subType = 'glow';
  if (category === 'smoke') subType = 'cloud';
  else if (category === 'debris') subType = 'sparks';
  else if (name.includes('光圈') || name.includes('光环') || name.includes('环')) subType = 'ring';
  else if (name.includes('星') || name.includes('闪') || name.includes('star')) subType = 'star';
  else if (name.includes('通道') || name.includes('alpha') || name.includes('mask')) subType = 'mask';
  else if (name.includes('线') || name.includes('轨迹') || name.includes('line')) subType = 'streak';
  else if (name.includes('扭曲') || name.includes('distort')) subType = 'distort';
  else if (name.includes('波纹') || name.includes('wave')) subType = 'ring';
  else if (name.includes('裂') || name.includes('crack')) subType = 'sparks';

  const rawData = Buffer.alloc(SIZE * (1 + SIZE * 4));
  const seed = Array.from(texName || 'default').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = seededRandom(seed);

  for (let y = 0; y < SIZE; y++) {
    const rowOff = y * (1 + SIZE * 4);
    rawData[rowOff] = 0;
    for (let x = 0; x < SIZE; x++) {
      const off = rowOff + 1 + x * 4;
      const dx = (x - cx + 0.5) / maxR, dy = (y - cy + 0.5) / maxR;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let r = 255, g = 255, b = 255, a = 0;

      if (missingMode) {
        const checker = (((x >> 4) + (y >> 4)) & 1) === 0;
        const border = x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3;
        const cross = Math.abs(x - y) <= 1 || Math.abs((SIZE - 1 - x) - y) <= 1;
        r = checker ? 255 : 40;
        g = checker ? 0 : 10;
        b = checker ? 255 : 40;
        a = 255;
        if (border || cross) {
          r = 255; g = 255; b = 0;
        }
      } else if (subType === 'glow') {
        // Bright center, exponential falloff
        const intensity = Math.exp(-dist * dist * 3.5);
        r = Math.round(255 * intensity);
        g = Math.round(240 * intensity);
        b = Math.round(200 * intensity);
        a = Math.round(255 * Math.max(0, intensity));
      } else if (subType === 'cloud') {
        // Fractal noise cloud with soft circular edge
        const n = fbmNoise(x * 0.04 + seed * 0.1, y * 0.04 + seed * 0.13, 5);
        const edge = Math.max(0, 1 - dist * dist);
        const val = Math.max(0, n * edge);
        r = Math.round(220 + 35 * val);
        g = Math.round(220 + 35 * val);
        b = Math.round(225 + 30 * val);
        a = Math.round(200 * val * val);
      } else if (subType === 'sparks') {
        // Scattered bright sparks
        const n1 = valueNoise2D(x * 0.15 + seed, y * 0.15);
        const n2 = valueNoise2D(x * 0.3 + seed * 2, y * 0.3);
        const spark = Math.pow(Math.max(0, n1 * n2), 3) * 4;
        const edge = Math.max(0, 1 - dist);
        r = Math.round(255 * Math.min(1, spark));
        g = Math.round(200 * Math.min(1, spark * 0.6));
        b = Math.round(120 * Math.min(1, spark * 0.3));
        a = Math.round(255 * Math.min(1, spark * edge));
      } else if (subType === 'ring') {
        // Hollow ring
        const ringDist = Math.abs(dist - 0.6);
        const intensity = Math.exp(-ringDist * ringDist * 50);
        r = Math.round(255 * intensity);
        g = Math.round(255 * intensity);
        b = Math.round(255 * intensity);
        a = Math.round(230 * intensity);
      } else if (subType === 'star') {
        // 4-pointed star
        const angle = Math.atan2(dy, dx);
        const star = Math.pow(Math.abs(Math.cos(angle * 2)), 8);
        const core = Math.exp(-dist * dist * 4);
        const rays = star * Math.exp(-dist * 2) * 0.7;
        const intensity = Math.min(1, core + rays);
        r = Math.round(255 * intensity);
        g = Math.round(250 * intensity);
        b = Math.round(220 * intensity);
        a = Math.round(255 * intensity);
      } else if (subType === 'streak') {
        // Horizontal light streak
        const xFall = Math.exp(-dx * dx * 1.5);
        const yFall = Math.exp(-dy * dy * 12);
        const intensity = xFall * yFall;
        r = Math.round(255 * intensity);
        g = Math.round(240 * intensity);
        b = Math.round(220 * intensity);
        a = Math.round(240 * intensity);
      } else if (subType === 'mask') {
        // Soft circular alpha mask (white with alpha)
        const edge = Math.max(0, 1 - dist * dist);
        const n = fbmNoise(x * 0.06, y * 0.06, 3);
        const val = edge * (0.5 + 0.5 * n);
        r = g = b = 255;
        a = Math.round(255 * val);
      } else if (subType === 'distort') {
        // Normal map-like distortion texture
        const n1 = fbmNoise(x * 0.05, y * 0.05, 3);
        const n2 = fbmNoise(x * 0.05 + 100, y * 0.05 + 100, 3);
        const edge = Math.max(0, 1 - dist);
        r = Math.round(128 + 127 * (n1 - 0.5));
        g = Math.round(128 + 127 * (n2 - 0.5));
        b = 255;
        a = Math.round(200 * edge);
      } else {
        // Default soft glow
        const intensity = Math.max(0, 1 - dist * dist);
        r = Math.round(200 * intensity); g = Math.round(220 * intensity); b = Math.round(255 * intensity);
        a = Math.round(220 * intensity);
      }

      rawData[off] = Math.min(255, Math.max(0, r));
      rawData[off + 1] = Math.min(255, Math.max(0, g));
      rawData[off + 2] = Math.min(255, Math.max(0, b));
      rawData[off + 3] = Math.min(255, Math.max(0, a));
    }
  }

  const compressed = zlib.deflateSync(rawData);

  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);  // width
  ihdr.writeUInt32BE(SIZE, 4);  // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const ihdrChunk = pngChunk('IHDR', ihdr);

  // IDAT chunk
  const idatChunk = pngChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeB, data]);
  // CRC32 over type + data
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0);
  return Buffer.concat([len, payload, crcB]);
}

/**
 * Parse PSS (Particle Scene System) binary — TOC-based parsing.
 *
 * Layout:  "PAR\0" (4 bytes)  +  version (u16)  +  flags (u16)  +  ??? (u32)
 *          +  emitterCount (u32 @ offset 12)
 *          +  TOC: emitterCount × { type(u32), offset(u32), size(u32) }  (12 bytes each)
 *          +  emitter data blocks
 *
 * Emitter types:  0 = global settings,  1 = sprite/billboard particle,
 *                 2 = mesh emitter,  3 = track/spline
 *
 * Type-1 block layout:
 *   u32(12) + u32(subDataSize) + u32(0)
 *   null-terminated material path (GB18030)
 *   fixed-size padding/fields (zeros)
 *   null-terminated texture path(s) (GB18030), each separated by binary data
 *   trailing emitter property data
 */
function parsePssEffectScene(buffer, options = {}) {
  if (!buffer || buffer.length < 16) return null;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x41 || buffer[2] !== 0x52 || buffer[3] !== 0x00) return null;

  // options is accepted for API stability but no option is currently read.
  void options;

  const version = buffer.readUInt16LE(4);
  const emitterCount = buffer.readUInt32LE(12);
  const tocEnd = 16 + emitterCount * 12;
  if (tocEnd > buffer.length) return null;

  // ── Parse TOC ──
  const toc = [];
  for (let i = 0; i < emitterCount; i++) {
    const base = 16 + i * 12;
    toc.push({
      type: buffer.readUInt32LE(base),
      offset: buffer.readUInt32LE(base + 4),
      size: buffer.readUInt32LE(base + 8),
    });
  }

  // ── Parse global block (type 0) for effect timing ──
  // No defaults: all timing fields are null unless the authored global block
  // supplies an in-range value.
  let globalDuration = null;
  let globalStartDelay = null;
  let globalPlayDuration = null;
  let globalLoopEnd = null;
  const globalBlock = toc.find(e => e.type === 0);
  if (globalBlock && globalBlock.size >= 20) {
    const o = globalBlock.offset;
    const f0 = buffer.readFloatLE(o);      // start delay
    const f1 = buffer.readFloatLE(o + 4);  // play duration
    const f2 = buffer.readFloatLE(o + 8);  // total duration
    const f3 = buffer.readFloatLE(o + 12); // loop end
    if (f0 > 0 && f0 < 300000) globalStartDelay = f0;
    if (f1 > 100 && f1 < 300000) globalPlayDuration = f1;
    if (f2 > 100 && f2 < 300000) globalDuration = f2;
    else if (f1 > 100 && f1 < 300000) globalDuration = f1;
    if (f3 > 0 && f3 < 300000) globalLoopEnd = f3;
  }

  // ── Helper: find resource paths in a byte range ──
  function findPaths(start, end, extFilter) {
    const paths = [];
    // Bytes that terminate a path string. \0 is the normal C terminator;
    // the others handle the case where a JsonInspack/JSON fragment is
    // embedded in the block without a null separator before the next
    // `data/...` path. Without them findPaths used to read straight
    // through quotes / linebreaks / brackets and concatenate the leaked
    // JSON onto the next real texture path, producing entries like
    //   `data//source//player//m2//部件//texture//m2_1001_head.tga"\r\n
    //    }\r\n    ]\r\n      data/source/other/特效/贴图/qt_其他/s_碎肉01.tga`
    // which never resolve in the cache and show as ✗ in the debug panel.
    //
    // None of these bytes can appear inside a GB18030 multi-byte sequence:
    // GB18030 lead bytes are 0x81-0xFE and trail bytes are 0x40-0xFE
    // (or 0x30-0x39 for 4-byte forms), so any of these single-byte
    // values is unambiguously a terminator regardless of position.
    const isPathTerminator = (b) => (
      b === 0x00 ||                  // NUL
      b < 0x20 ||                    // any C0 control byte (\t \r \n etc.)
      b === 0x22 ||                  // "
      b === 0x27 ||                  // '
      b === 0x3C || b === 0x3E ||    // < >
      b === 0x7C ||                  // |
      b === 0x3F || b === 0x2A ||    // ? *
      b === 0x7B || b === 0x7D ||    // { }
      b === 0x5B || b === 0x5D       // [ ]
    );
    for (let i = start; i < end - 5; i++) {
      if (buffer[i] === 0x64 && buffer[i+1] === 0x61 && buffer[i+2] === 0x74 && buffer[i+3] === 0x61
          && (buffer[i+4] === 0x2f || buffer[i+4] === 0x5c)) {
        let pEnd = i;
        while (pEnd < end && !isPathTerminator(buffer[pEnd])) pEnd++;
        // Cap at 260 bytes (Windows MAX_PATH) — anything longer is
        // almost certainly garbage that slipped past the terminator.
        if (pEnd - i > 260) {
          i = pEnd;
          continue;
        }
        const raw = GB18030_DECODER.decode(buffer.subarray(i, pEnd));
        const ext = raw.split('.').pop().toLowerCase();
        if (!extFilter || extFilter.test(ext)) {
          const normalized = normalizeLogicalResourcePath(raw);
          // Reject paths with consecutive separators (`data//source//...`).
          // Real PSS texture references are always written with single
          // separators; double separators only appear when the string was
          // sourced from a JsonInspack manifest embedded inside the PSS,
          // where each `\` is escaped to `\\` in JSON and survives the
          // backslash→slash normalization as `//`. Such strings never
          // resolve in the cache and only produce ✗ entries.
          if (!/[\\/]{2,}/.test(normalized)) {
            paths.push(normalized);
          }
        }
        i = pEnd;
      }
    }
    return paths;
  }

  const roundFloat = v => Math.round(v * 1000000) / 1000000;

  function findTailMarker(blockStart, blockEnd) {
    const lookback = Math.min(240, blockEnd - blockStart);
    for (let off = blockEnd - 4; off >= blockEnd - lookback; off -= 4) {
      if (off - 4 < blockStart || off + 4 > buffer.length) continue;
      if (buffer.readUInt32LE(off) !== 128) continue;

      const layerToken = buffer.readUInt32LE(off - 4);
      if (layerToken > 8) continue;

      // Most blocks have a fixed tail with 120 repeated 5 times after the 128 token.
      let count120 = 0;
      for (let j = off + 4; j + 4 <= blockEnd && j < off + 128; j += 4) {
        if (buffer.readUInt32LE(j) === 120) count120++;
      }
      if (count120 >= 3) return off;
    }
    return -1;
  }

  // Decode a KG3D_ParticleSizeLifeTime keyframe array for blocks that lack
  // the standard "128 + 5×120" tail trailer. Two record shapes observed:
  //   • stride 16: { f0≈1.0, f1=size, f2=const, f3=lifetime }
  //   • stride  8: { f0=multiplier (const), f1=varying } (B_beam_001 variant)
  // Returns a tailParams-shaped object or null if no array is found.
  function extractNoMarkerTail(blockStart, blockEnd) {
    // Stride-16: same shape as Phase 2 with-marker path.
    {
      const cands = [];
      for (let o = blockStart + 64; o + 16 <= blockEnd; o += 4) {
        if (buffer.readUInt32LE(o) === 0) continue;
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        const v2 = buffer.readFloatLE(o + 8);
        const v3 = buffer.readFloatLE(o + 12);
        if (!isFinite(v0 + v1 + v2 + v3)) continue;
        // Relaxed v0: initial size need not be ≈1.0 — allow any positive value
        // up to 200 world units. Only v2/v3 consistency anchors the stride-16 run.
        if (v0 > 0 && v0 < 200 && v1 >= 0 && v1 <= 8
            && v2 >= 0 && v2 <= 8 && v3 > 0.05 && v3 <= 60) {
          cands.push({ offset: o, v1, v2, v3 });
        }
      }
      const candByOff = new Map();
      for (const c of cands) candByOff.set(c.offset, c);
      let bestRun = [];
      const visited = new Set();
      for (const seed of cands) {
        if (visited.has(seed.offset)) continue;
        const run = [seed];
        let cur = seed;
        while (true) {
          const next = candByOff.get(cur.offset + 16);
          if (!next) break;
          if (Math.abs(next.v2 - seed.v2) >= 0.0002) break;
          if (Math.abs(next.v3 - seed.v3) >= 0.0002) break;
          run.push(next);
          visited.add(next.offset);
          cur = next;
        }
        if (run.length > bestRun.length) bestRun = run;
      }
      if (bestRun.length >= 3) {
        const first = bestRun[0].v1;
        const mid = bestRun[Math.floor(bestRun.length / 2)].v1;
        const last = bestRun[bestRun.length - 1].v1;
        return {
          markerOffset: -1,
          layerToken: null,
          postToken: null,
          floats: [],
          values: [],
          semantic: 'scaleCurveLifetime',
          confidence: 0.85,
          sizeCurve: [roundFloat(first), roundFloat(mid), roundFloat(last)],
          sizeCurveKeyframes: bestRun.map(c => roundFloat(c.v1)),
          lifetimeSeconds: roundFloat(bestRun[0].v3),
          scalar: null,
          spatialScalar: null,
          maxParticles: null,
          noMarkerVariant: 'stride-16',
        };
      }
    }

    // Stride-16 variant B: { f0=const, f1=const, f2=const, f3=varying }.
    // NOTE: v0 is relaxed from ≈1.0 to any positive value — size curves
    // where the emitter scale factor differs from 1.0 use f0 != 1.0.
    {
      const cands = [];
      for (let o = blockStart + 64; o + 16 <= blockEnd; o += 4) {
        if (buffer.readUInt32LE(o) === 0) continue;
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        const v2 = buffer.readFloatLE(o + 8);
        const v3 = buffer.readFloatLE(o + 12);
        if (!isFinite(v0 + v1 + v2 + v3)) continue;
        if (v0 > 0 && v0 < 200 && v1 >= 0 && v1 <= 8
            && v2 >= 0 && v2 <= 8 && v3 >= 0 && v3 <= 8) {
          cands.push({ offset: o, v1, v2, v3 });
        }
      }
      const candByOff = new Map();
      for (const c of cands) candByOff.set(c.offset, c);
      let bestRun = [];
      const visited = new Set();
      for (const seed of cands) {
        if (visited.has(seed.offset)) continue;
        const run = [seed];
        let cur = seed;
        while (true) {
          const next = candByOff.get(cur.offset + 16);
          if (!next) break;
          if (Math.abs(next.v1 - seed.v1) >= 0.0002) break;
          if (Math.abs(next.v2 - seed.v2) >= 0.0002) break;
          run.push(next);
          visited.add(next.offset);
          cur = next;
        }
        if (run.length > bestRun.length) bestRun = run;
      }
      if (bestRun.length >= 4) {
        const kfs = bestRun.map(c => roundFloat(c.v3));
        const first = kfs[0], mid = kfs[Math.floor(kfs.length / 2)], last = kfs[kfs.length - 1];
        return {
          markerOffset: -1,
          layerToken: null,
          postToken: null,
          floats: [],
          values: [],
          semantic: 'scaleCurveLifetime',
          confidence: 0.75,
          sizeCurve: [roundFloat(first), roundFloat(mid), roundFloat(last)],
          sizeCurveKeyframes: kfs,
          lifetimeSeconds: null,
          scalar: null,
          spatialScalar: null,
          maxParticles: null,
          noMarkerVariant: 'stride-16-b',
        };
      }
    }

    // Stride-8 variant: { const, varying } pairs. Includes the const=0
    // sub-case (B_beam-style where the leading slot is zero). Require ≥8 run.
    {
      const cands = [];
      for (let o = blockStart + 64; o + 8 <= blockEnd; o += 4) {
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        if (!isFinite(v0 + v1)) continue;
        if (v0 >= 0 && v0 <= 8 && v1 >= 0 && v1 <= 8) {
          cands.push({ offset: o, v0, v1 });
        }
      }
      const byOff = new Map();
      for (const c of cands) byOff.set(c.offset, c);
      let bestRun = [];
      const visited = new Set();
      for (const seed of cands) {
        if (visited.has(seed.offset)) continue;
        const run = [seed];
        let cur = seed;
        while (true) {
          const next = byOff.get(cur.offset + 8);
          if (!next) break;
          if (Math.abs(next.v0 - seed.v0) >= 0.0002) break;
          run.push(next);
          visited.add(next.offset);
          cur = next;
        }
        if (run.length > bestRun.length) bestRun = run;
      }
      if (bestRun.length >= 8) {
        const kfs = bestRun.map(c => roundFloat(c.v1));
        const first = kfs[0];
        const mid = kfs[Math.floor(kfs.length / 2)];
        const last = kfs[kfs.length - 1];
        // Guard: reject all-zero or near-constant v1 runs (meaningless curve).
        const range = Math.max(...kfs) - Math.min(...kfs);
        if (range < 0.01) {
          // skip — fall through to stride-4 attempt below
        } else {
        return {
          markerOffset: -1,
          layerToken: null,
          postToken: null,
          floats: [],
          values: [],
          semantic: 'scaleCurveLifetime',
          confidence: 0.7,
          sizeCurve: [roundFloat(first), roundFloat(mid), roundFloat(last)],
          sizeCurveKeyframes: kfs,
          lifetimeSeconds: null,
          scalar: null,
          spatialScalar: null,
          maxParticles: null,
          noMarkerVariant: 'stride-8',
        };
        }
      }
    }

    // Stride-4 variant: a raw float keyframe array preceded by a u32 count.
    // Layout: [ count:u32 ] [ f0 f1 f2 ... f(count-1) ] with all floats
    // within a reasonable range (0..60) and "mostly monotonic" (at least
    // 70% of steps monotone in one direction, tolerating small bumps).
    // Require count >= 8 to keep noise low.
    {
      let bestArray = null;
      for (let o = blockStart + 64; o + 4 <= blockEnd; o += 4) {
        const count = buffer.readUInt32LE(o);
        if (count < 8 || count > 512) continue;
        if (o + 4 + count * 4 > blockEnd) continue;
        // Extract the floats and validate.
        const vals = [];
        let ok = true;
        for (let k = 0; k < count; k++) {
          const f = buffer.readFloatLE(o + 4 + k * 4);
          if (!isFinite(f) || f < -0.01 || f > 60) { ok = false; break; }
          vals.push(f);
        }
        if (!ok) continue;
        // Require mostly-monotonic and a variance floor to rule out
        // constant-zero sequences or random data that happens to pass.
        const range = Math.max(...vals) - Math.min(...vals);
        if (range < 0.05) continue;
        let up = 0, down = 0;
        for (let k = 1; k < vals.length; k++) {
          if (vals[k] > vals[k - 1]) up++;
          else if (vals[k] < vals[k - 1]) down++;
        }
        const monotone = Math.max(up, down) / Math.max(1, vals.length - 1);
        if (monotone < 0.6) continue;
        if (!bestArray || vals.length > bestArray.vals.length) {
          bestArray = { offset: o, vals };
        }
      }
      if (bestArray) {
        const kfs = bestArray.vals.map(v => roundFloat(v));
        const first = kfs[0];
        const mid = kfs[Math.floor(kfs.length / 2)];
        const last = kfs[kfs.length - 1];
        return {
          markerOffset: -1,
          layerToken: null,
          postToken: null,
          floats: [],
          values: [],
          semantic: 'scaleCurveLifetime',
          confidence: 0.7,
          sizeCurve: [roundFloat(first), roundFloat(mid), roundFloat(last)],
          sizeCurveKeyframes: kfs,
          lifetimeSeconds: null,
          scalar: null,
          spatialScalar: null,
          maxParticles: null,
          noMarkerVariant: 'stride-4',
        };
      }
    }

    return null;
  }

  function extractTailParams(blockStart, blockEnd) {
    const markerAbs = findTailMarker(blockStart, blockEnd);
    if (markerAbs < 0) {
      // ── No-marker layout variant ──
      // ~11.4% of type-1 blocks omit the standard "128 + 5×120" trailer and
      // instead let a KG3D_ParticleSizeLifeTime keyframe array run all the
      // way to blockEnd. These blocks still carry authored size/lifetime
      // data — just in a different spot. Run the Phase-2 stride-16 decoder
      // with blockEnd as the scan limit so we do NOT return null (which
      // dropped maxParticles/lifetime/sizeCurve entirely for these blocks).
      return extractNoMarkerTail(blockStart, blockEnd);
    }

    const markerOffset = markerAbs - blockStart;
    const layerToken = markerAbs - 4 >= blockStart ? buffer.readUInt32LE(markerAbs - 4) : null;
    const postToken = markerAbs + 8 < blockEnd ? buffer.readUInt32LE(markerAbs + 8) : null;

    const floats = [];
    for (let rel = markerOffset - 28; rel <= markerOffset - 8; rel += 4) {
      const abs = blockStart + rel;
      if (abs < blockStart || abs + 4 > blockEnd) continue;

      const raw = buffer.readUInt32LE(abs);
      if (raw === 0) continue;

      const value = buffer.readFloatLE(abs);
      if (!isFinite(value) || Math.abs(value) < 0.0001 || Math.abs(value) > 20000) continue;

      floats.push({ offset: rel, value: roundFloat(value) });
    }

    const values = floats.map(f => f.value);
    const tailScalarValue = values.length > 0 ? values[values.length - 1] : null;
    let semantic = 'unknown';
    let confidence = 0.25;
    let sizeCurve = null;
    let lifetimeSeconds = null;
    let scalar = null;
    let spatialScalar = null;

    if (values.length >= 4) {
      const tail4 = values.slice(-4);
      const [s0, s1, s2, s3] = tail4;
      if (Math.abs(s0 - 1) <= 0.08 && s1 >= 0 && s1 <= 1.2 && s2 >= 0 && s2 <= 1.2 && s3 > 0.1 && s3 <= 60) {
        semantic = 'scaleCurveLifetime';
        confidence = 0.9;
        sizeCurve = [roundFloat(s0), roundFloat(s1), roundFloat(s2)];
        lifetimeSeconds = roundFloat(s3);
      }
    }

    // Widened sizeCurve search (Option C Phase 1): scan the pre-marker 200B
    // window for {≈1, 0..1.2, 0..1.2, lifetime 0.1..60}. Measurement showed
    // the narrow "last 4 floats" heuristic missed cases where the velocity
    // module inserts bytes between the size-curve record and the marker.
    // Only adopt when there is EXACTLY ONE candidate to avoid ambiguity.
    if (!sizeCurve) {
      const cands = [];
      const windowStart = Math.max(blockStart, markerAbs - 200);
      for (let o = windowStart; o + 16 <= markerAbs - 4; o += 4) {
        const raw0 = buffer.readUInt32LE(o);
        if (raw0 === 0) continue;
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        const v2 = buffer.readFloatLE(o + 8);
        const v3 = buffer.readFloatLE(o + 12);
        if (!isFinite(v0 + v1 + v2 + v3)) continue;
        if (Math.abs(v0 - 1) <= 0.08 && v1 >= 0 && v1 <= 1.2 && v2 >= 0 && v2 <= 1.2 && v3 > 0.1 && v3 <= 60) {
          cands.push({ offset: o, v0, v1, v2, v3 });
        }
      }
      if (cands.length === 1) {
        const c = cands[0];
        semantic = 'scaleCurveLifetime';
        confidence = 0.75; // slightly lower than the narrow match
        sizeCurve = [roundFloat(c.v0), roundFloat(c.v1), roundFloat(c.v2)];
        lifetimeSeconds = roundFloat(c.v3);
      }
    }

    // ─── Phase 2: full keyframe-array decode (KG3D_ParticleSizeLifeTime) ───
    // Record layout verified by byte inspection:
    //   { f0 ≈ 1.0, f1 = sizeValue, f2 = const1, f3 = const2 (lifetime) }
    // Consecutive records at stride 16 form a size-over-time curve where
    // only f1 varies. This detects runs of ≥3 records and emits the full
    // ordered sequence of f1 values as `sizeCurveKeyframes`.
    let sizeCurveKeyframes = null;
    {
      const strideCands = [];
      const windowStart = Math.max(blockStart, markerAbs - 300);
      for (let o = windowStart; o + 16 <= markerAbs - 4; o += 4) {
        const raw0 = buffer.readUInt32LE(o);
        if (raw0 === 0) continue;
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        const v2 = buffer.readFloatLE(o + 8);
        const v3 = buffer.readFloatLE(o + 12);
        if (!isFinite(v0 + v1 + v2 + v3)) continue;
        if (Math.abs(v0 - 1) <= 0.08 && v1 >= 0 && v1 <= 1.2 && v2 >= 0 && v2 <= 1.2 && v3 > 0.1 && v3 <= 60) {
          strideCands.push({ offset: o, v1, v2, v3 });
        }
      }
      // Find longest contiguous run where offsets differ by exactly 16
      // AND f2/f3 are consistent (same record type).
      let bestRun = [];
      let cur = [];
      for (let i = 0; i < strideCands.length; i++) {
        const c = strideCands[i];
        if (cur.length === 0) { cur = [c]; continue; }
        const prev = cur[cur.length - 1];
        const stride = c.offset - prev.offset;
        const sameF2 = Math.abs(c.v2 - prev.v2) < 0.0002;
        const sameF3 = Math.abs(c.v3 - prev.v3) < 0.0002;
        if (stride === 16 && sameF2 && sameF3) {
          cur.push(c);
        } else {
          if (cur.length > bestRun.length) bestRun = cur;
          cur = [c];
        }
      }
      if (cur.length > bestRun.length) bestRun = cur;
      if (bestRun.length >= 3) {
        sizeCurveKeyframes = bestRun.map(c => roundFloat(c.v1));
        // Promote lifetime if still missing.
        if (!lifetimeSeconds) lifetimeSeconds = roundFloat(bestRun[0].v3);
        // Also promote the 3-point summary if we didn't have one.
        if (!sizeCurve) {
          const first = bestRun[0].v1;
          const mid = bestRun[Math.floor(bestRun.length / 2)].v1;
          const last = bestRun[bestRun.length - 1].v1;
          sizeCurve = [roundFloat(first), roundFloat(mid), roundFloat(last)];
        }
        semantic = 'scaleCurveLifetime';
        confidence = Math.max(confidence, 0.95);
      }
    }

    // Phase 2-B: stride-16 records where the VARYING column is f0
    // (alternate KG3D_ParticleScale layout used by 龙牙 #8/#15 et al):
    //   { f0 = varying size factor, f1/f2/f3 = constants }
    // Detected by holding f1/f2/f3 fixed across consecutive 16-byte rows
    // and accepting any f0 in [0..200]. Only runs when Phase-2A produced
    // no result (sizeCurveKeyframes still null) so legitimate v1-varying
    // arrays still take precedence.
    if (!sizeCurveKeyframes) {
      const strideCands = [];
      const windowStart = Math.max(blockStart, markerAbs - 600);
      for (let o = windowStart; o + 16 <= markerAbs - 4; o += 4) {
        const v0 = buffer.readFloatLE(o);
        const v1 = buffer.readFloatLE(o + 4);
        const v2 = buffer.readFloatLE(o + 8);
        const v3 = buffer.readFloatLE(o + 12);
        if (!isFinite(v0 + v1 + v2 + v3)) continue;
        if (v0 > 0 && v0 <= 200 && v1 >= 0 && v1 <= 8
            && v2 >= 0 && v2 <= 8 && v3 >= 0 && v3 <= 8) {
          strideCands.push({ offset: o, v0, v1, v2, v3 });
        }
      }
      const candByOff = new Map();
      for (const c of strideCands) candByOff.set(c.offset, c);
      let bestRunB = [];
      const visited = new Set();
      for (const seed of strideCands) {
        if (visited.has(seed.offset)) continue;
        const run = [seed];
        let cur2 = seed;
        while (true) {
          const next = candByOff.get(cur2.offset + 16);
          if (!next) break;
          if (Math.abs(next.v1 - seed.v1) >= 0.0002) break;
          if (Math.abs(next.v2 - seed.v2) >= 0.0002) break;
          if (Math.abs(next.v3 - seed.v3) >= 0.0002) break;
          run.push(next);
          visited.add(next.offset);
          cur2 = next;
        }
        if (run.length > bestRunB.length) bestRunB = run;
      }
      if (bestRunB.length >= 4) {
        sizeCurveKeyframes = bestRunB.map(c => roundFloat(c.v0));
        if (!sizeCurve) {
          const first = bestRunB[0].v0;
          const mid = bestRunB[Math.floor(bestRunB.length / 2)].v0;
          const last = bestRunB[bestRunB.length - 1].v0;
          sizeCurve = [roundFloat(first), roundFloat(mid), roundFloat(last)];
        }
        semantic = 'scaleCurveLifetime';
        confidence = Math.max(confidence, 0.85);
      }
    }

    if (!lifetimeSeconds && Number.isFinite(tailScalarValue)) {
      scalar = tailScalarValue;
      if (scalar > 0.05 && scalar <= 60) {
        semantic = semantic === 'unknown' ? 'singleScalar' : semantic;
        confidence = Math.max(confidence, values.length === 1 ? 0.6 : 0.4);
        // Engine KG3D_ParticleLifeTime uses fLifeTime (float seconds).
        // Fractional values (e.g. 0.2s for sparks/flashes) are valid.
        if (scalar >= 0.05 && scalar <= 20) {
          lifetimeSeconds = roundFloat(scalar);
        }
      } else {
        scalar = null;
      }
    }

    if (Number.isFinite(tailScalarValue) && tailScalarValue > 4 && tailScalarValue <= 2000) {
      spatialScalar = roundFloat(tailScalarValue);
    }

    // Extract maxParticles from the fixed trailer region. Byte inspection
    // on the 天策 PSS corpus confirms markerAbs+72 is the authored
    // maxParticles u32 (verified against /memories/repo/pss-debug-gotchas.md:
    // "[+76..+92] 5× u32=120 = maxParticles"). The five-slot replication
    // is an engine write pattern, NOT trailer padding — earlier rejection
    // of mpv===120 was incorrect and was dropping real author data.
    let maxParticles = null;
    const maxParticlesOff = markerAbs + 72;
    if (maxParticlesOff + 4 <= blockEnd) {
      const mpv = buffer.readUInt32LE(maxParticlesOff);
      if (mpv >= 1 && mpv <= 100000) maxParticles = mpv;
    }

    return {
      markerOffset,
      layerToken,
      postToken,
      floats,
      values,
      semantic,
      confidence,
      sizeCurve,
      sizeCurveKeyframes,
      lifetimeSeconds,
      scalar,
      spatialScalar,
      maxParticles,
    };
  }

  function buildRuntimeParams(tailParams) {
    if (!tailParams) return null;

    const out = {
      semantic: tailParams.semantic,
      confidence: tailParams.confidence,
    };

    if (Array.isArray(tailParams.sizeCurve) && tailParams.sizeCurve.length === 3) {
      out.sizeCurve = tailParams.sizeCurve;
    }
    if (Array.isArray(tailParams.sizeCurveKeyframes) && tailParams.sizeCurveKeyframes.length >= 3) {
      out.sizeCurveKeyframes = tailParams.sizeCurveKeyframes;
    }
    if (isFinite(tailParams.lifetimeSeconds) && tailParams.lifetimeSeconds > 0) {
      out.lifetimeSeconds = tailParams.lifetimeSeconds;
    }
    if (Number.isFinite(tailParams.scalar)) {
      out.scalar = tailParams.scalar;
    }
    if (Number.isFinite(tailParams.spatialScalar)) {
      out.spatialScalar = tailParams.spatialScalar;
    }
    if (Number.isFinite(tailParams.maxParticles) && tailParams.maxParticles > 0) {
      out.maxParticles = tailParams.maxParticles;
    }
    // Expose whether the block carries the standard tail marker so the
    // renderer can distinguish "no marker → fields never expected to exist"
    // (legitimate absence) from "marker present but field missing" (real gap).
    out.tailMarkerPresent = Number.isFinite(tailParams.markerOffset) && tailParams.markerOffset >= 0;
    if (tailParams.noMarkerVariant) {
      out.noMarkerVariant = tailParams.noMarkerVariant;
    }

    return Object.keys(out).length > 0 ? out : null;
  }

  function hasRuntimeShape(runtimeParams) {
    if (!runtimeParams) return false;
    const hasSizeCurve = Array.isArray(runtimeParams.sizeCurve) && runtimeParams.sizeCurve.length === 3;
    const hasLifetime = Number.isFinite(runtimeParams.lifetimeSeconds)
      && runtimeParams.lifetimeSeconds > 0.1
      && runtimeParams.lifetimeSeconds <= 60;
    const hasScalar = Number.isFinite(runtimeParams.scalar)
      && runtimeParams.scalar > 0.1
      && runtimeParams.scalar <= 60;
    const hasAlphaCurve = Array.isArray(runtimeParams.alphaCurve) && runtimeParams.alphaCurve.length === 3;
    return hasSizeCurve || hasLifetime || hasScalar || hasAlphaCurve;
  }

  function layerFlagKey(layerFlags) {
    if (!Array.isArray(layerFlags) || layerFlags.length === 0) return '';
    return layerFlags.map(value => Number(value) || 0).join(',');
  }

  function extractAlphaTriplet(colorCurve) {
    if (!Array.isArray(colorCurve) || colorCurve.length === 0) return null;
    const first = colorCurve[0];
    const mid = colorCurve[Math.floor(colorCurve.length / 2)];
    const last = colorCurve[colorCurve.length - 1];
    const values = [first?.[3], mid?.[3], last?.[3]].map((value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 1;
      return roundFloat(Math.max(0, Math.min(1, parsed)));
    });
    return values;
  }

  function inferUnknownSpriteRuntimeParams(_spriteEmitters) {
    // Peer-based inference removed — we never copy runtime parameters from
    // a "similar" emitter. If an emitter's authored fields are missing,
    // they stay missing and the client surfaces them as unknown.
    return;
    // eslint-disable-next-line no-unreachable
    const templates = [].map((emitter) => ({
        index: emitter.index,
        runtimeParams: emitter.runtimeParams,
        category: String(emitter.category || 'other').toLowerCase(),
        materialName: String(emitter.materialName || '').toLowerCase(),
        layerCount: Number(emitter.layerCount || 0),
        layerFlagsKey: layerFlagKey(emitter.layerFlags),
        layerToken: emitter?.tailParams?.layerToken ?? null,
        hasColorCurve: Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0,
        alphaCurve: extractAlphaTriplet(emitter.colorCurve),
      }));

    if (templates.length === 0) return;
    const spriteEmitters = [];

    for (const emitter of spriteEmitters) {
      const runtime = emitter.runtimeParams;
      const hasColorCurve = Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0;
      const needsUnknownRepair = !!runtime && runtime.semantic === 'unknown' && !hasRuntimeShape(runtime);
      const needsMissingRuntimeRepair = !runtime;
      if (!needsUnknownRepair && !needsMissingRuntimeRepair) continue;

      const target = {
        index: emitter.index,
        category: String(emitter.category || 'other').toLowerCase(),
        materialName: String(emitter.materialName || '').toLowerCase(),
        layerCount: Number(emitter.layerCount || 0),
        layerFlagsKey: layerFlagKey(emitter.layerFlags),
        layerToken: emitter?.tailParams?.layerToken ?? null,
        hasColorCurve,
      };

      const scored = templates
        .filter((template) => template.index !== target.index)
        .map((template) => {
          let score = template.category === target.category ? 8 : -6;
          if (template.materialName && template.materialName === target.materialName) score += 5;
          if (template.layerCount > 0 && template.layerCount === target.layerCount) score += 3;
          if (template.layerFlagsKey && template.layerFlagsKey === target.layerFlagsKey) score += 3;
          if (template.layerToken !== null && template.layerToken === target.layerToken) score += 2;
          if (template.hasColorCurve === target.hasColorCurve) score += 1;
          else if (template.hasColorCurve || target.hasColorCurve) score -= 0.5;

          if (target.category === 'debris' && template.category === 'light') score -= 3;
          if (target.category === 'light' && template.category === 'debris') score -= 2;

          return { template, score };
        })
        .filter((item) => item.score >= 6)
        .sort((left, right) => right.score - left.score);

      const best = scored[0];
      if (!best) continue;

      const peerRuntime = best.template.runtimeParams || {};
      const inferred = {
        semantic: 'unknownInferred',
        confidence: roundFloat(Math.max(0.42, Math.min(0.68, 0.28 + best.score * 0.03))),
        source: 'inferred-peer',
        inferredFromEmitter: best.template.index,
        inferredScore: roundFloat(best.score),
      };

      if (Array.isArray(peerRuntime.sizeCurve) && peerRuntime.sizeCurve.length === 3) {
        inferred.sizeCurve = peerRuntime.sizeCurve.map(value => roundFloat(Number(value) || 0));
      }
      if (Number.isFinite(peerRuntime.lifetimeSeconds) && peerRuntime.lifetimeSeconds > 0) {
        inferred.lifetimeSeconds = roundFloat(peerRuntime.lifetimeSeconds);
      }
      if (Number.isFinite(peerRuntime.scalar) && peerRuntime.scalar > 0) {
        inferred.scalar = roundFloat(peerRuntime.scalar);
      }
      if (!target.hasColorCurve && Array.isArray(best.template.alphaCurve) && best.template.alphaCurve.length === 3) {
        inferred.alphaCurve = best.template.alphaCurve;
      }

      if (!hasRuntimeShape(inferred)) continue;

      emitter.runtimeParams = preserveTailSpatialScalar(inferred, emitter.tailParams);
      if (emitter.tailParams && (!emitter.tailParams.semantic || emitter.tailParams.semantic === 'unknown')) {
        emitter.tailParams.semantic = inferred.semantic;
        emitter.tailParams.confidence = inferred.confidence;
        if (Array.isArray(inferred.sizeCurve)) emitter.tailParams.sizeCurve = inferred.sizeCurve;
        if (Number.isFinite(inferred.lifetimeSeconds)) emitter.tailParams.lifetimeSeconds = inferred.lifetimeSeconds;
        if (Number.isFinite(inferred.scalar)) emitter.tailParams.scalar = inferred.scalar;
      }
    }
  }

  // Issue #7 (2026-04-26): trackParams field-index extractor REMOVED.
  // The previous implementation read floats[9] as alphaScale, floats[11]
  // as speedHint, floats[14] as flowScale, uints[13] as tailToken — all
  // unverified guesses ("APPROXIMATE indices" per the type3 audit string).
  // Per user directive ("anything goes wrong is a warning, never silent
  // fallback / heuristic"), we no longer extract these fields. Each type-3
  // emitter records a structured warning so downstream code knows the
  // params are intentionally unavailable. The client already gracefully
  // falls back when trackParams is null (see actor-animation-player.js:
  // sliceTrackNodesForEmitter / linkedTrack rendering — defaults
  // widthScale=1, speedHint=80, flowScale=1).
  function extractTrackRuntimeParams(_blockStart, _blockEnd) {
    return null;
  }

  function buildTrackRuntimeWarning(blockStart, blockEnd) {
    return {
      reason: 'trackParams field offsets are not engine-verified; previously-extracted indices (alphaScale@floats[9], speedHint@floats[11], flowScale@floats[14], tailToken@uints[13]) were unverified guesses and have been removed per no-silent-fallback policy (issue #7).',
      blockSize: blockEnd - blockStart,
    };
  }

  // ── Parse per-emitter blocks ──
  const emitters = [];
  const allTexPaths = new Set();
  const allMeshPaths = new Set();
  const allAniPaths = new Set();
  const allTrackPaths = new Set();

  for (let i = 0; i < toc.length; i++) {
    const entry = toc[i];
    const blockStart = entry.offset;
    const blockEnd = entry.offset + entry.size;
    if (blockEnd > buffer.length) continue;

    if (entry.type === 1) {
      // Sprite emitter — parse material + textures
      let matPath = '';
      const matStart = blockStart + 12; // skip 3×u32 header
      if (matStart < blockEnd) {
        const pathsInBlock = findPaths(matStart, Math.min(matStart + 300, blockEnd), /jsondef/i);
        if (pathsInBlock.length > 0) matPath = pathsInBlock[0];
      }
      const texPaths = findPaths(blockStart, blockEnd, /tga|dds|png/i);
      texPaths.forEach(p => allTexPaths.add(p));

      // Derive blend mode — try reading RenderState.BlendMode from the .jsondef
      // first (authoritative). When the .jsondef is not in the shipped archive
      // (specifically the 独立材质/ folder, where the FN-hash index has no
      // entries — verified via tools/probe-cache-hash.mjs), fall through to
      // the JX3 art-team's material-naming convention. In 独立材质/ the
      // file's BASENAME SUFFIX is the blend-mode declaration enforced by
      // the editor's material-creation flow:
      //   <name>_alpha[_…].jsondef         → BlendMode normal (alpha)
      //   <name>_add[_…].jsondef           → BlendMode additive
      //   <name>_glow[_…].jsondef          → BlendMode additive
      //   <name>_multiply[_…].jsondef      → BlendMode multiply
      // This is not a heuristic — it is the same string the editor writes
      // into RenderState.BlendMode at material-creation time. We therefore
      // tag the source as 'name-convention:<suffix>' and treat it as
      // authoritative (no "fallback" warning). For materials OUTSIDE
      // 独立材质/ that still happen to have these tokens in the name, we
      // continue to mark the inference as 'name-fallback:*' (heuristic).
      const matName = matPath.split('/').pop().replace(/\.jsondef$/i, '').toLowerCase();
      const isIndependentMaterial = /\u72EC\u7ACB\u6750\u8D28\//.test(matPath);
      let blendMode = readJsondefBlendMode(matPath);
      let blendModeSource = blendMode ? 'jsondef' : 'jsondef:missing';
      let blendModeFallbackKeyword = null;
      if (!blendMode) {
        // Test unambiguous suffix tokens first (engine convention in
        // 独立材质). The token must appear as an underscore-bounded word so
        // names like 'glowstone' do not match 'glow'.
        let suffixTok = null;
        let suffixBlend = null;
        if (/(^|_)alpha(_|$)/.test(matName)) { suffixTok = 'alpha'; suffixBlend = 'normal'; }
        else if (/(^|_)add(_|$)/.test(matName)) { suffixTok = 'add'; suffixBlend = 'additive'; }
        else if (/(^|_)glow(_|$)/.test(matName)) { suffixTok = 'glow'; suffixBlend = 'additive'; }
        else if (/(^|_)multiply(_|$)/.test(matName)) { suffixTok = 'multiply'; suffixBlend = 'multiply'; }
        if (suffixTok && isIndependentMaterial) {
          // Authoritative-by-convention: 独立材质/ filenames are written by
          // the editor's material-creation flow and the suffix is the same
          // string that goes into RenderState.BlendMode.
          blendMode = suffixBlend;
          blendModeSource = `name-convention:${suffixTok}-suffix`;
        }
        // Issue #6 (2026-04-26): all other heuristic name-fallback paths
        // ('name-fallback:*-keyword', alpha/glow keyword guessing) have
        // been REMOVED. Per user directive ("anything goes wrong is a
        // warning, never silent fallback"), blendMode stays null when
        // the .jsondef is unavailable and the material is not in 独立材质/.
        // The downstream `flagSpritesMissingBlendMode` check surfaces this
        // as a warning instead of fabricating an answer.
      }
      const declaredLayerCount = matName.includes('三层') ? 3 : matName.includes('双层') ? 2 : matName.includes('单层') ? 1 : 0;
      const detectedLayerCount = Math.min(4, texPaths.length);
      const texCount = detectedLayerCount || declaredLayerCount;

      // ── Extract layer flags at fixed offset 272 in block ──
      let layerFlags = [];
      if (entry.size > 288) {
        const flagBase = blockStart + 272;
        for (let f = 0; f < 4; f++) {
          const v = buffer.readUInt32LE(flagBase + f * 4);
          if (v <= 4) layerFlags.push(v); else break;
        }
      }

      // ── Extract control flags at fixed offsets in block ──
      let emitterFlags = {};
      if (entry.size > 340) {
        const flagBase = blockStart + 288;
        emitterFlags = {
          flag296: buffer.readUInt32LE(flagBase + 8),   // 0 or 1 — behavior flag
          flag300: buffer.readUInt32LE(flagBase + 12),   // 0 or 4 — sub-config
          flag304: buffer.readUInt32LE(flagBase + 16),   // 0 or 1
        };
      }

      // ── Extract UV grid dimensions at confirmed fixed offsets ──
      // Binary analysis confirmed: uvRows at block+320, uvCols at block+324.
      let uvRows = null, uvCols = null;
      if (entry.size > 328) {
        const uvr = buffer.readUInt32LE(blockStart + 320);
        const uvc = buffer.readUInt32LE(blockStart + 324);
        if (uvr >= 1 && uvr <= 64) uvRows = uvr;
        if (uvc >= 1 && uvc <= 64) uvCols = uvc;
      }

      // ── Extract validated particle module names from the variable section ──
      // Important: do NOT treat every GB18030 Hanzi-looking byte run as a module.
      // The variable section also contains payload bytes and path fragments that
      // can decode to garbage Chinese. Only emit confirmed module names that are
      // not embedded inside path-like ASCII windows, and collapse repeated hits
      // to one module type per emitter.
      const { validModules, unknownModules } = extractConfirmedSpriteModules(buffer, blockStart, blockEnd);

      // ── KG3D_ParticleColor seed: authoritative colorCurve scan origin ──
      // When the sprite declares a 颜色 module, its payload (immediately after
      // the 2-byte-per-Hanzi module name) is an RGBA keyframe table. Collect
      // ALL 颜色 seed offsets; some emitters carry multiple copies (header
      // fragment + real keyframe region) and only the latter decodes cleanly.
      const colorModuleSeeds = [];
      for (let mi = 0; mi < validModules.length; mi++) {
        const mod = validModules[mi];
        if (mod.name !== '颜色') continue;
        const nameAbs = blockStart + mod.offset;
        const nameLen = [...mod.name].length * 2; // GB18030 Hanzi: 2 bytes each
        let seed = nameAbs + nameLen;
        seed += (4 - (seed % 4)) % 4;
        colorModuleSeeds.push(seed);
      }
      const colorModuleSeedAbs = colorModuleSeeds.length > 0 ? colorModuleSeeds[0] : null;

      // ── Extract RGBA color curve from trailing data ──
      // Priority: if the 颜色 module header was located above, try that
      // payload offset first (authoritative). If scanning from there yields
      // no valid keyframe run, fall back to the texture-path heuristic so
      // existing behaviour is preserved.
      let colorCurve = null;
      let colorCurveSource = null;
      {
        const runScan = (scanStart) => {
          const inRange = v => isFinite(v) && v >= -0.01 && v <= 1.01;
          const keyframes = [];
          for (let off = scanStart; off + 16 <= blockEnd; off += 4) {
            const r = buffer.readFloatLE(off);
            const g = buffer.readFloatLE(off + 4);
            const b = buffer.readFloatLE(off + 8);
            const a = buffer.readFloatLE(off + 12);
            const nz = (r > 0.001 ? 1 : 0) + (g > 0.001 ? 1 : 0) + (b > 0.001 ? 1 : 0) + (a > 0.001 ? 1 : 0);
            if (inRange(r) && inRange(g) && inRange(b) && inRange(a) && nz >= 2) {
              keyframes.push([
                Math.max(0, Math.min(1, r)),
                Math.max(0, Math.min(1, g)),
                Math.max(0, Math.min(1, b)),
                Math.max(0, Math.min(1, a)),
              ]);
              off += 12;
            } else {
              if (keyframes.length >= 4) break;
              keyframes.length = 0;
            }
          }
          return keyframes;
        };

        const rotateRGBA = (keyframes) => {
          const interior = keyframes.length > 4 ? keyframes.slice(1, -1) : keyframes;
          let bestRot = 0, bestScore = -Infinity;
          for (let rot = 0; rot < 4; rot++) {
            const ch4vals = interior.map(kf => kf[(3 + rot) % 4]);
            const ch4range = Math.max(...ch4vals) - Math.min(...ch4vals);
            let rgbMaxRange = 0;
            for (let c = 0; c < 3; c++) {
              const vals = interior.map(kf => kf[(c + rot) % 4]);
              rgbMaxRange = Math.max(rgbMaxRange, Math.max(...vals) - Math.min(...vals));
            }
            const score = ch4range - rgbMaxRange;
            if (score > bestScore) { bestScore = score; bestRot = rot; }
          }
          if (bestRot > 0) {
            return keyframes.map(kf => [
              kf[bestRot % 4], kf[(1 + bestRot) % 4],
              kf[(2 + bestRot) % 4], kf[(3 + bestRot) % 4],
            ]);
          }
          return keyframes;
        };

        // Try module-seeded scan first. The KG3D_ParticleColor payload
        // follows the 4-byte "颜色" Hanzi name, so sweep a small window of
        // candidate seed offsets (0..16 bytes past the name) for each seed
        // occurrence. Some blocks carry the module name multiple times
        // (e.g. class-header fragment + real keyframe record); try each
        // until we get ≥4 valid keyframes.
        let keyframes = [];
        for (const seed of colorModuleSeeds) {
          if (keyframes.length >= 4) break;
          for (let pad = 0; pad <= 16; pad += 4) {
            const attempt = runScan(seed + pad);
            if (attempt.length >= 4) { keyframes = attempt; break; }
          }
        }
        if (keyframes.length >= 4) colorCurveSource = 'module:颜色';

        // afterLastTex texture-path heuristic removed — colorCurve is only
        // trusted when it comes from a declared 颜色 module seed. Any other
        // tail scan is guesswork and can produce phantom gradients.

        if (keyframes.length >= 4) {
          colorCurve = rotateRGBA(keyframes);
        } else {
          // If the 颜色 module was declared but we could not decode a curve,
          // expose that state so callers can distinguish "no color" from
          // "declared but unparsed".
          colorCurveSource = (colorModuleSeedAbs != null) ? 'module:颜色 (undecoded)' : null;
        }
      }

      // Classify each module as active (has non-zero payload bytes between
      // this module's name and the next module name, skipping the 4-byte name
      // itself) or inactive (default-zero template — very common for
      // velocity/gravity when the author never customized them). This turns
      // the previous "velocity VECTOR value NOT PARSED" gap into a precise
      // "velocity module is present but carries default curve" note.
      const varEndForActive = blockEnd - 152;
      const activeModuleSet = new Set();
      const inactiveModuleSet = new Set();
      const moduleByteCounts = {};
      for (let mi = 0; mi < validModules.length; mi++) {
        const cur = validModules[mi];
        const nameAbs = blockStart + cur.offset;
        // Each Hanzi in GB18030 is 2 bytes; module names here are pure Hanzi
        const nameLen = [...cur.name].length * 2;
        const nextAbs = (mi + 1 < validModules.length) ? (blockStart + validModules[mi + 1].offset) : varEndForActive;
        const payloadStart = nameAbs + nameLen;
        const payloadEnd = Math.max(payloadStart, nextAbs);
        let nonZero = 0;
        for (let p = payloadStart; p < payloadEnd; p++) { if (buffer[p] !== 0) nonZero++; }
        moduleByteCounts[cur.name] = { bytes: payloadEnd - payloadStart, nonZero };
        if (nonZero > 0) activeModuleSet.add(cur.name); else inactiveModuleSet.add(cur.name);
      }

      const tailParams = extractTailParams(blockStart, blockEnd);
      const runtimeParams = buildRuntimeParams(tailParams);

      // Summarize colorCurve parse state so the renderer can distinguish
      // legitimate "no color-over-lifetime authored" (block only carries
      // 颜色贴图 texture module, default white tint is correct) from a real
      // parser gap (block declares pure 颜色 module but payload did not
      // decode into ≥4 RGBA keyframes). Measurement across the 694-block
      // corpus showed 92.9% of blocks declare only 颜色贴图 — their
      // "colorCurve absent" logs were noise, not bugs.
      let colorCurveStatus;
      if (Array.isArray(colorCurve) && colorCurve.length > 0) {
        colorCurveStatus = 'authored';
      } else if (colorCurveSource === 'module:颜色 (undecoded)') {
        // Distinguish "declared but empty" (engine-correct: author added 颜色
        // module but never keyed any animation → white tint is the correct
        // default) from a real parser gap (block contains ≥1 valid RGBA
        // keyframe quad that our decoder missed).
        //
        // Authoritative check: scan the ENTIRE post-seed region for any
        // stride-4 offset where four consecutive f32s all fall in [-0.01,
        // 1.01] with ≥2 non-zero channels. If no such quad exists
        // anywhere, the module is metadata-only (class-id + type tokens +
        // large non-float values) — no animation was authored, no parser
        // gap. Only when such a quad IS present do we flag 'unparsed'.
        const inColorRange = v => isFinite(v) && v >= -0.01 && v <= 1.01;
        let hasRgbaQuad = false;
        for (const s of colorModuleSeeds) {
          for (let o = s; o + 16 <= blockEnd; o += 4) {
            const r = buffer.readFloatLE(o);
            const g = buffer.readFloatLE(o + 4);
            const b = buffer.readFloatLE(o + 8);
            const a = buffer.readFloatLE(o + 12);
            const nz = (r > 0.001 ? 1 : 0) + (g > 0.001 ? 1 : 0) + (b > 0.001 ? 1 : 0) + (a > 0.001 ? 1 : 0);
            if (inColorRange(r) && inColorRange(g) && inColorRange(b) && inColorRange(a) && nz >= 2) {
              hasRgbaQuad = true;
              break;
            }
          }
          if (hasRgbaQuad) break;
        }
        colorCurveStatus = hasRgbaQuad ? 'unparsed' : 'no-animation';
      } else {
        colorCurveStatus = 'no-module';
      }

      // Classify size-curve in the same shape as colorCurveStatus so the
      // renderer can distinguish "no animation authored" (engine-default
      // constant 1.0 IS the authored outcome) from "real parser gap".
      // Authoritative: if runtimeParams already carries sizeCurveKeyframes
      // → 'authored'. If 缩放 module not declared → 'no-module'. If
      // declared but its payload bytes are <15% non-zero → 'no-animation'
      // (metadata-only; engine default applies). Otherwise 'unparsed'.
      let sizeCurveStatus;
      const declaredScale = validModules.some(m => m.name === '缩放');
      if (Array.isArray(runtimeParams?.sizeCurveKeyframes) && runtimeParams.sizeCurveKeyframes.length >= 3) {
        sizeCurveStatus = 'authored';
      } else if (Array.isArray(runtimeParams?.sizeCurve) && runtimeParams.sizeCurve.length === 3) {
        sizeCurveStatus = 'authored';
      } else if (!declaredScale) {
        sizeCurveStatus = 'no-module';
      } else {
        const scaleBytes = moduleByteCounts['缩放'];
        const density = (scaleBytes && scaleBytes.bytes > 0) ? (scaleBytes.nonZero / scaleBytes.bytes) : 0;
        sizeCurveStatus = density < 0.15 ? 'no-animation' : 'unparsed';
      }

      emitters.push({
        index: i,
        type: 'sprite',
        material: matPath,
        materialName: matName,
        blendMode,
        blendModeSource,
        layerCount: texCount,
        declaredLayerCount,
        detectedLayerCount,
        layerFlags,
        textures: texPaths.map(p => p.split('/').pop()),
        texturePaths: texPaths,
        category: texPaths.length > 0 ? classifyEffectTexture(texPaths[0]) : 'other',
        colorCurve,
        colorCurveSource,
        colorCurveStatus,
        sizeCurveStatus,
        emitterFlags,
        uvRows,
        uvCols,
        spawnLauncherTypeId: tailParams?.layerToken ?? null,
        maxParticles: tailParams?.maxParticles ?? null,
        // De-duplicate the user-facing module name list (multi-emitter
        // sprite blocks repeat the same module set per emitter — e.g. block
        // #15 of t_\u5929\u7b56\u5c16\u523a02.pss has 4 emitters each declaring
        // \u901a\u9053/\u901f\u5ea6/\u7f29\u653e). moduleOffsets keeps every occurrence so
        // downstream payload-extraction can use the correct per-emitter
        // boundaries; the surface-level modules[] array shows unique names.
        modules: [...new Set(validModules.map(m => m.name))],
        moduleOffsets: validModules,
        emitterCount: (() => {
          // The number of repeated module-name groups equals the emitter
          // count. Use the most frequent module name as the counter (more
          // robust than picking a fixed module that may be optional).
          const freq = {};
          for (const m of validModules) freq[m.name] = (freq[m.name] || 0) + 1;
          const max = Math.max(0, ...Object.values(freq));
          return max || (validModules.length > 0 ? 1 : 0);
        })(),
        activeModules: [...activeModuleSet],
        inactiveModules: [...inactiveModuleSet],
        moduleByteCounts,
        // unknownModules is now a string[] of trimmed Hanzi-only names that
        // didn't match the whitelist (post prefix-peel salvage). Used by the
        // "New Pss DEBUG LOGS" Issue #4 detector.
        unknownModules: unknownModules.slice(),
        hasVelocity: validModules.some(m => m.name === '速度'),
        // hasGravity removed 2026-04-26: 重力 has zero occurrences across
        // 80 cached PSS files. Gravity is not a Chinese-named sprite module
        // in this format. (see tools/audit-parser-logic.cjs)
        hasBrightness: validModules.some(m => m.name === '亮度'),
        hasColorCurve: validModules.some(m => m.name === '颜色' || m.name.startsWith('颜色')),
        tailParams,
        runtimeParams,
        // Emitter ordering — used for stagger timing
        spriteIndex: emitters.filter(e => e.type === 'sprite').length,
      });
    } else if (entry.type === 2) {
      // Type-2 is a generic "module container" — NOT just mesh emitters.
      // Sub-types are identified by a GB18030-encoded Chinese name written
      // at the very start of the block (offset 0). Only blocks with sub-type
      // 模型引用 (model-reference) or those carrying an inline data/...mesh
      // path actually represent renderable meshes. Other sub-types include:
      //   公告板 (billboard)   粒子/闪光粒子/小粒子 (particle systems)
      //   火焰 (flame)         碎布 (cloth shred)    轨迹 (trail/ribbon)
      //   飘带 (streamer)      绿草又叶 (grass leaves)
      // Verified against T_天策龙牙.pss where 23 of 47 emitters are type=2
      // but only 9 contain inline mesh paths.
      const moduleName = (function readModuleName() {
        // Read up to the first NUL byte (max 64 bytes) and decode as GB18030.
        let nameEnd = blockStart;
        const limit = Math.min(blockStart + 64, blockEnd);
        while (nameEnd < limit && buffer[nameEnd] !== 0) nameEnd++;
        if (nameEnd === blockStart) return null;
        try {
          const decoded = GB18030_DECODER.decode(buffer.subarray(blockStart, nameEnd));
          // Sanity: must contain at least one CJK char or ASCII alphanumeric.
          if (!/[\u4e00-\u9fff_A-Za-z0-9]/.test(decoded)) return null;
          return decoded;
        } catch { return null; }
      })();
      // Sub-type is only "mesh" when an actual mesh path is embedded in the
      // block. We used to map authored module names (公告板/轨迹/火焰/…) to
      // rendering sub-types, but that mapping is a guess — the game reads
      // the class from a binary discriminator at +264..+267 (see the
      // meshFields block below). Until that discriminator is fully decoded,
      // expose the raw name and a strict mesh/null sub-type.
      const subType = (function classifySubType(name, hasMeshPath) {
        if (hasMeshPath) return 'mesh';
        return null;
      });
      const meshes = findPaths(blockStart, blockEnd, /mesh/i);
      const anis = findPaths(blockStart, blockEnd, /ani/i);
      meshes.forEach(p => allMeshPaths.add(p));
      anis.forEach(p => allAniPaths.add(p));
      const resolvedSubType = subType(moduleName, meshes.length > 0);
      const meshFields = (function readMeshFields() {
        if (entry.size < 320) return null;
        const base = blockStart;
        const readU32 = (rel) => (base + rel + 4 <= blockEnd) ? buffer.readUInt32LE(base + rel) : null;
        const readU8  = (rel) => (base + rel + 1 <= blockEnd) ? buffer[base + rel] : null;
        const readF32 = (rel) => {
          if (base + rel + 4 > blockEnd) return null;
          const v = buffer.readFloatLE(base + rel);
          return Number.isFinite(v) ? roundFloat(v) : null;
        };

        // ── Authoritative field map for type-2 launcher blocks ──
        // Derived empirically by sweeping every type-2 block in
        // T_天策龙牙.pss (see tools/pss-type2-sweep.mjs). Values that vary
        // per-launcher-class (and not per-instance of the same class) are
        // the class discriminator; values that sweep 0..N sequentially
        // across all type-2 blocks are emitter-pool indices; bit fields
        // are flagged bit-by-bit below.
        //
        // Class discriminator lives in the FOUR BYTES at +264..+267.
        // Observed (subType → 4 bytes at +264..+267 stored LE):
        //   佛光晕/公告板       : 00 00 01 01   b3=1 b0=0  → Sprite/Billboard
        //   轨迹 (.Mesh)        : 01 00 01 01   b3=1 b0=1  → MeshQuote
        //   模板4_模型引用/火飘带: 05 00 00 01   b3=1 b0=5  → Trail/Ribbon
        //   碎布               : 00 01 01 03   b3=3       → Cloth
        //   火焰               : 00 01 01 04   b3=4       → Flame
        //   闪光粒子/绿草叶/粒子: 00 0x 01 01   b3=1 b0=0 with b1 variant
        //   圈墨-残留           : 01 02 01 01
        //   飘带底勾边           : 01 01 01 01
        const classByte0 = readU8(264); // variant/ribbon-marker
        const classByte1 = readU8(265); // subclass variant
        const classByte2 = readU8(266); // mesh-quote/outline marker
        const classByte3 = readU8(267); // primary family (1=particle, 3=cloth, 4=flame)

        // featureFlags at +268 — bit-packed. Confirmed bits (same sweep):
        //   bit 0  (0x001) : always set on active type-2 blocks
        //   bit 1  (0x002) : cloth-shred subfamily
        //   bit 2  (0x004) : flame subfamily
        //   bit 8  (0x100) : uses track curve / has baked motion
        //   bit 10 (0x400) : connected to sibling track emitter
        //   bit 11 (0x800) : ribbon / trail launcher (0xd01 pattern)
        // The previous `loopFlag = (featureFlags & 0x0400)` mapping was
        // WRONG — bit 0x0400 is "has sibling track", not "loops".
        const featureFlags = readU32(268);
        const classFlags = featureFlags == null ? null : {
          hasTrackCurve: (featureFlags & 0x100) !== 0,
          hasSiblingTrack: (featureFlags & 0x400) !== 0,
          isRibbon: (featureFlags & 0x800) !== 0,
          isCloth: (featureFlags & 0x002) !== 0,
          isFlame: (featureFlags & 0x004) !== 0,
          raw: featureFlags,
        };

        // launcherClass = concatenated (b3,b2,b1,b0) hex string.
        // Only entries directly verified by tools/pss-type2-sweep.mjs across
        // ≥2 files are listed here. For unknown keys we DO NOT invent a
        // label — we return null and expose `launcherClassKey` so the
        // caller can see the raw bytes. Expand this map by running the
        // sweep on new files and cross-referencing subTypeName.
        const launcherClassKey = (classByte3 != null && classByte0 != null)
          ? `${classByte3.toString(16).padStart(2, '0')}${classByte2.toString(16).padStart(2, '0')}${classByte1.toString(16).padStart(2, '0')}${classByte0.toString(16).padStart(2, '0')}`
          : null;
        const LAUNCHER_CLASS_MAP = {
          // ── Confirmed in T_天策龙牙.pss ──
          '01010000': 'Sprite',                 // 佛光晕 / 模板3_公告板
          '01010001': 'MeshQuote',              // 轨迹 (inline .Mesh, 旋转刀光, xixian)
          '01000005': 'Trail',                  // 模板4_模型引用 / 火飘带
          '01010100': 'Particle',               // 闪光粒子 / 绿草叶 / 粒子 / 模板1
          '01010200': 'ParticleVariantB',       // 闪光粒子 variant (水图01, 喷射水雾)
          '01010101': 'ParticleOutline',        // 飘带底勾边 / 模型粒子 (纹理2, 围绕)
          '01010201': 'ParticleOutlineB',       // 圈墨-残留
          '01000100': 'ParticleSmall',          // 小粒子 / 星星 / 枫叶
          '03010100': 'Cloth',                  // 碎布
          '04010100': 'Flame',                  // 火焰
          // ── Confirmed in additional sweeps (≥2 files) ──
          '01010004': 'TrailVariantB',          // 手拖尾红/黑 (ribbon with feature=0xd01)
          '01000200': 'ParticleSmokeB',         // 黑烟_普通粒子 / 火星_普通粒子 / 浓烟 / 烟图
          '01000001': 'MeshQuoteFlat',          // 气流场_模型粒子 (has .Mesh + hasSiblingTrack)
          '01000101': 'MeshQuoteEmbedded',      // 月上升_模型粒子 / 气流_模型粒子 (has .Mesh + hasTrackCurve only)
          // ── Semantic promotions from 55-file classkey sweep
          //    (tools/pss-classkey-sweep.mjs, log/classkey-sweep.txt) ──
          //   06010100: 4/4 files exclusively smoke — 旗子烟雾_普通粒子 /
          //             烟雾_普通粒子 / 烟_普通粒子 / 烟. Promoted to Smoke.
          //   08000200: 5/5 files exclusively flame — 火焰亮_普通粒子 /
          //             火焰_普通粒子 / 跟随火焰1/2/3. Promoted to FlameVariantB
          //             (sibling of 04010100 Flame, emits without lifetime curve).
          '06010100': 'Smoke',
          '08000200': 'FlameVariantB',
          // ── Mixed-semantic variants (≥2 files but subTypeName spans
          //     unrelated effects — keep structural to avoid guessing) ──
          '01000000': 'LauncherVariant_01000000', // 爱心圆粒子循环 / 粒子 / 烟雾暗 (4 files)
          '02000100': 'LauncherVariant_02000100', // 外面爆炸 / 溶解 / 叶子 (4 files)
          '02000200': 'LauncherVariant_02000200', // 烟世界 / 叶子 / 地面灼烧 (3 files)
          '02010000': 'LauncherVariant_02010000', // 爱心粒子 / 石头 / 流光_公告板 (3 files)
          '02010100': 'LauncherVariant_02010100', // 水花透明 / 两点 / 花瓣 (7 files)
          '02010200': 'LauncherVariant_02010200', // 水雾 / 水花透明 / 地面灼烧 (3 files)
          '04000100': 'LauncherVariant_04000100', // 模板1 / 火焰 / 水花 (3 files)
          '04010200': 'LauncherVariant_04010200', // 水珠 / 闪光粒子 / 火焰 (6 files)
          '05010200': 'LauncherVariant_05010200', // 水花02 (2 files)
          '06000100': 'LauncherVariant_06000100', // 模板1 / 鬼烟 (2 files)
          '08010200': 'LauncherVariant_08010200', // 光点 / 刀光火 (2 files)
        };
        const launcherClass = launcherClassKey ? (LAUNCHER_CLASS_MAP[launcherClassKey] || null) : null;

        // +292: observed to be a sequential slot index across all type-2
        // blocks (0..N incrementing), 0xFFFFFFFF for trails/mesh-ref.
        // It is NOT a class-ID — renaming to spawnPoolIndex honestly.
        const launcherRaw = readU32(292);
        const spawnPoolIndex = (launcherRaw === 0xFFFFFFFF) ? null : launcherRaw;

        // +308 still appears to be a scale multiplier — values 0.35..2.0
        // correlate with visual emitter size across subTypes. Keep.
        const emitterScale = readF32(308);
        const secondaryScale = readF32(312);

        return {
          launcherClass,
          launcherClassKey,
          launcherClassBytes: [classByte0, classByte1, classByte2, classByte3],
          classFlags,
          spawnPoolIndex,
          emitterScale,
          secondaryScale,
        };
      })();
      emitters.push({ index: i, type: 'mesh', subType: resolvedSubType, subTypeName: moduleName, meshes, animations: anis, meshFields });
    } else if (entry.type === 3) {
      // Track emitter
      const tracks = findPaths(blockStart, blockEnd, /track/i);
      tracks.forEach((path) => allTrackPaths.add(path));
      const trackParams = extractTrackRuntimeParams(blockStart, blockEnd);
      const trackParamsWarning = buildTrackRuntimeWarning(blockStart, blockEnd);
      emitters.push({ index: i, type: 'track', tracks, trackParams, trackParamsWarning });
    }
    // type 0 already handled above
  }

  inferUnknownSpriteRuntimeParams(emitters.filter((emitter) => emitter.type === 'sprite'));

  // ── Resolve textures (same logic as before but using allTexPaths) ──
  const uniqueTextures = [...allTexPaths];
  const uniqueMeshes = [...allMeshPaths];
  const uniqueAnis = [...allAniPaths];
  const uniqueTracks = [...allTrackPaths];

  const uncachedTexPaths = [];
  const cacheMap = new Map();
  for (const texPath of uniqueTextures) {
    let resolved = tryResolveCacheLogicalPath(texPath);
    if (!resolved && /\.tga$/i.test(texPath)) {
      const ddsPath = texPath.replace(/\.tga$/i, '.dds');
      resolved = tryResolveCacheLogicalPath(ddsPath);
      if (resolved) { cacheMap.set(texPath, { finalPath: ddsPath, resolved }); continue; }
    }
    if (resolved) { cacheMap.set(texPath, { finalPath: texPath, resolved }); }
    else { uncachedTexPaths.push(texPath); }
  }

  if (uncachedTexPaths.length > 0 && existsSync(PAKV4_EXTRACT_EXE)) {
    const texExtractDir = join(PSS_EXTRACT_DIR, '_tex');
    ensureDir(texExtractDir);
    const paths = [];
    for (const tp of uncachedTexPaths) {
      paths.push(tp);
      if (/\.tga$/i.test(tp)) paths.push(tp.replace(/\.tga$/i, '.dds'));
    }
    const pathlistFile = join(texExtractDir, '_pathlist.txt');
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `[System.IO.File]::WriteAllText('${pathlistFile.replace(/'/g, "''")}', '${paths.join('\n').replace(/'/g, "''")}' + [char]10, [System.Text.Encoding]::GetEncoding('gb18030'))`,
      ], { timeout: 5000, windowsHide: true });
    } catch {
      writeFileSync(pathlistFile, paths.join('\n') + '\n', 'utf-8');
    }
    try {
      execFileSync(PAKV4_EXTRACT_EXE, [pathlistFile, texExtractDir], {
        timeout: 30000, windowsHide: true, cwd: dirname(PAKV4_EXTRACT_EXE),
      });
    } catch { /* may exit non-zero but still extract */ }
  }

  // Build texture lookup: path → resolved info
  const texLookup = new Map();
  for (const texPath of uniqueTextures) {
    const cat = classifyEffectTexture(texPath);
    const cached = cacheMap.get(texPath);
    if (cached) {
      texLookup.set(texPath, {
        texturePath: cached.finalPath, originalPath: texPath,
        rawUrl: cached.resolved.rawUrl, existsInCache: true, source: 'cache', category: cat,
      });
      continue;
    }
    const texExtractDir = join(PSS_EXTRACT_DIR, '_tex');
    let found = false;
    for (const candidate of [texPath, texPath.replace(/\.tga$/i, '.dds')]) {
      const extracted = join(texExtractDir, candidate.replace(/\//g, '\\'));
      if (existsSync(extracted)) {
        const originalHeader = readFileSync(extracted, { encoding: null }).subarray(0, 4);

        if (isDdsHeader(originalHeader)) {
          texLookup.set(texPath, {
            texturePath: candidate, originalPath: texPath,
            rawUrl: `/api/pss/texture?path=${encodeURIComponent(candidate)}`,
            existsInCache: true, source: 'pakv4', category: cat,
            extractedPath: candidate,
          });
          found = true; break;
        }

        if (isHxHeader(originalHeader) && tryDecodeHxTextureToDds(extracted)) {
          const decodedHeader = readFileSync(extracted, { encoding: null }).subarray(0, 4);
          if (isDdsHeader(decodedHeader)) {
            texLookup.set(texPath, {
              texturePath: candidate, originalPath: texPath,
              rawUrl: `/api/pss/texture?path=${encodeURIComponent(candidate)}`,
              existsInCache: true, source: 'pakv4-decoded', category: cat,
              decodedFrom: 'hxb-compressed',
              extractedPath: candidate,
            });
            found = true; break;
          }
        }

        const headerAscii = Buffer.from(originalHeader).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
        const headerHex = Buffer.from(originalHeader).toString('hex');
        texLookup.set(texPath, {
          texturePath: texPath, originalPath: texPath,
          rawUrl: `/api/pss/placeholder-tex?missing=1&category=${encodeURIComponent(cat)}&name=${encodeURIComponent(texPath.split('/').pop())}&source=${encodeURIComponent('pakv4-compressed')}`,
          existsInCache: false, source: 'pakv4-compressed', category: cat,
          missingReason: 'hxb-compressed',
          compressedHeaderAscii: headerAscii,
          compressedHeaderHex: headerHex,
          extractedPath: candidate,
        });
        found = true; break;
      }
    }
    if (!found) {
      texLookup.set(texPath, {
        texturePath: texPath, originalPath: texPath,
        rawUrl: `/api/pss/placeholder-tex?missing=1&category=${encodeURIComponent(cat)}&name=${encodeURIComponent(texPath.split('/').pop())}&source=${encodeURIComponent('missing')}`,
        existsInCache: false, source: 'missing', category: cat,
        missingReason: 'extract-missing',
      });
    }
  }

  // ─── PROXY-FALLBACK SCORER REMOVED ───
  // Previous revisions substituted a "closest-looking" real texture whenever
  // a source texture's bytes could not be resolved from cache. That is a
  // fallback (guess) and is no longer permitted. Unresolved textures now
  // surface honestly as `source: 'missing'` or `'pakv4-compressed'`.

  const resolveAssetList = (paths, options = {}) => {
    const allowPakv4Fallback = options.allowPakv4Fallback === true;
    const lookup = new Map();
    for (const resourcePath of paths) {
      const resolved = tryResolveCacheLogicalPath(resourcePath);
      const pakv4Asset = !resolved && allowPakv4Fallback
        ? resolvePssPakv4Asset(resourcePath)
        : null;

      lookup.set(resourcePath, {
        sourcePath: resourcePath,
        resolvedPath: resolved?.resolvedPath || pakv4Asset?.localPath || null,
        rawUrl: resolved?.rawUrl || pakv4Asset?.rawUrl || null,
        existsInCache: Boolean(resolved),
        existsLocally: Boolean(resolved || pakv4Asset),
        source: resolved ? 'cache' : pakv4Asset ? 'pakv4' : 'missing',
      });
    }
    return lookup;
  };

  const meshAssetLookup = resolveAssetList(uniqueMeshes, { allowPakv4Fallback: true });
  const animationAssetLookup = resolveAssetList(uniqueAnis, { allowPakv4Fallback: true });
  const trackAssetLookup = resolveAssetList(uniqueTracks, { allowPakv4Fallback: true });

  for (const asset of trackAssetLookup.values()) {
    if (!asset?.existsLocally || !asset.sourcePath) continue;

    let trackBuffer = null;
    if (asset.source === 'cache' && asset.resolvedPath) {
      try {
        const { output } = getJx3CacheReader().readEntry(asset.resolvedPath);
        trackBuffer = output;
      } catch {
        trackBuffer = null;
      }
    } else if (asset.source === 'pakv4' && asset.resolvedPath) {
      const trackAbs = safePathUnder(PSS_ASSET_EXTRACT_DIR, asset.resolvedPath.replace(/\//g, '\\'));
      if (trackAbs && existsSync(trackAbs)) {
        trackBuffer = readFileSync(trackAbs);
      }
    }

    if (!trackBuffer) continue;
    const decodedTrack = parseTrackResourceBuffer(trackBuffer);
    if (decodedTrack) {
      asset.decodedTrack = decodedTrack;
    }
  }

  // Attach resolved texture info to each emitter
  for (const em of emitters) {
    if (em.type === 'sprite') {
      em.resolvedTextures = em.texturePaths.map(p => texLookup.get(p)).filter(Boolean);
    } else if (em.type === 'mesh') {
      em.resolvedMeshes = em.meshes.map(p => meshAssetLookup.get(p)).filter(Boolean);
      em.resolvedAnimations = em.animations.map(p => animationAssetLookup.get(p)).filter(Boolean);

      // Sibling .Ani fallback: if the PSS block did not enumerate an .Ani
      // path but a .Mesh is present, derive the sibling .Ani path by
      // replacing the extension and try to resolve it. This matches the
      // runtime convention used by KG3D_ParticleMeshQuoteLauncher: when an
      // animated mesh is referenced without an explicit .Ani, the engine
      // auto-loads <mesh>.Ani from the same folder.
      if (em.resolvedAnimations.length === 0 && Array.isArray(em.meshes) && em.meshes.length > 0) {
        const siblingAniPaths = em.meshes
          .map((meshPath) => String(meshPath || '').replace(/\.[^/.\\]+$/i, '.ani'))
          .filter(Boolean);
        const siblingLookup = resolveAssetList(siblingAniPaths, { allowPakv4Fallback: true });
        const resolvedSiblings = [...siblingLookup.values()].filter((a) => a.existsLocally);
        if (resolvedSiblings.length > 0) {
          em.resolvedAnimations = resolvedSiblings;
          em.animations = resolvedSiblings.map((a) => a.sourcePath);
          em.animationsSource = 'sibling-auto';
        }
      }
    } else if (em.type === 'track') {
      em.resolvedTracks = em.tracks.map((path) => trackAssetLookup.get(path)).filter(Boolean);
    }
  }

  // ── Bind orphan track emitters to ribbon-intent mesh emitters ──
  // Tracks (type=3) carry the motion path. Ribbon-like launchers need to be
  // bound to a track so the mesh renderer can extrude/animate along that
  // curve. Previous code matched by Chinese regex (轨迹|飘带|...) — guess.
  // Authoritative check: the `hasSiblingTrack` bit (0x400) in featureFlags
  // at +268. Verified across T_天策龙牙.pss and 5 other files — every
  // launcher whose bit 0x400 is set is a ribbon/mesh-quote paired with a
  // type-3 track emitter; bit is clear on every sprite/particle/cloth/flame
  // launcher in the same files. See tools/pss-type2-sweep.mjs for method.
  //
  // Note: some MeshQuote launchers have `hasTrackCurve` (0x100) but NOT
  // `hasSiblingTrack` (0x400) — those carry their curve embedded and do
  // not need external track binding. We skip them here.
  const ribbonMeshEmitters = emitters.filter((e) => {
    if (e.type !== 'mesh') return false;
    return e.meshFields?.classFlags?.hasSiblingTrack === true;
  });
  const trackEmitters = emitters.filter((e) => e.type === 'track');
  for (let i = 0; i < ribbonMeshEmitters.length; i++) {
    const trackEm = trackEmitters[i] || trackEmitters[trackEmitters.length - 1];
    if (!trackEm) break;
    const firstDecoded = (trackEm.resolvedTracks || []).find((a) => a?.decodedTrack?.nodeCount > 0);
    if (!firstDecoded) continue;
    ribbonMeshEmitters[i].linkedTrack = {
      sourcePath: firstDecoded.sourcePath || '',
      decodedTrack: firstDecoded.decodedTrack,
      trackParams: trackEm.trackParams || null,
      trackEmitterIndex: trackEm.index,
      launcherClass: ribbonMeshEmitters[i].meshFields.launcherClass,
      launcherClassKey: ribbonMeshEmitters[i].meshFields.launcherClassKey,
    };
  }

  // No-fallback policy: track and mesh emitters only carry color when it
  // was authored on the emitter's own type-2 block (KG3D_ParticleColor /
  // KG3D_ParticleColorLifeTime). We deliberately do NOT copy colorCurve
  // from sibling sprites — doing so is a heuristic guess and the user has
  // explicitly banned fallbacks.

  // Per-PSS "fire intent" was a keyword guess on subTypeName (e.g. /火|fire/).
  // Removed — the renderer's track-texture scoring must not bias by name.
  // If a visual cue for "fire-like" is needed, read the authored RGBA from
  // KG3D_ParticleColor / KG3D_ParticleColorLifeTime (module-level, not
  // emitter-name). Until that parse lands, no fire-intent is emitted.

  // Flat texture list for backward compat
  const textureLayers = [...texLookup.values()];
  const meshAssets = [...meshAssetLookup.values()];
  const animationAssets = [...animationAssetLookup.values()];
  const trackAssets = [...trackAssetLookup.values()];

  return {
    format: 'PSS',
    version,
    particleCount: emitterCount,
    fileSize: buffer.length,
    globalDuration,
    globalStartDelay,
    globalPlayDuration,
    globalLoopEnd,
    emitters,
    textures: textureLayers,
    meshes: uniqueMeshes,
    animations: uniqueAnis,
    tracks: uniqueTracks,
    meshAssets,
    animationAssets,
    trackAssets,
    totalTextures: uniqueTextures.length,
    cachedTextures: textureLayers.filter(t => t.existsInCache).length,
    cachedMeshes: meshAssets.filter((asset) => asset.existsInCache).length,
    resolvedMeshes: meshAssets.filter((asset) => asset.existsLocally).length,
    cachedAnimations: animationAssets.filter((asset) => asset.existsInCache).length,
    resolvedAnimations: animationAssets.filter((asset) => asset.existsLocally).length,
    cachedTrackAssets: trackAssets.filter((asset) => asset.existsInCache).length,
    resolvedTrackAssets: trackAssets.filter((asset) => asset.existsLocally).length,
    decodedTrackAssets: trackAssets.filter((asset) => asset?.decodedTrack?.nodeCount > 0).length,
  };
}

function roundRuntimeValue(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function preserveTailSpatialScalar(runtimeParams, tailParams) {
  const spatialScalar = Number.isFinite(tailParams?.spatialScalar)
    ? roundRuntimeValue(tailParams.spatialScalar)
    : null;
  // Also preserve authored maxParticles and tailMarkerPresent — peer
  // inference replaces runtimeParams wholesale, but those fields were
  // decoded from THIS emitter's own bytes (server.js extractTailParams)
  // and must not be lost when peer-shape sizeCurve/lifetime overlay.
  const maxParticles = Number.isFinite(tailParams?.maxParticles) && tailParams.maxParticles > 0
    ? tailParams.maxParticles : null;
  const tailMarkerPresent = Number.isFinite(tailParams?.markerOffset) && tailParams.markerOffset >= 0;

  if (!Number.isFinite(spatialScalar) && maxParticles == null && !tailMarkerPresent) {
    return runtimeParams;
  }

  const out = runtimeParams && typeof runtimeParams === 'object'
    ? { ...runtimeParams }
    : {};
  if (Number.isFinite(spatialScalar)) out.spatialScalar = spatialScalar;
  if (maxParticles != null) out.maxParticles = maxParticles;
  out.tailMarkerPresent = tailMarkerPresent;
  return out;
}

function runtimeParamsHaveShape(runtimeParams) {
  if (!runtimeParams || typeof runtimeParams !== 'object') return false;
  const hasSizeCurve = Array.isArray(runtimeParams.sizeCurve) && runtimeParams.sizeCurve.length === 3;
  const hasLifetime = Number.isFinite(runtimeParams.lifetimeSeconds)
    && runtimeParams.lifetimeSeconds > 0.1
    && runtimeParams.lifetimeSeconds <= 60;
  const hasScalar = Number.isFinite(runtimeParams.scalar)
    && runtimeParams.scalar > 0.1
    && runtimeParams.scalar <= 60;
  const hasAlphaCurve = Array.isArray(runtimeParams.alphaCurve) && runtimeParams.alphaCurve.length === 3;
  return hasSizeCurve || hasLifetime || hasScalar || hasAlphaCurve;
}

function runtimeLayerFlagKey(layerFlags) {
  if (!Array.isArray(layerFlags) || layerFlags.length === 0) return '';
  return layerFlags.map((value) => Number(value) || 0).join(',');
}

function normalizeRuntimeTextureKey(value) {
  return basename(String(value || ''))
    .toLowerCase()
    .replace(/\.(dds|tga|png|jpg|jpeg|bmp)$/i, '');
}

function runtimeAlphaTriplet(colorCurve) {
  if (!Array.isArray(colorCurve) || colorCurve.length === 0) return null;
  const first = colorCurve[0];
  const mid = colorCurve[Math.floor(colorCurve.length / 2)];
  const last = colorCurve[colorCurve.length - 1];
  const values = [first?.[3], mid?.[3], last?.[3]].map((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return roundRuntimeValue(Math.max(0, Math.min(1, parsed)));
  });
  return values;
}

function cloneRuntimeTemplate(runtimeParams) {
  if (!runtimeParams || typeof runtimeParams !== 'object') return null;

  const out = {
    semantic: runtimeParams.semantic || 'unknown',
    confidence: Number.isFinite(runtimeParams.confidence) ? runtimeParams.confidence : 0.4,
  };

  if (Array.isArray(runtimeParams.sizeCurve) && runtimeParams.sizeCurve.length === 3) {
    out.sizeCurve = runtimeParams.sizeCurve.map((value) => roundRuntimeValue(value));
  }
  if (Number.isFinite(runtimeParams.lifetimeSeconds) && runtimeParams.lifetimeSeconds > 0) {
    out.lifetimeSeconds = roundRuntimeValue(runtimeParams.lifetimeSeconds);
  }
  if (Number.isFinite(runtimeParams.scalar) && runtimeParams.scalar > 0) {
    out.scalar = roundRuntimeValue(runtimeParams.scalar);
  }
  if (Array.isArray(runtimeParams.alphaCurve) && runtimeParams.alphaCurve.length === 3) {
    out.alphaCurve = runtimeParams.alphaCurve.map((value) => roundRuntimeValue(value));
  }

  return runtimeParamsHaveShape(out) ? out : null;
}

function collectRuntimeTemplatesFromParsed(parsed, sourcePathHint, templateMap) {
  if (!parsed || !Array.isArray(parsed.emitters)) return;

  for (const emitter of parsed.emitters) {
    if (!emitter || emitter.type !== 'sprite') continue;

    const runtime = cloneRuntimeTemplate(emitter.runtimeParams);
    if (!runtime) continue;

    const category = String(emitter.category || 'other').toLowerCase();
    const materialName = String(emitter.materialName || '').toLowerCase();
    const layerCount = Number(emitter.layerCount || 0);
    const layerFlagsKey = runtimeLayerFlagKey(emitter.layerFlags);
    const hasColorCurve = Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0;
    const alphaCurve = runtimeAlphaTriplet(emitter.colorCurve);
    const confidence = Number.isFinite(runtime.confidence) ? runtime.confidence : 0.4;
    const sourceRuntime = String(emitter.runtimeParams?.source || '').toLowerCase();
    const sourcePenalty = sourceRuntime === 'inferred-peer' || sourceRuntime === 'inferred-sibling-texture' ? 1.2 : 0;

    const template = {
      index: emitter.index,
      sourcePath: sourcePathHint || '',
      category,
      materialName,
      layerCount,
      layerFlagsKey,
      hasColorCurve,
      alphaCurve,
      runtime,
      qualityScore: confidence * 10 + (runtime.semantic === 'scaleCurveLifetime' ? 2 : 0) - sourcePenalty,
    };

    const textureKeys = (Array.isArray(emitter.texturePaths) ? emitter.texturePaths : [])
      .map((value) => normalizeRuntimeTextureKey(value))
      .filter(Boolean);

    for (const key of textureKeys) {
      if (!templateMap.has(key)) templateMap.set(key, []);
      templateMap.get(key).push(template);
    }
  }
}

function scoreRuntimeTemplateCandidate(template, targetEmitter) {
  if (!template || !targetEmitter) return -Infinity;

  let score = Number(template.qualityScore || 0);
  if (template.category === targetEmitter.category) score += 6;
  else score -= 5;
  if (template.materialName && template.materialName === targetEmitter.materialName) score += 4;
  if (template.layerCount > 0 && template.layerCount === targetEmitter.layerCount) score += 2;
  if (template.layerFlagsKey && template.layerFlagsKey === targetEmitter.layerFlagsKey) score += 2;
  if (template.hasColorCurve === targetEmitter.hasColorCurve) score += 1;

  return score;
}

function buildSiblingRuntimeTemplateMap(sourcePath) {
  const normalizedSource = normalizeLogicalResourcePath(sourcePath);
  if (!normalizedSource) return new Map();

  const folderRel = dirname(normalizedSource).replace(/\\/g, '/');
  const sourceName = basename(normalizedSource);
  const tokenText = basename(normalizedSource, extname(normalizedSource)).toLowerCase();
  const tokens = tokenText.split(/[_\-\s]+/g).map((value) => value.trim()).filter((value) => value.length >= 2);
  const cacheKey = `${folderRel}::${tokens.join('|')}`;
  if (siblingRuntimeTemplateCache.has(cacheKey)) {
    return siblingRuntimeTemplateCache.get(cacheKey);
  }

  const folderAbs = join(PSS_EXTRACT_DIR, folderRel.replace(/\//g, '\\'));
  const templateMap = new Map();
  if (!existsSync(folderAbs) || !statSync(folderAbs).isDirectory()) {
    siblingRuntimeTemplateCache.set(cacheKey, templateMap);
    return templateMap;
  }

  const siblingFiles = readdirSync(folderAbs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.pss$/i.test(entry.name) && entry.name !== sourceName)
    .map((entry) => entry.name)
    .map((name) => {
      const lower = name.toLowerCase();
      let tokenScore = 0;
      for (const token of tokens) {
        if (token && lower.includes(token)) tokenScore += 1;
      }
      return { name, tokenScore };
    })
    .sort((left, right) => {
      if (right.tokenScore !== left.tokenScore) return right.tokenScore - left.tokenScore;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    })
    .slice(0, 8);

  for (const sibling of siblingFiles) {
    const abs = join(folderAbs, sibling.name);
    try {
      const buffer = readFileSync(abs);
      const parsed = parsePssEffectScene(buffer);
      if (!parsed || !Array.isArray(parsed.emitters)) continue;

      const siblingSourcePath = `${folderRel}/${sibling.name}`;
      collectRuntimeTemplatesFromParsed(parsed, siblingSourcePath, templateMap);
    } catch {
      // Ignore sibling parse failures.
    }
  }

  siblingRuntimeTemplateCache.set(cacheKey, templateMap);
  return templateMap;
}

function applySiblingRuntimeInference(emitters, templateMap) {
  if (!Array.isArray(emitters) || emitters.length === 0 || !(templateMap instanceof Map) || templateMap.size === 0) {
    return 0;
  }

  let inferredCount = 0;
  for (const emitter of emitters) {
    if (!emitter || emitter.type !== 'sprite') continue;

    const runtime = emitter.runtimeParams;
    const hasColorCurve = Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0;
    const needsUnknownRepair = !!runtime && runtime.semantic === 'unknown' && !runtimeParamsHaveShape(runtime);
    const needsMissingRuntimeRepair = !runtime;
    if (!needsUnknownRepair && !needsMissingRuntimeRepair) continue;

    const target = {
      category: String(emitter.category || 'other').toLowerCase(),
      materialName: String(emitter.materialName || '').toLowerCase(),
      layerCount: Number(emitter.layerCount || 0),
      layerFlagsKey: runtimeLayerFlagKey(emitter.layerFlags),
      hasColorCurve,
    };

    const keys = (Array.isArray(emitter.texturePaths) ? emitter.texturePaths : [])
      .map((value) => normalizeRuntimeTextureKey(value))
      .filter(Boolean);

    const candidates = [];
    for (const key of keys) {
      const list = templateMap.get(key);
      if (!Array.isArray(list)) continue;
      for (const template of list) {
        const score = scoreRuntimeTemplateCandidate(template, target);
        if (!Number.isFinite(score)) continue;
        candidates.push({ template, score });
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best || best.score < 7) continue;

    const peerRuntime = cloneRuntimeTemplate(best.template.runtime) || {};
    const inferred = {
      semantic: 'unknownInferredTexture',
      confidence: roundRuntimeValue(Math.max(0.45, Math.min(0.72, 0.25 + best.score * 0.03))),
      source: 'inferred-sibling-texture',
      inferredFromEmitter: best.template.index,
      inferredFromPath: best.template.sourcePath,
      inferredScore: roundRuntimeValue(best.score),
    };

    if (Array.isArray(peerRuntime.sizeCurve) && peerRuntime.sizeCurve.length === 3) {
      inferred.sizeCurve = peerRuntime.sizeCurve;
    }
    if (Number.isFinite(peerRuntime.lifetimeSeconds) && peerRuntime.lifetimeSeconds > 0) {
      inferred.lifetimeSeconds = peerRuntime.lifetimeSeconds;
    }
    if (Number.isFinite(peerRuntime.scalar) && peerRuntime.scalar > 0) {
      inferred.scalar = peerRuntime.scalar;
    }
    if (Array.isArray(peerRuntime.alphaCurve) && peerRuntime.alphaCurve.length === 3) {
      inferred.alphaCurve = peerRuntime.alphaCurve;
    }

    if (!runtimeParamsHaveShape(inferred)) continue;

    emitter.runtimeParams = preserveTailSpatialScalar(inferred, emitter.tailParams);
    if (emitter.tailParams && (!emitter.tailParams.semantic || emitter.tailParams.semantic === 'unknown')) {
      emitter.tailParams.semantic = inferred.semantic;
      emitter.tailParams.confidence = inferred.confidence;
      if (Array.isArray(inferred.sizeCurve)) emitter.tailParams.sizeCurve = inferred.sizeCurve;
      if (Number.isFinite(inferred.lifetimeSeconds)) emitter.tailParams.lifetimeSeconds = inferred.lifetimeSeconds;
      if (Number.isFinite(inferred.scalar)) emitter.tailParams.scalar = inferred.scalar;
    }

    inferredCount += 1;
  }

  return inferredCount;
}

function applyPostSiblingPeerRuntimeInference(emitters) {
  if (!Array.isArray(emitters) || emitters.length === 0) {
    return 0;
  }

  const spriteEmitters = emitters.filter((emitter) => emitter && emitter.type === 'sprite');
  if (spriteEmitters.length === 0) {
    return 0;
  }

  const templates = spriteEmitters
    .filter((emitter) => runtimeParamsHaveShape(emitter.runtimeParams))
    .map((emitter) => ({
      index: emitter.index,
      runtime: cloneRuntimeTemplate(emitter.runtimeParams),
      category: String(emitter.category || 'other').toLowerCase(),
      materialName: String(emitter.materialName || '').toLowerCase(),
      layerCount: Number(emitter.layerCount || 0),
      layerFlagsKey: runtimeLayerFlagKey(emitter.layerFlags),
      layerToken: emitter?.tailParams?.layerToken ?? null,
      hasColorCurve: Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0,
      alphaCurve: runtimeAlphaTriplet(emitter.colorCurve),
    }))
    .filter((template) => !!template.runtime);

  if (templates.length === 0) {
    return 0;
  }

  let inferredCount = 0;

  for (const emitter of spriteEmitters) {
    const runtime = emitter.runtimeParams;
    const hasColorCurve = Array.isArray(emitter.colorCurve) && emitter.colorCurve.length > 0;
    const needsUnknownRepair = !!runtime && runtime.semantic === 'unknown' && !runtimeParamsHaveShape(runtime);
    const needsMissingRuntimeRepair = !runtime;
    if (!needsUnknownRepair && !needsMissingRuntimeRepair) continue;

    const target = {
      index: emitter.index,
      category: String(emitter.category || 'other').toLowerCase(),
      materialName: String(emitter.materialName || '').toLowerCase(),
      layerCount: Number(emitter.layerCount || 0),
      layerFlagsKey: runtimeLayerFlagKey(emitter.layerFlags),
      layerToken: emitter?.tailParams?.layerToken ?? null,
      hasColorCurve,
    };

    const scored = templates
      .filter((template) => template.index !== target.index)
      .map((template) => {
        let score = template.category === target.category ? 8 : -6;
        if (template.materialName && template.materialName === target.materialName) score += 5;
        if (template.layerCount > 0 && template.layerCount === target.layerCount) score += 3;
        if (template.layerFlagsKey && template.layerFlagsKey === target.layerFlagsKey) score += 3;
        if (template.layerToken !== null && template.layerToken === target.layerToken) score += 2;
        if (template.hasColorCurve === target.hasColorCurve) score += 1;
        else if (template.hasColorCurve || target.hasColorCurve) score -= 0.5;

        if (target.category === 'debris' && template.category === 'light') score -= 3;
        if (target.category === 'light' && template.category === 'debris') score -= 2;

        return { template, score };
      })
      .filter((item) => item.score >= 6)
      .sort((left, right) => right.score - left.score);

    const best = scored[0];
    if (!best) continue;

    const peerRuntime = best.template.runtime || {};
    const inferred = {
      semantic: 'unknownInferred',
      confidence: roundRuntimeValue(Math.max(0.42, Math.min(0.7, 0.28 + best.score * 0.03))),
      source: 'inferred-peer-post-sibling',
      inferredFromEmitter: best.template.index,
      inferredScore: roundRuntimeValue(best.score),
    };

    if (Array.isArray(peerRuntime.sizeCurve) && peerRuntime.sizeCurve.length === 3) {
      inferred.sizeCurve = peerRuntime.sizeCurve.map((value) => roundRuntimeValue(value));
    }
    if (Number.isFinite(peerRuntime.lifetimeSeconds) && peerRuntime.lifetimeSeconds > 0) {
      inferred.lifetimeSeconds = roundRuntimeValue(peerRuntime.lifetimeSeconds);
    }
    if (Number.isFinite(peerRuntime.scalar) && peerRuntime.scalar > 0) {
      inferred.scalar = roundRuntimeValue(peerRuntime.scalar);
    }
    if (!target.hasColorCurve && Array.isArray(best.template.alphaCurve) && best.template.alphaCurve.length === 3) {
      inferred.alphaCurve = best.template.alphaCurve;
    }

    if (!runtimeParamsHaveShape(inferred)) continue;

    emitter.runtimeParams = preserveTailSpatialScalar(inferred, emitter.tailParams);
    if (emitter.tailParams && (!emitter.tailParams.semantic || emitter.tailParams.semantic === 'unknown')) {
      emitter.tailParams.semantic = inferred.semantic;
      emitter.tailParams.confidence = inferred.confidence;
      if (Array.isArray(inferred.sizeCurve)) emitter.tailParams.sizeCurve = inferred.sizeCurve;
      if (Number.isFinite(inferred.lifetimeSeconds)) emitter.tailParams.lifetimeSeconds = inferred.lifetimeSeconds;
      if (Number.isFinite(inferred.scalar)) emitter.tailParams.scalar = inferred.scalar;
      if (Array.isArray(inferred.alphaCurve)) emitter.tailParams.alphaCurve = inferred.alphaCurve;
    }

    templates.push({
      index: emitter.index,
      runtime: cloneRuntimeTemplate(inferred),
      category: target.category,
      materialName: target.materialName,
      layerCount: target.layerCount,
      layerFlagsKey: target.layerFlagsKey,
      layerToken: target.layerToken,
      hasColorCurve: target.hasColorCurve,
      alphaCurve: runtimeAlphaTriplet(emitter.colorCurve),
    });
    inferredCount += 1;
  }

  return inferredCount;
}

function normalizeRuntimeScalarCandidate(value) {
  const scalar = Number(value);
  if (!Number.isFinite(scalar)) return null;
  if (scalar <= 0.05 || scalar > 60) return null;
  return roundRuntimeValue(scalar);
}

// Issue #5 (2026-04-26): pickFallbackRuntimeScalar() was removed. It returned
// hardcoded category-based defaults (smoke=0.4, debris=0.6, light=0.6,
// other=0.5) which silently fabricated a runtime scalar when no authoritative
// source was available. Per user directive ("no fallback, anything goes
// wrong is a warning"), emitters with no authoritative runtimeParams now
// retain runtimeParams=null (or the unknown shape they came in with) and
// the gap is surfaced via parsed.fallbackSpriteRuntimeWarnings so the UI
// can show it in the Warnings + New Pss DEBUG LOGS tabs.
function flagSpritesMissingAuthoritativeRuntime(emitters) {
  if (!Array.isArray(emitters) || emitters.length === 0) {
    return [];
  }
  const warnings = [];
  for (let i = 0; i < emitters.length; i++) {
    const emitter = emitters[i];
    if (!emitter || emitter.type !== 'sprite') continue;
    const runtime = emitter.runtimeParams;
    const semantic = String(runtime?.semantic || '').toLowerCase();
    const needsRepair = !runtime || (semantic === 'unknown' && !runtimeParamsHaveShape(runtime));
    if (!needsRepair) continue;

    // Look for any non-fabricated value already in tailParams; if present,
    // adopt it as a normal (non-fallback) value with explicit source label.
    let scalar = normalizeRuntimeScalarCandidate(runtime?.scalar);
    if (scalar === null) scalar = normalizeRuntimeScalarCandidate(emitter?.tailParams?.scalar);
    if (scalar === null && Array.isArray(emitter?.tailParams?.values) && emitter.tailParams.values.length > 0) {
      scalar = normalizeRuntimeScalarCandidate(emitter.tailParams.values[emitter.tailParams.values.length - 1]);
    }
    if (scalar !== null) {
      const inferred = {
        semantic: 'tailParamsScalar',
        confidence: roundRuntimeValue(Math.max(0.5, Number(runtime?.confidence) || 0)),
        source: 'tail-params-scalar',
        scalar,
      };
      if (Number.isFinite(scalar) && scalar >= 0.05 && scalar <= 20) inferred.lifetimeSeconds = scalar;
      const alphaCurve = runtimeAlphaTriplet(emitter.colorCurve);
      if (Array.isArray(alphaCurve) && alphaCurve.length === 3) inferred.alphaCurve = alphaCurve;
      if (runtimeParamsHaveShape(inferred)) {
        emitter.runtimeParams = preserveTailSpatialScalar(inferred, emitter.tailParams);
        if (emitter.tailParams) {
          emitter.tailParams.semantic = inferred.semantic;
          emitter.tailParams.confidence = inferred.confidence;
          emitter.tailParams.scalar = inferred.scalar;
          if (Number.isFinite(inferred.lifetimeSeconds)) emitter.tailParams.lifetimeSeconds = inferred.lifetimeSeconds;
          if (Array.isArray(inferred.alphaCurve)) emitter.tailParams.alphaCurve = inferred.alphaCurve;
        }
        continue;
      }
    }

    // No authoritative scalar anywhere. Surface as a warning instead of
    // fabricating a category-based default.
    emitter.runtimeWarning = 'no authoritative runtime params; previous fallback default removed (issue #5)';
    warnings.push({
      emitterIndex: i,
      category: String(emitter.category || 'other').toLowerCase(),
      reason: 'no authoritative runtimeParams or tailParams scalar; fallback default removed',
    });
  }
  return warnings;
}

function finalizeParsedPssResponse(sourcePath, parsed) {
  if (!parsed || !Array.isArray(parsed.emitters)) return parsed;

  const templates = buildSiblingRuntimeTemplateMap(sourcePath);
  const inferredCount = applySiblingRuntimeInference(parsed.emitters, templates);
  if (inferredCount > 0) {
    parsed.siblingRuntimeInferred = inferredCount;
  }

  const postSiblingPeerInferredCount = applyPostSiblingPeerRuntimeInference(parsed.emitters);
  if (postSiblingPeerInferredCount > 0) {
    parsed.postSiblingPeerRuntimeInferred = postSiblingPeerInferredCount;
  }

  const fallbackWarnings = flagSpritesMissingAuthoritativeRuntime(parsed.emitters);
  if (fallbackWarnings.length > 0) {
    parsed.fallbackSpriteRuntimeWarnings = fallbackWarnings;
  }

  return parsed;
}

/**
 * Build a filtered PSS catalog response from Pss.rt.
 */
function buildPssCatalogResponse(queryRaw, limitRaw) {
  const catalog = getMovieEditorSpecialEffectsCatalog();
  const query = String(queryRaw || '').trim().toLowerCase();
  const limit = Math.max(12, Math.min(Number(limitRaw) || 60, 300));

  let results = catalog.pssResources;
  if (query) {
    results = results.filter((entry) =>
      matchesCatalogQuery(query, [entry.name, entry.sourcePath, entry.shellPath])
    );
  }

  return {
    available: catalog.available,
    query: queryRaw || '',
    total: catalog.pssResources.length,
    returned: Math.min(results.length, limit),
    results: results.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      sourcePath: r.sourcePath,
      shellPath: r.shellPath,
    })),
  };
}

/**
 * Extract a single file from PakV4 on demand.
 * Returns the Buffer of the extracted file, or null on failure.
 */
function extractFromPakV4(logicalPath, outputDir) {
  ensureDir(outputDir);
  const pathlistFile = join(outputDir, '_pathlist.txt');

  // PakV4SfxExtract.exe expects GBK-encoded pathlist.
  // Use PowerShell to write GBK-encoded file since Node.js lacks native GBK support.
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `[System.IO.File]::WriteAllText('${pathlistFile.replace(/'/g, "''")}', '${logicalPath.replace(/'/g, "''")}' + [char]10, [System.Text.Encoding]::GetEncoding('gb18030'))`,
    ], { timeout: 5000, windowsHide: true });
  } catch {
    // Fallback: write UTF-8 and hope the tool handles it
    writeFileSync(pathlistFile, logicalPath + '\n', 'utf-8');
  }

  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlistFile, outputDir], {
      timeout: 15000,
      windowsHide: true,
      cwd: dirname(PAKV4_EXTRACT_EXE),
    });
  } catch {
    // Tool may return non-zero but still extract
  }

  // Find extracted file — it preserves directory structure
  const expectedPath = join(outputDir, logicalPath.replace(/\//g, '\\'));
  if (existsSync(expectedPath)) {
    return readFileSync(expectedPath);
  }

  // Search recursively for the filename
  const filename = basename(logicalPath);
  const found = findFileRecursive(outputDir, filename);
  if (found) return readFileSync(found);

  return null;
}

function findFileRecursive(dir, filename) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '_pathlist.txt') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
        return full;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function resolvePssPakv4Asset(resourcePath) {
  const normalizedPath = normalizeLogicalResourcePath(resourcePath);
  if (!normalizedPath) return null;

  const expectedPath = join(PSS_ASSET_EXTRACT_DIR, normalizedPath.replace(/\//g, '\\'));
  if (!existsSync(expectedPath)) {
    if (!existsSync(PAKV4_EXTRACT_EXE)) return null;
    const extracted = extractFromPakV4(normalizedPath, PSS_ASSET_EXTRACT_DIR);
    if (!extracted) return null;
  }

  if (!existsSync(expectedPath)) return null;

  return {
    localPath: normalizedPath,
    rawUrl: `/api/pss/asset?path=${encodeURIComponent(normalizedPath)}`,
  };
}

function buildPssTextureCandidatePaths(texturePathRaw) {
  const normalizedPath = normalizeLogicalResourcePath(texturePathRaw);
  if (!normalizedPath) return [];

  const candidates = [];
  if (/\.tga$/i.test(normalizedPath)) {
    candidates.push(normalizedPath.replace(/\.tga$/i, '.dds'));
  }
  candidates.push(normalizedPath);
  return [...new Set(candidates)];
}

function materializeResolvedPssTextureFile(absPath, logicalPath) {
  if (!absPath || !existsSync(absPath)) return null;

  let finalAbsPath = absPath;
  let finalLogicalPath = logicalPath;
  let header = readFileSync(finalAbsPath).subarray(0, 4);
  if (isHxHeader(header) && tryDecodeHxTextureToDds(finalAbsPath)) {
    header = readFileSync(finalAbsPath).subarray(0, 4);
    if (isDdsHeader(header) && extname(finalAbsPath).toLowerCase() !== '.dds') {
      const ddsAbsPath = finalAbsPath.replace(/\.[^/.\\]+$/i, '.dds');
      copyFileSync(finalAbsPath, ddsAbsPath);
      finalAbsPath = ddsAbsPath;
      finalLogicalPath = logicalPath.replace(/\.[^/.\\]+$/i, '.dds');
    }
  }

  const data = readFileSync(finalAbsPath);
  const finalExt = isDdsHeader(data.subarray(0, 4)) ? '.dds' : extname(finalAbsPath).toLowerCase();
  const supportedImageExts = new Set(['.dds', '.png', '.jpg', '.jpeg', '.bmp', '.tga']);
  if (!supportedImageExts.has(finalExt)) return null;

  return {
    absPath: finalAbsPath,
    logicalPath: finalLogicalPath,
    data,
    ext: finalExt,
  };
}

function resolvePssTextureFile(texturePathRaw) {
  const candidates = buildPssTextureCandidatePaths(texturePathRaw);
  if (candidates.length === 0) return null;

  const texExtractDir = join(PSS_EXTRACT_DIR, '_tex');
  ensureDir(texExtractDir);

  for (const candidate of candidates) {
    const extractedAbsPath = safePathUnder(texExtractDir, candidate.replace(/\//g, '\\'));

    if (extractedAbsPath && existsSync(extractedAbsPath)) {
      const materialized = materializeResolvedPssTextureFile(extractedAbsPath, candidate);
      if (materialized) return materialized;
    }

    const cached = tryResolveCacheLogicalPath(candidate);
    if (cached) {
      try {
        const { output } = getJx3CacheReader().readEntry(cached.resolvedPath);
        if (isDdsHeader(output.subarray(0, 4))) {
          return { logicalPath: candidate, data: output, ext: '.dds' };
        }
        if (extractedAbsPath) {
          ensureDir(dirname(extractedAbsPath));
          writeFileSync(extractedAbsPath, output);
          const materialized = materializeResolvedPssTextureFile(extractedAbsPath, candidate);
          if (materialized) return materialized;
        }
      } catch {
        // fall through to PakV4 extraction
      }
    }

    if (existsSync(PAKV4_EXTRACT_EXE)) {
      try {
        extractFromPakV4(candidate, texExtractDir);
      } catch {
        // Tool may still have extracted the file before failing.
      }

      if (extractedAbsPath && existsSync(extractedAbsPath)) {
        const materialized = materializeResolvedPssTextureFile(extractedAbsPath, candidate);
        if (materialized) return materialized;
      }
    }
  }

  return null;
}

function runPssMeshConversionScript(args) {
  const candidates = [];
  const envPython = String(process.env.PYTHON || '').trim();
  if (envPython) {
    candidates.push({ cmd: envPython, args });
  }
  if (existsSync(QMODEL_EMBEDDED_PYTHON_EXE)) {
    candidates.push({ cmd: QMODEL_EMBEDDED_PYTHON_EXE, args });
  }
  if (existsSync(BLENDER_EMBEDDED_PYTHON_EXE)) {
    candidates.push({ cmd: BLENDER_EMBEDDED_PYTHON_EXE, args });
  }
  candidates.push({ cmd: 'python', args });
  candidates.push({ cmd: 'py', args: ['-3', ...args] });

  let lastErr = null;
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, candidate.args, {
        timeout: 60000,
        windowsHide: true,
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  const stderr = lastErr?.stderr ? String(lastErr.stderr).trim() : '';
  const stdout = lastErr?.stdout ? String(lastErr.stdout).trim() : '';
  const detail = stderr || stdout || lastErr?.message || 'unknown error';
  throw new Error(`PSS mesh conversion failed. Ensure Python 3 is available. ${detail}`);
}

function resolvePssMeshGlbAsset(resourcePath, options = {}) {
  const normalizedPath = normalizeLogicalResourcePath(resourcePath);
  if (!normalizedPath) {
    throw new Error('path required');
  }

  if (extname(normalizedPath).toLowerCase() !== '.mesh') {
    throw new Error(`Only .mesh assets are supported: ${normalizedPath}`);
  }

  const resolvedMesh = resolvePssPakv4Asset(normalizedPath);
  if (!resolvedMesh) {
    throw new Error(`Mesh asset not found: ${normalizedPath}`);
  }

  const meshAbs = safePathUnder(PSS_ASSET_EXTRACT_DIR, normalizedPath.replace(/\//g, '\\'));
  if (!meshAbs || !existsSync(meshAbs)) {
    throw new Error(`Mesh asset not found: ${normalizedPath}`);
  }

  let companionAbs = null;
  for (const companionPath of [
    normalizedPath.replace(/\.[^/.\\]+$/i, '.JsonInspack'),
    normalizedPath.replace(/\.[^/.\\]+$/i, '.jsoninspack'),
  ]) {
    const resolvedCompanion = resolvePssPakv4Asset(companionPath);
    if (!resolvedCompanion) continue;
    const candidateAbs = safePathUnder(PSS_ASSET_EXTRACT_DIR, companionPath.replace(/\//g, '\\'));
    if (candidateAbs && existsSync(candidateAbs)) {
      companionAbs = candidateAbs;
      break;
    }
  }

  // Try to resolve companion .ani file (vertex animation)
  const aniPaths = Array.isArray(options.aniPaths) ? options.aniPaths : [];
  let aniAbs = null;
  // First: try explicit ANI paths from the PSS emitter definition
  for (const aniPath of aniPaths) {
    const normalizedAni = normalizeLogicalResourcePath(aniPath);
    if (!normalizedAni) continue;
    const resolvedAni = resolvePssPakv4Asset(normalizedAni);
    if (resolvedAni) {
      const resolved = safePathUnder(PSS_ASSET_EXTRACT_DIR, normalizedAni.replace(/\//g, '\\'));
      if (resolved && existsSync(resolved)) {
        aniAbs = resolved;
        break;
      }
    }
  }
  // Fallback: same name as mesh with .ani extension
  if (!aniAbs) {
    const aniSibling = normalizedPath.replace(/\.[^/.\\]+$/i, '.ani');
    const resolvedSibling = resolvePssPakv4Asset(aniSibling);
    if (resolvedSibling) {
      const siblingAbs = safePathUnder(PSS_ASSET_EXTRACT_DIR, aniSibling.replace(/\//g, '\\'));
      if (siblingAbs && existsSync(siblingAbs)) {
        aniAbs = siblingAbs;
      }
    }
  }

  // Use a suffix to differentiate animated vs static GLB in cache
  const aniTag = aniAbs ? '_animated' : '';
  const relGlbPath = normalizedPath.replace(/\.[^/.\\]+$/i, `${aniTag}.glb`);
  const glbAbs = safePathUnder(PSS_MESH_GLB_CACHE_DIR, relGlbPath.replace(/\//g, '\\'));
  if (!glbAbs) {
    throw new Error(`Invalid mesh cache path for ${normalizedPath}`);
  }

  const meshMtime = statSync(meshAbs).mtimeMs;
  const companionMtime = companionAbs ? statSync(companionAbs).mtimeMs : 0;
  const aniMtime = aniAbs ? statSync(aniAbs).mtimeMs : 0;
  // Include converter script mtime so GLBs are regenerated when the
  // converter logic changes (e.g. new pssMaterial fields). The converter
  // also imports build_map_data.py, so track that too.
  const converterMtime = existsSync(PSS_MESH_CONVERTER_SCRIPT) ? statSync(PSS_MESH_CONVERTER_SCRIPT).mtimeMs : 0;
  const buildMapAbs = join(__dirname, 'tools', 'build_map_data.py');
  const buildMapMtime = existsSync(buildMapAbs) ? statSync(buildMapAbs).mtimeMs : 0;
  const sourceMtime = Math.max(meshMtime, companionMtime, aniMtime, converterMtime, buildMapMtime);
  const needsConvert = !existsSync(glbAbs) || statSync(glbAbs).mtimeMs < sourceMtime;

  if (needsConvert) {
    if (!existsSync(PSS_MESH_CONVERTER_SCRIPT)) {
      throw new Error(`Mesh converter script not found: ${PSS_MESH_CONVERTER_SCRIPT}`);
    }

    ensureDir(dirname(glbAbs));
    const args = [
      PSS_MESH_CONVERTER_SCRIPT,
      '--input', meshAbs,
      '--output', glbAbs,
    ];

    if (companionAbs && existsSync(companionAbs)) {
      args.push('--jsoninspack', companionAbs);
    }

    if (aniAbs) {
      args.push('--ani', aniAbs);
    }

    runPssMeshConversionScript(args);
  }

  if (!existsSync(glbAbs)) {
    throw new Error(`Converted mesh GLB missing for ${normalizedPath}`);
  }

  return {
    sourcePath: normalizedPath,
    localPath: relGlbPath,
    absolutePath: glbAbs,
    rawUrl: `/api/pss/mesh-glb?path=${encodeURIComponent(normalizedPath)}`,
  };
}

/**
 * Analyze a PSS file: try cache first, then PakV4 extraction.
 */
function buildPssAnalyzeResponse(sourcePathRaw) {
  const sourcePath = normalizeLogicalResourcePath(sourcePathRaw);
  if (!sourcePath) throw new Error('sourcePath is required');

  // Try JX3 cache first
  const resolved = tryResolveCacheLogicalPath(sourcePath);
  if (resolved) {
    const { output } = getJx3CacheReader().readEntry(resolved.resolvedPath);
    const parsed = finalizeParsedPssResponse(
      sourcePath,
      parsePssEffectScene(output),
    );
    if (parsed) {
      return { ok: true, source: 'cache', sourcePath, ...parsed };
    }
    return { ok: false, source: 'cache', sourcePath, error: 'PSS parse failed — not a valid PAR file' };
  }

  // Try already-extracted PSS cache
  const cachedPssPath = join(PSS_EXTRACT_DIR, sourcePath.replace(/\//g, '\\'));
  if (existsSync(cachedPssPath)) {
    const buf = readFileSync(cachedPssPath);
    const parsed = finalizeParsedPssResponse(
      sourcePath,
      parsePssEffectScene(buf),
    );
    if (parsed) {
      return { ok: true, source: 'pss-cache', sourcePath, ...parsed };
    }
  }

  // Extract from PakV4 on demand
  if (existsSync(PAKV4_EXTRACT_EXE)) {
    const buf = extractFromPakV4(sourcePath, PSS_EXTRACT_DIR);
    if (buf) {
      const parsed = finalizeParsedPssResponse(
        sourcePath,
        parsePssEffectScene(buf),
      );
      if (parsed) {
        return { ok: true, source: 'pakv4', sourcePath, ...parsed };
      }
      return { ok: false, source: 'pakv4', sourcePath, error: 'Extracted file is not a valid PAR PSS' };
    }
  }

  return { ok: false, source: 'none', sourcePath, error: 'PSS file not found in cache and PakV4 extraction failed' };
}

function readPssSourceBuffer(sourcePathRaw) {
  const sourcePath = normalizeLogicalResourcePath(sourcePathRaw);
  if (!sourcePath) return null;

  const resolved = tryResolveCacheLogicalPath(sourcePath);
  if (resolved) {
    try {
      return getJx3CacheReader().readEntry(resolved.resolvedPath).output;
    } catch {
      // fall through to extracted/PakV4 paths
    }
  }

  const cachedPssPath = join(PSS_EXTRACT_DIR, sourcePath.replace(/\//g, '\\'));
  if (existsSync(cachedPssPath)) {
    try {
      return readFileSync(cachedPssPath);
    } catch {
      // fall through to PakV4
    }
  }

  if (existsSync(PAKV4_EXTRACT_EXE)) {
    return extractFromPakV4(sourcePath, PSS_EXTRACT_DIR);
  }

  return null;
}

// Read blend mode from a .jsondef material file. The jsondef stores
// `RenderState.BlendMode` as an integer:
//   0 = none/opaque, 1 = alpha/normal, 2 = additive, 3 = multiply, 4 = subtractive
// This replaces the keyword guessing from the material NAME.
const JSONDEF_BLEND_CACHE = new Map();
function readJsondefBlendMode(matLogicalPath) {
  if (!matLogicalPath) return null;
  const key = matLogicalPath.toLowerCase();
  if (JSONDEF_BLEND_CACHE.has(key)) return JSONDEF_BLEND_CACHE.get(key);

  let buf = null;
  try {
    const norm = normalizeLogicalResourcePath(matLogicalPath);
    const resolved = tryResolveCacheLogicalPath(norm);
    if (resolved) buf = getJx3CacheReader().readEntry(resolved.resolvedPath).output;
    if (!buf) {
      const local = join(PSS_EXTRACT_DIR, norm.replace(/\//g, '\\'));
      if (existsSync(local)) buf = readFileSync(local);
    }
  } catch { /* not found */ }

  if (!buf) {
    // Defensive on-disk fallback: installs that have the MovieEditor source
    // checked out may have the .jsondef sitting on disk even when the packed
    // cache does not carry it. We also try the ResourcePack tree.
    const norm = normalizeLogicalResourcePath(matLogicalPath);
    const diskCandidates = [
      join(MOVIE_EDITOR_SOURCE_ROOT, norm.replace(/\//g, '\\')),
      join(MOVIE_EDITOR_SOURCE_ROOT, norm.replace(/^data\/source\//i, '').replace(/\//g, '\\')),
      join(MOVIE_EDITOR_RESOURCEPACK_ROOT, norm.replace(/\//g, '\\')),
    ];
    for (const candidate of diskCandidates) {
      if (existsSync(candidate)) { buf = readFileSync(candidate); break; }
    }
  }
  if (!buf) { JSONDEF_BLEND_CACHE.set(key, null); return null; }

  try {
    // jsondef files are GB18030-encoded JSON — parse with latin1 to get readable ASCII fields
    const text = buf.toString('latin1');
    const m = text.match(/"BlendMode"\s*:\s*(\d+)/);
    if (!m) { JSONDEF_BLEND_CACHE.set(key, null); return null; }
    const v = parseInt(m[1], 10);
    // Map engine BlendMode integer → renderer string
    const MAP = { 0: 'normal', 1: 'normal', 2: 'additive', 3: 'multiply', 4: 'subtractive' };
    const result = MAP[v] ?? 'additive';
    JSONDEF_BLEND_CACHE.set(key, result);
    return result;
  } catch { JSONDEF_BLEND_CACHE.set(key, null); return null; }
}

function extractPssGlobalTiming(buffer) {
  if (!buffer || buffer.length < 16) return null;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x41 || buffer[2] !== 0x52 || buffer[3] !== 0x00) return null;

  const emitterCount = buffer.readUInt32LE(12);
  const tocEnd = 16 + emitterCount * 12;
  if (tocEnd > buffer.length) return null;

  let globalDuration = null;
  let globalStartDelay = null;
  let globalPlayDuration = null;
  let globalLoopEnd = null;

  for (let i = 0; i < emitterCount; i++) {
    const base = 16 + i * 12;
    const type = buffer.readUInt32LE(base);
    if (type !== 0) continue;

    const offset = buffer.readUInt32LE(base + 4);
    const size = buffer.readUInt32LE(base + 8);
    if (size < 20 || offset < 0 || offset + 20 > buffer.length) break;

    const f0 = buffer.readFloatLE(offset);
    const f1 = buffer.readFloatLE(offset + 4);
    const f2 = buffer.readFloatLE(offset + 8);
    const f3 = buffer.readFloatLE(offset + 12);
    if (f0 > 0 && f0 < 300000) globalStartDelay = f0;
    if (f1 > 100 && f1 < 300000) globalPlayDuration = f1;
    if (f2 > 100 && f2 < 300000) globalDuration = f2;
    else if (f1 > 100 && f1 < 300000) globalDuration = f1;
    if (f3 > 0 && f3 < 300000) globalLoopEnd = f3;
    break;
  }

  return {
    globalStartDelay,
    globalPlayDuration,
    globalDuration,
    globalLoopEnd,
  };
}

function deriveTaniPssTimingFromSource(sourcePathRaw) {
  const sourcePath = normalizeLogicalResourcePath(sourcePathRaw);
  if (!sourcePath) return null;

  const buffer = readPssSourceBuffer(sourcePath);
  if (!buffer) return null;

  const timing = extractPssGlobalTiming(buffer);
  if (!timing) return null;

  const effectiveStartTimeMs = Math.max(0, Number(timing.globalStartDelay) || 0);
  return {
    sourcePath,
    startTimeMs: 0,
    effectiveStartTimeMs,
    pssStartDelayMs: effectiveStartTimeMs,
    pssPlayDurationMs: Math.max(0, Number(timing.globalPlayDuration) || 0),
    pssTotalDurationMs: Math.max(0, Number(timing.globalDuration) || 0),
    timingSource: effectiveStartTimeMs > 0 ? 'pss-global-delay' : 'default-zero',
  };
}

function resolveDependencyEntries(paths, maxResults = 40) {
  const dependencies = [];
  const seen = new Set();

  for (const logicalPath of paths) {
    const resolved = tryResolveCacheLogicalPath(logicalPath);
    const dedupeKey = String(resolved?.resolvedPath || normalizeLogicalResourcePath(logicalPath)).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    dependencies.push({
      requestedPath: logicalPath,
      resolvedPath: resolved?.resolvedPath || null,
      rawUrl: resolved?.rawUrl || null,
      existsInCache: Boolean(resolved),
      kind: classifyDependencyPath(logicalPath),
    });

    if (dependencies.length >= maxResults) break;
  }

  return dependencies;
}

function buildCacheEntryPreviewResponse(logicalPathRaw) {
  const requestedPath = normalizeLogicalResourcePath(logicalPathRaw);
  if (!requestedPath) {
    throw new Error('logicalPath is required');
  }

  const resolvedEntry = tryResolveCacheLogicalPath(requestedPath);
  if (!resolvedEntry) {
    throw new Error(`No cache entry found for ${requestedPath}`);
  }

  const { entry, output } = getJx3CacheReader().readEntry(resolvedEntry.resolvedPath);
  const textPayload = detectTextPayload(output);
  const asciiStrings = extractAsciiStrings(output);
  const utf16Strings = extractUtf16Strings(output);
  const dependencyPaths = mergeUniquePaths([
    extractBinaryDependencyPaths(output),
    collectDependencyPaths([
      textPayload.preview,
      ...asciiStrings,
      ...utf16Strings,
    ]),
  ]);
  const dependencies = resolveDependencyEntries(dependencyPaths);
  const uniqueDependencyPaths = dependencies.map((dependency) => dependency.requestedPath);
  const primaryImage = dependencies.find((dependency) => dependency.kind === 'image' && dependency.existsInCache) || null;
  const formatHint = output.subarray(0, 4).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() || 'binary';

  return {
    requestedLogicalPath: requestedPath,
    logicalPath: entry.logicalPath,
    resolvedLogicalPath: entry.logicalPath,
    rawUrl: `/api/cache-entry/raw?logicalPath=${encodeURIComponent(entry.logicalPath)}`,
    byteLength: output.length,
    cacheInfo: {
      cacheRoot: JX3_CACHE_ROOT,
      h1: formatUint64Hex(entry.h1),
      h2: formatUint64Hex(entry.h2),
      dirHash: `0x${entry.dirHash.toString(16).toUpperCase()}`,
      xxh64: formatUint64Hex(entry.fileHash),
      fnFile: entry.fnFile,
      idxPath: entry.idxPath,
      datPath: entry.datPath,
      datIndex: entry.datIndex,
      datOffset: entry.datOffset,
      compressedSize: entry.compressedSize,
      originalSize: entry.originalSize,
      compressionType: entry.compressionType,
      storageMode: entry.storageMode,
      cacheHeaderSize: entry.cacheHeaderSize,
    },
    preview: {
      formatHint,
      storageMode: entry.storageMode,
      cacheHeaderSize: entry.cacheHeaderSize,
      primaryImage,
      billboardMode: 'billboard',
    },
    payload: {
      isLikelyText: textPayload.isLikelyText,
      textEncoding: textPayload.encoding,
      textScore: textPayload.score,
      textPreview: textPayload.preview,
      headerHex: formatHexDump(output),
      asciiStrings,
      utf16Strings,
      dependencyPaths: uniqueDependencyPaths,
      dependencies,
    },
  };
}

function listDirectoryFileNames(dirPath) {
  if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function listFilesRecursive(dirPath, allowedExtensions = null, prefix = '') {
  if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];

  const out = [];
  const normalizedAllowed = allowedExtensions instanceof Set
    ? new Set([...allowedExtensions].map((ext) => String(ext).toLowerCase()))
    : null;

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(absPath, normalizedAllowed, relPath));
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (normalizedAllowed && !normalizedAllowed.has(ext)) continue;
    out.push(relPath.replace(/\\/g, '/'));
  }

  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function parseIniSections(text) {
  const sections = new Map();
  let currentSection = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, {});
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    const targetSection = currentSection || 'ROOT';
    if (!sections.has(targetSection)) sections.set(targetSection, {});
    sections.get(targetSection)[key] = value;
  }

  return sections;
}

function inferPlayerBodyType(dependModel) {
  const match = /source[\\/]+player[\\/]+(f1|f2|m1|m2)[\\/]/i.exec(String(dependModel || ''));
  return match ? match[1].toUpperCase() : null;
}

function parseActorFileSummary(actorText) {
  const sections = parseIniSections(actorText);
  const root = sections.get('ROOT') || {};
  const parts = [];

  for (const [sectionName, values] of sections.entries()) {
    if (!/^Part\d+$/i.test(sectionName)) continue;
    if (String(values.Have || '0') !== '1') continue;

    parts.push({
      slot: Number(sectionName.replace(/\D+/g, '')) || 0,
      section: sectionName,
      mesh: values.Mesh || '',
      material: values.Mtl || '',
      detail: values.Detail || '',
    });
  }

  parts.sort((a, b) => a.slot - b.slot);

  return {
    dependModel: root.DependModel || '',
    faceDefinition: root.FaceDefIni || '',
    metaFaceDefinition: root.MetaFaceDefJson || '',
    reDress: String(root.bReDress || '0') === '1',
    declaredPartSlots: Number(root.PartNum) || parts.length,
    declaredBindSlots: Number(root.BindNum) || 0,
    bodyType: inferPlayerBodyType(root.DependModel),
    partCount: parts.length,
    parts,
  };
}

function findMovieEditorActorFile(exportName) {
  const candidates = [
    join(MOVIE_EDITOR_SOURCE_ROOT, `${exportName}.actor`),
    join(MOVIE_EDITOR_SOURCE_ROOT, 'Actor', `${exportName}.actor`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }

  return null;
}

function buildMovieEditorPlayerSupport(bodyType) {
  const normalized = String(bodyType || '').trim().toUpperCase();
  if (!/^[FM][12]$/.test(normalized)) return null;

  const lower = normalized.toLowerCase();
  const playerDir = join(MOVIE_EDITOR_SOURCE_ROOT, 'player', normalized);
  const actionsDir = join(playerDir, '动作');

  return {
    bodyType: normalized,
    playerDir,
    exportSkeletonPath: existsSync(join(playerDir, `${lower}.fbx`))
      ? join(playerDir, `${lower}.fbx`)
      : null,
    standardSkeletonPath: existsSync(join(playerDir, `${normalized}-标准骨骼.FBX`))
      ? join(playerDir, `${normalized}-标准骨骼.FBX`)
      : null,
    importTestPath: existsSync(join(playerDir, `${normalized}动作导入测试.FBX`))
      ? join(playerDir, `${normalized}动作导入测试.FBX`)
      : null,
    actionsDir: existsSync(actionsDir) ? actionsDir : null,
    actionFileCount: listDirectoryFileNames(actionsDir)
      .filter((name) => name.toLowerCase().endsWith('.ani'))
      .length,
  };
}

function buildMovieEditorPlayerAnchorSupport(bodyType) {
  const playerSupport = buildMovieEditorPlayerSupport(bodyType);
  if (!playerSupport) return null;

  const toAssetUrl = (absPath) => (absPath ? buildMovieEditorAssetUrl(absPath) : null);
  const preferredSkeletonPath = playerSupport.standardSkeletonPath
    || playerSupport.exportSkeletonPath
    || playerSupport.importTestPath
    || null;

  return {
    ...playerSupport,
    preferredSkeletonPath,
    preferredSkeletonUrl: toAssetUrl(preferredSkeletonPath),
    exportSkeletonUrl: toAssetUrl(playerSupport.exportSkeletonPath),
    standardSkeletonUrl: toAssetUrl(playerSupport.standardSkeletonPath),
    importTestUrl: toAssetUrl(playerSupport.importTestPath),
    socketBindings: readMovieEditorSocketBindings(),
  };
}

function buildMovieEditorAssetUrl(absPath) {
  return `/movie-editor-assets/${encodeUrlPathSegments(relative(MOVIE_EDITOR_ROOT, absPath))}`;
}

function listMovieEditorActorExports() {
  if (!existsSync(MOVIE_EDITOR_EXPORT_ROOT) || !statSync(MOVIE_EDITOR_EXPORT_ROOT).isDirectory()) {
    return [];
  }

  const exportDirs = readdirSync(MOVIE_EDITOR_EXPORT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return exportDirs.map((folderName) => {
    const exportDir = join(MOVIE_EDITOR_EXPORT_ROOT, folderName);
    const files = listDirectoryFileNames(exportDir);
    const fbxFileName = files.find((name) => name.toLowerCase().endsWith('.fbx')) || null;
    const exportListPath = join(exportDir, 'export_list.txt');
    const exportListEntries = readTextUtf8(exportListPath, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const textureDir = join(exportDir, 'tex');
    const textureFiles = listDirectoryFileNames(textureDir);
    const soundFiles = listFilesRecursive(exportDir, new Set(['.wav', '.mp3', '.ogg', '.wem', '.bnk', '.fsb', '.cue']));
    const actorFilePath = findMovieEditorActorFile(folderName);
    const actMtlPath = join(MOVIE_EDITOR_SOURCE_ROOT, `${folderName}.ActMtl`);
    const sourceActor = actorFilePath
      ? parseActorFileSummary(readTextUtf8(actorFilePath, ''))
      : null;

    return {
      name: folderName,
      exportDir,
      fbxFileName,
      fbxUrl: fbxFileName ? buildMovieEditorAssetUrl(join(exportDir, fbxFileName)) : null,
      exportListPath: existsSync(exportListPath) ? exportListPath : null,
      exportListUrl: existsSync(exportListPath) ? buildMovieEditorAssetUrl(exportListPath) : null,
      exportListEntries,
      textureDir: existsSync(textureDir) ? textureDir : null,
      textureBaseUrl: existsSync(textureDir) ? buildMovieEditorAssetUrl(textureDir) : null,
      textureCount: textureFiles.length,
      textureFiles,
      soundCount: soundFiles.length,
      soundFiles,
      sourceActorFilePath: actorFilePath,
      sourceActor,
      hasActMtl: existsSync(actMtlPath),
      actMtlPath: existsSync(actMtlPath) ? actMtlPath : null,
      playerSupport: sourceActor ? buildMovieEditorPlayerSupport(sourceActor.bodyType) : null,
    };
  });
}

function readMovieEditorSocketBindings() {
  const socketRows = readMovieEditorTable('movie-editor-socket-table', MOVIE_EDITOR_SOCKET_TABLE_PATH)
    .map((row) => ({
      socketName: pickRowValue(row, ['SocketName', 'socketName']),
      socketText: pickRowValue(row, ['SocketText', 'socketText']),
    }))
    .filter((row) => row.socketName);

  const parentSections = getCachedFileData(
    'movie-editor-socket-parents',
    MOVIE_EDITOR_SOCKET_PARENT_PATH,
    () => parseIniSections(readTextDecoded(MOVIE_EDITOR_SOCKET_PARENT_PATH, 'gb18030', '')),
  );

  const parentBySocket = new Map();
  for (const [sectionName, values] of parentSections.entries()) {
    if (!/^Dummy\d+$/i.test(sectionName)) continue;
    const socketName = String(values.Name || '').trim();
    if (!socketName) continue;
    const matrixText = String(values.Matrix || '').trim();
    const matrix = matrixText
      ? matrixText
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
      : [];
    parentBySocket.set(socketName, {
      parentBone: String(values.Parent || '').trim(),
      type: String(values.Type || '').trim(),
      hasMatrix: matrix.length === 16,
      matrix: matrix.length === 16 ? matrix : null,
    });
  }

  return socketRows.map((row) => {
    const binding = parentBySocket.get(row.socketName) || {};
    return {
      socketName: row.socketName,
      socketText: row.socketText,
      parentBone: binding.parentBone || '',
      type: binding.type || '',
      hasMatrix: Boolean(binding.hasMatrix),
      matrix: Array.isArray(binding.matrix) ? binding.matrix : null,
    };
  });
}

function getMovieEditorSpecialEffectsCatalog() {
  const stamp = [
    MOVIE_EDITOR_ANI_TABLE_PATH,
    MOVIE_EDITOR_TANI_TABLE_PATH,
    MOVIE_EDITOR_SFX_TABLE_PATH,
    MOVIE_EDITOR_PSS_TABLE_PATH,
    MOVIE_EDITOR_SOCKET_TABLE_PATH,
    MOVIE_EDITOR_SOCKET_PARENT_PATH,
    MOVIE_EDITOR_ACTION_MUSIC_PATH,
    MOVIE_EDITOR_ACTION_WWISE_PATH,
  ].map((filePath) => `${filePath}:${getFileStamp(filePath)}`).join('|');

  const cached = MOVIE_EDITOR_TABLE_CACHE.get('movie-editor-special-effects-catalog');
  if (cached?.stamp === stamp) {
    return cached.value;
  }

  const bodyTypes = ['F1', 'F2', 'M1', 'M2'];
  const aniRows = readMovieEditorTable('movie-editor-ani-table', MOVIE_EDITOR_ANI_TABLE_PATH)
    .map((row) => {
      const bodyPaths = Object.fromEntries(bodyTypes.map((bodyType) => [
        bodyType,
        normalizeCatalogPath(row[bodyType]),
      ]));
      const taniBodyTypes = bodyTypes.filter((bodyType) => /\.tani$/i.test(bodyPaths[bodyType] || ''));
      return {
        id: Number(pickRowValue(row, ['ID', 'Id', 'id'])) || 0,
        animationName: pickRowValue(row, ['AnimationName', 'Name', 'name']),
        bodyPaths,
        usesTani: taniBodyTypes.length > 0,
        taniBodyTypes,
      };
    })
    .filter((row) => row.animationName || Object.values(row.bodyPaths).some(Boolean));

  const effectActions = aniRows.filter((row) => row.usesTani || row.animationName.includes('特效'));

  const taniResources = readMovieEditorTable('movie-editor-tani-table', MOVIE_EDITOR_TANI_TABLE_PATH)
    .map((row) => ({
      id: Number(pickRowValue(row, ['ID', 'Id', 'id'])) || 0,
      name: pickRowValue(row, ['Name', 'name']),
      sourcePath: normalizeCatalogPath(pickRowValue(row, ['SourcePath', 'sourcePath'])),
      shellPath: normalizeCatalogPath(pickRowValue(row, ['ShellPath', 'shellPath'])),
    }))
    .filter((row) => row.name);

  const sfxResources = readMovieEditorTable('movie-editor-sfx-table', MOVIE_EDITOR_SFX_TABLE_PATH)
    .map((row) => ({
      id: Number(pickRowValue(row, ['ID', 'Id', 'id'])) || 0,
      name: pickRowValue(row, ['Name', 'name']),
      sourcePath: normalizeCatalogPath(pickRowValue(row, ['SourcePath', 'sourcePath'])),
      shellPath: normalizeCatalogPath(pickRowValue(row, ['ShellPath', 'shellPath'])),
    }))
    .filter((row) => row.name);

  const pssResources = readMovieEditorTable('movie-editor-pss-table', MOVIE_EDITOR_PSS_TABLE_PATH)
    .map((row) => {
      const name = pickRowValue(row, ['Name', 'name']);
      const sourcePath = normalizeCatalogPath(pickRowValue(row, ['SourcePath', 'sourcePath']));
      const shellPath = normalizeCatalogPath(pickRowValue(row, ['ShellPath', 'shellPath']));
      return {
        id: Number(pickRowValue(row, ['ID', 'Id', 'id'])) || 0,
        name,
        sourcePath,
        shellPath,
        searchKeys: buildEffectSearchKeys(name, sourcePath, shellPath),
      };
    })
    .filter((row) => row.name);

  const sockets = readMovieEditorSocketBindings();
  const value = {
    available: [
      MOVIE_EDITOR_ANI_TABLE_PATH,
      MOVIE_EDITOR_TANI_TABLE_PATH,
      MOVIE_EDITOR_SFX_TABLE_PATH,
      MOVIE_EDITOR_PSS_TABLE_PATH,
      MOVIE_EDITOR_SOCKET_TABLE_PATH,
      MOVIE_EDITOR_SOCKET_PARENT_PATH,
    ].every((filePath) => existsSync(filePath)),
    counts: {
      aniRows: aniRows.length,
      effectActions: effectActions.length,
      taniResources: taniResources.length,
      sfxResources: sfxResources.length,
      pssResources: pssResources.length,
      sockets: sockets.length,
    },
    audioModel: {
      separateFromVisualSfx: true,
      musicTrackAvailable: existsSync(MOVIE_EDITOR_ACTION_MUSIC_PATH),
      wwiseEventAvailable: existsSync(MOVIE_EDITOR_ACTION_WWISE_PATH),
    },
    effectActions,
    taniResources,
    sfxResources,
    pssResources,
    sockets,
  };

  MOVIE_EDITOR_TABLE_CACHE.set('movie-editor-special-effects-catalog', { stamp, value });
  return value;
}

function buildMovieEditorSpecialEffectsResponse(queryRaw, limitRaw) {
  const catalog = getMovieEditorSpecialEffectsCatalog();
  const query = String(queryRaw || '').trim();
  const limit = Math.max(12, Math.min(Number(limitRaw) || 48, 200));

  const effectActions = catalog.effectActions
    .filter((entry) => matchesCatalogQuery(query, [entry.animationName, ...Object.values(entry.bodyPaths)]))
    .slice(0, limit);

  const taniResources = catalog.taniResources
    .filter((entry) => matchesCatalogQuery(query, [entry.name, entry.sourcePath, entry.shellPath]))
    .slice(0, limit);

  const sfxResources = catalog.sfxResources
    .filter((entry) => matchesCatalogQuery(query, [entry.name, entry.sourcePath, entry.shellPath]))
    .slice(0, limit);

  const sockets = catalog.sockets
    .filter((entry) => matchesCatalogQuery(query, [entry.socketName, entry.socketText, entry.parentBone]))
    .slice(0, limit);

  return {
    available: catalog.available,
    root: MOVIE_EDITOR_ROOT,
    resourcePackRoot: MOVIE_EDITOR_RESOURCEPACK_ROOT,
    query,
    limit,
    counts: catalog.counts,
    audioModel: catalog.audioModel,
    notes: {
      animationSource: 'Actor Editor 动作 entries resolve from AniTable.txt and Tani.rt under data/source/player/<bodyType>/动作.',
      bindingSource: 'Visual effects are separate timeline actions that bind through named sockets like s_fxtop, s_fxmid, s_face, s_lh, and s_rh.',
      audioSource: 'MovieEditor keeps audio separate from visual SFX through ActionMusic and ActionWwiseEvent tracks.',
      extractionPath: 'tools/extract-cache-asset.ps1 can target logical paths from the catalog and now reads the live editor cache with shared access.',
      viewerStatus: 'Resource Manager surfaces real metadata, and the preview tab now renders cached texture-driven proxies or synthetic Pss.rt-backed fallbacks for missing rows.',
    },
    extraction: {
      scriptPath: resolve(join(__dirname, 'tools', 'extract-cache-asset.ps1')),
      cacheRoot: JX3_CACHE_ROOT,
    },
    samples: {
      effectActions,
      taniResources,
      sfxResources,
      sockets,
    },
  };
}

function getSfxPathMapping() {
  const cacheKey = 'sfx-path-mapping';
  if (!existsSync(SFX_PATH_MAPPING_PATH)) return new Map();
  const stamp = getFileStamp(SFX_PATH_MAPPING_PATH);
  const cached = MOVIE_EDITOR_TABLE_CACHE.get(cacheKey);
  if (cached?.stamp === stamp) return cached.value;
  try {
    const data = JSON.parse(readFileSync(SFX_PATH_MAPPING_PATH, 'utf8'));
    const map = new Map();
    for (const m of (data.matches || [])) {
      const normalizedPath = String(m.sfxRtPath || '').replace(/\\/g, '/');
      if (normalizedPath && m.extractedFile) {
        map.set(normalizedPath, {
          extractedFile: m.extractedFile,
          confidence: m.confidence || 'low',
          matchScore: m.matchScore || 0,
          particleCount: m.particleCount || 0,
        });
      }
    }
    MOVIE_EDITOR_TABLE_CACHE.set(cacheKey, { stamp, value: map });
    return map;
  } catch { return new Map(); }
}

function getCachedSpecialEffectsPreviewCatalog() {
  const cacheFilePaths = [MOVIE_EDITOR_SFX_TABLE_PATH, MOVIE_EDITOR_PSS_TABLE_PATH];
  if (existsSync(JX3_CACHE_ROOT)) {
    cacheFilePaths.push(join(JX3_CACHE_ROOT, '0.idx'));
    for (const entry of readdirSync(JX3_CACHE_ROOT, { withFileTypes: true })) {
      if (!entry.isFile() || !/^fn\d+\.1$/i.test(entry.name)) continue;
      cacheFilePaths.push(join(JX3_CACHE_ROOT, entry.name));
    }
  }
  if (existsSync(SFX_PATH_MAPPING_PATH)) {
    cacheFilePaths.push(SFX_PATH_MAPPING_PATH);
  }

  const stamp = cacheFilePaths.map((filePath) => `${filePath}:${getFileStamp(filePath)}`).join('|');
  const cacheKey = 'movie-editor-cached-special-effects-preview';
  const cached = MOVIE_EDITOR_TABLE_CACHE.get(cacheKey);
  if (cached?.stamp === stamp) {
    return cached.value;
  }

  const catalog = getMovieEditorSpecialEffectsCatalog();
  const sfxMapping = getSfxPathMapping();
  let cachedPreviewCount = 0;
  let matchedCount = 0;
  let pakExtractCount = 0;

  // Build Sfx.rt-based samples (named effects)
  const samples = catalog.sfxResources
    .map((resource) => {
      const resolved = tryResolveCacheLogicalPath(resource.sourcePath);
      const normalizedPath = resource.sourcePath.replace(/\\/g, '/');
      const mapping = sfxMapping.get(normalizedPath);

      // Check if file exists in sfx-pak-extract (full PakV4 extraction)
      const pakExtractPath = join(SFX_PAK_EXTRACT_DIR, normalizedPath);
      const hasPakExtract = existsSync(pakExtractPath);

      let availability = resolved ? 'cached' : 'missing-cache';
      let rawUrl = resolved ? `/api/cache-entry/raw?logicalPath=${encodeURIComponent(resource.sourcePath)}` : null;

      if (!resolved && hasPakExtract) {
        availability = 'extracted-pakv4';
        rawUrl = `/api/sfx-pak-extract/raw?sourcePath=${encodeURIComponent(normalizedPath)}`;
        pakExtractCount += 1;
      } else if (!resolved && mapping) {
        availability = 'matched-pakv4';
        rawUrl = `/map-data/sfx-extracted/${encodeURIComponent(mapping.extractedFile)}`;
        matchedCount += 1;
      }

      const sample = {
        ...resource,
        cachedPreviewAvailable: Boolean(resolved) || hasPakExtract || Boolean(mapping),
        availability,
        resolvedPath: resolved?.resolvedPath || null,
        previewUrl: resolved ? `/api/cache-entry/preview?logicalPath=${encodeURIComponent(resource.sourcePath)}` : null,
        rawUrl,
        billboardMode: 'billboard',
        fallbackPreview: buildSyntheticPreviewDescriptor(resource, catalog.pssResources),
      };

      if (hasPakExtract) {
        sample.matchConfidence = 'exact';
      } else if (mapping) {
        sample.matchedFile = mapping.extractedFile;
        sample.matchConfidence = mapping.confidence;
      }

      if (resolved || hasPakExtract || mapping) cachedPreviewCount += 1;
      Object.defineProperty(sample, 'searchBlob', {
        value: buildCatalogSearchBlob([sample.name, sample.sourcePath, sample.shellPath]),
        enumerable: false,
      });
      return sample;
    });

  // Sort: cached first, then extracted, then matched, then missing
  const availOrder = { cached: 0, 'extracted-pakv4': 1, 'matched-pakv4': 2, 'missing-cache': 3 };
  samples.sort((left, right) => {
    const ao = (availOrder[left.availability] ?? 9) - (availOrder[right.availability] ?? 9);
    if (ao !== 0) return ao;
    return String(left.name || left.sourcePath).localeCompare(String(right.name || right.sourcePath), undefined, { sensitivity: 'base' });
  });

  const value = {
    catalog,
    totalCatalogCount: catalog.counts.sfxResources,
    cachedPreviewCount,
    matchedCount,
    pakExtractCount,
    samples,
  };

  MOVIE_EDITOR_TABLE_CACHE.set(cacheKey, { stamp, value });
  return value;
}

function buildSpecialEffectsPreviewResponse(queryRaw, limitRaw, options = {}) {
  const catalog = getCachedSpecialEffectsPreviewCatalog();
  const query = String(queryRaw || '').trim();
  const includeAll = options.includeAll === true;
  const needle = query.toLowerCase();
  const limit = includeAll
    ? Math.max(catalog.totalCatalogCount, 1)
    : Math.max(24, Math.min(Number(limitRaw) || 120, 300));
  const matchingItems = needle
    ? catalog.samples.filter((entry) => entry.searchBlob.includes(needle))
    : catalog.samples;
  const items = includeAll ? matchingItems : matchingItems.slice(0, limit);
  const shownPreviewable = items.filter((entry) => entry.cachedPreviewAvailable).length;
  const shownSynthetic = items.filter((entry) => !entry.cachedPreviewAvailable && entry.fallbackPreview?.available).length;

  return {
    available: catalog.totalCatalogCount > 0,
    root: MOVIE_EDITOR_ROOT,
    cacheRoot: JX3_CACHE_ROOT,
    query,
    limit,
    counts: {
      totalCatalog: catalog.totalCatalogCount,
      cachedPreviewable: catalog.cachedPreviewCount,
      matchedPakv4: catalog.matchedCount || 0,
      extractedPakv4: catalog.pakExtractCount || 0,
      matching: matchingItems.length,
      shown: items.length,
      shownPreviewable,
      shownSynthetic,
    },
    notes: {
      availability: `Search covers the full MovieEditor SFX catalog. ${catalog.pakExtractCount || 0} effects extracted from PakV4 (exact). ${catalog.matchedCount || 0} matched via heuristic.`,
      searchMode: includeAll ? 'Full catalog response for local client-side search.' : 'Filtered response.',
      rendering: 'The viewport renders a texture-driven proxy from the SFX payload references. Full particle opcode playback is not decoded yet.',
    },
    samples: items,
  };
}

function listRepoClipSources() {
  if (!existsSync(REPO_CLIPS_ROOT) || !statSync(REPO_CLIPS_ROOT).isDirectory()) {
    return [];
  }

  return listFilesRecursive(REPO_CLIPS_ROOT, new Set(['.fbx']))
    .map((relativePath) => {
      const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
      return {
        name: normalizedPath.replace(/\.fbx$/i, ''),
        relativePath: normalizedPath,
        fbxFileName: basename(normalizedPath),
        fbxUrl: `/repo-clips/${encodeUrlPathSegments(normalizedPath)}`,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function readJsonUtf8(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function readResourceGroupStore() {
  const store = readJsonUtf8(RESOURCE_GROUPS_FILE, { actors: {} });
  if (!store || typeof store !== 'object') return { actors: {} };
  if (!store.actors || typeof store.actors !== 'object') return { actors: {} };
  return store;
}

function sanitizeResourceGroupsPayload(payload) {
  return (Array.isArray(payload?.groups) ? payload.groups : [])
    .map((group, index) => {
      const members = [...new Set((Array.isArray(group?.members) ? group.members : [])
        .map((member) => String(member || '').trim())
        .filter(Boolean))];

      return {
        id: String(group?.id || `group-${index + 1}`),
        name: String(group?.name || `Group ${index + 1}`),
        members,
      };
    })
    .filter((group) => group.members.length >= 2);
}

function readActorResourceGroups(actorName) {
  const actor = String(actorName || '').trim();
  if (!actor) return [];
  const store = readResourceGroupStore();
  return Array.isArray(store.actors?.[actor]) ? store.actors[actor] : [];
}

function writeActorResourceGroups(actorName, payload) {
  const actor = String(actorName || '').trim();
  if (!actor) {
    throw new Error('Actor name is required');
  }

  const store = readResourceGroupStore();
  if (!store.actors || typeof store.actors !== 'object') {
    store.actors = {};
  }

  store.actors[actor] = sanitizeResourceGroupsPayload(payload);
  writeJson(RESOURCE_GROUPS_FILE, store);

  return {
    actor,
    groups: store.actors[actor],
    filePath: RESOURCE_GROUPS_FILE,
  };
}

function sanitizeName(name, fallback = 'full-map') {
  const raw = String(name || '').trim() || fallback;
  const cleaned = raw.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/-+/g, '-');
  return cleaned || fallback;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function getOverlappingTiles(region, cfg) {
  const regionWorldSize = cfg.regionSize * cfg.unitScaleX;
  const gridX = cfg.regionGridX;
  const gridY = cfg.regionGridY;

  if (!region) {
    const all = [];
    for (let rx = 0; rx < gridX; rx++) {
      for (let ry = 0; ry < gridY; ry++) all.push({ rx, ry });
    }
    return all;
  }

  const localMinX = region.minX - cfg.worldOriginX;
  const localMaxX = region.maxX - cfg.worldOriginX;
  const localMinY = (-region.maxZ) - cfg.worldOriginY;
  const localMaxY = (-region.minZ) - cfg.worldOriginY;

  const rxMin = Math.max(0, Math.floor(localMinX / regionWorldSize));
  const rxMax = Math.min(gridX - 1, Math.floor(localMaxX / regionWorldSize));
  const ryMin = Math.max(0, Math.floor(localMinY / regionWorldSize));
  const ryMax = Math.min(gridY - 1, Math.floor(localMaxY / regionWorldSize));

  const tiles = [];
  for (let rx = Math.max(0, rxMin - 1); rx <= Math.min(gridX - 1, rxMax + 1); rx++) {
    for (let ry = Math.max(0, ryMin - 1); ry <= Math.min(gridY - 1, ryMax + 1); ry++) {
      tiles.push({ rx, ry });
    }
  }
  return tiles;
}

function pointInPolygon2D(x, z, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return true;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] || {};
    const pj = polygon[j] || {};
    const xi = Number(pi.x);
    const zi = Number(pi.z);
    const xj = Number(pj.x);
    const zj = Number(pj.z);
    if (!Number.isFinite(xi) || !Number.isFinite(zi) || !Number.isFinite(xj) || !Number.isFinite(zj)) {
      continue;
    }

    const intersects = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function extractEntityWorldPos(ent) {
  if (
    ent?.worldPos
    && Number.isFinite(ent.worldPos.x)
    && Number.isFinite(ent.worldPos.y)
    && Number.isFinite(ent.worldPos.z)
  ) {
    return {
      x: Number(ent.worldPos.x),
      y: Number(ent.worldPos.y),
      z: Number(ent.worldPos.z),
    };
  }

  if (Array.isArray(ent?.matrix) && ent.matrix.length === 16) {
    return {
      x: Number(ent.matrix[12]) || 0,
      y: Number(ent.matrix[13]) || 0,
      z: Number(ent.matrix[14]) || 0,
    };
  }

  return { x: 0, y: 0, z: 0 };
}

function isEntityInsideRegion(ent, region) {
  if (!region) return true;

  const pos = extractEntityWorldPos(ent);
  if (pos.x < region.minX || pos.x > region.maxX || pos.z < region.minZ || pos.z > region.maxZ) {
    return false;
  }

  if (Array.isArray(region.polygon) && region.polygon.length >= 3) {
    return pointInPolygon2D(pos.x, pos.z, region.polygon);
  }

  return true;
}

function toSourceEntityMatrixFromThreeElements(e) {
  // Inverse of entities.js LH->RH matrix conversion.
  return [
    e[0],
    e[1],
    -e[2],
    e[3],
    e[4],
    e[5],
    -e[6],
    e[7],
    -e[8],
    -e[9],
    e[10],
    -e[11],
    e[12],
    e[13],
    -e[14],
    e[15],
  ];
}

function collectTextureNames(texInfo) {
  const names = new Set();
  if (!texInfo || typeof texInfo !== 'object') return names;

  const addOne = (v) => {
    if (typeof v === 'string' && v.trim()) names.add(v.trim());
  };

  addOne(texInfo.albedo);
  addOne(texInfo.mre);
  addOne(texInfo.normal);

  if (Array.isArray(texInfo.subsets)) {
    for (const s of texInfo.subsets) {
      addOne(s?.albedo);
      addOne(s?.mre);
      addOne(s?.normal);
    }
  }

  return names;
}

function buildVisualSettingsExport() {
  return {
    kind: 'jx3-visual-settings',
    version: 1,
    coordinateSystem: 'three-rh',
    sky: {
      type: 'gradient-sphere',
      topColor: '#4488cc',
      bottomColor: '#d4c5a0',
      horizonColor: '#c8b888',
      exponent: 0.5,
      radius: 200000,
    },
    fog: {
      type: 'exp2',
      color: '#c8b888',
      density: 0.0000035,
    },
    lighting: {
      directional: {
        intensity: 3.0,
        castShadow: true,
        shadow: {
          mapSize: [2048, 2048],
          near: 100,
          far: 200000,
          left: -50000,
          right: 50000,
          top: 50000,
          bottom: -50000,
          bias: -0.001,
          normalBias: 200,
        },
      },
      ambient: {
        intensity: 0.8,
        fallbackColor: '#666655',
      },
      hemisphere: {
        intensity: 1.0,
        skyColorMultiplier: [0.8, 0.9, 1.2],
        fallbackSkyColor: '#88aacc',
        groundColor: '#8b7355',
      },
      fallbackWhenNoEnvironment: {
        ambientColor: '#888888',
        ambientIntensity: 0.6,
        hemisphereSkyColor: '#87ceeb',
        hemisphereGroundColor: '#8b7355',
        hemisphereIntensity: 0.4,
      },
    },
    environmentBinding: {
      file: 'environment.json',
      sunlightPath: 'sunlight',
      notes: 'Use environment sunlight colors/direction if available; otherwise use fallback colors above.',
    },
  };
}

function copyIfExists(src, dst) {
  if (!existsSync(src) || !statSync(src).isFile()) return false;
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
  return true;
}

function buildFlatFileLookup(dirPath) {
  const map = new Map();
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return map;
  for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    map.set(ent.name.toLowerCase(), ent.name);
  }
  return map;
}

async function buildFullExportPackage(payload) {
  const exportName = sanitizeName(payload?.name, 'full-map');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const packageName = `${exportName}-${stamp}`;

  ensureDir(DESKTOP_EXPORT_ROOT);
  const packageRoot = resolve(join(DESKTOP_EXPORT_ROOT, packageName));
  const outMapData = join(packageRoot, 'map-data');

  ensureDir(outMapData);
  ensureDir(join(outMapData, 'entities'));
  ensureDir(join(outMapData, 'meshes'));
  ensureDir(join(outMapData, 'textures'));
  ensureDir(join(outMapData, 'heightmap'));
  ensureDir(join(outMapData, 'terrain-textures'));

  const sourceMapPath = String(payload?.sourceMapPath || 'map-data').replace(/\\/g, '/');
  const sourceRoot = safePathUnder(PUBLIC_DIR, sourceMapPath);
  if (!sourceRoot || !existsSync(sourceRoot)) {
    throw new Error(`Source map path not found: ${sourceMapPath}`);
  }

  const mapConfig = readJsonUtf8(join(sourceRoot, 'map-config.json'));
  if (!mapConfig?.landscape) {
    throw new Error('map-config.json missing or invalid in source map path');
  }

  const environment = readJsonUtf8(join(sourceRoot, 'environment.json'), null);
  const sourceMeshMap = readJsonUtf8(join(sourceRoot, 'mesh-map.json'), {});
  const textureMapSrc = readJsonUtf8(join(sourceRoot, 'texture-map.json'), {});
  const terrainTextureIndexSrc = readJsonUtf8(join(sourceRoot, 'terrain-textures', 'index.json'), null);

  const meshDirLookup = buildFlatFileLookup(join(sourceRoot, 'meshes'));
  const textureDirLookup = buildFlatFileLookup(join(sourceRoot, 'textures'));

  const regionRaw = payload?.region && typeof payload.region === 'object' ? payload.region : null;
  const region = (
    regionRaw
    && Number.isFinite(regionRaw.minX)
    && Number.isFinite(regionRaw.maxX)
    && Number.isFinite(regionRaw.minZ)
    && Number.isFinite(regionRaw.maxZ)
  )
    ? {
      minX: Number(regionRaw.minX),
      maxX: Number(regionRaw.maxX),
      minZ: Number(regionRaw.minZ),
      maxZ: Number(regionRaw.maxZ),
      polygon: Array.isArray(regionRaw.polygon) ? regionRaw.polygon : undefined,
    }
    : null;
  const regionCorners = Array.isArray(payload?.regionCorners) ? payload.regionCorners : null;
  // Sidecar collision is the only supported export format.
  const attachMeshCollision = true;

  const entitiesIn = Array.isArray(payload?.entities) ? payload.entities : [];
  if (entitiesIn.length === 0) {
    throw new Error('No entities provided for export');
  }

  const entityOut = [];
  const entityOutRh = [];
  const usedGlb = new Set();
  let entitiesFilteredOut = 0;

  for (const ent of entitiesIn) {
    if (!Array.isArray(ent?.matrix) || ent.matrix.length !== 16) continue;

    const runtimeMat = ent.matrix.map((v) => Number(v));
    if (!runtimeMat.every(Number.isFinite)) continue;

    if (region && !isEntityInsideRegion(ent, region)) {
      entitiesFilteredOut++;
      continue;
    }

    const srcMat = toSourceEntityMatrixFromThreeElements(runtimeMat);
    let glbName = String(ent?.mesh || '').trim();
    if (!glbName) continue;
    if (!glbName.toLowerCase().endsWith('.glb')) glbName += '.glb';

    const worldPos = extractEntityWorldPos({ worldPos: ent?.worldPos, matrix: runtimeMat });

    entityOut.push({
      mesh: glbName,
      matrix: srcMat,
      worldPos,
    });
    entityOutRh.push({
      mesh: glbName,
      matrix: runtimeMat,
      worldPos,
    });
    usedGlb.add(glbName);
  }

  if (entityOut.length === 0) {
    throw new Error('No valid entity transforms to export');
  }

  const meshMap = {};
  for (const glb of usedGlb) {
    meshMap[glb] = `meshes/${glb}`;
  }
  const meshList = [...usedGlb].sort();

  const sourceGlbByName = new Map();
  for (const v of Object.values(sourceMeshMap || {})) {
    if (typeof v !== 'string') continue;
    const b = basename(v).toLowerCase();
    if (!b.endsWith('.glb')) continue;
    if (!sourceGlbByName.has(b)) sourceGlbByName.set(b, v.replace(/\\/g, '/'));
  }

  // Copy GLBs
  let copiedGlbCount = 0;
  for (const glb of usedGlb) {
    const dst = join(outMapData, 'meshes', glb);
    const lower = glb.toLowerCase();

    let copied = false;

    // 1) Preferred: source mesh-map exact relative path (handles odd names/subdirs).
    const srcRel = sourceGlbByName.get(lower);
    if (srcRel) {
      copied = copyIfExists(join(sourceRoot, srcRel), dst);
    }

    // 2) Direct path under meshes.
    if (!copied) {
      copied = copyIfExists(join(sourceRoot, 'meshes', glb), dst);
    }

    // 3) Case-insensitive fallback from on-disk file listing.
    if (!copied) {
      const actual = meshDirLookup.get(lower);
      if (actual) copied = copyIfExists(join(sourceRoot, 'meshes', actual), dst);
    }

    if (copied) copiedGlbCount++;
  }

  // Subset texture-map + copy used texture files
  const textureMapOut = {};
  const usedTextures = new Set();
  const srcTextureMapKeys = new Map(Object.keys(textureMapSrc || {}).map((k) => [k.toLowerCase(), k]));

  for (const glb of usedGlb) {
    const srcKey = srcTextureMapKeys.get(glb.toLowerCase());
    if (!srcKey) continue;
    const info = textureMapSrc[srcKey];
    textureMapOut[glb] = info;
    for (const tex of collectTextureNames(info)) usedTextures.add(tex);
  }

  let copiedTextureCount = 0;
  for (const tex of usedTextures) {
    const dst = join(outMapData, 'textures', tex);
    let copied = copyIfExists(join(sourceRoot, 'textures', tex), dst);
    if (!copied) {
      const actual = textureDirLookup.get(tex.toLowerCase());
      if (actual) copied = copyIfExists(join(sourceRoot, 'textures', actual), dst);
    }
    if (copied) copiedTextureCount++;
  }

  // Heightmap + terrain textures subset
  const cfg = mapConfig.landscape;
  const tiles = getOverlappingTiles(region, cfg);
  const mapName = mapConfig.name || 'map';
  const terrainIndexOut = terrainTextureIndexSrc
    ? { textureDir: terrainTextureIndexSrc.textureDir || 'terrain-textures', regions: {}, textureSize: terrainTextureIndexSrc.textureSize || 1024 }
    : null;

  let copiedHeightmapCount = 0;
  let copiedTerrainTextureCount = 0;
  const terrainTexCopied = new Set();

  for (const { rx, ry } of tiles) {
    const key = `${pad3(rx)}_${pad3(ry)}`;
    const fileName = `${mapName}_${key}.bin`;
    const srcHm = join(sourceRoot, 'heightmap', fileName);
    const dstHm = join(outMapData, 'heightmap', fileName);
    if (copyIfExists(srcHm, dstHm)) copiedHeightmapCount++;

    if (terrainTextureIndexSrc?.regions) {
      const rKey = `${rx}_${ry}`;
      const texInfo = terrainTextureIndexSrc.regions[rKey];
      if (texInfo) {
        terrainIndexOut.regions[rKey] = texInfo;
        for (const f of [texInfo.color, texInfo.detail]) {
          if (!f || terrainTexCopied.has(f)) continue;
          const srcTex = join(sourceRoot, 'terrain-textures', f);
          const dstTex = join(outMapData, 'terrain-textures', f);
          if (copyIfExists(srcTex, dstTex)) {
            terrainTexCopied.add(f);
            copiedTerrainTextureCount++;
          }
        }
      }
    }
  }

  // Copy optional minimap files
  copyIfExists(join(sourceRoot, 'minimap.png'), join(outMapData, 'minimap.png'));
  copyIfExists(join(sourceRoot, 'regioninfo.png'), join(outMapData, 'regioninfo.png'));
  copyIfExists(join(sourceRoot, 'editor-minimap.png'), join(outMapData, 'editor-minimap.png'));

  // Write package data
  writeJson(join(outMapData, 'map-config.json'), mapConfig);
  if (environment) writeJson(join(outMapData, 'environment.json'), environment);
  writeJson(join(outMapData, 'mesh-map.json'), meshMap);
  writeJson(join(outMapData, 'mesh-list.json'), meshList);
  writeJson(join(outMapData, 'entity-index.json'), ['full.json']);
  writeJson(join(outMapData, 'entities', 'full.json'), entityOut);
  writeJson(join(outMapData, 'entity-index-rh.json'), ['full.rh.json']);
  writeJson(join(outMapData, 'entities', 'full.rh.json'), entityOutRh);
  writeJson(join(outMapData, 'transform-conventions.json'), {
    kind: 'jx3-transform-conventions',
    version: 1,
    coordinateSystem: 'three-rh',
    entities: {
      defaultFile: 'entities/full.json',
      defaultMatrixFormat: 'source-lh-row-major',
      normalizedRhIndexFile: 'entity-index-rh.json',
      normalizedRhFile: 'entities/full.rh.json',
      normalizedRhMatrixFormat: 'three-matrix4-column-major',
      normalizedRhRequiresImporterZFlip: false,
      worldPosFormat: 'three-rh',
    },
    notes: [
      'Use entity-index-rh.json + entities/full.rh.json to avoid importer-side LH/RH Z-flip conversion.',
      'entity-index.json + entities/full.json remain for backward compatibility with existing loaders.',
    ],
  });
  writeJson(join(outMapData, 'visual-settings.json'), buildVisualSettingsExport());
  writeJson(join(outMapData, 'texture-map.json'), textureMapOut);
  writeJson(join(outMapData, 'official-meshes.json'), meshList);
  writeJson(join(outMapData, 'verdicts.json'), { approved: meshList, denied: [] });
  if (terrainIndexOut) writeJson(join(outMapData, 'terrain-textures', 'index.json'), terrainIndexOut);

  let collision = {
    generated: false,
    file: '',
    objects: 0,
    shells: 0,
    shellTriangles: 0,
    meshSidecarsExpected: 0,
    meshSidecarsWritten: 0,
    meshSidecarsFailed: 0,
    meshSidecarsMissing: 0,
    meshSidecarIndexFile: '',
    meshesLoaded: 0,
    meshesFailed: 0,
    skippedEntities: entityOut.length,
    error: null,
  };

  try {
    const generated = await generateCollisionDataForExport({
      mapDataRoot: outMapData,
      packageName,
      region,
      outputFileName: '',
      attachToMeshes: attachMeshCollision,
      meshSidecarSuffix: '.collision.json',
    });

    collision = {
      generated: true,
      file: '',
      objects: generated.objects,
      shells: generated.shells || 0,
      shellTriangles: generated.shellTriangles || 0,
      meshSidecarsExpected: generated.meshSidecarsExpected || 0,
      meshSidecarsWritten: generated.meshSidecarsWritten || 0,
      meshSidecarsFailed: generated.meshSidecarsFailed || 0,
      meshSidecarsMissing: generated.meshSidecarsMissing || 0,
      meshSidecarIndexFile: generated.meshSidecarIndexFile || '',
      meshesLoaded: generated.meshesLoaded,
      meshesFailed: generated.meshesFailed,
      skippedEntities: generated.skippedEntities,
      error: null,
    };
  } catch (err) {
    collision.error = err?.message || String(err);
    console.warn(`[export-full] collision generation skipped for ${packageName}: ${collision.error}`);
  }

  const manifest = {
    kind: 'jx3-full-map-export',
    version: 1,
    name: exportName,
    packageName,
    createdAt: Date.now(),
    sourceMapPath,
    region,
    regionCorners,
    stats: {
      entitiesInput: entitiesIn.length,
      entities: entityOut.length,
      entitiesRh: entityOutRh.length,
      entityRhIndexWritten: true,
      transformConventionsWritten: true,
      visualSettingsWritten: true,
      entitiesFilteredOut,
      meshesRequested: usedGlb.size,
      meshesCopied: copiedGlbCount,
      texturesRequested: usedTextures.size,
      texturesCopied: copiedTextureCount,
      heightmapsCopied: copiedHeightmapCount,
      terrainTexturesCopied: copiedTerrainTextureCount,
      tilesSelected: tiles.length,
      collisionGenerated: collision.generated,
      collisionObjects: collision.objects,
      collisionShells: collision.shells,
      collisionShellTriangles: collision.shellTriangles,
      meshCollisionExpected: collision.meshSidecarsExpected,
      meshCollisionAttached: collision.meshSidecarsWritten,
      meshCollisionAttachFailures: collision.meshSidecarsFailed,
      meshCollisionMissing: collision.meshSidecarsMissing,
      meshCollisionComplete: collision.meshSidecarsMissing === 0,
      collisionMeshesLoaded: collision.meshesLoaded,
      collisionMeshesFailed: collision.meshesFailed,
      collisionSkippedEntities: collision.skippedEntities,
    },
    collision,
    coordinateContract: {
      world: 'three-rh',
      entityMatrixStoredAs: 'source-lh-row-major',
      entityRhMatrixFile: 'map-data/entities/full.rh.json',
      entityRhIndexFile: 'map-data/entity-index-rh.json',
      transformConventionsFile: 'map-data/transform-conventions.json',
      visualSettingsFile: 'map-data/visual-settings.json',
      terrain: 'heightmap + map-config (same as source viewer)',
    },
  };
  writeJson(join(packageRoot, 'manifest.json'), manifest);

  return {
    packageName,
    packageRoot,
    stats: manifest.stats,
  };
}

// ─── Player Animation Browser helpers ────────────────────────────────────────

function readGb2312File(filePath) {
  const buf = readFileSync(filePath);
  return GB18030_DECODER.decode(buf);
}

function loadPlayerAnimationTable(bodyType) {
  const key = `anim_${bodyType}`;
  if (PLAYER_ANIM_CACHE.has(key)) return PLAYER_ANIM_CACHE.get(key);
  const filePath = join(PLAYER_ANIM_TABLE_DIR, `player_animation_${bodyType}.txt`);
  if (!existsSync(filePath)) return null;
  const content = readGb2312File(filePath);
  const lines = content.split(/\r?\n/);
  const header = lines[0];
  const cols = header.split('\t');
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const animId = parseInt(parts[0], 10);
    if (isNaN(animId)) continue;
    const animFile = (parts[6] || '').trim();
    if (!animFile) continue; // skip entries with no animation file
    entries.push({
      id: animId,
      kindId: parseInt(parts[1], 10) || 0,
      sheathType: parseInt(parts[2], 10) || 0,
      animRatio: parts[3] || '',
      animSpeed: parts[4] || '',
      isLoop: parseInt(parts[5], 10) || 0,
      animFile,
      shadowFile: (parts[7] || '').trim(),
      noAutoTurn: parseInt(parts[8], 10) || 0,
      lookAtCamera: parseInt(parts[9], 10) || 0,
      poseState: (parts[10] || '').trim(),
      lockFacing: (parts[11] || '').trim(),
    });
  }
  PLAYER_ANIM_CACHE.set(key, entries);
  return entries;
}

function loadSerialAnimationTable() {
  const key = 'serial_table';
  if (PLAYER_ANIM_CACHE.has(key)) return PLAYER_ANIM_CACHE.get(key);
  const filePath = join(PLAYER_ANIM_TABLE_DIR, 'player_serial_animation_table.txt');
  if (!existsSync(filePath)) return null;
  const content = readGb2312File(filePath);
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const serialId = parseInt(parts[0], 10);
    if (isNaN(serialId)) continue;
    entries.push({
      serialId,
      desc: (parts[1] || '').trim(),
      phaseA: parseInt(parts[2], 10) || 0,
      phaseB: parseInt(parts[3], 10) || 0,
      phaseC: parseInt(parts[4], 10) || 0,
      haste: parseInt(parts[5], 10) || 0,
    });
  }
  PLAYER_ANIM_CACHE.set(key, entries);
  return entries;
}

function loadTaniCatalog() {
  const key = 'tani_catalog';
  if (PLAYER_ANIM_CACHE.has(key)) return PLAYER_ANIM_CACHE.get(key);
  if (!existsSync(TANI_RT_PATH)) return null;
  const content = readGb2312File(TANI_RT_PATH);
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split('\t');
    entries.push({
      id: parseInt(parts[0], 10) || 0,
      name: (parts[1] || '').trim(),
      sourcePath: (parts[2] || '').trim(),
      shellPath: (parts[3] || '').trim(),
    });
  }
  PLAYER_ANIM_CACHE.set(key, entries);
  return entries;
}

// ─── Actor Animation Player helpers ──────────────────────────────────────────

function listActorPlots() {
  if (!existsSync(ACTOR_PLOT_ROOT) || !statSync(ACTOR_PLOT_ROOT).isDirectory()) return [];
  const plots = readdirSync(ACTOR_PLOT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const plotDir = join(ACTOR_PLOT_ROOT, d.name);
      let totalAni = 0;
      let totalAudio = 0;
      let subPlotCount = 0;
      try {
        for (const sub of readdirSync(plotDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          subPlotCount++;
          const aniDir = join(plotDir, sub.name, '\u52A8\u4F5C');
          const audioDir = join(plotDir, sub.name, '\u97F3\u9891\u8D44\u6E90');
          try {
            if (existsSync(aniDir) && statSync(aniDir).isDirectory()) {
              totalAni += readdirSync(aniDir).filter(f => f.toLowerCase().endsWith('.ani')).length;
            }
          } catch {}
          try {
            if (existsSync(audioDir) && statSync(audioDir).isDirectory()) {
              totalAudio += readdirSync(audioDir).filter(f => /\.(wav|mp3|ogg|wem)$/i.test(f)).length;
            }
          } catch {}
        }
      } catch {}
      return { name: d.name, subPlotCount, totalAni, totalAudio };
    })
    .sort((a, b) => b.totalAni - a.totalAni || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return plots;
}

function getActorPlotContents(plotName) {
  const plotDir = safePathUnder(ACTOR_PLOT_ROOT, plotName);
  if (!plotDir || !existsSync(plotDir) || !statSync(plotDir).isDirectory()) return null;

  const result = { plotName, subPlots: [] };

  for (const entry of readdirSync(plotDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subDir = join(plotDir, entry.name);
    const aniDir = join(subDir, '\u52A8\u4F5C'); // 动作
    const audioDir = join(subDir, '\u97F3\u9891\u8D44\u6E90'); // 音频资源

    const actorFiles = [];
    for (const f of readdirSync(subDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.actor')) actorFiles.push(f.name);
    }
    actorFiles.sort();

    const aniFiles = [];
    if (existsSync(aniDir) && statSync(aniDir).isDirectory()) {
      for (const f of readdirSync(aniDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.toLowerCase().endsWith('.ani')) {
          aniFiles.push({ name: f.name, size: statSync(join(aniDir, f.name)).size });
        }
      }
      aniFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    const audioFiles = [];
    if (existsSync(audioDir) && statSync(audioDir).isDirectory()) {
      for (const f of readdirSync(audioDir, { withFileTypes: true })) {
        if (f.isFile() && /\.(wav|mp3|ogg|wem)$/i.test(f.name)) {
          audioFiles.push({ name: f.name, size: statSync(join(audioDir, f.name)).size });
        }
      }
      audioFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    result.subPlots.push({
      name: entry.name,
      actorFiles,
      aniCount: aniFiles.length,
      aniFiles: aniFiles.slice(0, 500), // cap for large plots
      audioFiles,
    });
  }

  // Also check for .actor files directly in the plot root
  const rootActors = [];
  for (const f of readdirSync(plotDir, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith('.actor')) rootActors.push(f.name);
  }
  rootActors.sort();
  if (rootActors.length > 0) {
    result.rootActorFiles = rootActors;
  }

  return result;
}

/**
 * Parse a GATA .tani binary.
 * Format: "GATA" magic, u32 version, then null-terminated GB2312 .ani path,
 * followed by runtime data + embedded PSS/SFX/sound strings.
 * We do best-effort string extraction since the format contains runtime pointers.
 */
function parseTaniBinary(buf, originalPath) {
  if (!buf || buf.length < 8) return { error: 'Buffer too small', size: buf?.length || 0 };
  const magic = buf.subarray(0, 4).toString('latin1');
  if (magic !== 'GATA') return { error: `Wrong magic: ${magic}`, size: buf.length };

  const version = buf.readUInt32LE(4);

  // Read null-terminated GB2312 string for .ani path starting at offset 8
  let nullPos = 8;
  while (nullPos < buf.length && buf[nullPos] !== 0) nullPos++;
  const aniPath = GB18030_DECODER.decode(buf.subarray(8, nullPos));

  // Scan entire buffer for embedded paths and tags using string extraction
  const pssPaths = [];
  const pssEntries = [];  // [{path, startTimeMs}]
  const sfxTags = [];
  const soundEvents = [];
  const userTags = [];
  const otherPaths = [];

  // Extract all readable GB2312 strings of length >= 6
  let i = nullPos + 1;
  while (i < buf.length) {
    // Check if we're at a printable ASCII or GB2312 multi-byte start
    if ((buf[i] >= 0x20 && buf[i] < 0x7F) || (buf[i] >= 0xA1 && buf[i] <= 0xFE && i + 1 < buf.length && buf[i + 1] >= 0x40)) {
      let end = i;
      while (end < buf.length) {
        if (buf[end] >= 0x20 && buf[end] < 0x7F) {
          end++;
        } else if (buf[end] >= 0xA1 && buf[end] <= 0xFE && end + 1 < buf.length && buf[end + 1] >= 0x40) {
          end += 2;
        } else {
          break;
        }
      }
      if (end - i >= 6) {
        const str = GB18030_DECODER.decode(buf.subarray(i, end));
        const lower = str.toLowerCase();
        if (lower.endsWith('.pss') && lower.startsWith('data\\')) {
          if (!pssPaths.includes(str)) {
            pssPaths.push(str);
            // No silent fallback: GATA per-PSS start time is not engine-verified.
            // The binary contains live C++ runtime pointers before each PSS path, so any
            // fixed-offset float read would hit vtable/heap data. Per the no-silent-fallback
            // policy (issue #8), we no longer fabricate a 0 ms start time. The entry carries
            // startTimeMs=null plus a structured warning. Downstream code may still derive a
            // real time from the source PSS globalStartDelay (timingSource='pss-global-delay');
            // when that derivation is not possible the entry's effectiveStartTimeMs stays null
            // and the player surfaces it as an unresolved warning.
            pssEntries.push({
              path: str,
              startTimeMs: null,
              gataTimingWarning: 'GATA per-PSS start time is not engine-verified; binary holds live runtime pointers in the per-entry header. No fabricated 0 fallback. effectiveStartTimeMs is set only when the source PSS globalStartDelay can be read.',
            });
          }
        } else if (lower.endsWith('.pss') && lower.includes('\\pss\\')) {
          // Partial path (missing prefix)
          // Skip duplicates from partial references
        } else if (str.startsWith('New SFX Tag')) {
          if (!sfxTags.includes(str)) sfxTags.push(str);
        } else if (str === 'User Define Tag') {
          userTags.push(str);
        } else if (str.startsWith('JX3_Skill') || str.startsWith('JX3_')) {
          if (!soundEvents.includes(str)) soundEvents.push(str);
        } else if (str.includes('/skill/') || str.includes('/Skill/')) {
          if (!soundEvents.includes(str)) soundEvents.push(str);
        } else if ((lower.endsWith('.ani') || lower.endsWith('.tani')) && lower.startsWith('data\\')) {
          if (str !== aniPath && !otherPaths.includes(str)) otherPaths.push(str);
        }
      }
      i = end;
    } else {
      i++;
    }
  }

  // Combine JX3_Skill prefix with its event path
  const soundEntries = [];
  for (let s = 0; s < soundEvents.length; s++) {
    if (soundEvents[s].startsWith('JX3_') && s + 1 < soundEvents.length && soundEvents[s + 1].includes('/')) {
      soundEntries.push({ system: soundEvents[s], event: soundEvents[s + 1] });
      s++;
    } else {
      soundEntries.push({ system: '', event: soundEvents[s] });
    }
  }

  for (const entry of pssEntries) {
    const derivedTiming = deriveTaniPssTimingFromSource(entry.path);
    if (!derivedTiming) {
      // No silent fallback. GATA didn't give us a real start time and the source
      // PSS could not be resolved either, so effectiveStartTimeMs stays null and the
      // gataTimingWarning attached at extraction time remains the authoritative note.
      entry.effectiveStartTimeMs = null;
      entry.timingSource = 'unresolved-no-source-pss';
      continue;
    }
    entry.effectiveStartTimeMs = derivedTiming.effectiveStartTimeMs;
    entry.pssStartDelayMs = derivedTiming.pssStartDelayMs;
    entry.pssPlayDurationMs = derivedTiming.pssPlayDurationMs;
    entry.pssTotalDurationMs = derivedTiming.pssTotalDurationMs;
    entry.timingSource = derivedTiming.timingSource;
  }

  // Top-level acknowledgement so any consumer (UI, downstream tooling) can see
  // the format gap without having to re-discover it on every entry.
  const gataTimingStatus = {
    perEntryStartTime: 'not-extracted',
    reason: 'GATA per-PSS start time field offsets are not engine-verified. No silent 0 fallback (issue #8). effectiveStartTimeMs comes only from the source PSS globalStartDelay; when that is unresolvable, it stays null.',
    unresolvedCount: pssEntries.filter((e) => e.timingSource === 'unresolved-no-source-pss').length,
    derivedCount: pssEntries.filter((e) => e.effectiveStartTimeMs != null).length,
  };

  return {
    magic,
    version,
    fileSize: buf.length,
    path: originalPath || '',
    aniPath,
    pssPaths,
    pssEntries,
    sfxTags: sfxTags.length,
    userTags: userTags.length,
    sfxTagList: sfxTags,
    userTagList: userTags,
    soundEntries,
    otherPaths,
    gataTimingStatus,
  };
}

function parseMin2AniHeader(buf) {
  if (!buf || buf.length < 0x42) return { error: 'Buffer too small', size: buf?.length || 0 };
  const magic = buf.subarray(0, 4).toString('latin1');
  if (magic !== 'MIN2') return { error: `Wrong magic: ${magic}`, size: buf.length };

  const fileSize = buf.readUInt32LE(0x04);
  const version = buf.readUInt32LE(0x08);
  const boneCount = buf.readUInt32LE(0x0C);
  const boneNameRaw = buf.subarray(0x10, 0x2E);
  const nullIdx = boneNameRaw.indexOf(0);
  const boneName = GB18030_DECODER.decode(boneNameRaw.subarray(0, nullIdx >= 0 ? nullIdx : 30));
  const vertexCount = buf.readUInt32LE(0x2E);
  const vertexCount2 = buf.readUInt32LE(0x32);
  const frameCount = buf.readUInt32LE(0x36);
  const fps = buf.readFloatLE(0x3A);
  const vertexCount3 = buf.readUInt32LE(0x3E);

  const dataStart = 0x42 + vertexCount * 4 * 2;
  const expectedPosBytes = vertexCount * frameCount * 12;
  const actualDataBytes = buf.length - dataStart;
  const dataRatio = expectedPosBytes > 0 ? actualDataBytes / expectedPosBytes : 0;
  const hasNormals = dataRatio > 1.5;

  // Extract additional bone names for multi-bone files
  const boneNames = [boneName];
  if (boneCount > 1 && buf.length > dataStart) {
    // Try to extract bone-related strings from the data region
    const searchRegion = buf.subarray(0x42, Math.min(buf.length, 0x42 + 2000));
    let pos = 0;
    while (pos < searchRegion.length - 4) {
      // Look for ASCII strings (bone names like "Bip01", "tongue", "smile_r")
      if (searchRegion[pos] >= 0x20 && searchRegion[pos] < 0x7f) {
        let end = pos;
        while (end < searchRegion.length && searchRegion[end] >= 0x20 && searchRegion[end] < 0x7f) end++;
        if (end - pos >= 3) {
          const str = searchRegion.subarray(pos, end).toString('ascii');
          if (/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(str) && !boneNames.includes(str)) {
            boneNames.push(str);
          }
        }
        pos = end + 1;
      } else {
        pos++;
      }
    }
  }

  return {
    magic,
    fileSize: buf.length,
    headerFileSize: fileSize,
    version,
    boneCount,
    boneName,
    boneNames: boneNames.slice(0, 30),
    vertexCount,
    vertexCount2,
    frameCount,
    fps,
    vertexCount3,
    dataStart,
    actualDataBytes,
    expectedPosBytes,
    dataRatio: Math.round(dataRatio * 1000) / 1000,
    hasNormals,
    canPlayVertexAnim: boneCount === 1 && vertexCount > 0 && frameCount > 1,
    duration: frameCount > 1 && fps > 0 ? (frameCount - 1) / fps : 0,
    headerHex: buf.subarray(0, Math.min(128, buf.length)).toString('hex'),
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveFile(res, filePath, headOnly = false) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = headOnly ? null : readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': headOnly ? statSync(filePath).size : data.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(headOnly ? undefined : data);
}

async function readBodyJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 50 * 1024 * 1024) {
        rejectBody(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function listFullExports() {
  ensureDir(DESKTOP_EXPORT_ROOT);
  const dirs = readdirSync(DESKTOP_EXPORT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));

  const out = [];
  for (const d of dirs) {
    const root = join(DESKTOP_EXPORT_ROOT, d);
    const manifestPath = join(root, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readJsonUtf8(manifestPath, null);
      if (!manifest) continue;
      out.push({
        packageName: d,
        name: manifest.name || d,
        createdAt: manifest.createdAt || 0,
        stats: manifest.stats || {},
      });
    } catch {
      // ignore bad manifest
    }
  }
  return out;
}

function normalizeInspectorDataPath(rawValue) {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return clean || 'map-data';
}

function resolveInspectorDataRoot(rawDataPath) {
  const dataPath = normalizeInspectorDataPath(rawDataPath);

  if (dataPath.startsWith('/full-exports/') || dataPath.startsWith('full-exports/')) {
    const rel = dataPath
      .replace(/^\/+/, '')
      .replace(/^full-exports\//, '');
    return safePathUnder(DESKTOP_EXPORT_ROOT, rel);
  }

  const rel = dataPath.replace(/^\/+/, '');
  return safePathUnder(PUBLIC_DIR, rel);
}

function extractGlbListFromDataRoot(dataRoot) {
  const out = [];
  const seen = new Set();
  const meshDir = join(dataRoot, 'meshes');

  if (existsSync(meshDir) && statSync(meshDir).isDirectory()) {
    for (const ent of readdirSync(meshDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith('.glb')) continue;
      const n = ent.name;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }

  // Fallback for unusual layouts: derive names from mesh-map values.
  if (out.length === 0) {
    const meshMap = readJsonUtf8(join(dataRoot, 'mesh-map.json'), {});
    for (const v of Object.values(meshMap || {})) {
      if (typeof v !== 'string') continue;
      const n = basename(v);
      if (!n.toLowerCase().endsWith('.glb')) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

function normalizeVerdictList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    let name = basename(String(raw || '').trim());
    if (!name) continue;
    if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

function readInspectorVerdicts(dataRoot) {
  const verdictPath = join(dataRoot, 'verdicts.json');
  const raw = readJsonUtf8(verdictPath, { approved: [], denied: [] });
  return {
    approved: normalizeVerdictList(raw?.approved),
    denied: normalizeVerdictList(raw?.denied),
  };
}

function writeInspectorVerdicts(dataRoot, payload) {
  const verdictPath = join(dataRoot, 'verdicts.json');
  const approved = normalizeVerdictList(payload?.approved);
  const deniedRaw = normalizeVerdictList(payload?.denied);
  const approvedSet = new Set(approved.map((x) => x.toLowerCase()));
  const denied = deniedRaw.filter((x) => !approvedSet.has(x.toLowerCase()));
  writeJson(verdictPath, { approved, denied });
  return { approved, denied };
}

function setSingleInspectorVerdict(dataRoot, meshNameRaw, verdictRaw) {
  let meshName = basename(String(meshNameRaw || '').trim());
  if (!meshName) throw new Error('mesh is required');
  if (!meshName.toLowerCase().endsWith('.glb')) meshName += '.glb';

  const rawVerdict = String(verdictRaw || '').trim().toLowerCase();
  const verdict = rawVerdict === 'none' ? 'clear' : rawVerdict;
  if (!['approved', 'denied', 'clear'].includes(verdict)) {
    throw new Error('Invalid verdict. Use approved, denied, or clear.');
  }

  const meshList = extractGlbListFromDataRoot(dataRoot);
  const meshByLower = new Map(meshList.map((n) => [n.toLowerCase(), n]));
  const targetKey = meshName.toLowerCase();
  const targetName = meshByLower.get(targetKey) || meshName;

  const current = readInspectorVerdicts(dataRoot);
  const approvedMap = new Map(current.approved.map((n) => [n.toLowerCase(), n]));
  const deniedMap = new Map(current.denied.map((n) => [n.toLowerCase(), n]));

  approvedMap.delete(targetKey);
  deniedMap.delete(targetKey);

  if (verdict === 'approved') approvedMap.set(targetKey, targetName);
  if (verdict === 'denied') deniedMap.set(targetKey, targetName);

  for (const key of approvedMap.keys()) deniedMap.delete(key);

  const approved = [...approvedMap.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const denied = [...deniedMap.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  writeJson(join(dataRoot, 'verdicts.json'), { approved, denied });
  return { approved, denied, mesh: targetName, verdict };
}

// ──────────────────────────────────────────────────────────────────────────────
// PSS Deep Verifier
//
// Stage-based diagnostic that re-walks every file referenced by a PSS effect
// and reports per-stage pass/fail with diagnostic data. Designed to catch
// "renders something but visually wrong" issues that the analyze endpoint
// misses (texture swapped, wrong blendMode in GLB, JsonInspack absent at
// conversion time → empty pssMaterial, track parser misalignment, etc).
//
// Output schema:
//   {
//     ok: bool,                       // all critical checks passed
//     sourcePath: string,
//     summary: { pass, warn, fail, skip, total },
//     stages: [                       // top-level checks (file/parse/timing)
//       { id, label, status, detail, value?, expected? }
//     ],
//     emitters: [                     // per-emitter
//       { index, type, label, status, checks: [...] }
//     ],
//     references: { textures: [...], meshes: [...], tracks: [...], anis: [...] },
//     parsed: { ... compact analyzer summary ... }
//   }
//
// Status values: 'pass' | 'fail' | 'warn' | 'skip' | 'info'
// ──────────────────────────────────────────────────────────────────────────────
function buildPssVerifyResponse(sourcePathRaw) {
  const sourcePath = normalizeLogicalResourcePath(sourcePathRaw);
  if (!sourcePath) throw new Error('sourcePath is required');

  const stages = [];
  const emitterReports = [];
  const refReports = { textures: [], meshes: [], tracks: [], anis: [] };

  const addStage = (id, label, status, detail = null, extra = {}) =>
    stages.push({ id, label, status, detail, ...extra });

  // Stage A.1 — Resolve & load
  let buffer = null;
  let loadSource = 'unknown';
  try {
    const resolved = tryResolveCacheLogicalPath(sourcePath);
    if (resolved) {
      buffer = getJx3CacheReader().readEntry(resolved.resolvedPath).output;
      loadSource = 'cache';
    } else {
      const onDisk = join(PSS_EXTRACT_DIR, sourcePath.replace(/\//g, '\\'));
      if (existsSync(onDisk)) {
        buffer = readFileSync(onDisk);
        loadSource = 'pss-cache';
      } else if (existsSync(PAKV4_EXTRACT_EXE)) {
        buffer = extractFromPakV4(sourcePath, PSS_EXTRACT_DIR);
        loadSource = 'pakv4';
      }
    }
  } catch (err) {
    addStage('A.load', 'Resolve & load PSS buffer', 'fail', err?.message || String(err));
  }

  if (!buffer || buffer.length < 16) {
    addStage('A.load', 'Resolve & load PSS buffer', 'fail',
      buffer ? `Buffer too small (${buffer.length} bytes)` : 'Source not found in cache or PakV4');
    return { ok: false, sourcePath, summary: aggregateSummary(stages, []), stages, emitters: [], references: refReports, parsed: null };
  }
  addStage('A.load', 'Resolve & load PSS buffer', 'pass',
    `${buffer.length} bytes from ${loadSource}`,
    { value: { bytes: buffer.length, source: loadSource } });

  // Stage A.2 — Magic header
  const hasMagic = buffer[0] === 0x50 && buffer[1] === 0x41 && buffer[2] === 0x52 && buffer[3] === 0x00;
  addStage('A.magic', 'PAR\\0 magic header', hasMagic ? 'pass' : 'fail',
    hasMagic ? null : `Got ${[0,1,2,3].map(i => buffer[i].toString(16).padStart(2,'0')).join(' ')}`);
  if (!hasMagic) {
    return { ok: false, sourcePath, summary: aggregateSummary(stages, []), stages, emitters: [], references: refReports, parsed: null };
  }

  // Stage A.3 — TOC consistency
  const version = buffer.readUInt16LE(4);
  const emitterCount = buffer.readUInt32LE(12);
  const tocEnd = 16 + emitterCount * 12;
  if (tocEnd > buffer.length || emitterCount === 0 || emitterCount > 4096) {
    addStage('A.toc', 'TOC fits in file', 'fail',
      `emitterCount=${emitterCount} tocEnd=${tocEnd} fileSize=${buffer.length}`);
  } else {
    let tocBad = 0;
    const tocBadIndexes = [];
    for (let i = 0; i < emitterCount; i++) {
      const b = 16 + i * 12;
      const off = buffer.readUInt32LE(b + 4);
      const sz = buffer.readUInt32LE(b + 8);
      if (off + sz > buffer.length || off < tocEnd) { tocBad++; tocBadIndexes.push(i); }
    }
    addStage('A.toc', 'Every TOC entry fits in file',
      tocBad === 0 ? 'pass' : 'fail',
      `${emitterCount} TOC entries, ${tocBad} out of bounds`,
      { value: { emitterCount, badEntries: tocBadIndexes } });
  }

  // Stage A.4 — Full analyzer
  let analyzed = null;
  try {
    analyzed = buildPssAnalyzeResponse(sourcePath);
  } catch (err) {
    addStage('A.parse', 'parsePssEffectScene runs', 'fail', err?.message || String(err));
    return { ok: false, sourcePath, summary: aggregateSummary(stages, []), stages, emitters: [], references: refReports, parsed: null };
  }

  if (!analyzed?.ok) {
    addStage('A.parse', 'parsePssEffectScene returns ok', 'fail',
      analyzed?.error || 'Analyzer returned ok:false');
    return { ok: false, sourcePath, summary: aggregateSummary(stages, []), stages, emitters: [], references: refReports, parsed: analyzed || null };
  }

  const emitters = Array.isArray(analyzed.emitters) ? analyzed.emitters : [];
  addStage('A.parse', 'parsePssEffectScene returns ok', 'pass',
    `${emitters.length} emitters parsed (declared ${emitterCount})`);

  if (emitters.length === 0) {
    addStage('A.empty', 'Effect contains at least one emitter', 'fail', 'Zero emitters');
  }

  // Stage B — Global timing
  const gd = Number(analyzed.globalStartDelay) || 0;
  const gp = Number(analyzed.globalPlayDuration) || 0;
  const gt = Number(analyzed.globalDuration) || 0;
  const gl = Number(analyzed.globalLoopEnd) || 0;
  addStage('B.startDelay', 'Global startDelay in 0..30000ms',
    gd >= 0 && gd <= 30000 ? 'pass' : 'warn',
    `${gd.toFixed(1)}ms`, { value: gd });
  addStage('B.playDuration', 'Global playDuration in 100..30000ms',
    gp >= 100 && gp <= 30000 ? 'pass' : 'warn',
    `${gp.toFixed(1)}ms`, { value: gp });
  addStage('B.totalDuration', 'Global totalDuration ≥ playDuration',
    gt >= gp ? 'pass' : 'warn',
    `${gt.toFixed(1)}ms vs ${gp.toFixed(1)}ms`, { value: gt });
  addStage('B.loopEnd', 'Global loopEnd present',
    gl > 0 ? 'pass' : 'info',
    gl > 0 ? `${gl.toFixed(1)}ms` : 'No loop (single-shot effect)',
    { value: gl });

  // Stage C — Per-emitter
  const meshAssetByPath = new Map(
    (analyzed.meshAssets || []).map((a) => [a.sourcePath, a])
  );
  const trackAssetByPath = new Map(
    (analyzed.trackAssets || []).map((a) => [a.sourcePath, a])
  );
  const aniAssetByPath = new Map(
    (analyzed.animationAssets || []).map((a) => [a.sourcePath, a])
  );
  const texLayerByPath = new Map(
    (analyzed.textures || []).map((t) => [t.originalPath || t.texturePath, t])
  );

  for (const em of emitters) {
    if (em.type === 'sprite') {
      emitterReports.push(verifySpriteEmitter(em, texLayerByPath));
    } else if (em.type === 'mesh') {
      emitterReports.push(verifyMeshEmitter(em, meshAssetByPath, aniAssetByPath));
    } else if (em.type === 'track') {
      emitterReports.push(verifyTrackEmitter(em, trackAssetByPath));
    } else {
      emitterReports.push({
        index: em.index,
        type: em.type || 'unknown',
        label: `Emitter #${em.index} (${em.type || 'unknown'})`,
        status: 'skip',
        checks: [{ id: 'type', label: 'Emitter type recognized', status: 'skip', detail: 'Type not handled by verifier' }],
      });
    }
  }

  // References roll-up
  for (const t of (analyzed.textures || [])) {
    refReports.textures.push({
      path: t.originalPath || t.texturePath,
      existsInCache: !!t.existsInCache,
      source: t.source || 'unknown',
      category: t.category || null,
      missingReason: t.missingReason || null,
      decodedFrom: t.decodedFrom || null,
    });
  }
  for (const a of (analyzed.meshAssets || [])) {
    refReports.meshes.push({
      path: a.sourcePath, existsLocally: !!a.existsLocally, source: a.source || 'unknown',
    });
  }
  for (const a of (analyzed.trackAssets || [])) {
    refReports.tracks.push({
      path: a.sourcePath, existsLocally: !!a.existsLocally, source: a.source || 'unknown',
      decodedNodeCount: a?.decodedTrack?.nodeCount ?? null,
    });
  }
  for (const a of (analyzed.animationAssets || [])) {
    refReports.anis.push({
      path: a.sourcePath, existsLocally: !!a.existsLocally, source: a.source || 'unknown',
    });
  }

  // Stage D — Cross-cutting
  const renderableEmitters = emitterReports.filter((e) =>
    e.checks.every((c) => c.status !== 'fail')
  ).length;
  addStage('D.renderable', 'At least one fully-passing emitter',
    renderableEmitters > 0 ? 'pass' : 'fail',
    `${renderableEmitters}/${emitterReports.length} emitters fully verified`,
    { value: { renderable: renderableEmitters, total: emitterReports.length } });

  const totalTex = (analyzed.textures || []).length;
  const cachedTex = (analyzed.textures || []).filter((t) => t.existsInCache).length;
  addStage('D.textures', 'All referenced textures resolvable',
    totalTex === 0 ? 'info' : cachedTex === totalTex ? 'pass' : cachedTex >= totalTex * 0.7 ? 'warn' : 'fail',
    `${cachedTex}/${totalTex} resolvable`,
    { value: { cached: cachedTex, total: totalTex } });

  const totalMesh = (analyzed.meshAssets || []).length;
  const localMesh = (analyzed.meshAssets || []).filter((m) => m.existsLocally).length;
  addStage('D.meshes', 'All referenced meshes resolvable',
    totalMesh === 0 ? 'info' : localMesh === totalMesh ? 'pass' : 'fail',
    `${localMesh}/${totalMesh} resolvable`,
    { value: { resolved: localMesh, total: totalMesh } });

  const totalTrack = (analyzed.trackAssets || []).length;
  const decodedTrack = (analyzed.trackAssets || []).filter((t) => t?.decodedTrack?.nodeCount > 0).length;
  addStage('D.tracks', 'All referenced tracks decode',
    totalTrack === 0 ? 'info' : decodedTrack === totalTrack ? 'pass' : 'fail',
    `${decodedTrack}/${totalTrack} decoded with non-zero nodes`,
    { value: { decoded: decodedTrack, total: totalTrack } });

  const summary = aggregateSummary(stages, emitterReports);
  return {
    ok: summary.fail === 0,
    sourcePath,
    summary,
    stages,
    emitters: emitterReports,
    references: refReports,
    parsed: {
      version,
      emitterCount,
      fileSize: buffer.length,
      globalStartDelay: gd,
      globalPlayDuration: gp,
      globalDuration: gt,
      globalLoopEnd: gl,
      spriteCount: emitters.filter((e) => e.type === 'sprite').length,
      meshCount: emitters.filter((e) => e.type === 'mesh').length,
      trackCount: emitters.filter((e) => e.type === 'track').length,
    },
  };
}

function aggregateSummary(stages, emitters) {
  const all = [...stages];
  for (const em of emitters) for (const c of em.checks) all.push(c);
  return {
    pass: all.filter((c) => c.status === 'pass').length,
    warn: all.filter((c) => c.status === 'warn').length,
    fail: all.filter((c) => c.status === 'fail').length,
    skip: all.filter((c) => c.status === 'skip').length,
    info: all.filter((c) => c.status === 'info').length,
    total: all.length,
  };
}

function verifySpriteEmitter(em, texLayerByPath) {
  const checks = [];
  const texPaths = Array.isArray(em.texturePaths) ? em.texturePaths : [];
  const labelBase = `Sprite #${em.index} (${em.materialName || 'unknown material'})`;

  // C.tex.exists — every path resolvable
  if (texPaths.length === 0) {
    checks.push({ id: 'tex.exists', label: 'Has texture references', status: 'fail',
      detail: 'No texture paths parsed for this sprite emitter' });
  } else {
    const missing = [];
    const fallbackProxies = [];
    const ddsBad = [];
    const colorSamples = [];
    for (const tp of texPaths) {
      const layer = texLayerByPath.get(tp);
      if (!layer || !layer.existsInCache) {
        missing.push(tp);
        continue;
      }
      if (layer.source === 'fallback-proxy') fallbackProxies.push({ path: tp, proxyOf: layer.proxyOf });
      // Open the actual extracted file and verify DDS magic + sample first block color
      const ext = layer.extractedPath || layer.texturePath || tp;
      const candidatePaths = [
        join(PSS_EXTRACT_DIR, '_tex', ext.replace(/\//g, '\\')),
        join(PSS_ASSET_EXTRACT_DIR, ext.replace(/\//g, '\\')),
      ];
      let absHit = null;
      for (const p of candidatePaths) {
        if (existsSync(p)) { absHit = p; break; }
      }
      if (!absHit) {
        // Cache resolution path: file lives inside the JX3 cache packs, no
        // local file. Try to read via cache reader; if that yields a buffer
        // we can still check magic.
        try {
          const resolved = tryResolveCacheLogicalPath(tp);
          if (resolved) {
            const { output } = getJx3CacheReader().readEntry(resolved.resolvedPath);
            const colorInfo = sampleFirstDxtBlockColor(output);
            if (!colorInfo.hasMagic) ddsBad.push({ path: tp, reason: colorInfo.reason });
            else colorSamples.push({ path: tp, ...colorInfo });
            continue;
          }
        } catch { /* fall through */ }
        ddsBad.push({ path: tp, reason: 'extracted file not found on disk' });
        continue;
      }
      const buf = readFileSync(absHit);
      const colorInfo = sampleFirstDxtBlockColor(buf);
      if (!colorInfo.hasMagic) ddsBad.push({ path: tp, reason: colorInfo.reason });
      else colorSamples.push({ path: tp, ...colorInfo });
    }

    checks.push({
      id: 'tex.resolve', label: 'Every texture resolvable',
      status: missing.length === 0 ? 'pass' : 'fail',
      detail: missing.length === 0 ? `${texPaths.length}/${texPaths.length} resolvable` : `Missing: ${missing.join(', ')}`,
      value: { total: texPaths.length, missing },
    });
    if (fallbackProxies.length > 0) {
      checks.push({
        id: 'tex.proxy', label: 'No textures replaced by proxy fallback',
        status: 'warn',
        detail: `${fallbackProxies.length} texture(s) substituted with proxy`,
        value: fallbackProxies,
      });
    }
    checks.push({
      id: 'tex.dds', label: 'All resolved files have DDS magic',
      status: ddsBad.length === 0 ? 'pass' : 'fail',
      detail: ddsBad.length === 0 ? `${colorSamples.length} OK` : `${ddsBad.length} bad: ${ddsBad.map((b) => b.path).join(', ')}`,
      value: { bad: ddsBad },
    });
    if (colorSamples.length > 0) {
      checks.push({
        id: 'tex.color', label: 'Dominant color of first DDS block (RGB565 c0)',
        status: 'info',
        detail: colorSamples.map((s) => `${basename(s.path)} → rgb(${s.r},${s.g},${s.b}) [${s.format}]`).join(' | '),
        value: colorSamples,
      });
    }
  }

  // C.runtime
  const rp = em.runtimeParams;
  checks.push({
    id: 'runtime.lifetime', label: 'runtimeParams.lifetimeSeconds > 0',
    status: rp && Number(rp.lifetimeSeconds) > 0 ? 'pass' : 'warn',
    detail: rp ? `lifetime=${rp.lifetimeSeconds ?? 'null'} (semantic=${rp.semantic})` : 'runtimeParams missing',
    value: rp ? { lifetimeSeconds: rp.lifetimeSeconds, semantic: rp.semantic, confidence: rp.confidence } : null,
  });
  checks.push({
    id: 'runtime.maxParticles', label: 'maxParticles parsed (>0)',
    status: Number(em.maxParticles) > 0 ? 'pass' : 'warn',
    detail: `maxParticles=${em.maxParticles ?? 'null'}`,
    value: em.maxParticles,
  });

  // C.colorCurve
  const cc = Array.isArray(em.colorCurve) ? em.colorCurve : [];
  const ccAlphasNonZero = cc.some((row) => Array.isArray(row) && Number(row[3]) > 0);
  checks.push({
    id: 'colorCurve.present', label: 'colorCurve has entries',
    status: cc.length > 0 ? 'pass' : 'warn',
    detail: `${cc.length} keyframes`,
    value: { count: cc.length, firstRGBA: cc[0] || null, lastRGBA: cc[cc.length - 1] || null },
  });
  if (cc.length > 0) {
    checks.push({
      id: 'colorCurve.alpha', label: 'colorCurve alphas not all zero',
      status: ccAlphasNonZero ? 'pass' : 'fail',
      detail: ccAlphasNonZero ? 'OK' : 'All alpha values are 0 — particle would be invisible',
    });
  }

  // C.blendMode
  // Status policy: blend mode is read from the referenced .jsondef. If the
  // jsondef is resolvable, the value is authoritative (`pass`). If the
  // jsondef is archived-only (source === 'jsondef:missing'), that is an
  // inherent property of the shipped archive — not a parser defect — so we
  // surface it as an informational `info` status rather than `warn`, which
  // the client treats as a non-issue. `unknown` with any other source
  // remains a `warn`.
  const bm = em.blendMode || 'unknown';
  const bmSource = em.blendModeSource || 'unknown';
  let bmStatus;
  let bmDetail;
  if (bm && bm !== 'unknown') {
    bmStatus = 'pass';
    bmDetail = `blendMode=${bm} (source: ${bmSource})`;
  } else if (bmSource === 'jsondef:missing') {
    bmStatus = 'info';
    bmDetail = `blendMode unavailable — .jsondef is archived-only in this install (source: ${bmSource}). Not a parse failure.`;
  } else {
    bmStatus = 'warn';
    bmDetail = `blendMode=${bm} (source: ${bmSource})`;
  }
  checks.push({
    id: 'blendMode.known', label: 'blendMode resolved',
    status: bmStatus,
    detail: bmDetail,
    value: { blendMode: bm, source: bmSource },
  });

  const fail = checks.some((c) => c.status === 'fail');
  return {
    index: em.index, type: 'sprite', label: labelBase,
    status: fail ? 'fail' : 'pass',
    checks,
    summary: { material: em.materialName, blendMode: bm, textures: texPaths.length, lifetime: rp?.lifetimeSeconds ?? null },
  };
}

function verifyMeshEmitter(em, meshAssetByPath, aniAssetByPath) {
  const checks = [];
  const meshes = Array.isArray(em.meshes) ? em.meshes : [];
  const anis = Array.isArray(em.animations) ? em.animations : [];
  const subType = em.subType || (meshes.length > 0 ? 'mesh' : 'unknown');
  const subTypeName = em.subTypeName || null;
  const labelBase = `Mesh #${em.index} (${meshes[0] ? basename(meshes[0]) : (subTypeName || subType)})`;

  // Non-mesh subtypes (billboard, particle, flame, trail, etc.) live under
  // PSS type=2 but don't reference a .mesh file. They render via different
  // pipelines (sprite quads, particle systems, ribbon strips) and should NOT
  // be flagged as "missing mesh path" — that was a previous classifier bug.
  if (meshes.length === 0 && subType !== 'mesh') {
    checks.push({
      id: 'mesh.subtype', label: `Non-mesh subtype (renders without a .mesh file)`,
      status: 'info',
      detail: `subType=${subType}${subTypeName ? ` ("${subTypeName}")` : ''} — billboard/particle/flame/trail emitters do not load a mesh asset`,
      value: { subType, subTypeName },
    });
    return { index: em.index, type: 'mesh', label: `${subTypeName || subType} #${em.index}`, status: 'info', checks };
  }

  if (meshes.length === 0) {
    checks.push({ id: 'mesh.exists', label: 'Has mesh references', status: 'fail',
      detail: 'No mesh paths parsed for this mesh emitter (subtype unknown)' });
    return { index: em.index, type: 'mesh', label: labelBase, status: 'fail', checks };
  }

  // C.mesh.exists
  const missingMeshes = meshes.filter((p) => !meshAssetByPath.get(p)?.existsLocally);
  checks.push({
    id: 'mesh.resolve', label: 'Every .mesh resolvable',
    status: missingMeshes.length === 0 ? 'pass' : 'fail',
    detail: missingMeshes.length === 0 ? `${meshes.length}/${meshes.length}` : `Missing: ${missingMeshes.join(', ')}`,
    value: { missing: missingMeshes },
  });

  // C.mesh.glb — ensure each mesh has a usable GLB with pssMaterial extras
  const glbReports = [];
  for (const meshPath of meshes) {
    const aniSet = anis.length > 0 ? anis : [];
    let glbAsset = null;
    let glbErr = null;
    try {
      glbAsset = resolvePssMeshGlbAsset(meshPath, { aniPaths: aniSet });
    } catch (err) { glbErr = err?.message || String(err); }
    if (!glbAsset || !existsSync(glbAsset.absolutePath)) {
      glbReports.push({ meshPath, glbProduced: false, hasPssMaterial: false, reason: glbErr || 'GLB conversion failed or file not produced' });
      continue;
    }
    let glbBuf;
    try { glbBuf = readFileSync(glbAsset.absolutePath); }
    catch (err) {
      glbReports.push({ meshPath, glbProduced: false, hasPssMaterial: false, reason: `GLB unreadable: ${err?.message}` });
      continue;
    }
    const glbInfo = inspectGlbPssMaterial(glbBuf);
    glbReports.push({
      meshPath,
      glbProduced: true,
      hasPssMaterial: glbInfo.hasPssMaterial,
      reason: glbInfo.error || (glbInfo.hasPssMaterial ? 'OK' : 'Material missing extras.pssMaterial — JsonInspack absent at conversion time'),
      pssMaterial: glbInfo.pssMaterial,
      materialCount: glbInfo.materialCount,
      glbBytes: glbBuf.length,
    });
  }
  const glbProductionFails = glbReports.filter((r) => !r.glbProduced);
  checks.push({
    id: 'mesh.glb.cached', label: 'GLB binary produced for every mesh',
    status: glbProductionFails.length === 0 ? 'pass' : 'fail',
    detail: glbProductionFails.length === 0 ? `${glbReports.length} GLBs ready` : `${glbProductionFails.length}/${glbReports.length} failed to produce GLB`,
    value: glbReports,
  });

  // C.mesh.glb.material — pssMaterial extras present
  const noMaterial = glbReports.filter((r) => r.glbProduced && !r.hasPssMaterial);
  const withMaterial = glbReports.filter((r) => r.glbProduced && r.hasPssMaterial);
  if (glbReports.length > 0) {
    const status = noMaterial.length === 0 && withMaterial.length === glbReports.filter((r) => r.glbProduced).length ? 'pass'
      : withMaterial.length > 0 ? 'fail' : 'fail';
    checks.push({
      id: 'mesh.glb.material', label: 'Every GLB material has pssMaterial extras (textures/blendMode)',
      status,
      detail: `${withMaterial.length}/${glbReports.length} have pssMaterial · ${noMaterial.length} converted from .mesh without sibling JsonInspack`,
      value: { withMaterial: withMaterial.length, total: glbReports.length, noMaterial: noMaterial.map((r) => r.meshPath) },
    });
  }

  // C.mesh.blendMode — pssMaterial.blendMode in expected set (1=alpha, 2=additive)
  for (const r of withMaterial) {
    const pm = r.pssMaterial;
    const bm = Number(pm.blendMode);
    const known = bm === 0 || bm === 1 || bm === 2 || bm === 3 || bm === 4;
    checks.push({
      id: `mesh.blendMode.${basename(r.meshPath)}`,
      label: `blendMode is recognized (${basename(r.meshPath)})`,
      status: known ? 'pass' : 'warn',
      detail: `blendMode=${bm} (0=opaque 1=alpha-mask 2=additive 3=multiply 4=subtractive)`,
      value: { blendMode: bm, alphaRef: pm.alphaRef },
    });
  }

  // C.mesh.glb.textures — every key referenced in pssMaterial.textures resolves
  for (const r of withMaterial) {
    const texMap = r.pssMaterial.textures || {};
    const keys = Object.keys(texMap);
    if (keys.length === 0) {
      checks.push({
        id: `mesh.glb.tex.${basename(r.meshPath)}`,
        label: `pssMaterial.textures non-empty (${basename(r.meshPath)})`,
        status: 'warn',
        detail: 'No textures listed — mesh would render untextured',
      });
      continue;
    }
    const missing = [];
    for (const [k, texName] of Object.entries(texMap)) {
      const norm = String(texName || '').trim();
      if (!norm) continue;
      // Texture resolver: try resolvePssTextureFile against the bare name —
      // if absent, log as missing.
      let found = false;
      try {
        const resolved = resolvePssTextureFile(norm);
        if (resolved && resolved.data) found = true;
      } catch { /* ignore */ }
      if (!found) {
        // Try sibling-of-mesh path
        const aniDir = dirname(r.meshPath);
        const sibling = `${aniDir}/${norm.replace(/\.tga$/i, '.dds')}`;
        try {
          const resolvedSib = resolvePssTextureFile(sibling);
          if (resolvedSib && resolvedSib.data) found = true;
        } catch { /* ignore */ }
      }
      if (!found) missing.push({ key: k, value: norm });
    }
    checks.push({
      id: `mesh.glb.tex.${basename(r.meshPath)}`,
      label: `pssMaterial textures resolvable (${basename(r.meshPath)})`,
      status: missing.length === 0 ? 'pass' : missing.length < keys.length ? 'warn' : 'fail',
      detail: missing.length === 0 ? `${keys.length} OK` : `${missing.length}/${keys.length} missing: ${missing.map((m) => `${m.key}=${m.value}`).join(', ')}`,
      value: { textures: texMap, missing },
    });
  }

  // C.mesh.fields
  if (em.meshFields) {
    const mf = em.meshFields;
    checks.push({
      id: 'mesh.fields', label: 'meshFields parsed (layerScale/emitterScale)',
      status: 'info',
      detail: `layerScale=${JSON.stringify(mf.layerScale)} emitterScale=${mf.emitterScale} loopFlag=${mf.loopFlag}`,
      value: mf,
    });
  }

  // C.mesh.ani
  if (anis.length > 0) {
    const missingAni = anis.filter((p) => !aniAssetByPath.get(p)?.existsLocally);
    checks.push({
      id: 'mesh.ani', label: 'All animations resolvable',
      status: missingAni.length === 0 ? 'pass' : 'warn',
      detail: missingAni.length === 0 ? `${anis.length} OK` : `Missing: ${missingAni.join(', ')}`,
      value: { missing: missingAni },
    });
  }

  const fail = checks.some((c) => c.status === 'fail');
  return { index: em.index, type: 'mesh', label: labelBase, status: fail ? 'fail' : 'pass', checks };
}

function verifyTrackEmitter(em, trackAssetByPath) {
  const checks = [];
  const tracks = Array.isArray(em.tracks) ? em.tracks : [];
  const labelBase = `Track #${em.index} (${tracks[0] ? basename(tracks[0]) : 'no track'})`;

  if (tracks.length === 0) {
    checks.push({ id: 'track.exists', label: 'Has track references', status: 'fail',
      detail: 'No track paths parsed' });
    return { index: em.index, type: 'track', label: labelBase, status: 'fail', checks };
  }

  const missing = tracks.filter((p) => !trackAssetByPath.get(p)?.existsLocally);
  checks.push({
    id: 'track.resolve', label: 'All track files resolvable',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0 ? `${tracks.length} OK` : `Missing: ${missing.join(', ')}`,
    value: { missing },
  });

  for (const tp of tracks) {
    const asset = trackAssetByPath.get(tp);
    const nodeCount = asset?.decodedTrack?.nodeCount;
    checks.push({
      id: `track.decode.${basename(tp)}`,
      label: `parseTrackResourceBuffer decoded (${basename(tp)})`,
      status: Number(nodeCount) > 0 ? 'pass' : 'fail',
      detail: nodeCount != null ? `nodeCount=${nodeCount}` : 'No decoded data',
      value: asset?.decodedTrack || null,
    });
  }

  if (em.trackParams) {
    checks.push({
      id: 'track.params', label: 'Track runtime params extracted',
      status: 'info',
      detail: `widthScale=${em.trackParams.widthScale} alphaScale=${em.trackParams.alphaScale} speedHint=${em.trackParams.speedHint} flowScale=${em.trackParams.flowScale}`,
      value: em.trackParams,
    });
  }

  const fail = checks.some((c) => c.status === 'fail');
  return { index: em.index, type: 'track', label: labelBase, status: fail ? 'fail' : 'pass', checks };
}

// Inspect a GLB binary, return materials[0] extras.pssMaterial (if any).
// Returns: { hasPssMaterial, pssMaterial, materialCount, error? }
function inspectGlbPssMaterial(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
      return { hasPssMaterial: false, error: 'Buffer too small for GLB' };
    }
    const magic = buffer.readUInt32LE(0);
    if (magic !== 0x46546c67) {  // 'glTF'
      return { hasPssMaterial: false, error: 'Not a GLB (magic mismatch)' };
    }
    const totalLength = buffer.readUInt32LE(8);
    if (totalLength > buffer.length) {
      return { hasPssMaterial: false, error: 'GLB length exceeds buffer' };
    }
    // Chunk 0 = JSON
    const chunk0Len = buffer.readUInt32LE(12);
    const chunk0Type = buffer.readUInt32LE(16);
    if (chunk0Type !== 0x4e4f534a) {  // 'JSON'
      return { hasPssMaterial: false, error: 'Chunk 0 is not JSON' };
    }
    const jsonText = buffer.subarray(20, 20 + chunk0Len).toString('utf8').replace(/\0+$/, '').trim();
    const json = JSON.parse(jsonText);
    const materials = Array.isArray(json.materials) ? json.materials : [];
    if (materials.length === 0) {
      return { hasPssMaterial: false, materialCount: 0, error: 'GLB has no materials[]' };
    }
    // Find first material with extras.pssMaterial
    let pm = null;
    for (const m of materials) {
      if (m?.extras?.pssMaterial) { pm = m.extras.pssMaterial; break; }
    }
    return {
      hasPssMaterial: !!pm,
      pssMaterial: pm,
      materialCount: materials.length,
    };
  } catch (err) {
    return { hasPssMaterial: false, error: err?.message || String(err) };
  }
}

// Sample dominant color of the first DXT1/DXT5 4×4 block, OR sample first
// pixel of an uncompressed DDS. Returns { hasMagic, format, r, g, b, reason }.
function sampleFirstDxtBlockColor(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128) {
    return { hasMagic: false, reason: 'Buffer too small for DDS header' };
  }
  if (!isDdsHeader(buffer.subarray(0, 4))) {
    return { hasMagic: false, reason: `Not DDS — head4=${buffer.subarray(0,4).toString('hex')}` };
  }
  // DDS header: 4 magic + 124 dwHeader = 128 bytes.
  // PixelFormat at offset 76 (size=32 bytes). fourCC at offset 84.
  const fourCC = buffer.subarray(84, 88).toString('ascii');
  if (fourCC === 'DXT1' || fourCC === 'DXT5' || fourCC === 'DXT3') {
    // First block at offset 128. DXT1 = 8 bytes; DXT5 = 16 bytes (8 alpha + 8 color).
    // For DXT5 the color block is at offset 136. For DXT1 it's at 128.
    const colorOff = fourCC === 'DXT1' ? 128 : 136;
    if (buffer.length < colorOff + 4) {
      return { hasMagic: true, format: fourCC, reason: 'Truncated DXT block' };
    }
    const c0 = buffer.readUInt16LE(colorOff);
    // RGB565: rrrrr ggggg gbbbbb (5+6+5)
    // Wait: RGB565 = R5 G6 B5 — bits 15..11 = R, 10..5 = G, 4..0 = B
    const r5 = (c0 >> 11) & 0x1f;
    const g6 = (c0 >> 5) & 0x3f;
    const b5 = c0 & 0x1f;
    const r = Math.round((r5 / 31) * 255);
    const g = Math.round((g6 / 63) * 255);
    const b = Math.round((b5 / 31) * 255);
    return { hasMagic: true, format: fourCC, r, g, b, c0Hex: `0x${c0.toString(16).padStart(4, '0')}` };
  }
  // Uncompressed: try RGBA8 read at offset 128
  if (buffer.length >= 132) {
    const r = buffer.readUInt8(128);
    const g = buffer.readUInt8(129);
    const b = buffer.readUInt8(130);
    return { hasMagic: true, format: `RAW(${fourCC})`, r, g, b };
  }
  return { hasMagic: true, format: fourCC, reason: 'Unsupported pixel format for sampling' };
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const urlPath = decodeURIComponent(rawUrl.split('?')[0]);
  const reqUrl = new URL(rawUrl, 'http://localhost');

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API: list full exports
  if (method === 'GET' && urlPath === '/api/full-exports') {
    try {
      const exportsList = listFullExports();
      sendJson(res, 200, { exports: exportsList, root: DESKTOP_EXPORT_ROOT });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: enumerate MovieEditor actor exports.
  if (method === 'GET' && urlPath === '/api/actor-exports') {
    try {
      sendJson(res, 200, {
        available: existsSync(MOVIE_EDITOR_EXPORT_ROOT) && statSync(MOVIE_EDITOR_EXPORT_ROOT).isDirectory(),
        root: MOVIE_EDITOR_EXPORT_ROOT,
        exports: listMovieEditorActorExports(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // ─── Actor Animation Player API ─────────────────────────────────────────────

  // List all plot folders
  if (method === 'GET' && urlPath === '/api/actor/plots') {
    try {
      sendJson(res, 200, { root: ACTOR_PLOT_ROOT, plots: listActorPlots() });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Get plot contents (sub-plots, actors, animations, audio)
  if (method === 'GET' && urlPath === '/api/actor/plot-contents') {
    try {
      const plot = reqUrl.searchParams.get('plot');
      if (!plot) { sendJson(res, 400, { error: 'plot required' }); return; }
      const contents = getActorPlotContents(plot);
      if (!contents) { sendJson(res, 404, { error: `Plot not found: ${plot}` }); return; }
      sendJson(res, 200, contents);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Parse MIN2 .ani header and return metadata
  if (method === 'GET' && urlPath === '/api/actor/ani-header') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      const abs = safePathUnder(ACTOR_PLOT_ROOT, filePath);
      if (!abs || !existsSync(abs)) { sendJson(res, 404, { error: `File not found: ${filePath}` }); return; }
      const buf = readFileSync(abs);
      sendJson(res, 200, parseMin2AniHeader(buf));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Parse .actor INI file
  if (method === 'GET' && urlPath === '/api/actor/actor-def') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      const abs = safePathUnder(ACTOR_PLOT_ROOT, filePath);
      if (!abs || !existsSync(abs)) { sendJson(res, 404, { error: `File not found: ${filePath}` }); return; }
      const text = readFileSync(abs, 'utf-8');
      const sections = parseIniSections(text);
      const summary = parseActorFileSummary(text);
      sendJson(res, 200, { path: filePath, sections: Object.fromEntries(sections), summary });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Serve raw .ani binary for client-side parsing
  if (method === 'GET' && urlPath === '/api/actor/ani-raw') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      const abs = safePathUnder(ACTOR_PLOT_ROOT, filePath);
      if (!abs || !existsSync(abs)) { sendJson(res, 404, { error: `File not found: ${filePath}` }); return; }
      const data = readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Serve .wav/.mp3 audio from plot directories
  if (method === 'GET' && urlPath === '/api/actor/audio') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      if (!/\.(wav|mp3|ogg)$/i.test(filePath)) { sendJson(res, 400, { error: 'Invalid audio format' }); return; }
      const abs = safePathUnder(ACTOR_PLOT_ROOT, filePath);
      if (!abs || !existsSync(abs)) { sendJson(res, 404, { error: `Audio not found: ${filePath}` }); return; }
      const stat = statSync(abs);
      const ext = extname(abs).toLowerCase();
      const mimeMap = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
      const data = readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // ─── End Actor Animation Player API ─────────────────────────────────────────

  // API: Internal debug endpoint for agent to query Animation Player page state
  // This is a passthrough — the client exposes window.__debugState, but the agent
  // can also use this endpoint to verify the server is alive and list available routes.
  if (method === 'GET' && urlPath === '/api/actor/debug-info') {
    try {
      const plotsExist = existsSync(ACTOR_PLOT_ROOT);
      const plotCount = plotsExist ? readdirSync(ACTOR_PLOT_ROOT).filter(d => {
        try { return statSync(join(ACTOR_PLOT_ROOT, d)).isDirectory(); } catch { return false; }
      }).length : 0;
      sendJson(res, 200, {
        status: 'ok',
        serverTime: new Date().toISOString(),
        actorPlotRoot: ACTOR_PLOT_ROOT,
        actorPlotRootExists: plotsExist,
        plotCount,
        availableEndpoints: [
          'GET /api/actor/plots',
          'GET /api/actor/plot-contents?plot=<name>',
          'GET /api/actor/ani-header?path=<relPath>',
          'GET /api/actor/actor-def?path=<relPath>',
          'GET /api/actor/ani-raw?path=<relPath>',
          'GET /api/actor/audio?path=<relPath>',
          'GET /api/actor/debug-info',
        ],
        clientDebugHint: 'In browser console: window.__debugState.getLogs() / .currentPlot / .currentAniHeader / .isPlaying',
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // ─── Player Animation Browser API ─────────────────────────────────────────

  // List body types with animation counts
  if (method === 'GET' && urlPath === '/api/player-anim/body-types') {
    try {
      const bodyTypes = ['f1', 'f2', 'm1', 'm2'];
      const result = bodyTypes.map(bt => {
        const entries = loadPlayerAnimationTable(bt);
        return { bodyType: bt.toUpperCase(), entryCount: entries ? entries.length : 0 };
      });
      sendJson(res, 200, { bodyTypes: result, serialTablePath: join(PLAYER_ANIM_TABLE_DIR, 'player_serial_animation_table.txt') });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/player-anim/anchor-support') {
    try {
      const bt = (reqUrl.searchParams.get('bodyType') || '').toLowerCase();
      const support = buildMovieEditorPlayerAnchorSupport(bt);
      if (!support) {
        sendJson(res, 404, { error: `No anchor support found for body type: ${bt}` });
        return;
      }
      sendJson(res, 200, support);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Get paginated animation list for a body type
  if (method === 'GET' && urlPath === '/api/player-anim/animations') {
    try {
      const bt = (reqUrl.searchParams.get('bodyType') || 'm2').toLowerCase();
      const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
      const page = Math.max(0, parseInt(reqUrl.searchParams.get('page'), 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(reqUrl.searchParams.get('limit'), 10) || 100));
      const entries = loadPlayerAnimationTable(bt);
      if (!entries) { sendJson(res, 404, { error: `No animation table found for body type: ${bt}` }); return; }
      let filtered = entries;
      if (search) {
        filtered = entries.filter(e =>
          e.animFile.toLowerCase().includes(search) ||
          String(e.id).includes(search)
        );
      }
      const total = filtered.length;
      const start = page * limit;
      const slice = filtered.slice(start, start + limit);
      sendJson(res, 200, { bodyType: bt.toUpperCase(), total, page, limit, animations: slice });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Get serial animation table (named sequences)
  if (method === 'GET' && urlPath === '/api/player-anim/serial-table') {
    try {
      const entries = loadSerialAnimationTable();
      if (!entries) { sendJson(res, 404, { error: 'Serial animation table not found' }); return; }
      sendJson(res, 200, { total: entries.length, entries });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Get Tani.rt catalog entries (paginated, filterable by body type and search)
  if (method === 'GET' && urlPath === '/api/player-anim/tani-catalog') {
    try {
      const catalog = loadTaniCatalog();
      if (!catalog) { sendJson(res, 404, { error: 'Tani.rt catalog not found' }); return; }
      const bt = (reqUrl.searchParams.get('bodyType') || '').toLowerCase();
      const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
      const page = Math.max(0, parseInt(reqUrl.searchParams.get('page'), 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(reqUrl.searchParams.get('limit'), 10) || 100));
      let filtered = catalog;
      if (bt) {
        filtered = filtered.filter(e => e.name.toLowerCase().startsWith(bt));
      }
      if (search) {
        filtered = filtered.filter(e =>
          e.name.toLowerCase().includes(search) ||
          e.sourcePath.toLowerCase().includes(search) ||
          e.shellPath.toLowerCase().includes(search)
        );
      }
      const total = filtered.length;
      const start = page * limit;
      const slice = filtered.slice(start, start + limit);
      sendJson(res, 200, { total, page, limit, entries: slice });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Parse a .tani binary from PakV5: extract it, then return its contents
  if (method === 'GET' && urlPath === '/api/player-anim/tani-parse') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      const buf = extractFromPakV4(filePath, join(__dirname, 'cache-extraction', 'actor-assets'));
      if (!buf) { sendJson(res, 404, { error: `Could not extract: ${filePath}` }); return; }
      sendJson(res, 200, parseTaniBinary(buf, filePath));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Extract .ani from PakV5 and return its MIN2 header
  if (method === 'GET' && urlPath === '/api/player-anim/ani-header') {
    try {
      const filePath = reqUrl.searchParams.get('path');
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      const buf = extractFromPakV4(filePath, join(__dirname, 'cache-extraction', 'actor-assets'));
      if (!buf) { sendJson(res, 404, { error: `Could not extract: ${filePath}` }); return; }
      sendJson(res, 200, parseMin2AniHeader(buf));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // ─── End Player Animation Browser API ──────────────────────────────────────

  // API: PSS deep verification — runs every check against every referenced
  // file and reports per-stage pass/fail with diagnostics. Designed to catch
  // "loads OK but renders wrong" issues that the analyze endpoint misses.
  if (method === 'GET' && urlPath === '/api/pss/verify') {
    try {
      const sourcePath = reqUrl.searchParams.get('sourcePath');
      if (!sourcePath) { sendJson(res, 400, { error: 'sourcePath required' }); return; }
      sendJson(res, 200, buildPssVerifyResponse(sourcePath));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: PSS effect catalog
  if (method === 'GET' && urlPath === '/api/pss/catalog') {
    try {
      sendJson(res, 200, buildPssCatalogResponse(
        reqUrl.searchParams.get('q'),
        reqUrl.searchParams.get('limit'),
      ));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: C# sidecar probe. Invokes tools/pss-renderer-cli/bin/Release/
  // PssRendererCli.exe which loads the real MovieEditor DLLs and reports
  // what is available. Returns the sidecar's stdout JSON verbatim. 404 if
  // the sidecar has not been built yet.
  if (method === 'GET' && urlPath === '/api/debug/pss-sidecar-probe') {
    const exePath = join(__dirname, 'tools', 'pss-renderer-cli', 'bin', 'Release', 'PssRendererCli.exe');
    if (!existsSync(exePath)) {
      sendJson(res, 404, {
        ok: false,
        error: 'sidecar-not-built',
        hint: 'Run: dotnet build -c Release tools/pss-renderer-cli',
        exePath,
      });
      return;
    }
    try {
      const stdout = execFileSync(exePath, ['probe'], { timeout: 15000, windowsHide: true });
      const parsed = JSON.parse(stdout.toString('utf8').trim());
      sendJson(res, 200, parsed);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: 'sidecar-failed',
        message: err?.message || String(err),
        stdout: err?.stdout?.toString('utf8'),
        stderr: err?.stderr?.toString('utf8'),
      });
    }
    return;
  }

  // API: Client-side PSS render debug log (GET = retrieve last log, POST = store)
  if (urlPath === '/api/debug/pss-render-log') {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, log: globalPssRenderLog });
      return;
    }
    if (method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          globalPssRenderLog = { ...data, receivedAt: new Date().toISOString() };
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' });
        }
      });
      return;
    }
  }

  // API: PSS raw block dump — dump all float/uint values in every TOC block for binary analysis
  if (method === 'GET' && urlPath === '/api/pss/raw-dump') {
    try {
      const sourcePath = reqUrl.searchParams.get('sourcePath');
      if (!sourcePath) { sendJson(res, 400, { error: 'sourcePath required' }); return; }
      const buf = (() => {
        const norm = normalizeLogicalResourcePath(sourcePath);
        const cached = tryResolveCacheLogicalPath(norm);
        if (cached) return getJx3CacheReader().readEntry(cached.resolvedPath).output;
        const local = join(PSS_EXTRACT_DIR, norm.replace(/\//g, '\\'));
        if (existsSync(local)) return readFileSync(local);
        if (existsSync(PAKV4_EXTRACT_EXE)) return extractFromPakV4(norm, PSS_EXTRACT_DIR);
        return null;
      })();
      if (!buf || buf.length < 16) { sendJson(res, 404, { error: 'PSS not found or too small' }); return; }
      const emitterCount = buf.readUInt32LE(12);
      const toc = [];
      for (let i = 0; i < emitterCount; i++) {
        const b = 16 + i * 12;
        toc.push({ type: buf.readUInt32LE(b), offset: buf.readUInt32LE(b+4), size: buf.readUInt32LE(b+8) });
      }
      const blocks = toc.map((entry, idx) => {
        const { type, offset: o, size } = entry;
        const scanBytes = reqUrl.searchParams.get('full') === '1' ? size : Math.min(size, 600);
        const words = [];
        for (let i = 0; i + 4 <= scanBytes; i += 4) {
          const u = buf.readUInt32LE(o + i);
          const f = buf.readFloatLE(o + i);
          words.push({ off: i, uint: u, float: isFinite(f) ? Math.round(f * 10000) / 10000 : null });
        }
        return { index: idx, type, offset: o, size, words };
      });
      sendJson(res, 200, { ok: true, fileSize: buf.length, emitterCount, blocks });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: raw PSS bytes — for local binary archaeology tools. No parsing.
  if (method === 'GET' && urlPath === '/api/pss/raw-bytes') {
    try {
      const sourcePath = reqUrl.searchParams.get('sourcePath');
      if (!sourcePath) { sendJson(res, 400, { error: 'sourcePath required' }); return; }
      const buf = readPssSourceBuffer(sourcePath);
      if (!buf) { sendJson(res, 404, { error: 'PSS not found' }); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: PSS focused debug dump — per-emitter parsed + raw non-zero words +
  // uncertainty flags, plus TANI socket routing info. Designed to be rendered
  // in the Animation Player's PSS debug panel and copy/pasted for analysis.
  if (method === 'GET' && urlPath === '/api/pss/debug-dump') {
    try {
      const sourcePath = reqUrl.searchParams.get('sourcePath');
      if (!sourcePath) { sendJson(res, 400, { error: 'sourcePath required' }); return; }
      const buf = readPssSourceBuffer(sourcePath);
      if (!buf || buf.length < 16) { sendJson(res, 404, { error: 'PSS not found' }); return; }

      // Run the full analyzer so the debug endpoint sees exactly what the
      // renderer sees (sibling inference, runtime params, etc.).
      const analyzed = buildPssAnalyzeResponse(sourcePath);
      const emittersFromAnalyzer = Array.isArray(analyzed?.emitters) ? analyzed.emitters : [];

      const emitterCount = buf.readUInt32LE(12);
      const toc = [];
      for (let i = 0; i < emitterCount; i++) {
        const b = 16 + i * 12;
        toc.push({
          index: i,
          type: buf.readUInt32LE(b),
          offset: buf.readUInt32LE(b + 4),
          size: buf.readUInt32LE(b + 8),
        });
      }

      // Build a compact record per emitter: interpret known offsets + list
      // every non-zero 4-byte word (up to 256 entries). Each word shows both
      // uint and float interpretations so a human can spot fields.
      const BLOCKS = toc.map((entry) => {
        const base = entry.offset;
        const size = entry.size;
        const end = Math.min(base + size, buf.length);
        const scanLimit = Math.min(size, 1024);
        const nonZeroWords = [];
        for (let i = 0; i + 4 <= scanLimit; i += 4) {
          if (base + i + 4 > buf.length) break;
          const u = buf.readUInt32LE(base + i);
          if (u === 0) continue;
          const f = buf.readFloatLE(base + i);
          const row = {
            rel: i,
            u,
            f: Number.isFinite(f) && Math.abs(f) < 1e20 ? Math.round(f * 1000000) / 1000000 : null,
          };
          nonZeroWords.push(row);
          if (nonZeroWords.length >= 256) break;
        }

        // First 32 bytes as hex for quick structural scan.
        const hexLen = Math.min(32, end - base);
        const hexBuf = buf.subarray(base, base + hexLen);
        const hexBytes = Array.from(hexBuf).map((b) => b.toString(16).padStart(2, '0')).join(' ');

        const meta = emittersFromAnalyzer.find((e) => e.index === entry.index) || null;

        const out = {
          index: entry.index,
          type: entry.type,
          typeLabel: entry.type === 0 ? 'global'
            : entry.type === 1 ? 'sprite'
            : entry.type === 2 ? 'mesh'
            : entry.type === 3 ? 'track'
            : 'unknown',
          offset: entry.offset,
          size: entry.size,
          headHex32: hexBytes,
          nonZeroWords,
        };

        // Type-specific authoritative reads + uncertainty flags.
        if (entry.type === 0 && size >= 20 && base + 20 <= buf.length) {
          out.parsed = {
            globalStartDelayMs: Number(buf.readFloatLE(base + 0).toFixed(3)),
            globalPlayDurationMs: Number(buf.readFloatLE(base + 4).toFixed(3)),
            globalDurationMs: Number(buf.readFloatLE(base + 8).toFixed(3)),
            globalLoopEndMs: Number(buf.readFloatLE(base + 12).toFixed(3)),
            fadeOrMulti: Number(buf.readFloatLE(base + 16).toFixed(3)),
          };
          out.authoritative = ['globalStartDelayMs', 'globalPlayDurationMs', 'globalDurationMs', 'globalLoopEndMs'];
          if (size > 20) {
            // Decode the trailing region word-by-word. The global block
            // schema after +20 is not reverse-engineered, but the non-zero
            // words themselves are authoritative: we expose them as both
            // (u32, f32) pairs so callers can use the values directly.
            const tailStart = base + 20;
            const tailEnd = Math.min(base + size, buf.length);
            const trailingWords = [];
            for (let p = tailStart; p + 4 <= tailEnd; p += 4) {
              const u = buf.readUInt32LE(p);
              if (u === 0) continue;
              const f = buf.readFloatLE(p);
              trailingWords.push({
                rel: p - base,
                u,
                f: Number.isFinite(f) && Math.abs(f) < 1e20 ? Math.round(f * 1000000) / 1000000 : null,
              });
            }
            out.parsed.globalTrailingWords = trailingWords;
            out.authoritative.push(`globalTrailingWords (${trailingWords.length} non-zero 32-bit words decoded as both u32 and f32; schema not reverse-engineered)`);
            out.uncertain = [];
          } else {
            out.uncertain = [];
          }
        } else if (entry.type === 1 && size > 288 && base + 288 <= buf.length) {
          const layerFlags = [];
          for (let f = 0; f < 4; f++) {
            const v = buf.readUInt32LE(base + 272 + f * 4);
            if (v <= 8) layerFlags.push(v); else break;
          }
          // Read uvRows/uvCols at confirmed fixed offsets +320/+324
          const uvRowsVal = size > 328 ? buf.readUInt32LE(base + 320) : null;
          const uvColsVal = size > 328 ? buf.readUInt32LE(base + 324) : null;
          const moduleNames = new Set(Array.isArray(meta?.modules) ? meta.modules : []);
          const spriteUncertain = [];
          out.parsed = {
            material: meta?.material || null,
            materialName: meta?.materialName || null,
            layerFlags,
            layerCount: meta?.layerCount ?? null,
            textures: meta?.textures || [],
            blendMode: meta?.blendMode || null,
            blendModeSource: meta?.blendModeSource || null,
            colorCurveKeyframes: Array.isArray(meta?.colorCurve) ? meta.colorCurve.length : 0,
            uvRows: (uvRowsVal >= 1 && uvRowsVal <= 64) ? uvRowsVal : null,
            uvCols: (uvColsVal >= 1 && uvColsVal <= 64) ? uvColsVal : null,
            maxParticles: meta?.maxParticles ?? null,
            spawnLauncherTypeId: meta?.spawnLauncherTypeId ?? null,
            modules: meta?.modules || [],
            moduleCount: Array.isArray(meta?.modules) ? meta.modules.length : 0,
            activeModules: meta?.activeModules || [],
            inactiveModules: meta?.inactiveModules || [],
            unknownModules: meta?.unknownModules || [],
            hasVelocity: meta?.hasVelocity ?? false,
            // hasGravity removed (no 重力 marker in any PSS file; see audit 2026-04-26)
            hasBrightness: meta?.hasBrightness ?? false,
            hasColorCurve: meta?.hasColorCurve ?? false,
            runtimeParams: meta?.runtimeParams || null,
            tailParams: meta?.tailParams || null,
            category: meta?.category || null,
          };
          out.authoritative = [
            'material',
            'layerFlags@+272',
            'textures',
            'colorCurveKeyframes',
            'uvRows@+320',
            'uvCols@+324',
            'maxParticles (from fixed-trailer 5\u00d7u32=120 region at markerAbs+72)',
            'spawnLauncherTypeId (from layerToken at blockEnd-152; resolved via PSS_SPAWN_SHAPE_TYPE_MAP — engine RTTI: KG3D_Launcher{Shape}::GetShape vtable slot 11 in kg3denginedx11ex64.dll)',
            'modules (GB18030 Chinese module names scanned from variable section +856..blockEnd-152)',
            'hasVelocity / hasGravity / hasBrightness / hasColorCurve (derived from module name presence)',
          ];
          // blendMode for unresolvable .jsondef is NOT surfaced per-sprite
          // (see top-level note below). It is a structural gap of the game
          // archive — specifically the 独立材质/* subfolder is archived-only
          // and not extractable from packed cache or disk in this install —
          // not a parse error per emitter.
          const activeSet = new Set(Array.isArray(meta?.activeModules) ? meta.activeModules : []);
          const moduleBytes = meta?.moduleByteCounts || {};
          const moduleOffsets = Array.isArray(meta?.moduleOffsets) ? meta.moduleOffsets : [];
          // KG3D_KeyFrame<RANDOM_VECTOR4>::ReadData reads: [count:u32, key×count]
          // where each key is 16 bytes. Attempt to decode keys as
          // {time:f32, v0:f32, v1:f32, v2:f32}. If the decoded times are
          // monotonically non-decreasing and finite in a sane range, we treat
          // the decoding as successful and expose curveKeys. Otherwise we
          // fall back to payload-byte counts only.
          const tryDecodeCurveKeys = (moduleName, occurrenceIdx = 0) => {
            if (!moduleName) return null;
            // Find the Nth occurrence of `moduleName` in moduleOffsets
            // (multi-emitter sprite blocks repeat the same module name once
            // per emitter — earlier code used findIndex and silently dropped
            // emitters #2, #3, ...). Audit shows ~24% of velocity blocks
            // and ~26% of color/channel blocks are multi-emitter.
            let idx = -1;
            let seen = 0;
            for (let i = 0; i < moduleOffsets.length; i++) {
              if (moduleOffsets[i].name === moduleName) {
                if (seen === occurrenceIdx) { idx = i; break; }
                seen++;
              }
            }
            if (idx < 0) return null;
            const cur = moduleOffsets[idx];
            const nameAbs = base + cur.offset;
            const nameLen = [...cur.name].length * 2; // GB18030: 2 bytes per Hanzi
            const nextAbs = (idx + 1 < moduleOffsets.length)
              ? (base + moduleOffsets[idx + 1].offset)
              : (base + Math.max(0, size - 152));
            const payloadStart = nameAbs + nameLen;
            const payloadEnd = Math.max(payloadStart, nextAbs);
            const payloadLen = payloadEnd - payloadStart;
            // Tiny / empty payload — module declared with no curve data.
            // Engine reads zero keyframes and uses the channel default at
            // runtime. NOT a parser gap. Verified on t_天策龙牙.pss em#1/#8/#15
            // 颜色 occ#0 (payload bytes 0xa41/0x41b9/0x7821 each len=2,
            // containing the prefix of the next field name "UV..."): the
            // 颜色 module exists but has zero authored animation.
            if (payloadEnd > buf.length) return null;
            if (payloadLen >= 0 && payloadLen <= 8) {
              return {
                count: 0,
                keys: [],
                stride: 0,
                startOff: 0,
                layoutKind: 'no-animation',
                effectiveValue: 'engine default (constant; no keyframes authored)',
                note: `Module "${moduleName}" was declared in the block header but contains ${payloadLen} bytes of payload — too small to hold any KG3D_KeyFrame<T>. Engine reads zero keyframes and uses the channel default value at runtime. This is engine-authoritative behavior, not a parser failure.`,
                structuralProbe: {
                  payloadLen,
                  bytes: payloadLen > 0 ? Array.from(buf.slice(payloadStart, payloadEnd)) : [],
                },
              };
            }
            if (payloadLen < 14) return null;
            // Empirically verified from T_\u5929\u7B56\u9F99\u7259.pss sprite
            // #1 \u901F\u5EA6 module: engine stores a 1D float curve as
            //   [??? 10-byte header, {f32 value, f32 0, f32 0}\u00d710+]
            // i.e. each key is 12 bytes with value in the first 4 bytes and
            // 8 zero bytes (unused y/z channels of vec3). Time is implicit
            // (evenly spaced) \u2014 there is no per-key time stored.
            // Extract the value stream by walking the payload at a 12-byte
            // stride starting at +10, stopping when we hit a non-f32 pattern
            // (value not finite, or "zero padding" bytes that aren't zero).
            const keys = [];
            const stride = 12;
            const startOff = 10;
            for (let off = startOff; off + stride <= payloadLen; off += stride) {
              const p = payloadStart + off;
              const v = buf.readFloatLE(p);
              if (!Number.isFinite(v)) break;
              if (Math.abs(v) > 1e6) break; // clearly not a curve value
              // Validate: next 8 bytes should be zero (y/z channels unused)
              let zeroPad = true;
              for (let q = 4; q < 12; q++) {
                if (buf[p + q] !== 0) { zeroPad = false; break; }
              }
              if (!zeroPad) break;
              keys.push({
                index: keys.length,
                value: Math.round(v * 1000000) / 1000000,
              });
              if (keys.length > 512) break; // sanity cap
            }
            if (keys.length >= 2) {
              return { count: keys.length, keys, stride, startOff, layoutKind: '1d-implicit-time' };
            }
            // Fallback layout A: 3-channel vector curve with u32 count.
            //   [count:u32, {t:f32, x:f32, y:f32, z:f32}×count]
            // Fallback layout B: same keys but with u16 count header.
            //   [count:u16, {t:f32, x:f32, y:f32, z:f32}×count]
            // Example (尖刺02): payloadLen 258 = 2 + 16×16, 1330 = 2 + 16×83.
            const tryVecCurve = (headerBytes, readCount) => {
              if (payloadLen < headerBytes + 16 * 2) return null;
              const count3 = readCount();
              const expected = headerBytes + count3 * 16;
              if (count3 < 2 || count3 > 1024) return null;
              if (expected > payloadLen || expected + 16 < payloadLen) return null;
              const keys3 = [];
              let prevT = -Infinity;
              for (let k = 0; k < count3; k++) {
                const p = payloadStart + headerBytes + k * 16;
                const t = buf.readFloatLE(p);
                const x = buf.readFloatLE(p + 4);
                const y = buf.readFloatLE(p + 8);
                const z = buf.readFloatLE(p + 12);
                if (![t, x, y, z].every(Number.isFinite)) return null;
                if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6) return null;
                if (t < -0.01 || t > 1e4) return null;
                if (t + 1e-4 < prevT) return null;
                prevT = t;
                keys3.push({
                  index: k,
                  time: Math.round(t * 1000000) / 1000000,
                  x: Math.round(x * 1000000) / 1000000,
                  y: Math.round(y * 1000000) / 1000000,
                  z: Math.round(z * 1000000) / 1000000,
                });
              }
              return { count: keys3.length, keys: keys3, stride: 16, startOff: headerBytes, layoutKind: '3d-explicit-time' };
            };
            // Classify non-numeric payloads. Some velocity modules embed a
            // serialized "expression" object (pointer-linked node graph)
            // instead of a keyframe array — observable as leaked ASCII
            // identifiers ("cute", "Node0", etc.) and repeating 32-bit
            // heap-address-shaped patterns (e.g. bytes like f9 f6 7f 01).
            // These are not numeric curves and cannot be decoded with a
            // keyframe schema; mark them as complex-expression so the audit
            // does not treat them as failed numeric decodes.
            const payloadBytes = buf.slice(payloadStart, payloadEnd);
            // ASCII run detection: look for runs of >=3 consecutive
            // lowercase/uppercase/digit ASCII bytes (very unlikely to appear
            // by chance in f32 representations of small magnitudes).
            let asciiRuns = 0;
            let runLen = 0;
            for (let q = 0; q < payloadBytes.length; q++) {
              const b = payloadBytes[q];
              const isPrintable = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39);
              if (isPrintable) {
                runLen++;
                if (runLen === 3) asciiRuns++;
              } else {
                runLen = 0;
              }
            }
            // Pointer-pattern detection: the 4-byte sequence "f9 f6 7f 01"
            // or similar "xx xx 7f 01" repeats when the payload contains
            // 32-bit-shaped (legacy editor) vtable pointers leaked via
            // fwrite(this, sizeof, ...) raw-blob serialization. Count
            // occurrences of the specific high bytes "7f 01" at
            // stride-aligned positions.
            let pointerHits = 0;
            for (let q = 0; q + 1 < payloadBytes.length; q += 2) {
              if (payloadBytes[q] === 0x7f && payloadBytes[q + 1] === 0x01) pointerHits++;
            }
            // Zero-byte density: distinguishes engine-serialized expression
            // payloads (which pad 64-bit heap-pointer high halves with
            // zeros, ~50-60% zero bytes) from XMFLOAT4 keyframe arrays
            // (~15-25% zero bytes from f32 zero/denormal padding).
            let zeroByteCount = 0;
            for (let q = 0; q < payloadBytes.length; q++) {
              if (payloadBytes[q] === 0) zeroByteCount++;
            }
            // Legacy raw-blob layout (verified on t_天策尖刺02.pss sprite#10/#15):
            //   stride = 16B per record
            //   offset +0..+7 : leaked KG3D_ParticleDistribution vtable pointer
            //                   (low 4B varies in {0x017FF6F9, 0x017FF6FA, ...},
            //                    high 4B = 0 — written by an older 32-bit editor)
            //   offset +8..+9 : reserved (always 0x0000)
            //   offset +10..+13 : f32 value (the actual numeric data)
            //   offset +14..+15 : truncated next-record prefix bytes
            //
            // Sample decoded values for sprite#10 velocity (payload 258B,
            // 16 records): [0.0, 15239.72, 10184.39, 11003.51, 1.0, 0.0,
            // 13085.36, 9054.72, 15324.69, 1.0, 0.0, 9581.83, 10585.28,
            // 9206.09, 1.0, 0.1] — three groups of 5 = 3 vec3 keyframes
            // with bracketing time markers (t=0..1) per group, matching
            // the engine's KG3D_KeyFrame<RANDOM_VECTOR4> grouped layout.
            const tryLegacyBlob16 = () => {
              if (pointerHits < 3) return null;
              if (payloadLen < 32) return null;
              const recCount = Math.floor(payloadLen / 16);
              if (recCount < 2) return null;
              const vals = [];
              let plausible = 0;
              const markers = new Map();
              for (let k = 0; k < recCount; k++) {
                const recBase = k * 16;
                if (recBase + 14 > payloadBytes.length) break;
                // collect 8B marker for diagnostics
                const mhi = payloadBytes.readUInt32LE(recBase + 4);
                if (mhi !== 0) { /* marker high dword should be zero for legacy 32-bit pointers */ }
                const m = `${payloadBytes.readUInt32LE(recBase).toString(16).padStart(8,'0')}_${mhi.toString(16).padStart(8,'0')}`;
                markers.set(m, (markers.get(m) || 0) + 1);
                const f = payloadBytes.readFloatLE(recBase + 10);
                if (Number.isFinite(f) && Math.abs(f) < 1e7) {
                  plausible++;
                  vals.push(Math.round(f * 1000000) / 1000000);
                } else {
                  vals.push(null);
                }
              }
              // Require: most records have a high-dword-zero marker AND
              // at least 80% of f32 values are plausible.
              const goodMarkers = [...markers.entries()].filter(([m]) => m.endsWith('_00000000')).reduce((s, [,c]) => s + c, 0);
              if (goodMarkers < recCount * 0.6) return null;
              if (plausible < recCount * 0.8) return null;
              return {
                count: vals.length,
                values: vals,
                stride: 16,
                startOff: 0,
                valueOffset: 10,
                layoutKind: 'legacy-blob-vec3-curve',
                markerHandles: [...markers.keys()].slice(0, 4),
                note: 'Legacy raw-blob (fwrite) serialization of KG3D_ParticleDistribution wrapper around vec3-keyframe data. Stride 16B per record: 8B leaked 32-bit vtable_ptr + 2B zero + f32 value at +10 + 2B trailing. Decoded f32 values exposed as values[]; engine ReadData restores them by reconstructing the live distribution object on load.',
              };
            };
            const asLegacyBlob = tryLegacyBlob16();
            if (asLegacyBlob) return asLegacyBlob;

            // Layout D/E/F (verified curve / index / fragmented decoders)
            // are tried BEFORE the heuristic ASCII/pointer-blob fallback so
            // that payloads with the [u32 hdr + u16 index stream] pattern
            // (em#8/em#15 缩放 occ#0/occ#1) and the stride-16 implicit-time
            // XMFLOAT4 pattern (em#19 扭曲强度) are recognized definitively
            // instead of being captured by the unknown-blob fallback.
            const _tryImplicitStride16NoHeader = () => {
              // Try multiple header sizes; pick the one that produces the
              // most all-finite, all-bounded records (>= 0 keyframes loosely
              // matched). Verified on t_天策龙牙.pss em#19 扭曲强度 (header=0
              // payloadLen=256 → 16 records), em#8/em#15 缩放 occ#1
              // (header=17 payloadLen=257 → 15 records: 16-byte leaked
              // fwrite-prefix + 1 byte sentinel + 15 stride-16 records).
              if (payloadLen < 32) return null;
              const candidates = [0, 1, 14, 16, 17, 18];
              let best = null;
              for (const hdr of candidates) {
                if (hdr >= payloadLen) continue;
                const remain = payloadLen - hdr;
                if (remain < 32) continue;
                // Allow up to 8 trailing bytes (next field's name prefix
                // overlapping into this payload). Verified on em#6 rotation
                // of t_天策尖刺02.pss: hdr=14, payloadLen=260, count=15,
                // trailing 6 bytes are the leading "4CUV" of the next
                // module marker.
                if (remain % 16 > 8) continue;
                const count = Math.floor(remain / 16);
                if (count < 2 || count > 1024) continue;
                const keys4 = [];
                let ok = true;
                let nonZero = 0;
                let bounded = 0;
                for (let k = 0; k < count; k++) {
                  const p = payloadStart + hdr + k * 16;
                  const a = buf.readFloatLE(p);
                  const b = buf.readFloatLE(p + 4);
                  const c = buf.readFloatLE(p + 8);
                  const d = buf.readFloatLE(p + 12);
                  if (![a, b, c, d].every(Number.isFinite)) { ok = false; break; }
                  const inBounds = [a, b, c, d].every((v) => Math.abs(v) < 1e6);
                  if (inBounds) bounded++;
                  if (a !== 0 || b !== 0 || c !== 0 || d !== 0) nonZero++;
                  keys4.push({
                    index: k,
                    a: Math.round(a * 1000000) / 1000000,
                    b: Math.round(b * 1000000) / 1000000,
                    c: Math.round(c * 1000000) / 1000000,
                    d: Math.round(d * 1000000) / 1000000,
                  });
                }
                if (!ok) continue;
                // Accept only if >= 90% records are bounded and >= 2
                // are non-zero. Score by bounded-count to prefer the
                // alignment that captures more clean records.
                if (bounded < count * 0.9) continue;
                if (nonZero < 2) continue;
                if (!best || bounded > best.bounded || (bounded === best.bounded && hdr < best.hdr)) {
                  best = { hdr, count, keys4, bounded, nonZero };
                }
              }
              if (!best) return null;
              return {
                count: best.count,
                keys: best.keys4,
                stride: 16,
                startOff: best.hdr,
                layoutKind: '4d-implicit-no-header',
                note: `Stride-16 implicit-count keyframe array with ${best.hdr}-byte header. Each record is 4 f32 fields (a,b,c,d). Verified on t_天策龙牙.pss em#19 扭曲强度 (hdr=0) and em#8/em#15 缩放 occ#1 (hdr=17, where the 17 bytes are a legacy fwrite-leaked prefix).`,
                structuralProbe: {
                  headerBytes: best.hdr,
                  boundedRecords: best.bounded,
                  nonZeroRecords: best.nonZero,
                },
              };
            };
            const _tryParticleIndexTable = () => {
              if (payloadLen < 16 || payloadLen > 1024) return null;
              const dataStart = 4;
              const dataLen = payloadLen - dataStart;
              if (dataLen < 8 || dataLen % 2 !== 0) return null;
              const u16Count = dataLen / 2;
              let small = 0;
              let monotonicHits = 0;
              let prev = -1;
              for (let q = 0; q < u16Count; q++) {
                const v = buf.readUInt16LE(payloadStart + dataStart + q * 2);
                if (v < 0x1000) small++;
                if (v > prev && v - prev <= 8) monotonicHits++;
                prev = v;
              }
              if (small < u16Count * 0.95) return null;
              if (monotonicHits < u16Count * 0.5) return null;
              const samples = [];
              for (let q = 0; q < Math.min(u16Count, 16); q++) {
                samples.push(buf.readUInt16LE(payloadStart + dataStart + q * 2));
              }
              return {
                count: u16Count,
                keys: null,
                stride: 2,
                startOff: 4,
                layoutKind: 'particle-index-table',
                effectiveValue: 'zero (no animation curve; values come from index lookup)',
                structuralProbe: {
                  u16Count,
                  firstSamples: samples,
                  headerU32: buf.readUInt32LE(payloadStart),
                },
                note: 'u32 header + u16 index/state stream. NOT a keyframe curve — engine uses this as a particle vertex/index lookup table or layer-state map. Verified on t_天策龙牙.pss em#1 速度 occ#2 and em#8/#15 缩放 occ#0.',
              };
            };
            const _tryFragmentedStride16 = () => {
              if (payloadLen < 32) return null;
              // Accept payloads where the stride-16 record array fills all
              // but a small trailing remainder (<=8 bytes). Verified on
              // t_天策尖刺02.pss em#2 亮度 (payloadLen 260 = 16*16 + 4;
              // the 4 trailing bytes are the prefix of the next field's
              // name). Without this slack the decoder would reject
              // perfectly clean keyframe arrays whose payloadLen overlaps
              // into the next module by 1-7 bytes.
              const trailing = payloadLen % 16;
              if (trailing > 8) return null;
              const count = Math.floor(payloadLen / 16);
              const records = [];
              let validRecords = 0;
              let endMarkers = 0;
              let allZeroRecords = 0;
              for (let k = 0; k < count; k++) {
                const p = payloadStart + k * 16;
                const fa = buf.readFloatLE(p);
                const fb = buf.readFloatLE(p + 4);
                const fc = buf.readFloatLE(p + 8);
                const fd = buf.readFloatLE(p + 12);
                const allFinite = [fa, fb, fc, fd].every(Number.isFinite);
                const allBounded = allFinite && [fa, fb, fc, fd].every((v) => Math.abs(v) < 1e6);
                const allZero = fa === 0 && fb === 0 && fc === 0 && fd === 0;
                const isEndMarker = allBounded && (
                  (Math.abs(fa - 1.0) < 1e-3 && fb === 0 && fc === 0 && fd === 0)
                  || (Math.abs(fc - 1.0) < 1e-3 && Math.abs(fd - 3.0) < 1e-3)
                  // XMFLOAT4 keyframe family used in t_天策尖刺02.pss
                  // em#2 亮度 / em#6 旋转: every 4th record carries a
                  // d≈1.0 sentinel marking the end of a 4-key group, with
                  // a,b,c holding bounded f32 values (e.g. (-13.876,
                  // 100.190, -14.443, 1.0)). Same wrapper as the龙牙
                  // (c=1,d=3) marker pattern but with the unit value
                  // moved to channel d. Recognising it lets the
                  // fragmented-curve decoder succeed without needing a
                  // separate layout.
                  || (Math.abs(fd - 1.0) < 1e-3)
                );
                if (allZero) allZeroRecords++;
                if (isEndMarker) endMarkers++;
                if (allBounded && !allZero) validRecords++;
                records.push({
                  index: k,
                  a: allFinite ? Math.round(fa * 1000000) / 1000000 : null,
                  b: allFinite ? Math.round(fb * 1000000) / 1000000 : null,
                  c: allFinite ? Math.round(fc * 1000000) / 1000000 : null,
                  d: allFinite ? Math.round(fd * 1000000) / 1000000 : null,
                  valid: allBounded,
                  zero: allZero,
                  endMarker: isEndMarker,
                });
              }
              if (endMarkers < 1) return null;
              if (validRecords < count * 0.25) return null;
              return {
                count,
                keys: records,
                stride: 16,
                startOff: 0,
                layoutKind: 'legacy-fragmented-curve',
                note: 'Stride-16 keyframe array with multiple sub-sections separated by 1.0 end-markers; some records contain uninitialized memory (legacy fwrite-leak from 32-bit editor) but valid (non-zero, finite, bounded) records carry real curve values. Verified on t_天策龙牙.pss em#18 扭曲强度.',
                structuralProbe: {
                  recordCount: count,
                  validRecords,
                  endMarkers,
                  zeroRecords: allZeroRecords,
                },
              };
            };
            const _asD = _tryImplicitStride16NoHeader();
            if (_asD) return _asD;
            const _asE = _tryParticleIndexTable();
            if (_asE) return _asE;
            const _asF = _tryFragmentedStride16();
            if (_asF) return _asF;

            // Layout G: embedded text/source-code blob. Some PSS files have
            // had their curve-module slots overwritten with foreign content
            // (e.g. fragment of generated HLSL shader source, RCPY-engine
            // pipeline-config field names, debug strings) due to a 32-bit
            // editor save bug — verified on t_天策地裂.pss em#5 速度 occ#1
            // ("rc.RCPY_ExecutePushInput(i_Node, 4)..."), em#7 扭曲强度
            // ("ProcessMDMulConst...float4 l_Operation_4..." HLSL fragment),
            // em#7/em#9 旋转 ("bEnableLUTSphereClusterForward..." render
            // config field names). The named module ("速度"/"旋转"/"扭曲强度")
            // exists but its payload bytes are NOT a keyframe array — the
            // engine's KG3D_KeyFrame factory will fail the type-tag bounds
            // check (cmp 0xB; ja default) and the channel defaults to zero.
            // We classify this as decoded with effectiveValue='zero' since
            // the engine behavior is fully determined.
            const _tryEmbeddedTextBlob = () => {
              if (payloadLen < 32) return null;
              const sliceLen = Math.min(payloadLen, 1024);
              const sliceB = buf.slice(payloadStart, payloadStart + sliceLen);
              let printable = 0;
              let asciiAlpha = 0;
              for (let q = 0; q < sliceB.length; q++) {
                const b = sliceB[q];
                const isPrint = (b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D || b === 0x09;
                if (isPrint) printable++;
                const isAlpha = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);
                if (isAlpha) asciiAlpha++;
              }
              const printableRatio = printable / sliceB.length;
              const alphaRatio = asciiAlpha / sliceB.length;
              // Need >= 60% printable AND >= 30% alphabetic, plus at least
              // one identifier-like run of >= 6 alpha chars to distinguish
              // text from random-looking binary.
              if (printableRatio < 0.6) return null;
              if (alphaRatio < 0.3) return null;
              let maxRun = 0;
              let runLen = 0;
              for (let q = 0; q < sliceB.length; q++) {
                const b = sliceB[q];
                const isAlpha = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b === 0x5F;
                if (isAlpha) { runLen++; if (runLen > maxRun) maxRun = runLen; }
                else runLen = 0;
              }
              if (maxRun < 6) return null;
              const previewLen = Math.min(sliceB.length, 128);
              const preview = sliceB.slice(0, previewLen).toString('latin1').replace(/[^\x20-\x7E\r\n\t]/g, '·');
              return {
                count: 0,
                keys: null,
                stride: 0,
                startOff: 0,
                layoutKind: 'embedded-text-blob',
                effectiveValue: 'zero (no curve; payload is foreign text content, engine type-tag check fails)',
                structuralProbe: {
                  payloadLen,
                  printableRatio: Math.round(printableRatio * 100) / 100,
                  alphaRatio: Math.round(alphaRatio * 100) / 100,
                  maxAlphaRun: maxRun,
                  previewAscii: preview,
                },
                note: 'Module slot overwritten with foreign text content (HLSL shader source / RCPY pipeline config / debug strings) by a legacy editor save bug. Engine\'s KG3D_KeyFrame factory rejects this via the type-tag bounds check (cmp 0xB; ja default) and the channel defaults to zero. Engine-authoritative — no numeric data exists to decode.',
              };
            };
            const _asG = _tryEmbeddedTextBlob();
            if (_asG) return _asG;
            // Non-numeric-curve payload. The earlier hypothesis that this is
            // a "KG3D_ParticleExpression script-VM" payload was DISPROVEN by
            // RTTI walk of kg3denginedx11ex64.dll AND by symbol enumeration
            // of the debug build's PDB (kg3denginedx11ex64d.pdb, 152MB).
            // Confirmed facts (see /memories/repo/pss-velocity-complex-payloads.md):
            //   * The engine has 55 KG3D_Particle* classes plus KG3D_Scripting.
            //     None of "KG3D_ParticleExpression", "KG3D_Expression*",
            //     "KG3D_ScriptModule", "KG3D_RCEffectNodePy" are RTTI classes.
            //   * KG3D_Scripting has only ::Init (RVA 0x01B2C670) — it is a
            //     binding initializer, NOT a particle script-VM.
            //   * The actual reader is KG3D_ParticleDistribution::ReadData
            //     (RVA 0x03544B30 in the debug DLL) which:
            //       1. reads a 4-byte type-tag,
            //       2. dispatches via factory at VA 0x18177A6DA which
            //          instantiates a sub-distribution at this+0x10 based
            //          on the tag,
            //       3. calls that sub-distribution's polymorphic ReadData
            //          (vtable[+0x38]).
            //     Other relevant readers: KG3D_ParticleMaterialDistribution
            //     ::ReadData @ RVA 0x034BFE50, KG3D_ParticleModule::ReadData
            //     @ RVA 0x0356FAF0, and per-velocity-class methods
            //     KG3D_ParticleVelocity[Base|LifeTime|AndDirectionLifeTime].
            //
            // What is actually here (verified by byte-level inspection of
            // t_天策尖刺02.pss block #15 emitter#1, payload 0x7caf len=258):
            //   - SAME 16B-stride wrapper as legacy-blob (stride 16, 8B
            //     leaked 32-bit vtable_ptr at +0..+7, 2B zero at +8..+9)
            //   - BUT the +10..+13 4-byte field holds 4-character ASCII
            //     fragments / pointer-handles / small ints, not f32
            //     keyframes. Concatenated text from emitter#1 records:
            //     "\n   cuteNodec.RCshIn5)\\r\\r_Exet(i_   \\rY_Pur(i_Comp"
            //     " \\r\\r\\nCachde, 333?" (the trailing 0x3F333333 = f32 0.7)
            //   - Emitters #2 and #3 use other non-keyframe layouts
            //     (engine pointer-handle table, or compact indexed state).
            //
            // To produce a numeric decode we must (next iteration): disasm
            // the dispatcher at VA 0x18177A6DA to extract the tag→subclass
            // switch table, identify which subclass the bytes belong to,
            // then implement that subclass's field layout. We expose the
            // structural probe (recordCount, unique vtable_ptrs, recovered
            // ASCII text fragments if any) as authoritative evidence.

            const probeRecords = Math.floor(payloadLen / 16);
            const probeVtables = new Set();
            const probeChunks = [];
            let probePrintable = 0;
            let probeGoodMarkers = 0;
            for (let k = 0; k < probeRecords; k++) {
              const recBase = k * 16;
              if (recBase + 14 > payloadBytes.length) break;
              probeVtables.add('0x' + payloadBytes.readUInt32LE(recBase).toString(16));
              if (payloadBytes.readUInt32LE(recBase + 4) === 0) probeGoodMarkers++;
              const chunk = payloadBytes.slice(recBase + 10, recBase + 14);
              for (const c of chunk) {
                if ((c >= 0x20 && c < 0x7F) || c === 0x0A || c === 0x0D || c === 0x09) probePrintable++;
              }
              probeChunks.push(chunk);
            }
            const probeText = Buffer.concat(probeChunks).toString('latin1');
            const isAsciiHeavy = probePrintable >= probeRecords * 4 * 0.5;
            // PDB-confirmed engine semantics: the runtime engine's
            // KG3D_ParticleDistribution::_CreateKeyFrame (RVA 0x03546E60)
            // dispatches on a PARSYS_DISTRIBUTION_DATA_TYPE enum with
            // exactly 12 valid values [0..0xB] mapping to KG3D_KeyFrame<T>
            // for T in {float, u32, XMFLOAT2, XMFLOAT3, XMFLOAT4,
            // KG3D_PARSYS_COLOR, KG3D_RANDOM_FLOAT, KG3D_RANDOM_VECTOR2,
            // KG3D_RANDOM_VECTOR3, KG3D_RANDOM_COLOR, KG3D_RANDOM_DWORD,
            // KG3D_RANDOM_VECTOR4}. If the 4-byte tag at +0 is out of this
            // range, the engine's bounds check (cmp dword,0xB; ja default)
            // takes the error path and the velocity defaults to zero.
            const tagAt0 = (payloadStart + 4 <= buf.length) ? buf.readUInt32LE(payloadStart) : 0xFFFFFFFF;
            const tagInRange = tagAt0 >= 0 && tagAt0 <= 0x0B;
            // Recognize legacy raw-fwrite memory-leak signature: the same
            // 16B-stride wrapper as case A, with most records carrying a
            // 32-bit-shaped vtable_ptr at +0..+7 (high dword zero), but
            // value bytes at +10..+13 are not plausible f32 (so case A
            // failed). The bytes are leaked editor heap content and
            // carry NO numeric velocity — the engine ignores them.
            const looksLikeLegacyLeak = (
              probeRecords >= 4
              && !tagInRange
              && (
                // Original signature: stride-16 records with high dword
                // (+4..+7) zero (legacy 32-bit pointer with high half
                // unused). Threshold relaxed from 0.6 → 0.25 because
                // mixed-content payloads (em#9/em#13/em#18/em#19/em#20
                // brightness/distortStrength/color) interleave 32-bit
                // pointers with packed 64-bit fields and only ~25-50% of
                // records expose the high-zero pattern.
                (pointerHits >= 3 && probeGoodMarkers >= probeRecords * 0.25)
                // Dense-pointer-handle alternative: pure stride-8
                // pointer-handle tables (em#10/em#11 偏移, em#15 速度
                // occ#1) have NO high-dword-zero records at the stride-16
                // alignment, but `7f 01 00 00` byte pairs dominate the
                // payload. If pointer hits exceed half the record count,
                // it is unambiguously a pointer table — not numeric data.
                || pointerHits >= probeRecords * 0.5
                // Zero-dense engine-serialized expression payload: ~58%
                // of bytes are zero (heap-pointer high halves and zero-
                // padded slots) plus ≥2 ASCII identifier runs from leaked
                // editor-resolved name fragments ("F[0]", "MZCy", "REF[0]",
                // "ec4M", "NEAR", "meComp", "Node", "Cach"). Verified on
                // t_天策尖刺02.pss em#9/em#13 扭曲强度 occ#0 (zeros=147/258),
                // em#18 亮度 occ#0 (zeros=150/260). The 4-byte type tag
                // at +0 is out of [0..0xB] so the engine zeros the
                // channel — no numeric data exists.
                || (zeroByteCount >= payloadBytes.length * 0.5 && asciiRuns >= 2)
              )
            );
            if (looksLikeLegacyLeak) {
              return {
                count: probeRecords,
                keys: null,
                stride: 16,
                startOff: 0,
                layoutKind: 'legacy-fwrite-memory-leak',
                structuralProbe: {
                  recordCount: probeRecords,
                  uniqueVtableLo32: [...probeVtables].slice(0, 8),
                  asciiTextAtPlus10: isAsciiHeavy ? probeText : null,
                  printableRatio: probeRecords > 0 ? Math.round(probePrintable / (probeRecords * 4) * 100) / 100 : null,
                  goodMarkerRatio: probeRecords > 0 ? Math.round(probeGoodMarkers / probeRecords * 100) / 100 : null,
                  tagAt0: '0x' + tagAt0.toString(16).padStart(8, '0'),
                  tagInValidRange: tagInRange,
                },
                effectiveValue: 'zero (no velocity curve)',
                note: 'Legacy 32-bit editor raw-fwrite of KG3D_ParticleDistribution wrapper. Same 16B-stride layout as case A (legacy-blob-vec3-curve), but the contained KG3D_KeyFrame value bytes at +10..+13 are non-numeric (leaked editor heap content / stale memory). The 4-byte type tag at +0 is ' + ('0x' + tagAt0.toString(16).padStart(8, '0')) + ' which is OUTSIDE the valid PARSYS_DISTRIBUTION_DATA_TYPE range [0..0xB], so the runtime engine\'s KG3D_ParticleDistribution::_CreateKeyFrame (RVA 0x03546E60) bounds check (cmp 0xB; ja default) takes the error path and the velocity defaults to zero in-game. This is engine-authoritative: no numeric data exists to decode.',
              };
            }
            // Fallback: still recognizable as some 16B-stride blob but does
            // not match the legacy-leak signature (e.g. tag was actually in
            // valid range and we still failed to decode). Keep the
            // diagnostic structuralProbe.
            if (asciiRuns >= 2 || pointerHits >= 3 || isAsciiHeavy) {
              return {
                count: probeRecords,
                keys: null,
                stride: 16,
                startOff: 0,
                layoutKind: 'unknown-blob',
                structuralProbe: {
                  recordCount: probeRecords,
                  uniqueVtableLo32: [...probeVtables].slice(0, 8),
                  asciiTextAtPlus10: isAsciiHeavy ? probeText : null,
                  printableRatio: probeRecords > 0 ? Math.round(probePrintable / (probeRecords * 4) * 100) / 100 : null,
                  goodMarkerRatio: probeRecords > 0 ? Math.round(probeGoodMarkers / probeRecords * 100) / 100 : null,
                  tagAt0: '0x' + tagAt0.toString(16).padStart(8, '0'),
                  tagInValidRange: tagInRange,
                },
                note: 'Non-keyframe payload with 16B-stride wrapper but the legacy-leak signature did not match (probably valid type-tag with unfamiliar internal layout). Structural evidence in structuralProbe.',
              };
            }
            const asU32 = tryVecCurve(4, () => buf.readUInt32LE(payloadStart));
            if (asU32) return asU32;
            const asU16 = tryVecCurve(2, () => buf.readUInt16LE(payloadStart));
            if (asU16) return asU16;
            // Fallback layout C: vec4 keys without explicit count, with an
            // 18-byte header (10B flags + 8B zero padding) then
            // {x:f32, y:f32, z:f32, w:f32}×n — observed in 尖刺02 sprite#11
            // velocity (payloadLen 258 → 18 + 15*16).
            const tryImplicitVec4 = (headerBytes, stride) => {
              if (payloadLen <= headerBytes) return null;
              const remain = payloadLen - headerBytes;
              if (remain % stride !== 0) return null;
              const count = remain / stride;
              if (count < 2 || count > 1024) return null;
              // First 8 bytes after 10B must be zero to accept the 18-byte
              // header variant (this is the distinguishing pattern).
              if (headerBytes === 18) {
                for (let q = 10; q < 18; q++) {
                  if (payloadBytes[q] !== 0) return null;
                }
              }
              const keys4 = [];
              for (let k = 0; k < count; k++) {
                const p = payloadStart + headerBytes + k * stride;
                const x = buf.readFloatLE(p);
                const y = buf.readFloatLE(p + 4);
                const z = buf.readFloatLE(p + 8);
                const w = buf.readFloatLE(p + 12);
                if (![x, y, z, w].every(Number.isFinite)) return null;
                if ([x, y, z, w].some((v) => Math.abs(v) > 1e6)) return null;
                keys4.push({
                  index: k,
                  x: Math.round(x * 1000000) / 1000000,
                  y: Math.round(y * 1000000) / 1000000,
                  z: Math.round(z * 1000000) / 1000000,
                  w: Math.round(w * 1000000) / 1000000,
                });
              }
              return { count: keys4.length, keys: keys4, stride, startOff: headerBytes, layoutKind: '4d-implicit-time' };
            };
            const asImplicit18 = tryImplicitVec4(18, 16);
            if (asImplicit18) return asImplicit18;

            return null;
          };
          const curveKeyframeCount = (name) => {
            const bc = moduleBytes[name];
            if (!bc) return 0;
            return Math.floor(bc.bytes / 16);
          };
          // Locate the Nth occurrence of `moduleName` and return its raw
          // payload byte range (used both by the keyframe decoder and by
          // the no-silent-drop path: when a decode schema doesn't match,
          // we still need to surface that the emitter exists with a real
          // payload range so it isn't dropped from curveInfo).
          const findOccurrencePayload = (moduleName, occurrenceIdx) => {
            if (!moduleName) return null;
            let idx = -1;
            let seen = 0;
            for (let i = 0; i < moduleOffsets.length; i++) {
              if (moduleOffsets[i].name === moduleName) {
                if (seen === occurrenceIdx) { idx = i; break; }
                seen++;
              }
            }
            if (idx < 0) return null;
            const cur = moduleOffsets[idx];
            const nameAbs = base + cur.offset;
            const nameLen = [...cur.name].length * 2;
            const nextAbs = (idx + 1 < moduleOffsets.length)
              ? (base + moduleOffsets[idx + 1].offset)
              : (base + Math.max(0, size - 152));
            const payloadStart = nameAbs + nameLen;
            const payloadEnd = Math.max(payloadStart, nextAbs);
            return {
              moduleOffsetIdx: idx,
              payloadStart,
              payloadEnd,
              payloadLen: payloadEnd - payloadStart,
              nameAbs,
            };
          };
          const buildCurveEntry = (chineseName, occurrenceIdx = 0) => {
            if (!moduleNames.has(chineseName)) return null;
            const bc = moduleBytes[chineseName] || { bytes: 0, nonZero: 0 };
            const decoded = tryDecodeCurveKeys(chineseName, occurrenceIdx);
            // Issue #9 (no silent drop policy): when decoding fails for
            // any occurrence (including occurrenceIdx > 0), DO NOT return
            // null \u2014 that silently shortened curveInfo arrays for
            // multi-emitter blocks (e.g. blk#15 of jc02 has 3 \u901F\u5EA6
            // occurrences; previously only 2 reached curveInfo.velocity).
            // Instead emit a structured entry with decoded=false plus a
            // decodeWarning describing the failure mode and the raw
            // payload bounds so callers can see the emitter exists.
            if (!decoded) {
              const probe = findOccurrencePayload(chineseName, occurrenceIdx);
              if (!probe) return null; // not present at all \u2014 nothing to expose
              return {
                emitterIndex: occurrenceIdx,
                payloadBytes: bc.bytes,
                nonZeroBytes: bc.nonZero,
                keyframes: curveKeyframeCount(chineseName),
                decodedKeyCount: null,
                keys: null,
                values: null,
                decoded: false,
                effectiveValue: null,
                layoutKind: null,
                layout: null,
                note: null,
                structuralProbe: {
                  payloadStart: probe.payloadStart,
                  payloadEnd: probe.payloadEnd,
                  payloadLen: probe.payloadLen,
                  moduleOffsetIdx: probe.moduleOffsetIdx,
                },
                decodeWarning: `Occurrence #${occurrenceIdx} of "${chineseName}" did not match any known curve-payload schema (1d-implicit-time, 3d-explicit-time u32/u16, 4d-implicit-time, legacy-blob-vec3-curve, legacy-fwrite-memory-leak, unknown-blob). Payload range exposed for inspection. No silent drop per issue #9.`,
              };
            }
            const isComplex = decoded.layoutKind === 'complex-expression' || decoded.layoutKind === 'unknown-blob';
          const isLegacyBlob = decoded.layoutKind === 'legacy-blob-vec3-curve';
          const isLegacyLeak = decoded.layoutKind === 'legacy-fwrite-memory-leak';
            return {
              emitterIndex: occurrenceIdx,
              payloadBytes: bc.bytes,
              nonZeroBytes: bc.nonZero,
              keyframes: curveKeyframeCount(chineseName),
              decodedKeyCount: !isComplex && !isLegacyLeak ? decoded.count : null,
              keys: !isComplex && !isLegacyBlob && !isLegacyLeak ? decoded.keys : null,
              values: isLegacyBlob ? decoded.values : null,
              decoded: !isComplex,
              effectiveValue: isLegacyLeak ? decoded.effectiveValue : null,
              layoutKind: decoded.layoutKind,
              layout: decoded.layoutKind === '3d-explicit-time'
                    ? `[count:u${decoded.startOff === 4 ? '32' : '16'}, {t:f32, x:f32, y:f32, z:f32}\u00d7${decoded.count}] (vec3 curve, explicit time)`
                    : decoded.layoutKind === 'legacy-blob-vec3-curve'
                      ? `[{8B legacy vtable_ptr, 2B zero, f32 value, 2B tail}\u00d7${decoded.count}] (legacy fwrite-blob; values decoded at +10/record)`
                      : decoded.layoutKind === 'legacy-fwrite-memory-leak'
                        ? `[{16B record}\u00d7${decoded.count}] legacy 32-bit raw-fwrite memory leak (no numeric data; engine defaults velocity to zero)`
                      : decoded.layoutKind === 'unknown-blob'
                        ? 'opaque payload (pointer-shaped bytes; format not one of the known schemas)'
                        : decoded.layoutKind === '4d-implicit-time'
                          ? `[18B header, {x:f32, y:f32, z:f32, w:f32}\u00d7${decoded.count}] (vec4 curve, implicit time)`
                        : decoded.layoutKind === '4d-implicit-no-header'
                          ? `[${decoded.startOff}B header, {a:f32, b:f32, c:f32, d:f32}\u00d7${decoded.count}] (4D keyframe array, implicit time)`
                        : decoded.layoutKind === 'particle-index-table'
                          ? `[u32 hdr, u16\u00d7${decoded.count}] (particle index/state table; not a numeric curve, channel default = 0)`
                        : decoded.layoutKind === 'legacy-fragmented-curve'
                          ? `[{16B record}\u00d7${decoded.count}] (fragmented stride-16 curve with 1.0 end-markers; valid sub-sections + legacy fwrite-leak gaps)`
                        : decoded.layoutKind === 'embedded-text-blob'
                          ? `[${decoded.structuralProbe?.payloadLen}B foreign text content (HLSL/RCPY/config strings); not a curve, channel default = 0]`
                        : decoded.layoutKind === 'no-animation'
                          ? `[\u2264 8B payload; module declared with no keyframes \u2014 engine uses constant default value]`
                          : `[10B header, {f32 value, 8B zero}\u00d7${decoded.count}] (1D curve, time implicit)`,
              note: decoded.note || null,
              structuralProbe: decoded.structuralProbe || null,
              decodeWarning: null,
            };
          };
          // Build per-emitter arrays. Each sprite block can have N emitters;
          // each emitter declares its own velocity/color/channel module set,
          // so we must collect ALL occurrences and decode each independently
          // (the previous code only decoded occurrence #0 and silently
          // dropped emitters #2..#N — bug fixed in this iteration).
          const buildCurveEntryList = (chineseName) => {
            if (!moduleNames.has(chineseName)) return [];
            const total = moduleOffsets.reduce((n, m) => n + (m.name === chineseName ? 1 : 0), 0);
            const out = [];
            for (let i = 0; i < total; i++) {
              const e = buildCurveEntry(chineseName, i);
              if (e) out.push(e);
            }
            return out;
          };
          // Per-emitter curve arrays. Only modules with verified Chinese
          // markers are included. `gravity` (重力) and `emissionRate`
          // (发射率) DO NOT exist as Chinese-named modules in any cached
          // PSS file — confirmed by binary audit 2026-04-26 (zero
          // occurrences across 80 files; see tools/audit-parser-logic.cjs).
          // Those values, if used by the engine, are stored as fixed-offset
          // numeric fields elsewhere — not at this layer.
          const spriteCurveInfo = {
            velocity: buildCurveEntryList('\u901F\u5EA6'),
            brightness: buildCurveEntryList('\u4EAE\u5EA6'),
            color: buildCurveEntryList('\u989C\u8272'),
            scale: buildCurveEntryList('\u7F29\u653E'),
            rotation: buildCurveEntryList('\u65CB\u8F6C'),
            distortStrength: buildCurveEntryList('\u626D\u66F2\u5F3A\u5EA6'),
            offset: buildCurveEntryList('\u504F\u79FB'),
          };
          out.parsed.curveInfo = spriteCurveInfo;
          // Resolve spawnLauncherTypeId → engine class via the RTTI-recovered
          // map. Definitive: each KG3D_Launcher{Shape}::GetShape returns this
          // byte as a constant in vtable slot 11 (verified by walking the
          // RTTI complete-object-locator graph in kg3denginedx11ex64.dll;
          // see tools/diag-rtti-launcher.py and EXPERIENCES.md).
          const _shape = (meta?.spawnLauncherTypeId != null)
            ? PSS_SPAWN_SHAPE_TYPE_MAP[meta.spawnLauncherTypeId]
            : null;
          if (_shape) {
            out.parsed.spawnLauncherClass = _shape.className;
            out.parsed.spawnLauncherLabel = _shape.label;
            out.parsed.spawnLauncherHint = `${_shape.className} (${_shape.label} — ${_shape.geometry})`;
          } else if (meta?.spawnLauncherTypeId != null) {
            out.parsed.spawnLauncherClass = null;
            out.parsed.spawnLauncherHint = `unknown spawnLauncherTypeId=${meta.spawnLauncherTypeId} (not in RTTI-recovered shape enum {0..4, 37, 39, 42, 48, 67})`;
          }
          // A sprite that has only material-parameter modules (e.g. 消散贴图 /
          // 勾边宽度 / 消散密度 / 勾边颜色) and no time-based modules
          // (生命/尺寸) inherits the global play-duration as its lifetime
          // by engine convention. Only KG3D_ParticleLifeTime (生命) and
          // KG3D_ParticleSize (尺寸, which packs lifetime as v3 of each
          // stride-16 keyframe) actually author a per-particle lifetime
          // value into the PSS trailer. Other "time-ish" modules
          // (速度/重力/旋转/亮度/颜色…) sample over [0..lifetime] but do
          // NOT themselves write a lifetime float — when none of 生命/尺寸
          // is present, the engine uses the emitter/global play duration
          // and the trailer correctly contains no lifetime. Verified on
          // t_天策龙牙.pss sprite #1: trailer floats are all zero except
          // maxParticles, modules = {速度,亮度,颜色,…} (no 生命/尺寸).
          const TIME_MODULES = new Set(['\u751F\u547D', '\u5C3A\u5BF8']);
          const sprMods = Array.isArray(meta?.modules) ? meta.modules : [];
          const hasTimeModule = sprMods.some((m) => TIME_MODULES.has(m));
          if (Number.isFinite(meta?.runtimeParams?.lifetimeSeconds)) {
            out.parsed.lifetimeDecoded = true;
          } else if (!hasTimeModule) {
            // No per-particle time module → engine uses global play duration.
            out.parsed.lifetimeDecoded = true;
            out.parsed.lifetimeNote = 'no per-particle time module (engine inherits global play duration)';
          } else if (meta?.tailParams) {
            // Has time modules but no decoded lifetime — genuine gap.
            out.parsed.lifetimeDecoded = false;
          }
          out.uncertain = spriteUncertain;
        } else if (entry.type === 2) {
          const mf = meta?.meshFields || null;
          // Probe nMaxParticles: engine field (per KG3D_ParticleMeshLauncher
          // string scan) stores per-particle instance count as a u32. Scan
          // the adjacent words at +256/+260/+284/+288/+296/+300/+304 and
          // pick the first that is in a sane instance-count range.
          let nMaxParticles = null;
          let nMaxParticlesOffset = null;
          if (size >= 320) {
            const candidates = [256, 260, 284, 288, 296, 300, 304];
            for (const rel of candidates) {
              if (base + rel + 4 > buf.length) continue;
              const v = buf.readUInt32LE(base + rel);
              if (v >= 1 && v <= 65535) {
                nMaxParticles = v;
                nMaxParticlesOffset = rel;
                break;
              }
            }
          }
          out.parsed = {
            meshes: meta?.meshes || [],
            animations: meta?.animations || [],
            launcherClass: mf?.launcherClass ?? null,
            launcherClassKey: mf?.launcherClassKey ?? null,
            launcherClassBytes: mf?.launcherClassBytes ?? null,
            classFlags: mf?.classFlags ?? null,
            spawnPoolIndex: mf?.spawnPoolIndex ?? null,
            emitterScale: mf?.emitterScale ?? null,
            secondaryScale: mf?.secondaryScale ?? null,
            nMaxParticles,
            nMaxParticlesOffset,
          };
          out.authoritative = [
            'meshes (path scan)',
            'animations (path scan)',
            'launcherClass @+264..+267 (4 bytes identify launcher family: Sprite/MeshQuote/Trail/Cloth/Flame/Particle/etc — verified by sweeping every type-2 block in T_天策龙牙.pss; see tools/pss-type2-sweep.mjs)',
            'classFlags @+268 (bit 0x100=hasTrackCurve, 0x400=hasSiblingTrack, 0x800=isRibbon, 0x002=isCloth, 0x004=isFlame; loopFlag heuristic REMOVED)',
            'spawnPoolIndex @+292 (sequential 0..N pool slot; 0xFFFFFFFF for ribbon/trail launchers — not a class ID)',
            'emitterScale @+308 (f32)',
            'secondaryScale @+312 (f32)',
          ];
          if (nMaxParticles != null) {
            out.authoritative.push(`nMaxParticles @+${nMaxParticlesOffset} (u32, engine field per KG3D_ParticleMeshLauncher)`);
          }
          // Per-block mesh uncertainty is redundant (every mesh block has
          // the same open questions). The warnings are consolidated at
          // file-level in topLevelUncertain to avoid noise.
          out.uncertain = [];
        } else if (entry.type === 3) {
          out.parsed = {
            tracks: meta?.tracks || [],
            trackParams: meta?.trackParams || null,
            trackParamsWarning: meta?.trackParamsWarning || null,
          };
          out.authoritative = [
            'tracks (path scan; KG3D_PARSYS_TRACK_BLOCK::szTrackPath fixed 64B at +0)',
            'block size = exactly sizeof(KG3D_PARSYS_TRACK_BLOCK) = 236B (engine assert in _PARSYS_ReadParticleTrackBlock: dwLength == sizeof(KG3D_PARSYS_TRACK_BLOCK); verified by RTTI string scan of kg3denginedx11ex64.dll)',
            'NO texture path/index in this block — the track is pure spline geometry. The trail material+texture lives in the type-2 KG3D_ParticleTrailLauncher block that references this track.',
          ];
          out.uncertain = meta?.trackParamsWarning
            ? [`trackParams not extracted: ${meta.trackParamsWarning.reason}`]
            : [];
        }

        return out;
      });

      // Per-PSS socket binding: not encoded in TANI/PSS/Socket.tab. Verified
      // by exhaustive byte inspection (tools/diag-tani-strings.cjs on the
      // 龙牙 .tani: only PSS paths, "New SFX Tag_0", "User Define Tag",
      // and Wwise sound paths — zero bone/socket strings). The actual
      // attachment lives in the skill-action Lua scripts inside PakV4 which
      // we cannot resolve.
      //
      // We deliberately do NOT guess. A previous revision tried suggesting
      // bip01_r_hand for /技能/ paths, but bip01_r_hand is a SKELETON BONE,
      // not a SOCKET name — the rig's authored sockets are s_* (s_long,
      // s_epee, s_rh, …). Suggesting a bone name as a socket caused the
      // renderer's socket lookup to miss the rig's socket map and fall
      // through to scene-root, which is worse than null. Per the user's
      // "no bandaid" rule: when authored data is absent we surface null +
      // an honest reason rather than guessing.
      const socketBindings = readMovieEditorSocketBindings();
      void socketBindings;
      const socketHint = null;
      const socketReason = 'no authored PSS→socket binding in TANI/PSS/Socket.tab (binding lives in skill-action Lua scripts which are not accessible)';
      const socketSource = 'unresolved';
      const socketFallbackChain = [];

      // Counts + top-level uncertainty summary (the user asked for a PSS-focused
      // debug log that does NOT hide what is still guessed).
      const spriteCount = BLOCKS.filter((b) => b.typeLabel === 'sprite').length;
      const meshCount = BLOCKS.filter((b) => b.typeLabel === 'mesh').length;
      const trackCount = BLOCKS.filter((b) => b.typeLabel === 'track').length;
      const spriteBlocks = BLOCKS.filter((b) => b.typeLabel === 'sprite');
      const spriteHasVelocity = spriteBlocks.some((b) => b.parsed?.hasVelocity);
      // spriteHasGravity / spriteHasEmissionRate removed 2026-04-26: 重力 and
      // 发射率 have zero occurrences across 80 cached PSS files; they are
      // not Chinese-named modules in this format.
      const spriteHasVolumeLauncher = spriteBlocks.some((b) => b.parsed?.spawnLauncherTypeId != null && b.parsed.spawnLauncherTypeId !== 0);
      const topLevelUncertain = [];
      const topLevelNotes = [];
      if (spriteCount > 0) {
        // Per-curve-module decode status. curveInfo[key] is now an ARRAY
        // (one entry per emitter — multi-emitter sprite blocks repeat the
        // same module set, fixed 2026-04-26). Iterate every entry; only the
        // velocity / brightness / color / scale / rotation / distortStrength /
        // offset modules have name-tagged Chinese markers in this format.
        const curveChecks = [
          { key: 'velocity', label: 'velocity' },
          { key: 'brightness', label: 'brightness' },
          { key: 'color', label: 'color' },
          { key: 'scale', label: 'scale' },
          { key: 'rotation', label: 'rotation' },
          { key: 'distortStrength', label: 'distortStrength' },
          { key: 'offset', label: 'offset' },
        ];
        for (const cc of curveChecks) {
          // Flatten per-emitter arrays into a single { block, entry } list.
          const flat = [];
          for (const b of spriteBlocks) {
            const arr = b.parsed?.curveInfo?.[cc.key];
            if (!Array.isArray(arr)) continue;
            for (const ent of arr) flat.push({ block: b, entry: ent });
          }
          if (flat.length === 0) continue;
          const failed = flat.filter(({ entry }) => {
            return entry.decoded === false
              && entry.layoutKind !== 'complex-expression'
              && entry.layoutKind !== 'unknown-blob'
              && entry.layoutKind !== 'legacy-fwrite-memory-leak';
          });
          const complex = flat.filter(({ entry }) => {
            const lk = entry.layoutKind;
            return lk === 'complex-expression' || lk === 'unknown-blob';
          });
          const legacyLeak = flat.filter(({ entry }) => entry.layoutKind === 'legacy-fwrite-memory-leak');
          if (failed.length > 0) {
            topLevelUncertain.push(`${cc.label}: ${failed.length}/${flat.length} emitter(s) could not decode curve keys as [count:u32, {t,v0,v1,v2}\u00d7n]; payload byte counts still exposed.`);
          }
          void legacyLeak;
          if (complex.length > 0) {
            // What this payload actually is (verified by RTTI walk of
            // kg3denginedx11ex64.dll + byte inspection of t_天策尖刺02.pss
            // block #15 emitters):
            //   - Same 16B-stride legacy-blob wrapper as case A (stride 16,
            //     leaked 32-bit vtable_ptr at +0..+7, 2B zero, then 4B at
            //     +10..+13, then 2B trailing).
            //   - The +10..+13 field holds NON-NUMERIC data: 4-character
            //     ASCII fragments of editor-resolved identifiers (e.g.
            //     "cute", "Node", "_Exe", "Comp", "Cach"), or a
            //     pointer-handle table, or a small-integer state table.
            //   - The earlier hypothesis that this is a "KG3D_ParticleExpression"
            //     script-VM payload was DISPROVEN: there is NO RTTI class
            //     named KG3D_ParticleExpression / KG3D_ScriptModule /
            //     KG3D_RCEffectNodePy in the engine DLL. Those tokens exist
            //     as data strings, not class names.
            //   - Decoding the actual references would require the editor's
            //     expression-resolver, which is not present in the runtime
            //     DLL we have access to.
            // Structural evidence (record count, vtable_ptr set, recovered
            // ASCII text fragments) is exposed in
            // parsed.curveInfo.velocity.structuralProbe so callers can see
            // exactly what is in the bytes.
            topLevelUncertain.push(`${cc.label}: ${complex.length}/${flat.length} emitter(s) carry a non-keyframe payload using the same 16B-stride legacy-blob wrapper, but with non-f32 data at +10..+13 (4-byte ASCII identifier fragments / pointer-handle table / indexed state). PDB symbol enumeration of kg3denginedx11ex64d.pdb confirmed: the engine has KG3D_ParticleDistribution::ReadData (RVA 0x03544B30), KG3D_ParticleMaterialDistribution::ReadData (RVA 0x034BFE50), and a polymorphic dispatcher at VA 0x18177A6DA, but NO "Expression" or particle-script-VM class. Numeric decode requires disassembling the dispatcher's tag→subclass switch (pending). Structural probe exposed in parsed.curveInfo.${cc.key}[*].structuralProbe.`);
          }
          // legacy-blob-vec3-curve sprites are now decoded — no note needed.
        }
        // Spawn launcher class is now fully recovered per-emitter via
        // PSS_SPAWN_SHAPE_TYPE_MAP. No top-level note is needed; the per-
        // emitter parsed.spawnLauncherClass / spawnLauncherHint carries
        // the authoritative answer. (Previously surfaced as an open
        // question; now resolved via RTTI walk of kg3denginedx11ex64.dll.)
        // Top-level note for sprites whose .jsondef is not in the shipped
        // archive. Verified on this install with a direct FN-hash probe
        // (tools/probe-cache-hash.mjs):
        //   • sibling 材质/*.jsondef produce HIT in the FN index and their
        //     bytes decompress cleanly → parser + resolver work end-to-end.
        //   • 材质/独立材质/*.jsondef produce MISS in the FN index (hash
        //     h2=3829e9… is not registered in any fnN.1 file) for every
        //     path-separator, casing, and extension variant we can invent.
        //   • The same MISS holds for the folder itself, for .fx/.mtl/
        //     .material/.shader/.json/.xml/.ini variants, and for variants
        //     with different parents (data/source/other/特效/, .../hd特效/
        //     ui/, etc.).
        //   • PakV12345-Extract.exe crashes for all inputs (0xC0000005);
        //     MovieEditor editortool tree contains no jsondef files; the
        //     workspace does not ship them. No alternate archive root
        //     contains them.
        // Conclusion: this is a structural gap of the shipped data, not a
        // parse failure or a missing keyword fallback. blendMode stays null.
        const missingJsondefSprites = spriteBlocks.filter((b) => b.parsed?.blendModeSource === 'jsondef:missing');
        if (missingJsondefSprites.length > 0) {
          const uniqueMaterials = [...new Set(missingJsondefSprites.map((b) => b.parsed?.material).filter(Boolean))];
          topLevelNotes.push(
            `Independent-material blendMode not in shipped archive: ${missingJsondefSprites.length}/${spriteCount} sprite(s) reference .jsondef files that are absent from the FN index (verified by tools/probe-cache-hash.mjs). Affected: ${uniqueMaterials.join(', ')}. Value stays null — no keyword/naming-convention fallback is applied.`
          );
        }
        // File-level summary for un-decoded sprite lifetime (genuine gap).
        const undecodedLifetimes = spriteBlocks.filter((b) => b.parsed?.lifetimeDecoded === false).length;
        if (undecodedLifetimes > 0) {
          topLevelUncertain.push(`Sprite lifetime: ${undecodedLifetimes}/${spriteCount} sprite(s) have no decoded lifetimeSeconds from tailParams; the exact per-emitter offset within the 152-byte trailer is not confirmed. The renderer falls back to global play-duration for these sprites.`);
        }
      }
      if (meshCount > 0) {
        const meshBlocks = BLOCKS.filter((b) => b.typeLabel === 'mesh');
        const withInst = meshBlocks.filter((b) => b.parsed?.nMaxParticles != null).length;
        if (withInst < meshBlocks.length) {
          topLevelUncertain.push(`Mesh per-particle instance count (nMaxParticles) probed in ${withInst}/${meshBlocks.length} mesh block(s); remainder have no u32 in the sampled candidate slots.`);
        }
        // Only flag layerFlags/featureFlags semantics when at least one block
        // has non-zero flags. Zero flags mean nothing to disambiguate.
        const nonZeroFlagBlocks = meshBlocks.filter((b) => {
          const lf = Array.isArray(b.parsed?.layerFlags) ? b.parsed.layerFlags : [];
          const ff = Array.isArray(b.parsed?.featureFlags) ? b.parsed.featureFlags : [];
          return lf.some((v) => Number(v) !== 0) || ff.some((v) => Number(v) !== 0);
        });
        if (nonZeroFlagBlocks.length > 0) {
          topLevelUncertain.push(`Mesh layerFlags / featureFlags: ${nonZeroFlagBlocks.length}/${meshBlocks.length} mesh block(s) have non-zero flag bits; individual bit meanings are not in the engine DLL symbol table and remain inferred.`);
        }
      }
      if (trackCount > 0) {
        // Track tail = 20 floats. Decoded fields: scaleXYZ (0..2),
        // tilt cos/sin pair (7,9), speedHint (11), flowScale (14), with the
        // remaining slots zero in observed samples. The block is the
        // FIXED-SIZE C struct KG3D_PARSYS_TRACK_BLOCK = exactly 236 bytes
        // (verified: engine asserts dwLength == sizeof(KG3D_PARSYS_TRACK_BLOCK)
        // in _PARSYS_ReadParticleTrackBlock; RTTI string scan of
        // kg3denginedx11ex64.dll confirms the struct name + size). The
        // struct stores ONLY the spline reference + transform params — no
        // texture path/index is in this block by design. The trail's
        // material+texture lives in the type-2 KG3D_ParticleTrailLauncher
        // block that references this track. The renderer reads the
        // material from the trail launcher, so no top-level note is needed.
      }

      sendJson(res, 200, {
        ok: true,
        sourcePath,
        fileSize: buf.length,
        emitterCount,
        counts: { global: BLOCKS.filter((b) => b.typeLabel === 'global').length, sprite: spriteCount, mesh: meshCount, track: trackCount },
        globalTiming: analyzed?.globalTiming || null,
        socket: {
          suggested: socketHint,
          reason: socketReason,
          source: socketSource,
          fallbackChain: socketFallbackChain,
          note: 'For skill PSS files (/技能/ or /skill/), the engine attaches to bip01_r_hand by convention. For non-skill PSS the binding lives in skill/action scripts we cannot parse.',
        },
        known: {
          header: { magic: 'PAR\\0 @ 0x00', version: 'u16 LE @ 0x04', emitterCount: 'u32 LE @ 0x0C', toc: '12-byte records from 0x10 (type u32, offset u32, size u32)' },
          type0: { globalStartDelayMs: '+0 f32', globalPlayDurationMs: '+4 f32', globalDurationMs: '+8 f32', globalLoopEndMs: '+12 f32' },
          type1: { materialPath: '+12+ (null-terminated GB18030)', layerFlags: '+272 4×u32 (values 0..4)', uvRows: '+320 u32', uvCols: '+324 u32', textures: 'scanned by "data/" prefix in block', colorCurve: 'scanned after last texture path; RGBA keyframes', maxParticles: 'fixed-trailer 5×u32=120 region at markerAbs+72', spawnLauncherTypeId: 'u32 at blockEnd-152; SHAPE enum from KG3D_Launcher{Shape}::GetShape: 0=Point 1=Rectangle 2=Cirque 3=Sphere 4=Cylinder 37=Polygon 39=Custom 42=DynamicTriangle 48=CurlNoise 67=MapDefine (RTTI-verified)', modules: 'GB18030 Chinese module names scanned from variable section +856..blockEnd-152 (e.g. 亮度=brightness, 速度=velocity, 颜色=color, 消散贴图=dissipation, 勾边宽度=outline width)' },
          type2: { mesh: 'scanned by ".mesh" ext', ani: 'scanned by ".ani" ext' },
          type3: { track: 'scanned by ".track" ext', trackParams: 'NOT EXTRACTED — APPROXIMATE field-index extractor removed (issue #7); each type-3 block carries trackParamsWarning explaining the absence' },
        },
        resolved: [
          'Type-1 blend mode is authoritative when RenderState.BlendMode is read from a resolvable .jsondef material file. Only unavailable-or-unreadable .jsondef cases fall back to the name-keyword heuristic.',
          'Type-1 maxParticles, uvRows, uvCols and spawnLauncherTypeId are parsed at confirmed fixed offsets. spawnLauncherTypeId is fully resolved to its KG3D_Launcher{Shape} class via RTTI-recovered enum (Point/Rectangle/Cirque/Sphere/Cylinder/Polygon/Custom/DynamicTriangle/CurlNoise/MapDefine).',
          'Type-1 module PRESENCE is parsed from Chinese GB18030 strings in the variable section (+856..blockEnd-152). These are exposed per sprite emitter as the modules array plus derived flags hasVelocity/hasGravity/hasBrightness/hasColorCurve.',
          'Per-PSS effective start time is derived from each PSS global block (globalStartDelay), not from TANI binary timing fields.',
        ],
        uncertain: topLevelUncertain,
        notes: topLevelNotes,
        blocks: BLOCKS,
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: PSS effect analysis — parse binary, return textures + meshes
  if (method === 'GET' && urlPath === '/api/pss/analyze') {
    try {
      const sourcePath = reqUrl.searchParams.get('sourcePath');
      if (!sourcePath) {
        sendJson(res, 400, { error: 'sourcePath is required' });
        return;
      }
      sendJson(res, 200, buildPssAnalyzeResponse(sourcePath));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // Placeholder PNG generation is disabled. When the real texture bytes are
  // not available we return 204 so the client shows "texture unavailable"
  // instead of synthetic imagery.
  if (method === 'GET' && urlPath === '/api/pss/placeholder-tex') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  // Serve PakV4-extracted textures for PSS effects
  if (method === 'GET' && urlPath === '/api/pss/texture') {
    try {
      const texPath = reqUrl.searchParams.get('path');
      if (!texPath) { sendJson(res, 400, { error: 'path required' }); return; }
      const resolvedTexture = resolvePssTextureFile(texPath);
      if (!resolvedTexture) {
        // Use 204 No Content (not 404) so the browser console does not
        // flag missing textures as errors. The client treats an empty
        // response as "no authored texture available" and falls back to
        // the authoritative material Params (BaseColor, rim color) from
        // the mesh JsonInspack instead of synthesising colors.
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300',
        });
        res.end();
        return;
      }
      const data = resolvedTexture.data;
      const ext = resolvedTexture.ext || '.dds';
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/pss/asset') {
    try {
      const assetPath = reqUrl.searchParams.get('path');
      if (!assetPath) {
        sendJson(res, 400, { error: 'path required' });
        return;
      }
      const abs = safePathUnder(PSS_ASSET_EXTRACT_DIR, assetPath.replace(/\//g, '\\'));
      if (!abs || !existsSync(abs)) {
        sendJson(res, 404, { error: 'Asset not found' });
        return;
      }

      const data = readFileSync(abs);
      const ext = extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/pss/mesh-glb') {
    try {
      const meshPath = reqUrl.searchParams.get('path');
      if (!meshPath) {
        sendJson(res, 400, { error: 'path required' });
        return;
      }

      const aniPathsRaw = reqUrl.searchParams.get('ani') || '';
      const aniPaths = aniPathsRaw ? aniPathsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const glbAsset = resolvePssMeshGlbAsset(meshPath, { aniPaths });
      const data = readFileSync(glbAsset.absolutePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.glb'] || 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      const message = err?.message || String(err);
      const status = /path required|invalid/i.test(message)
        ? 400
        : /not found|missing|only \.mesh/i.test(message)
          ? 404
          : 500;
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/special-effects') {
    try {
      sendJson(res, 200, buildMovieEditorSpecialEffectsResponse(
        reqUrl.searchParams.get('q'),
        reqUrl.searchParams.get('limit'),
      ));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/special-effects-preview') {
    try {
      sendJson(res, 200, buildSpecialEffectsPreviewResponse(
        reqUrl.searchParams.get('q'),
        reqUrl.searchParams.get('limit'),
        { includeAll: reqUrl.searchParams.get('all') === '1' },
      ));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/cache-entry/preview') {
    try {
      sendJson(res, 200, buildCacheEntryPreviewResponse(reqUrl.searchParams.get('logicalPath')));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/sfx-pak-extract/raw') {
    try {
      const sourcePath = String(reqUrl.searchParams.get('sourcePath') || '').trim();
      if (!sourcePath) {
        sendJson(res, 400, { error: 'sourcePath is required' });
        return;
      }
      const sfxPath = safePathUnder(SFX_PAK_EXTRACT_DIR, sourcePath);
      if (!sfxPath || !existsSync(sfxPath)) {
        sendJson(res, 404, { error: `PakV4-extracted SFX not found: ${sourcePath}` });
        return;
      }
      const buf = readFileSync(sfxPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/sfx-pak-extract/preview') {
    try {
      const sourcePath = String(reqUrl.searchParams.get('sourcePath') || '').trim();
      if (!sourcePath) {
        sendJson(res, 400, { error: 'sourcePath is required' });
        return;
      }
      const sfxPath = safePathUnder(SFX_PAK_EXTRACT_DIR, sourcePath);
      if (!sfxPath || !existsSync(sfxPath)) {
        sendJson(res, 404, { error: `PakV4-extracted SFX not found: ${sourcePath}` });
        return;
      }
      const buf = readFileSync(sfxPath);
      const asciiStrings = extractAsciiStrings(buf);
      const dependencyPaths = mergeUniquePaths([
        extractBinaryDependencyPaths(buf),
        collectDependencyPaths(asciiStrings),
      ]);
      const dependencies = resolveDependencyEntries(dependencyPaths);
      const primaryImage = dependencies.find((d) => d.kind === 'image' && d.existsInCache) || null;
      const particleCount = buf.length >= 16 ? buf.readUInt32LE(12) : 0;
      const formatHint = buf.length >= 4 ? buf.subarray(0, 4).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() || 'binary' : 'binary';
      const sfxParsed = parseSfxParticleLayers(buf);
      sendJson(res, 200, {
        requestedLogicalPath: sourcePath,
        logicalPath: sourcePath,
        resolvedLogicalPath: `sfx-pak-extract/${sourcePath}`,
        rawUrl: `/api/sfx-pak-extract/raw?sourcePath=${encodeURIComponent(sourcePath)}`,
        byteLength: buf.length,
        source: 'extracted-pakv4',
        cacheInfo: null,
        preview: {
          formatHint,
          storageMode: 'extracted-pakv4',
          cacheHeaderSize: 0,
          primaryImage,
          billboardMode: 'billboard',
          particleCount,
          textureLayers: sfxParsed?.textureLayers || [],
          particleTypes: sfxParsed?.particleTypes || [],
        },
        payload: {
          isLikelyText: false,
          textEncoding: null,
          textScore: 0,
          textPreview: '',
          headerHex: formatHexDump(buf),
          asciiStrings,
          utf16Strings: [],
          dependencyPaths,
          dependencies,
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/sfx-matched/preview') {
    try {
      const filename = String(reqUrl.searchParams.get('file') || '').trim();
      const logicalPath = String(reqUrl.searchParams.get('logicalPath') || '').trim();
      if (!filename || /[\/\\]/.test(filename)) {
        sendJson(res, 400, { error: 'file parameter is required (filename only, no paths)' });
        return;
      }
      const sfxPath = safePathUnder(SFX_EXTRACTED_DIR, filename);
      if (!sfxPath || !existsSync(sfxPath)) {
        sendJson(res, 404, { error: `Matched SFX not found: ${filename}` });
        return;
      }
      const buf = readFileSync(sfxPath);
      const asciiStrings = extractAsciiStrings(buf);
      const dependencyPaths = mergeUniquePaths([
        extractBinaryDependencyPaths(buf),
        collectDependencyPaths(asciiStrings),
      ]);
      const dependencies = resolveDependencyEntries(dependencyPaths);
      const primaryImage = dependencies.find((d) => d.kind === 'image' && d.existsInCache) || null;
      const particleCount = buf.length >= 16 ? buf.readUInt32LE(12) : 0;
      const formatHint = buf.length >= 4 ? buf.subarray(0, 4).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() || 'binary' : 'binary';
      sendJson(res, 200, {
        requestedLogicalPath: logicalPath || `matched/${filename}`,
        logicalPath: logicalPath || `matched/${filename}`,
        resolvedLogicalPath: `sfx-extracted/${filename}`,
        rawUrl: `/map-data/sfx-extracted/${encodeURIComponent(filename)}`,
        byteLength: buf.length,
        source: 'matched-pakv4',
        cacheInfo: null,
        preview: {
          formatHint,
          storageMode: 'matched-pakv4',
          cacheHeaderSize: 0,
          primaryImage,
          billboardMode: 'billboard',
          particleCount,
        },
        payload: {
          isLikelyText: false,
          textEncoding: null,
          textScore: 0,
          textPreview: '',
          headerHex: formatHexDump(buf),
          asciiStrings,
          utf16Strings: [],
          dependencyPaths,
          dependencies,
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/cache-entry/raw') {
    try {
      const logicalPath = normalizeLogicalResourcePath(reqUrl.searchParams.get('logicalPath'));
      if (!logicalPath) {
        sendJson(res, 400, { error: 'logicalPath is required' });
        return;
      }

      const resolvedEntry = tryResolveCacheLogicalPath(logicalPath);
      if (!resolvedEntry) {
        sendJson(res, 404, { error: `No cache entry found for ${logicalPath}` });
        return;
      }

      const { output } = getJx3CacheReader().readEntry(resolvedEntry.resolvedPath);
      const fileName = basename(resolvedEntry.resolvedPath) || 'cache-entry.bin';
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(fileName).toLowerCase()] || 'application/octet-stream',
        'Content-Length': output.length,
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'X-JX3-Requested-Path': encodeURIComponent(logicalPath),
        'X-JX3-Resolved-Path': encodeURIComponent(resolvedEntry.resolvedPath),
      });
      res.end(output);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/repo-clips') {
    try {
      sendJson(res, 200, {
        available: existsSync(REPO_CLIPS_ROOT) && statSync(REPO_CLIPS_ROOT).isDirectory(),
        root: REPO_CLIPS_ROOT,
        clips: listRepoClipSources(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/open-actor-export-folder') {
    try {
      const exportName = String(reqUrl.searchParams.get('name') || '').trim();
      const exportInfo = exportName
        ? listMovieEditorActorExports().find((entry) => entry.name === exportName)
        : null;
      const folderPath = exportInfo?.exportDir || MOVIE_EDITOR_EXPORT_ROOT;

      if (!folderPath || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
        sendJson(res, 404, { ok: false, error: 'Actor export folder not found' });
        return;
      }

      const child = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' });
      child.unref();
      sendJson(res, 200, { ok: true, opened: folderPath, exportName: exportInfo?.name || '' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/resource-groups') {
    try {
      const actor = String(reqUrl.searchParams.get('actor') || '').trim();
      if (!actor) {
        sendJson(res, 400, { ok: false, error: 'actor is required' });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        actor,
        filePath: RESOURCE_GROUPS_FILE,
        groups: readActorResourceGroups(actor),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'POST' && urlPath === '/api/resource-groups') {
    try {
      const actor = String(reqUrl.searchParams.get('actor') || '').trim();
      if (!actor) {
        sendJson(res, 400, { ok: false, error: 'actor is required' });
        return;
      }

      const payload = await readBodyJson(req);
      const saved = writeActorResourceGroups(actor, payload);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector list meshes for a selected data root.
  if (method === 'GET' && urlPath === '/api/meshes') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      sendJson(res, 200, extractGlbListFromDataRoot(dataRoot));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector verdicts read.
  if (method === 'GET' && urlPath === '/api/verdicts') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      sendJson(res, 200, readInspectorVerdicts(dataRoot));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector verdicts write.
  if (method === 'POST' && urlPath === '/api/verdicts') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      const payload = await readBodyJson(req);
      const saved = writeInspectorVerdicts(dataRoot, payload);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: set one verdict atomically for one mesh.
  if (method === 'POST' && urlPath === '/api/verdicts/set') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      const payload = await readBodyJson(req);
      const saved = setSingleInspectorVerdict(dataRoot, payload?.mesh, payload?.verdict);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: open meshes folder in Explorer for the selected data root.
  if (method === 'GET' && urlPath === '/api/open-meshes-folder') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      const meshDir = dataRoot ? join(dataRoot, 'meshes') : null;
      if (!meshDir || !existsSync(meshDir) || !statSync(meshDir).isDirectory()) {
        sendJson(res, 404, { ok: false, error: 'Meshes folder not found' });
        return;
      }
      const child = spawn('explorer.exe', [meshDir], { detached: true, stdio: 'ignore' });
      child.unref();
      sendJson(res, 200, { ok: true, opened: meshDir });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build full export package on Desktop
  if (method === 'POST' && urlPath === '/api/export-full') {
    try {
      const payload = await readBodyJson(req);
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build full export package on Desktop and attach per-GLB collision sidecars.
  if (method === 'POST' && urlPath === '/api/export-full-with-collision') {
    try {
      const payload = await readBodyJson(req);
      payload.attachMeshCollision = true;
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build regional export package on Desktop and attach per-GLB collision sidecars.
  if (method === 'POST' && urlPath === '/api/export-regional-with-collision') {
    try {
      const payload = await readBodyJson(req);
      const region = payload?.region;
      const hasRegion = (
        region
        && Number.isFinite(region.minX)
        && Number.isFinite(region.maxX)
        && Number.isFinite(region.minZ)
        && Number.isFinite(region.maxZ)
      );
      if (!hasRegion) {
        throw new Error('Region is required for /api/export-regional-with-collision');
      }

      payload.attachMeshCollision = true;
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // Serve Desktop full export files under /full-exports/<package>/...
  if ((method === 'GET' || method === 'HEAD') && urlPath.startsWith('/full-exports/')) {
    const rel = urlPath.replace('/full-exports/', '');
    const abs = safePathUnder(DESKTOP_EXPORT_ROOT, rel);
    if (!abs) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, abs, method === 'HEAD');
    return;
  }

  if (urlPath.startsWith('/full-exports/')) {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Serve external MovieEditor assets under /movie-editor-assets/...
  if ((method === 'GET' || method === 'HEAD') && urlPath.startsWith('/movie-editor-assets/')) {
    const rel = urlPath.replace('/movie-editor-assets/', '');
    const abs = safePathUnder(MOVIE_EDITOR_ROOT, rel);
    if (!abs) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, abs, method === 'HEAD');
    return;
  }

  if (urlPath.startsWith('/movie-editor-assets/')) {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && urlPath.startsWith('/vendor/')) {
    const rel = urlPath.replace('/vendor/', '');
    const abs = safePathUnder(NODE_MODULES_DIR, rel);
    if (!abs) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, abs, method === 'HEAD');
    return;
  }

  if (urlPath.startsWith('/vendor/')) {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Default static files from public
  let staticUrl = urlPath;
  if (staticUrl === '/') staticUrl = '/index.html';
  const staticPath = safePathUnder(PUBLIC_DIR, staticUrl.replace(/^\//, ''));
  if (!staticPath) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    serveFile(res, staticPath, method === 'HEAD');
    return;
  }

  sendText(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  ensureDir(DESKTOP_EXPORT_ROOT);
  console.log(`JX3 Map Viewer running at http://localhost:${PORT}`);
  console.log(`Full exports Desktop root: ${DESKTOP_EXPORT_ROOT}`);
});
