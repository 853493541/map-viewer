#!/usr/bin/env node
import { request as httpsRequest } from 'node:https';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import iconv from 'iconv-lite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CDN_ROOT = 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/';
const MAKEPACKAGES_URL = `${CDN_ROOT}v/2/MakePackages.bin`;
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const DOWNLOAD_DIR = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'downloads');
const MIRROR_DIR = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'resource-browser');
const INDEX_PATH = join(MIRROR_DIR, 'resource-index.jsonl');
const STATUS_PATH = join(MIRROR_DIR, 'package-status.jsonl');
const SUMMARY_PATH = join(MIRROR_DIR, 'resource-index-summary.json');
const DIR_CACHE_PATH = join(MIRROR_DIR, 'hpkg-dir-cache.json');
const AUDIO_EXTENSIONS = new Set(['.wem', '.bnk', '.ogg', '.wav', '.mp3']);
const BROWSER_AUDIO_EXTENSIONS = new Set(['.ogg', '.wav', '.mp3']);
const CONVERTIBLE_AUDIO_EXTENSIONS = new Set(['.wem']);
const TEXTURE_EXTENSIONS = new Set(['.dds', '.tga', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.hx']);
const MODEL_EXTENSIONS = new Set(['.mdl', '.model', '.mesh', '.fbx', '.smd', '.obj', '.m2']);
const ANIMATION_EXTENSIONS = new Set(['.ani', '.tani', '.ska', '.skl', '.anim']);
const MATERIAL_EXTENSIONS = new Set(['.mtl', '.mat', '.material', '.mtrl', '.fx', '.shader']);

let lzhamUncompress = null;

function parseArgs(argv) {
  const args = {
    download: false,
    previewOnly: true,
    force: false,
    limit: 0,
    offset: 0,
    concurrency: 4,
    search: '',
    timeoutMs: 30_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--download') {
      args.download = true;
      args.previewOnly = false;
    } else if (value === '--preview-only') {
      args.previewOnly = true;
      args.download = false;
    } else if (value === '--force') args.force = true;
    else if (value === '--limit') args.limit = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (value === '--offset') args.offset = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (value === '--concurrency') args.concurrency = Math.min(16, Math.max(1, Number(argv[++i] || 4) || 4));
    else if (value === '--search') args.search = String(argv[++i] || '').trim().toLowerCase();
    else if (value === '--timeout-ms') args.timeoutMs = Math.max(1000, Number(argv[++i] || 30_000) || 30_000);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return args;
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function getLzhamUncompress() {
  if (lzhamUncompress) return lzhamUncompress;
  const library = koffi.load(LZHAM_DLL);
  lzhamUncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  return lzhamUncompress;
}

function toNativeBase32(value) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let current = BigInt.asUintN(64, BigInt(value));
  if (current === 0n) return 'a';
  let out = '';
  while (current > 0n) {
    out = alphabet[Number(current & 31n)] + out;
    current >>= 5n;
  }
  return out;
}

function requestBuffer(url, options = {}) {
  const method = options.method || 'GET';
  const maxBytes = Number(options.maxBytes || 64 * 1024 * 1024);
  const headers = options.headers || {};
  return new Promise((resolveP, rejectP) => {
    const request = httpsRequest(url, { method, timeout: Number(options.timeoutMs || 30_000), headers }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error(`response too large: ${total} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolveP({ statusCode: response.statusCode || 0, headers: response.headers, buffer: Buffer.concat(chunks) });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout fetching ${url}`)));
    request.on('error', rejectP);
    request.end();
  });
}

function requestHead(url, timeoutMs = 4000) {
  return new Promise((resolveP) => {
    const request = httpsRequest(url, { method: 'HEAD', timeout: timeoutMs }, (response) => {
      response.resume();
      resolveP({ statusCode: response.statusCode || 0, headers: response.headers, contentLength: Number(response.headers['content-length'] || 0) });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolveP({ statusCode: 0, error: String(error?.message || error), contentLength: 0 }));
    request.end();
  });
}

function downloadFile(url, outPath, expectedSize, timeoutMs) {
  if (existsSync(outPath)) {
    const size = statSync(outPath).size;
    if (!expectedSize || size === expectedSize) return Promise.resolve({ skipped: true, size });
  }
  ensureDir(dirname(outPath));
  const tmpPath = `${outPath}.tmp`;
  try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* noop */ }
  return new Promise((resolveP, rejectP) => {
    const file = createWriteStream(tmpPath);
    let total = 0;
    const request = httpsRequest(url, { method: 'GET', timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        file.destroy();
        rejectP(new Error(`download HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => { total += chunk.length; });
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (expectedSize && total !== expectedSize) {
            rejectP(new Error(`downloaded ${total} bytes, expected ${expectedSize}`));
            return;
          }
          renameSync(tmpPath, outPath);
          resolveP({ skipped: false, size: total });
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout downloading ${url}`)));
    request.on('error', (error) => {
      file.destroy();
      rejectP(error);
    });
    request.end();
  });
}

function decodeMakePackages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('MakePackages.bin response is too small');
  const expectedSize = buffer.readUInt32LE(4);
  const output = Buffer.alloc(expectedSize);
  const outputLength = [expectedSize >>> 0];
  const status = getLzhamUncompress()(output, outputLength, buffer.subarray(8), (buffer.length - 8) >>> 0);
  if (status !== 0) throw new Error(`lzham_z_uncompress failed for MakePackages.bin: ${status}`);
  return outputLength[0] === output.length ? output : output.subarray(0, outputLength[0]);
}

const LOCAL_MAKEPACKAGES_PATH = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'MakePackages.bin');

