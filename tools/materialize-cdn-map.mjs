#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import iconv from 'iconv-lite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_INDEX_PATH = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'resource-browser', 'resource-index.jsonl');
const CDN_DOWNLOAD_DIR = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'downloads');
const DEFAULT_OUT_BASE = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'materialized-maps');
const MIRROR_SCRIPT = join(__dirname, 'mirror-online-hpkg.mjs');
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';

function parseArgs(argv) {
  const args = {
    mapName: '',
    indexPath: DEFAULT_INDEX_PATH,
    outRoot: '',
    downloadMissing: false,
    includeMinimap: false,
    dependencies: true,
    textures: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--map-name') args.mapName = next();
    else if (arg === '--index') args.indexPath = resolve(next());
    else if (arg === '--out-root') args.outRoot = resolve(next());
    else if (arg === '--download-missing') args.downloadMissing = true;
    else if (arg === '--include-minimap') args.includeMinimap = true;
    else if (arg === '--no-dependencies') args.dependencies = false;
    else if (arg === '--textures') args.textures = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/materialize-cdn-map.mjs --map-name <name> [--download-missing] [--out-root <dir>] [--include-minimap] [--textures]');
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!args.mapName) throw new Error('--map-name is required');
  if (!args.outRoot) args.outRoot = join(DEFAULT_OUT_BASE, args.mapName);
  return args;
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function normalizeCdnMemberPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function safePathUnder(root, relativePath) {
  const resolvedRoot = resolve(root);
  const normalized = normalizeCdnMemberPath(relativePath);
  if (!normalized || normalized.split('/').some((part) => part === '..')) return null;
  const resolvedPath = resolve(resolvedRoot, normalized);
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolvedPath;
}

function decodePathBytes(bytes) {
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  return { text: iconv.decode(bytes, 'gb18030'), encoding: 'gb18030' };
}

function readCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  return decodePathBytes(buffer.subarray(start, stop));
}

let lzhamUncompress = null;
function getLzhamUncompress() {
  if (lzhamUncompress) return lzhamUncompress;
  if (!existsSync(LZHAM_DLL)) throw new Error(`LZHAM DLL not found: ${LZHAM_DLL}`);
  const library = koffi.load(LZHAM_DLL);
  lzhamUncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  return lzhamUncompress;
}

function decodeHpkgIndex(hpkg) {
  if (!Buffer.isBuffer(hpkg) || hpkg.length < 64) throw new Error('HPKG file is too small');
  const magic = hpkg.readUInt32LE(0);
  const version = hpkg.readUInt32LE(4);
  const count = hpkg.readUInt32LE(0x10);
  const indexSize = hpkg.readUInt32LE(0x20);
  const packedIndexSize = hpkg.readUInt32LE(0x28);
  const payloadSize = hpkg.readUInt32LE(0x30);
  if (magic !== 0x9585 || version !== 102) throw new Error(`Unexpected HPKG header: magic=0x${magic.toString(16)} version=${version}`);
  if (!count || indexSize % count !== 0) throw new Error(`Invalid HPKG index sizing: count=${count} indexSize=${indexSize}`);
  const payloadStart = 64 + packedIndexSize;
  if (payloadStart + payloadSize > hpkg.length) throw new Error('HPKG payload extends beyond file size');

  const index = Buffer.alloc(indexSize);
  const outputLength = [indexSize >>> 0];
  const status = getLzhamUncompress()(index, outputLength, hpkg.subarray(68, payloadStart), (packedIndexSize - 4) >>> 0);
  if (status !== 0) throw new Error(`HPKG index LZHAM decode failed: ${status}`);

  const recordSize = indexSize / count;
  const records = [];
  for (let row = 0; row < count; row += 1) {
    const base = row * recordSize;
    const pathInfo = readCString(index, base + 4, base + 260);
    const originalSize = index.readUInt32LE(base + 280);
    const storedSize = index.readUInt32LE(base + 284);
    records.push({
      row,
      index: index.readUInt32LE(base),
      path: normalizeCdnMemberPath(pathInfo.text),
      pathEncoding: pathInfo.encoding,
      originalSize,
      storedSize,
      memberHeaderSize: storedSize - originalSize,
      payloadOffset: index.readUInt32LE(base + 288),
      flags: index.readUInt32LE(base + 292),
    });
  }
  return { count, payloadStart, records };
}

function findLocalPackage(packageName, packageSize = 0) {
  const cleanName = String(packageName || '').trim();
  if (!cleanName || /[\\/]/.test(cleanName) || !existsSync(CDN_DOWNLOAD_DIR)) return null;
  const candidates = readdirSync(CDN_DOWNLOAD_DIR)
    .filter((name) => name.endsWith(`_${cleanName}.hpkg`) || name === `${cleanName}.hpkg`)
    .map((name) => join(CDN_DOWNLOAD_DIR, name));
  return candidates.find((candidate) => !packageSize || statSync(candidate).size === Number(packageSize)) || candidates[0] || null;
}

const attemptedDownloads = new Set();
function ensurePackageDownloaded(row, options) {
  const packageName = String(row.packageName || '').trim();
  if (!options.downloadMissing || !packageName || attemptedDownloads.has(packageName)) return;
  attemptedDownloads.add(packageName);
  console.log(`[cdn-map] downloading package ${packageName}`);
  const result = spawnSync(process.execPath, [
    MIRROR_SCRIPT,
    '--download',
    '--concurrency', '1',
    '--limit', '1',
    '--search', packageName,
    '--timeout-ms', '120000',
  ], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Download failed for ${packageName}: ${detail}`);
  }
}

function decodeMemberPayload(stored, record) {
  if (record.storedSize === record.originalSize) return stored;
  const memberHeaderSize = record.storedSize - record.originalSize;
  if (memberHeaderSize > 0 && memberHeaderSize <= 64) {
    return stored.subarray(memberHeaderSize, memberHeaderSize + record.originalSize);
  }

  const lzham = getLzhamUncompress();
  for (const skip of [0, 4, 8, 12, 16, 20, 24, 32]) {
    if (skip >= stored.length) continue;
    const output = Buffer.alloc(record.originalSize);
    const outputLength = [record.originalSize >>> 0];
    const status = lzham(output, outputLength, stored.subarray(skip), (stored.length - skip) >>> 0);
    if (status === 0) return output.subarray(0, outputLength[0]);
  }

  throw new Error(`Could not decode compressed member ${record.path}: stored=${record.storedSize} original=${record.originalSize}`);
}

const packageCache = new Map();
function loadPackage(row, options) {
  let hpkgPath = findLocalPackage(row.packageName, row.packageSize || 0);
  if (!hpkgPath) {
    ensurePackageDownloaded(row, options);
    hpkgPath = findLocalPackage(row.packageName, row.packageSize || 0);
  }
  if (!hpkgPath) throw new Error(`Downloaded HPKG not found for ${row.packageName}`);
  if (!packageCache.has(hpkgPath)) {
    const hpkg = readFileSync(hpkgPath);
    const decoded = decodeHpkgIndex(hpkg);
    const recordByPath = new Map(decoded.records.map((record) => [record.path.toLowerCase(), record]));
    packageCache.set(hpkgPath, { hpkg, decoded, recordByPath });
  }
  return packageCache.get(hpkgPath);
}

function extractRow(row, options) {
  const normalizedPath = normalizeCdnMemberPath(row.path);
  const outPath = safePathUnder(options.outRoot, normalizedPath);
  if (!outPath) throw new Error(`Invalid output path for ${normalizedPath}`);
  if (existsSync(outPath) && statSync(outPath).size === Number(row.originalSize || 0)) {
    return { status: 'cached', outPath };
  }
  const loaded = loadPackage(row, options);
  const record = loaded.recordByPath.get(normalizedPath.toLowerCase());
  if (!record) throw new Error(`Member not found in ${row.packageName}.hpkg: ${normalizedPath}`);
  const storedStart = loaded.decoded.payloadStart + record.payloadOffset;
  const storedEnd = storedStart + record.storedSize;
  if (storedEnd > loaded.hpkg.length) throw new Error(`Member payload extends beyond package: ${normalizedPath}`);
  const stored = loaded.hpkg.subarray(storedStart, storedEnd);
  const raw = decodeMemberPayload(stored, record);
  ensureDir(dirname(outPath));
  writeFileSync(outPath, raw);
  return { status: 'extracted', outPath };
}

function parseIndexRow(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function getIndexInputFiles(indexPath) {
  const resolved = resolve(indexPath);
  const files = [];
  if (existsSync(resolved) && statSync(resolved).isFile()) files.push(resolved);

  const resourceBrowserDir = existsSync(resolved) && statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  const browseMapDir = join(resourceBrowserDir, 'browse-map');
  if (existsSync(browseMapDir)) {
    for (const name of readdirSync(browseMapDir)) {
      if (/^files-\d+\.jsonl$/i.test(name)) files.push(join(browseMapDir, name));
    }
  }
  return [...new Set(files)].sort();
}

async function readIndexRows(indexPath, accept) {
  const rows = [];
  const seen = new Set();
  for (const filePath of getIndexInputFiles(indexPath)) {
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const row = parseIndexRow(line);
        if (!row?.path || !accept(row)) continue;
        const key = `${row.packageName || ''}\u0000${normalizeCdnMemberPath(row.path).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    } finally {
      reader.close();
      input.destroy();
    }
  }
  return rows;
}