async function loadPackageList(timeoutMs) {
  let buffer;
  if (existsSync(LOCAL_MAKEPACKAGES_PATH)) {
    buffer = readFileSync(LOCAL_MAKEPACKAGES_PATH);
  } else {
    const fetched = await requestBuffer(MAKEPACKAGES_URL, { maxBytes: 8 * 1024 * 1024, timeoutMs });
    if (fetched.statusCode !== 200) throw new Error(`MakePackages.bin HTTP ${fetched.statusCode}`);
    buffer = fetched.buffer;
  }
  const decoded = decodeMakePackages(buffer);
  if (decoded.length % 12 !== 0) throw new Error(`decoded MakePackages size ${decoded.length} is not divisible by 12`);
  const items = [];
  for (let offset = 0; offset + 12 <= decoded.length; offset += 12) {
    const hash = decoded.readBigUInt64LE(offset);
    const size = decoded.readUInt32LE(offset + 8);
    if (hash === 0n || size === 0) continue;
    const packageName = toNativeBase32(hash);
    items.push({
      index: items.length + 1,
      recordIndex: offset / 12,
      packageName,
      path: `${packageName}.hpkg`,
      hashHex: `0x${hash.toString(16).padStart(16, '0')}`,
      size,
    });
  }
  return { fetchedBytes: buffer.length, decodedBytes: decoded.length, items };
}

function decodePathBytes(bytes) {
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  return { text: iconv.decode(bytes, 'gb18030'), encoding: 'gb18030' };
}

function readCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  const bytes = buffer.subarray(start, stop);
  return decodePathBytes(bytes);
}

function decodeHpkgIndex(hpkg, options = {}) {
  if (!Buffer.isBuffer(hpkg) || hpkg.length < 64) throw new Error('HPKG file is too small');
  const magic = hpkg.readUInt32LE(0);
  const version = hpkg.readUInt32LE(4);
  const count = hpkg.readUInt32LE(0x10);
  const indexSize = hpkg.readUInt32LE(0x20);
  const packedIndexSize = hpkg.readUInt32LE(0x28);
  const payloadSize = hpkg.readUInt32LE(0x30);
  if (magic !== 0x9585 || version !== 102) throw new Error(`Unexpected HPKG header: magic=0x${magic.toString(16)} version=${version}`);
  if (!count || indexSize % count !== 0) throw new Error(`Invalid HPKG index sizing: count=${count} indexSize=${indexSize}`);
  const packedStart = 64;
  const payloadStart = packedStart + packedIndexSize;
  if (payloadStart > hpkg.length) throw new Error('HPKG index is incomplete');
  if (!options.indexOnly && payloadStart + payloadSize > hpkg.length) throw new Error('HPKG payload extends beyond file size');

  const index = Buffer.alloc(indexSize);
  const outputLength = [indexSize >>> 0];
  const status = getLzhamUncompress()(index, outputLength, hpkg.subarray(packedStart + 4, payloadStart), (packedIndexSize - 4) >>> 0);
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
      path: pathInfo.text,
      pathEncoding: pathInfo.encoding,
      originalSize,
      storedSize,
      payloadOffset: index.readUInt32LE(base + 288),
      flags: index.readUInt32LE(base + 292),
      memberHeaderSize: storedSize - originalSize,
    });
  }
  return { count, indexSize, packedIndexSize, payloadSize, payloadStart, recordSize, records };
}