async function collectRowsByPrefixes(indexPath, prefixes) {
  const normalizedPrefixes = prefixes.map(normalizeCdnMemberPath).filter(Boolean);
  return readIndexRows(indexPath, (row) => {
    const path = normalizeCdnMemberPath(row.path);
    return normalizedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });
}

async function collectRowsByExactPaths(indexPath, wantedPaths) {
  const wanted = new Set([...wantedPaths].map((value) => normalizeCdnMemberPath(value).toLowerCase()).filter(Boolean));
  if (!wanted.size) return [];
  return readIndexRows(indexPath, (row) => wanted.has(normalizeCdnMemberPath(row.path).toLowerCase()));
}

function readTextLoose(filePath) {
  const raw = readFileSync(filePath);
  try { return iconv.decode(raw, 'gb18030'); } catch { return raw.toString('utf8'); }
}

function parseJsonLoose(filePath) {
  return JSON.parse(readTextLoose(filePath));
}

function walkFiles(dirPath, predicate, out = []) {
  if (!existsSync(dirPath)) return out;
  for (const name of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, name.name);
    if (name.isDirectory()) walkFiles(fullPath, predicate, out);
    else if (!predicate || predicate(fullPath)) out.push(fullPath);
  }
  return out;
}

function collectEntityModelPaths(outRoot, mapName) {
  const sceneDir = join(outRoot, 'data', 'source', 'maps', mapName, 'entities', 'sceneinfo');
  const files = walkFiles(sceneDir, (filePath) => filePath.toLowerCase().endsWith('.json'));
  const paths = new Set();
  for (const filePath of files) {
    let json;
    try { json = parseJsonLoose(filePath); } catch { continue; }
    const objects = json?.worldObjects;
    if (!objects || typeof objects !== 'object') continue;
    for (const obj of Object.values(objects)) {
      const actorModel = obj?.comRender?.actorModel;
      if (actorModel) paths.add(normalizeCdnMemberPath(actorModel));
    }
  }
  return paths;
}

function addModelCompanions(modelPaths) {
  const wanted = new Set();
  for (const modelPath of modelPaths) {
    const normalized = normalizeCdnMemberPath(modelPath);
    if (!normalized) continue;
    wanted.add(normalized);
    const extension = extname(normalized).toLowerCase();
    const stem = normalized.slice(0, normalized.length - extname(normalized).length);
    if (extension === '.mesh') {
      wanted.add(`${stem}.JsonInspack`);
      wanted.add(`${stem}.jsoninspack`);
    } else if (extension === '.srt') {
      wanted.add(`${stem}.mesh`);
      wanted.add(`${stem}_3dmesh.JsonInspack`);
      wanted.add(`${stem}_3dmesh.jsoninspack`);
    }
  }
  return wanted;
}