function classifyPath(path) {
  const extension = extname(path || '').toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) return { extension, type: 'Audio', playable: BROWSER_AUDIO_EXTENSIONS.has(extension) || CONVERTIBLE_AUDIO_EXTENSIONS.has(extension) };
  if (TEXTURE_EXTENSIONS.has(extension)) return { extension, type: 'Texture', playable: false };
  if (MODEL_EXTENSIONS.has(extension)) return { extension, type: 'Model', playable: false };
  if (ANIMATION_EXTENSIONS.has(extension)) return { extension, type: 'Animation', playable: false };
  if (MATERIAL_EXTENSIONS.has(extension)) return { extension, type: 'Material', playable: false };
  return { extension, type: 'Other', playable: false };
}

function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function loadProcessedPackages(options = {}) {
  const processed = new Set();
  if (!existsSync(STATUS_PATH)) return processed;
  for (const line of readFileSync(STATUS_PATH, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.ok && row.packageName && (!options.requireFullDownload || row.fullDownloaded)) processed.add(row.packageName);
    } catch { /* ignore malformed status lines */ }
  }
  return processed;
}

function writeSummary(summary) {
  writeFileSync(SUMMARY_PATH, JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2));
}

function derivePackageDir(packageName) {
  const cleanName = String(packageName || '').trim();
  if (cleanName.length < 3) return null;
  return cleanName.charCodeAt(2);
}

async function resolvePackageUrl(item, dirCache, timeoutMs) {
  const cacheKey = `${item.packageName}:${item.size}`;
  const cached = dirCache[cacheKey];
  if (cached && Number.isInteger(cached.dir)) {
    return { ...cached, url: `${CDN_ROOT}${cached.relativePath}` };
  }
  const makeResult = (dir, relativePath, derived) => ({
    dir, relativePath, statusCode: 200, contentLength: item.size, sizeMatches: true,
    ...(derived ? { derived: true } : {}),
  });
  const derivedDir = derivePackageDir(item.packageName);
  if (Number.isInteger(derivedDir)) {
    const localPath = join(DOWNLOAD_DIR, `${derivedDir}_${item.packageName}.hpkg`);
    if (existsSync(localPath)) {
      const result = makeResult(derivedDir, `${derivedDir}/${item.packageName}.hpkg`, true);
      dirCache[cacheKey] = result;
      writeFileSync(DIR_CACHE_PATH, JSON.stringify(dirCache, null, 2));
      return { ...result, url: `${CDN_ROOT}${result.relativePath}` };
    }
  }
  try {
    const files = existsSync(DOWNLOAD_DIR) ? readdirSync(DOWNLOAD_DIR) : [];
    const match = files.find((f) => f.endsWith(`_${item.packageName}.hpkg`));
    if (match) {
      const dir = Number(match.split('_')[0]);
      if (Number.isInteger(dir)) {
        const result = makeResult(dir, `${dir}/${item.packageName}.hpkg`, true);
        dirCache[cacheKey] = result;
        writeFileSync(DIR_CACHE_PATH, JSON.stringify(dirCache, null, 2));
        return { ...result, url: `${CDN_ROOT}${result.relativePath}` };
      }
    }
  } catch { /* fall through to CDN probe */ }
  if (Number.isInteger(derivedDir)) {
    const relativePath = `${derivedDir}/${item.packageName}.hpkg`;
    const url = `${CDN_ROOT}${relativePath}`;
    const head = await requestHead(url, Math.min(timeoutMs, 5000));
    if (head.statusCode === 200 && (!head.contentLength || head.contentLength === item.size)) {
      const result = {
        dir: derivedDir,
        relativePath,
        statusCode: head.statusCode,
        contentLength: head.contentLength,
        sizeMatches: head.contentLength === item.size,
        derived: true,
      };
      dirCache[cacheKey] = result;
      writeFileSync(DIR_CACHE_PATH, JSON.stringify(dirCache, null, 2));
      return { ...result, url };
    }
  }
  const dirs = Array.from({ length: 256 }, (_, dir) => dir);
  for (let offset = 0; offset < dirs.length; offset += 32) {
    const batch = dirs.slice(offset, offset + 32);
    const probes = await Promise.all(batch.map(async (dir) => {
      const relativePath = `${dir}/${item.packageName}.hpkg`;
      const url = `${CDN_ROOT}${relativePath}`;
      const head = await requestHead(url, Math.min(timeoutMs, 5000));
      return { dir, relativePath, url, ...head };
    }));
    const hit = probes.find((probe) => probe.statusCode === 200 && probe.contentLength === item.size)
      || probes.find((probe) => probe.statusCode === 200);
    if (hit) {
      const result = {
        dir: hit.dir,
        relativePath: hit.relativePath,
        statusCode: hit.statusCode,
        contentLength: hit.contentLength,
        sizeMatches: hit.contentLength === item.size,
      };
      dirCache[cacheKey] = result;
      writeFileSync(DIR_CACHE_PATH, JSON.stringify(dirCache, null, 2));
      return { ...result, url: hit.url };
    }
  }
  throw new Error(`No live hpkg URL found for ${item.packageName}.hpkg (${item.size} bytes)`);
}