function collectTexturePaths(outRoot) {
  const files = walkFiles(outRoot, (filePath) => filePath.toLowerCase().endsWith('.jsoninspack'));
  const paths = new Set();
  const addTextureCandidate = (texturePath) => {
    paths.add(texturePath);
    const extension = extname(texturePath).toLowerCase();
    if (extension === '.tga') {
      paths.add(`${texturePath.slice(0, texturePath.length - extension.length)}.dds`);
    }
  };
  for (const filePath of files) {
    let json;
    try { json = parseJsonLoose(filePath); } catch { continue; }
    for (const lod of json?.LOD || []) {
      for (const group of lod?.Group || []) {
        for (const subset of group?.Subset || []) {
          for (const param of subset?.Param || []) {
            if (param?.Type !== 'Texture' || !param?.Value) continue;
            const texturePath = normalizeCdnMemberPath(param.Value);
            if (texturePath.toLowerCase().startsWith('data/')) addTextureCandidate(texturePath);
          }
        }
      }
    }
  }
  return paths;
}

function extractRows(rows, options, label) {
  let extracted = 0;
  let cached = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = extractRow(row, options);
      if (result.status === 'cached') cached += 1;
      else extracted += 1;
    } catch (error) {
      failed += 1;
      if (failed <= 20) console.warn(`[cdn-map] failed ${row.path}: ${error?.message || error}`);
    }
    const total = extracted + cached + failed;
    if (total % 200 === 0) console.log(`[cdn-map] ${label}: ${total}/${rows.length}`);
  }
  console.log(`[cdn-map] ${label}: extracted=${extracted} cached=${cached} failed=${failed}`);
  return { extracted, cached, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.indexPath)) throw new Error(`Resource index not found: ${options.indexPath}`);
  ensureDir(options.outRoot);

  const prefixes = [`data/source/maps/${options.mapName}`];
  if (options.includeMinimap) {
    prefixes.push(`data/source/maps/${options.mapName}minimap`);
    prefixes.push(`data/source/maps/${options.mapName}minimap_mb`);
  }

  console.log(`[cdn-map] map=${options.mapName}`);
  console.log(`[cdn-map] out=${options.outRoot}`);
  const mapRows = await collectRowsByPrefixes(options.indexPath, prefixes);
  console.log(`[cdn-map] source rows=${mapRows.length}`);
  const sourceStats = extractRows(mapRows, options, 'source');

  let dependencyStats = { extracted: 0, cached: 0, failed: 0 };
  let textureStats = { extracted: 0, cached: 0, failed: 0 };
  let modelPaths = new Set();
  let dependencyRows = [];
  let textureRows = [];

  if (options.dependencies) {
    modelPaths = collectEntityModelPaths(options.outRoot, options.mapName);
    const wanted = addModelCompanions(modelPaths);
    console.log(`[cdn-map] entity model paths=${modelPaths.size}, dependency path candidates=${wanted.size}`);
    dependencyRows = await collectRowsByExactPaths(options.indexPath, wanted);
    console.log(`[cdn-map] dependency rows=${dependencyRows.length}`);
    dependencyStats = extractRows(dependencyRows, options, 'dependencies');
  }

  if (options.textures) {
    const texturePaths = collectTexturePaths(options.outRoot);
    console.log(`[cdn-map] material texture path candidates=${texturePaths.size}`);
    textureRows = await collectRowsByExactPaths(options.indexPath, texturePaths);
    console.log(`[cdn-map] texture rows=${textureRows.length}`);
    textureStats = extractRows(textureRows, options, 'textures');
  }

  const summary = {
    ok: sourceStats.failed === 0 && dependencyStats.failed === 0 && textureStats.failed === 0,
    mapName: options.mapName,
    outRoot: options.outRoot,
    sourceRows: mapRows.length,
    dependencyRows: dependencyRows.length,
    textureRows: textureRows.length,
    modelPathCount: modelPaths.size,
    sourceStats,
    dependencyStats,
    textureStats,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(options.outRoot, 'materialize-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[cdn-map] ERROR: ${error?.stack || error?.message || error}`);
  process.exit(1);
});