async function fetchHpkgIndexOnly(resolved, timeoutMs) {
  const head = await requestBuffer(resolved.url, {
    headers: { Range: 'bytes=0-63' },
    maxBytes: 128 * 1024,
    timeoutMs,
  });
  if (head.statusCode !== 206 && head.statusCode !== 200) throw new Error(`range header HTTP ${head.statusCode}`);
  if (head.buffer.length < 64) throw new Error(`range header too small: ${head.buffer.length}`);
  const packedIndexSize = head.buffer.readUInt32LE(0x28);
  const wanted = 64 + packedIndexSize;
  const indexFetch = await requestBuffer(resolved.url, {
    headers: { Range: `bytes=0-${wanted - 1}` },
    maxBytes: wanted + 1024,
    timeoutMs,
  });
  if (indexFetch.statusCode !== 206 && indexFetch.statusCode !== 200) throw new Error(`range index HTTP ${indexFetch.statusCode}`);
  if (indexFetch.buffer.length < wanted) throw new Error(`range index too small: ${indexFetch.buffer.length}, wanted ${wanted}`);
  return indexFetch.buffer.subarray(0, wanted);
}

function appendPackageRecords(item, resolved, decoded, fullDownloaded) {
  const lines = [];
  for (const record of decoded.records) {
    const classified = classifyPath(record.path);
    lines.push(JSON.stringify({
      packageName: item.packageName,
      packageSize: item.size,
      hashHex: item.hashHex,
      packageDir: resolved.dir,
      packageRemotePath: resolved.relativePath,
      packageRecordIndex: item.recordIndex,
      fullDownloaded,
      row: record.row,
      index: record.index,
      path: record.path,
      name: record.path.split('/').pop() || record.path,
      folder: record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '',
      pathEncoding: record.pathEncoding,
      extension: classified.extension,
      type: classified.type,
      playable: classified.playable,
      originalSize: record.originalSize,
      storedSize: record.storedSize,
      memberHeaderSize: record.memberHeaderSize,
      payloadOffset: record.payloadOffset,
      flags: record.flags,
    }));
  }
  appendFileSync(INDEX_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function processPackage(item, args, dirCache, stats, options = {}) {
  const resolved = await resolvePackageUrl(item, dirCache, args.timeoutMs);
  const localPath = join(DOWNLOAD_DIR, `${resolved.dir}_${item.packageName}.hpkg`);
  let hpkg;
  let fullDownloaded = false;
  let downloadResult = null;
  if (args.download) {
    downloadResult = await downloadFile(resolved.url, localPath, item.size, Math.max(args.timeoutMs, 120_000));
    hpkg = readFileSync(localPath);
    fullDownloaded = true;
  } else if (existsSync(localPath)) {
    const fullBuffer = readFileSync(localPath);
    hpkg = fullBuffer.subarray(0, 64 + fullBuffer.readUInt32LE(0x28));
    fullDownloaded = true;
  } else {
    hpkg = await fetchHpkgIndexOnly(resolved, args.timeoutMs);
  }
  const decoded = decodeHpkgIndex(hpkg, { indexOnly: !args.download });
  if (options.appendRecords !== false) appendPackageRecords(item, resolved, decoded, fullDownloaded);
  const byType = {};
  for (const record of decoded.records) {
    const type = classifyPath(record.path).type;
    byType[type] = (byType[type] || 0) + 1;
  }
  appendFileSync(STATUS_PATH, `${JSON.stringify({
    ok: true,
    packageName: item.packageName,
    size: item.size,
    dir: resolved.dir,
    remotePath: resolved.relativePath,
    records: decoded.records.length,
    fullDownloaded,
    skippedDownload: !!downloadResult?.skipped,
    byType,
    updatedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  stats.ok += 1;
  stats.records += decoded.records.length;
  if (fullDownloaded) stats.downloadedBytes += item.size;
  console.log(`[mirror] ok ${stats.ok + stats.failed + stats.skipped}/${stats.total} ${item.packageName}.hpkg records=${decoded.records.length} dir=${resolved.dir}${fullDownloaded ? ' downloaded' : ' preview'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(MIRROR_DIR);
  ensureDir(DOWNLOAD_DIR);
  if (args.force) {
    for (const path of [INDEX_PATH, STATUS_PATH, SUMMARY_PATH]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* noop */ }
    }
  }
  const dirCache = readJsonFile(DIR_CACHE_PATH, {});
  const indexedPackages = args.force ? new Set() : loadProcessedPackages();
  const processed = args.force ? new Set() : loadProcessedPackages({ requireFullDownload: args.download });
  const list = await loadPackageList(args.timeoutMs);
  const normalizedSearch = args.search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? list.items.filter((item) => `${item.packageName} ${item.hashHex} ${item.size} ${item.recordIndex}`.toLowerCase().includes(normalizedSearch))
    : list.items;
  const selected = filtered.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  const pending = selected.filter((item) => !processed.has(item.packageName));
  const stats = {
    mode: args.download ? 'download' : 'preview-only',
    totalOnlinePackages: list.items.length,
    totalFiltered: filtered.length,
    total: selected.length,
    alreadyProcessed: selected.length - pending.length,
    ok: 0,
    failed: 0,
    skipped: selected.length - pending.length,
    records: 0,
    downloadedBytes: 0,
    indexPath: INDEX_PATH,
    statusPath: STATUS_PATH,
    downloadDir: DOWNLOAD_DIR,
    makePackagesUrl: MAKEPACKAGES_URL,
  };
  writeSummary(stats);
  console.log(`[mirror] ${stats.mode} packages=${pending.length}/${selected.length} filtered=${filtered.length} online=${list.items.length} concurrency=${args.concurrency}`);
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const item = pending[next];
      next += 1;
      try {
        await processPackage(item, args, dirCache, stats, { appendRecords: !indexedPackages.has(item.packageName) });
      } catch (error) {
        stats.failed += 1;
        appendFileSync(STATUS_PATH, `${JSON.stringify({
          ok: false,
          packageName: item.packageName,
          size: item.size,
          error: String(error?.message || error),
          updatedAt: new Date().toISOString(),
        })}\n`, 'utf8');
        console.error(`[mirror] fail ${stats.ok + stats.failed + stats.skipped}/${stats.total} ${item.packageName}.hpkg ${String(error?.message || error)}`);
      }
      writeSummary(stats);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(1, pending.length)) }, () => worker()));
  writeSummary({ ...stats, finishedAt: new Date().toISOString() });
  console.log(`[mirror] done ok=${stats.ok} failed=${stats.failed} skipped=${stats.skipped} records=${stats.records} downloadedBytes=${stats.downloadedBytes}`);
}

main().catch((error) => {
  console.error(`[mirror] fatal ${String(error?.stack || error)}`);
  process.exitCode = 1;
});