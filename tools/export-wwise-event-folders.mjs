#!/usr/bin/env node
// Export a reverse Wwise map: WEM id -> named event -> original Wwise object path.
// By default this writes manifests only. Use --write-wem or --decode-ogg to
// materialize files into the same event-folder layout.

import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import koffi from 'koffi';
import iconv from 'iconv-lite';
import { decodeWemToOgg, getWemBuffer } from './wwise-audio-resolver.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '..');
const DEFAULT_INDEX_PATH = join(REPO_ROOT, 'log', 'wwise-soundbank-index.json');
const DEFAULT_RESOURCE_INDEX_PATH = join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'resource-browser', 'resource-index.jsonl');
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'cache-extraction', 'wwise-event-folders');
const CDN_ONLINE_ROOT = join(REPO_ROOT, 'cache-extraction', 'online-cdn');
const CDN_DOWNLOAD_DIR = join(CDN_ONLINE_ROOT, 'downloads');
const CDN_HPKG_EXTRACTED_DIR = join(CDN_ONLINE_ROOT, 'extracted');
const MIRROR_ONLINE_HPKG_SCRIPT = join(TOOL_DIR, 'mirror-online-hpkg.mjs');
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const WW2OGG_EXE = join(TOOL_DIR, 'bin', 'ww2ogg', 'ww2ogg.exe');
const WW2OGG_CODEBOOKS = join(TOOL_DIR, 'bin', 'ww2ogg', 'packed_codebooks_aoTuV_603.bin');

let cdnLzhamUncompress = null;
const attemptedPackageDownloads = new Set();

function usage() {
  return `Usage: node tools/export-wwise-event-folders.mjs [options]

Builds a reverse Wwise sound map from log/wwise-soundbank-index.json.

Options:
  --query <text>       Keep events/WEMs whose name/path/bank contains text. Repeatable.
  --regex <pattern>    Keep events/WEMs matching a JavaScript regex.
  --bank <name>        Keep events that reference this bank. Repeatable.
  --limit <n>          Limit selected event rows after filtering.
  --include-empty      Include events with no resolved WEMs.
  --write-wem          Create organized .wem files via hardlink/copy/extract.
  --decode-ogg         Decode/copy organized .ogg files. Use with filters first.
  --download-missing   Download only selected missing CDN HPKG packages when materializing.
  --no-cdn-trace       Do not scan the CDN resource index for package provenance.
  --index <path>       Override Wwise index path.
  --resource-index <p> Override CDN resource-index.jsonl path.
  --out <dir>          Output directory. Default: cache-extraction/wwise-event-folders
  --help               Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    indexPath: DEFAULT_INDEX_PATH,
    resourceIndexPath: DEFAULT_RESOURCE_INDEX_PATH,
    outDir: DEFAULT_OUT_DIR,
    queries: [],
    banks: [],
    regexes: [],
    limit: 0,
    includeEmpty: false,
    writeWem: false,
    decodeOgg: false,
    downloadMissing: false,
    cdnTrace: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--query' || arg === '-q') options.queries.push(next());
    else if (arg === '--regex') options.regexes.push(new RegExp(next(), 'i'));
    else if (arg === '--bank') options.banks.push(next().toLowerCase());
    else if (arg === '--limit') options.limit = Math.max(0, Number(next()) || 0);
    else if (arg === '--include-empty') options.includeEmpty = true;
    else if (arg === '--write-wem') options.writeWem = true;
    else if (arg === '--decode-ogg') options.decodeOgg = true;
    else if (arg === '--download-missing') options.downloadMissing = true;
    else if (arg === '--no-cdn-trace') options.cdnTrace = false;
    else if (arg === '--index') options.indexPath = resolve(next());
    else if (arg === '--resource-index') options.resourceIndexPath = resolve(next());
    else if (arg === '--out') options.outDir = resolve(next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.queries = options.queries.map((value) => value.toLowerCase());
  return options;
}

function repoRelative(filePath) {
  const text = String(filePath || '');
  if (!text) return '';
  const resolved = isAbsolute(text) ? text : resolve(text);
  const rel = relative(REPO_ROOT, resolved);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return text.replace(/\\/g, '/');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function walkFiles(root, predicate, out = []) {
  if (!root || !existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && predicate(fullPath)) out.push(fullPath);
    }
  }
  return out;
}

function localWemRoots(index) {
  const roots = [
    ...(index.roots || []),
    index.root,
    join(REPO_ROOT, 'cache-extraction', 'wwise-pak-extract', 'Windows', 'base'),
    join(REPO_ROOT, 'cache-extraction', 'wwise-pak-extract', 'extra-dirs'),
  ].filter(Boolean);
  return [...new Set(roots.map((root) => resolve(root)).filter((root) => existsSync(root)))];
}

function localWemScore(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  let score = 0;
  if (normalized.includes('/wwise-pak-extract/windows/base/')) score += 100;
  if (normalized.includes('/generatedsoundbanks/windows/base/')) score += 90;
  if (normalized.includes('/wwise-pak-extract/')) score += 20;
  return score;
}

function findLocalWemFiles(index, wemIds) {
  const ids = new Set([...wemIds].map(String));
  const found = new Map();
  if (!ids.size) return found;
  for (const root of localWemRoots(index)) {
    const matches = walkFiles(root, (filePath) => {
      if (extname(filePath).toLowerCase() !== '.wem') return false;
      const id = basename(filePath, extname(filePath));
      return ids.has(id);
    });
    for (const filePath of matches) {
      const id = basename(filePath, extname(filePath));
      const previous = found.get(id);
      if (!previous || localWemScore(filePath) > localWemScore(previous)) found.set(id, filePath);
    }
  }
  return found;
}

function decodeXmlAttr(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlAttr(attrText, name) {
  const re = new RegExp(`${name}="([^"]*)"`);
  const match = re.exec(attrText);
  return match ? decodeXmlAttr(match[1]) : '';
}

function collectSoundbanksInfo(index) {
  const eventPaths = new Map();
  const eventFiles = new Map();
  for (const [eventName, event] of Object.entries(index.events || {})) {
    if (event.path) eventPaths.set(eventName, event.path);
  }

  const roots = [...new Set([...(index.roots || []), index.root].filter(Boolean))];
  for (const root of roots) {
    const xmlFiles = walkFiles(root, (filePath) => extname(filePath).toLowerCase() === '.xml');
    for (const xmlPath of xmlFiles) {
      let content;
      try {
        content = readFileSync(xmlPath, 'utf8');
      } catch {
        continue;
      }
      if (!content.includes('<SoundBanksInfo')) continue;
      const eventRe = /<Event\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Event>)/g;
      let match;
      while ((match = eventRe.exec(content))) {
        const attrs = match[1];
        const body = match[2] || '';
        const name = xmlAttr(attrs, 'Name');
        if (!name) continue;
        const objectPath = xmlAttr(attrs, 'ObjectPath');
        if (objectPath) eventPaths.set(name, objectPath);
        const refs = parseEventFileRefs(body);
        if (refs.length) {
          const existing = eventFiles.get(name) || [];
          const seen = new Set(existing.map((ref) => String(ref.id)));
          for (const ref of refs) {
            if (seen.has(String(ref.id))) continue;
            seen.add(String(ref.id));
            existing.push(ref);
          }
          eventFiles.set(name, existing);
        }
      }
    }
  }
  return { eventPaths, eventFiles };
}

function parseEventFileRefs(eventBody) {
  const refs = [];
  const sections = [
    { tag: 'ReferencedStreamedFiles', streamed: true },
    { tag: 'ExcludedMemoryFiles', streamed: true },
    { tag: 'IncludedMemoryFiles', streamed: false },
  ];
  for (const section of sections) {
    const sectionRe = new RegExp(`<${section.tag}>\\s*([\\s\\S]*?)<\\/${section.tag}>`, 'g');
    let sectionMatch;
    while ((sectionMatch = sectionRe.exec(eventBody))) {
      collectFileRefsFromBlock(sectionMatch[1], section.streamed, refs);
    }
  }
  if (!refs.length) collectFileRefsFromBlock(eventBody, true, refs);
  return refs;
}

function collectFileRefsFromBlock(block, streamed, refs) {
  const fileRe = /<File\s+([^>]*?)>([\s\S]*?)<\/File>/g;
  let match;
  while ((match = fileRe.exec(block))) {
    const id = xmlAttr(match[1], 'Id');
    if (!/^\d+$/.test(id)) continue;
    const body = match[2] || '';
    const shortName = decodeXmlAttr((body.match(/<ShortName>([^<]*)<\/ShortName>/) || [])[1] || `${id}.wem`);
    const sourcePath = decodeXmlAttr((body.match(/<Path>([^<]*)<\/Path>/) || [])[1] || '');
    refs.push({ id: String(id), shortName, sourcePath, streamed });
  }
}

function cleanSegment(segment, fallback = 'unnamed', maxLength = 96) {
  const cleaned = String(segment || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const value = cleaned || fallback;
  return value.slice(0, maxLength);
}

function eventSegments(eventName, objectPath) {
  const raw = String(objectPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let segments = raw ? raw.split('/').filter(Boolean) : [];
  if (segments[0]?.toLowerCase() === 'events') segments = segments.slice(1);
  if (segments.length === 0) {
    const first = String(eventName || 'unknown').split(/[_/\\]/).find(Boolean) || 'unknown';
    segments = ['unknown-object-path', first, eventName];
  } else if (segments[segments.length - 1] !== eventName) {
    segments.push(eventName);
  }
  return segments.map((segment) => cleanSegment(segment));
}

function selectedEventRecords(index, soundbanksInfo, options) {
  const records = [];
  const { eventPaths, eventFiles } = soundbanksInfo;
  for (const [eventName, event] of Object.entries(index.events || {})) {
    const directRefs = eventFiles.get(eventName) || [];
    const fallbackWemIds = [...(event.wems?.streamed || []), ...(event.wems?.inMemory || [])].map((id) => String(id));
    const wemRefs = directRefs.length
      ? directRefs.map((ref) => ({ ...ref, traceMode: 'soundbanksinfo' }))
      : fallbackWemIds.map((id) => ({ id, shortName: '', sourcePath: '', streamed: index.wems?.[id]?.streamed === true, traceMode: 'index-fallback' }));
    if (!options.includeEmpty && wemRefs.length === 0) continue;
    if (options.banks.length) {
      const bankSet = new Set((event.banks || []).map((bank) => String(bank).toLowerCase()));
      if (!options.banks.some((bank) => bankSet.has(bank))) continue;
    }

    const objectPath = eventPaths.get(eventName) || event.path || '';
    const wems = wemRefs.map((ref) => index.wems?.[ref.id]).filter(Boolean);
    const haystack = [
      eventName,
      objectPath,
      ...(event.banks || []),
      ...wemRefs.map((ref) => ref.id),
      ...wemRefs.map((ref) => ref.shortName || ''),
      ...wemRefs.map((ref) => ref.sourcePath || ''),
      ...wems.map((wem) => wem.name || ''),
    ].join('\n').toLowerCase();
    if (options.queries.length && !options.queries.every((query) => haystack.includes(query))) continue;
    if (options.regexes.length && !options.regexes.every((regex) => regex.test(haystack))) continue;

    records.push({ eventName, event, objectPath, wemRefs, directMapped: directRefs.length > 0 });
    if (options.limit && records.length >= options.limit) break;
  }
  return records;
}

async function loadCdnWemTrace(resourceIndexPath, wemIds) {
  const ids = new Set([...wemIds].map(String));
  const trace = new Map();
  if (!ids.size || !existsSync(resourceIndexPath)) return trace;
  const stream = createReadStream(resourceIndexPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('.wem') || !line.includes('GeneratedSoundBanks')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const match = /(?:^|\/)(\d+)\.wem$/i.exec(String(row.path || row.name || ''));
    if (!match || !ids.has(match[1])) continue;
    const existing = trace.get(match[1]);
    const currentScore = cdnScore(row);
    if (!existing || currentScore > existing.score) {
      trace.set(match[1], { score: currentScore, row });
    }
  }
  return new Map([...trace.entries()].map(([id, value]) => [id, value.row]));
}

function cdnScore(row) {
  const path = String(row.path || '').toLowerCase();
  let score = 0;
  if (path.includes('/windows/base/')) score += 100;
  else if (path.includes('/windows/')) score += 80;
  if (row.fullDownloaded) score += 10;
  return score;
}

function materializedFileName(eventName, wemId, wemName, ext) {
  const cleanWemName = String(wemName || `${wemId}.wem`).replace(/\.(wem|wav|ogg|mp3)$/i, '');
  return cleanSegment(`${wemId}__${cleanWemName}__${eventName}`, String(wemId), 170) + ext;
}

function ensureDir(directoryPath) {
  mkdirSync(directoryPath, { recursive: true });
}

function hardlinkOrCopy(sourcePath, targetPath) {
  if (existsSync(targetPath) && statSync(targetPath).size > 0) return 'already';
  ensureDir(dirname(targetPath));
  try {
    linkSync(sourcePath, targetPath);
    return 'hardlink';
  } catch {
    copyFileSync(sourcePath, targetPath);
    return 'copy';
  }
}

function safePathUnder(root, relativePath) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, normalizeCdnMemberPath(relativePath));
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolvedPath;
}

function normalizeCdnMemberPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function readCdnCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  const bytes = buffer.subarray(start, stop);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  return { text: iconv.decode(bytes, 'gb18030'), encoding: 'gb18030' };
}

function getCdnLzhamUncompress() {
  if (cdnLzhamUncompress) return cdnLzhamUncompress;
  if (!existsSync(LZHAM_DLL)) throw new Error(`LZHAM DLL not found: ${LZHAM_DLL}`);
  const library = koffi.load(LZHAM_DLL);
  cdnLzhamUncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  return cdnLzhamUncompress;
}

function decodeCdnHpkgIndex(hpkg) {
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
  if (payloadStart + payloadSize > hpkg.length) throw new Error('HPKG payload extends beyond file size');
  const index = Buffer.alloc(indexSize);
  const outputLength = [indexSize >>> 0];
  const status = getCdnLzhamUncompress()(index, outputLength, hpkg.subarray(packedStart + 4, payloadStart), (packedIndexSize - 4) >>> 0);
  if (status !== 0) throw new Error(`HPKG index LZHAM decode failed: ${status}`);
  const recordSize = indexSize / count;
  const records = [];
  for (let row = 0; row < count; row += 1) {
    const base = row * recordSize;
    const pathInfo = readCdnCString(index, base + 4, base + 260);
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
  return { count, indexSize, packedIndexSize, payloadSize, payloadStart, recordSize, records };
}

function findCdnLocalPackage(packageName, packageSize = 0) {
  const cleanName = String(packageName || '').trim();
  if (!cleanName || /[\\/]/.test(cleanName) || !existsSync(CDN_DOWNLOAD_DIR)) return null;
  const candidates = readdirSync(CDN_DOWNLOAD_DIR)
    .filter((name) => name.endsWith(`_${cleanName}.hpkg`) || name === `${cleanName}.hpkg`)
    .map((name) => join(CDN_DOWNLOAD_DIR, name));
  return candidates.find((candidate) => !packageSize || statSync(candidate).size === Number(packageSize)) || candidates[0] || null;
}

function ensureCdnPackageDownloaded(cdnRow, options) {
  if (!options.downloadMissing) return false;
  const packageName = String(cdnRow?.packageName || '').trim();
  if (!packageName || attemptedPackageDownloads.has(packageName)) return false;
  attemptedPackageDownloads.add(packageName);
  execFileSync(process.execPath, [
    MIRROR_ONLINE_HPKG_SCRIPT,
    '--download',
    '--concurrency', '1',
    '--limit', '1',
    '--search', packageName,
    '--timeout-ms', '120000',
  ], { cwd: REPO_ROOT, stdio: 'pipe', windowsHide: true, timeout: 600_000 });
  return true;
}

function extractCdnRawWemToCache(cdnRow, options) {
  const packageName = String(cdnRow?.packageName || '').trim();
  const memberPath = normalizeCdnMemberPath(cdnRow?.path);
  if (!packageName || !memberPath) return { status: 'cdn-trace-missing', path: '' };
  if (!/\.wem$/i.test(memberPath)) return { status: 'cdn-not-wem', path: '' };
  const extractedPath = safePathUnder(CDN_HPKG_EXTRACTED_DIR, `${packageName}/${memberPath}`);
  if (!extractedPath) return { status: 'cdn-invalid-output-path', path: '' };
  if (existsSync(extractedPath) && statSync(extractedPath).size > 0) return { status: 'cdn-cache', path: extractedPath };

  let hpkgPath = findCdnLocalPackage(packageName, cdnRow.packageSize || 0);
  if (!hpkgPath && options.downloadMissing) {
    try {
      ensureCdnPackageDownloaded(cdnRow, options);
    } catch (err) {
      return { status: `cdn-download-failed: ${String(err?.message || err)}`, path: '' };
    }
    hpkgPath = findCdnLocalPackage(packageName, cdnRow.packageSize || 0);
  }
  if (!hpkgPath) return { status: 'cdn-package-missing', path: '' };

  try {
    const hpkg = readFileSync(hpkgPath);
    const decoded = decodeCdnHpkgIndex(hpkg);
    const record = decoded.records.find((entry) => entry.path.toLowerCase() === memberPath.toLowerCase());
    if (!record) return { status: 'cdn-member-missing', path: '' };
    const storedStart = decoded.payloadStart + record.payloadOffset;
    const storedEnd = storedStart + record.storedSize;
    if (storedEnd > hpkg.length) return { status: 'cdn-member-out-of-range', path: '' };
    if (record.memberHeaderSize < 0 || record.memberHeaderSize > 64) return { status: `cdn-bad-member-header: ${record.memberHeaderSize}`, path: '' };
    const raw = hpkg.subarray(storedStart + record.memberHeaderSize, storedStart + record.memberHeaderSize + record.originalSize);
    ensureDir(dirname(extractedPath));
    writeFileSync(extractedPath, raw);
    return { status: 'cdn-extract', path: extractedPath };
  } catch (err) {
    return { status: `cdn-extract-failed: ${String(err?.message || err)}`, path: '' };
  }
}

function writeRawWem(wemId, wemEntry, sourcePath, targetPath, cdnRow, options) {
  if (existsSync(targetPath) && statSync(targetPath).size > 0) return 'already';
  ensureDir(dirname(targetPath));
  if (sourcePath && existsSync(sourcePath)) return hardlinkOrCopy(sourcePath, targetPath);
  if (wemEntry?.file && existsSync(wemEntry.file)) return hardlinkOrCopy(wemEntry.file, targetPath);
  const cdnSource = extractCdnRawWemToCache(cdnRow, options);
  if (cdnSource.path && existsSync(cdnSource.path)) return `${cdnSource.status}+${hardlinkOrCopy(cdnSource.path, targetPath)}`;
  const buffer = getWemBuffer(wemId);
  if (!buffer) return 'missing';
  writeFileSync(targetPath, buffer);
  return 'extract';
}

function writeDecodedOgg(wemId, sourcePath, targetPath, cdnRow, options) {
  if (existsSync(targetPath) && statSync(targetPath).size > 0) return 'already';
  ensureDir(dirname(targetPath));
  if (!sourcePath || !existsSync(sourcePath)) {
    const cdnSource = extractCdnRawWemToCache(cdnRow, options);
    if (cdnSource.path && existsSync(cdnSource.path)) sourcePath = cdnSource.path;
  }
  if (sourcePath && existsSync(sourcePath)) {
    if (!existsSync(WW2OGG_EXE)) return 'ww2ogg-exe-missing';
    if (!existsSync(WW2OGG_CODEBOOKS)) return 'ww2ogg-codebooks-missing';
    const tempDir = mkdtempSync(join(tmpdir(), `jx3-wwise-${wemId}-`));
    const tempWem = join(tempDir, `${wemId}.wem`);
    const tempOgg = join(tempDir, `${wemId}.ogg`);
    try {
      copyFileSync(sourcePath, tempWem);
      execFileSync(WW2OGG_EXE, [tempWem, '-o', tempOgg, '--pcb', WW2OGG_CODEBOOKS], { stdio: ['ignore', 'ignore', 'pipe'] });
      if (existsSync(tempOgg) && statSync(tempOgg).size > 0) {
        copyFileSync(tempOgg, targetPath);
      }
    } catch (err) {
      return `ww2ogg-failed: ${err?.stderr?.toString()?.trim() || err?.message || err}`;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    return existsSync(targetPath) && statSync(targetPath).size > 0 ? 'decode-temp' : 'ww2ogg-no-output';
  }
  const decoded = decodeWemToOgg(wemId);
  if (decoded.error) return decoded.error;
  if (decoded.oggPath && existsSync(decoded.oggPath)) return hardlinkOrCopy(decoded.oggPath, targetPath);
  writeFileSync(targetPath, decoded.oggBuffer);
  return decoded.cached ? 'cache-buffer' : 'decode-buffer';
}

function makeManifestRows(index, records, cdnTrace, localWemFiles, options) {
  const rows = [];
  for (const record of records) {
    const segments = eventSegments(record.eventName, record.objectPath);
    const eventDir = join(options.outDir, 'by-event', ...segments);
    const logicalFolder = segments.join('/');
    const wemRefs = record.wemRefs.length ? record.wemRefs : [{ id: '', shortName: '', sourcePath: '', streamed: null, traceMode: 'none' }];
    for (const wemRef of wemRefs) {
      const wemId = wemRef.id;
      const wemEntry = wemId ? index.wems?.[wemId] || {} : {};
      const cdn = wemId ? cdnTrace.get(wemId) : null;
      const localWemPath = wemId ? wemEntry.file || localWemFiles.get(wemId) || '' : '';
      const wemName = wemRef.shortName || wemEntry.name || (wemId ? `${wemId}.wem` : '');
      const row = {
        eventName: record.eventName,
        eventId: record.event.id ?? null,
        objectPath: record.objectPath || '',
        logicalFolder,
        banks: record.event.banks || [],
        wemId: wemId || null,
        wemName,
        wwiseSourcePath: wemRef.sourcePath || '',
        traceMode: wemRef.traceMode,
        streamed: wemId ? wemRef.streamed === true || wemEntry.streamed === true : null,
        wemBank: wemEntry.bank || '',
        localWemPath: repoRelative(localWemPath),
        cdnPath: cdn?.path || '',
        cdnPackageName: cdn?.packageName || '',
        cdnPackageRemotePath: cdn?.packageRemotePath || '',
        cdnFullDownloaded: cdn ? Boolean(cdn.fullDownloaded) : null,
      };
      if (wemId && options.writeWem) {
        const targetPath = join(eventDir, materializedFileName(record.eventName, wemId, wemName, '.wem'));
        row.materializedWemPath = repoRelative(targetPath);
        row.materializedWemStatus = writeRawWem(wemId, wemEntry, localWemPath, targetPath, cdn, options);
      }
      if (wemId && options.decodeOgg) {
        const targetPath = join(eventDir, materializedFileName(record.eventName, wemId, wemName, '.ogg'));
        const materializedWemPath = row.materializedWemPath ? resolve(REPO_ROOT, row.materializedWemPath) : '';
        const decodeSourcePath = localWemPath || (materializedWemPath && existsSync(materializedWemPath) ? materializedWemPath : '');
        row.materializedOggPath = repoRelative(targetPath);
        row.materializedOggStatus = writeDecodedOgg(wemId, decodeSourcePath, targetPath, cdn, options);
      }
      rows.push(row);
    }
  }
  return rows;
}

function writeOutputs(rows, options, summary) {
  ensureDir(options.outDir);
  const jsonlPath = join(options.outDir, 'manifest.jsonl');
  const jsonPath = join(options.outDir, 'summary.json');
  const tsvPath = join(options.outDir, 'manifest.tsv');

  writeFileSync(jsonlPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  const headers = [
    'eventName', 'eventId', 'objectPath', 'logicalFolder', 'banks', 'wemId', 'wemName',
    'wwiseSourcePath', 'traceMode', 'streamed', 'wemBank', 'localWemPath', 'cdnPath', 'cdnPackageName', 'cdnPackageRemotePath',
    'materializedWemPath', 'materializedWemStatus', 'materializedOggPath', 'materializedOggStatus',
  ];
  const tsv = [headers.join('\t')];
  for (const row of rows) {
    tsv.push(headers.map((header) => {
      const value = row[header];
      return Array.isArray(value) ? value.join(',') : String(value ?? '').replace(/[\r\n\t]+/g, ' ');
    }).join('\t'));
  }
  writeFileSync(tsvPath, tsv.join('\n') + '\n');
  writeFileSync(jsonPath, JSON.stringify({ ...summary, outputs: {
    manifestJsonl: repoRelative(jsonlPath),
    manifestTsv: repoRelative(tsvPath),
    summary: repoRelative(jsonPath),
    eventRoot: repoRelative(join(options.outDir, 'by-event')),
  } }, null, 2));
  return { jsonlPath, jsonPath, tsvPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!existsSync(options.indexPath)) throw new Error(`Wwise index not found: ${options.indexPath}`);

  const index = readJson(options.indexPath);
  const soundbanksInfo = collectSoundbanksInfo(index);
  const records = selectedEventRecords(index, soundbanksInfo, options);
  const selectedWemIds = new Set(records.flatMap((record) => record.wemRefs.map((ref) => ref.id)).filter(Boolean).map(String));
  const localWemFiles = findLocalWemFiles(index, selectedWemIds);
  const cdnTrace = options.cdnTrace ? await loadCdnWemTrace(options.resourceIndexPath, selectedWemIds) : new Map();
  const rows = makeManifestRows(index, records, cdnTrace, localWemFiles, options);
  const eventsWithWems = records.filter((record) => record.wemRefs.length > 0).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    index: repoRelative(options.indexPath),
    resourceIndex: options.cdnTrace ? repoRelative(options.resourceIndexPath) : null,
    filters: {
      queries: options.queries,
      banks: options.banks,
      regexes: options.regexes.map((regex) => regex.source),
      limit: options.limit || null,
      includeEmpty: options.includeEmpty,
    },
    indexStats: index.stats || {},
    selectedEvents: records.length,
    selectedEventsWithWems: eventsWithWems,
    selectedWems: selectedWemIds.size,
    localWemFiles: localWemFiles.size,
    manifestRows: rows.length,
    objectPathsRecovered: soundbanksInfo.eventPaths.size,
    directMappedEvents: soundbanksInfo.eventFiles.size,
    selectedDirectMappedEvents: records.filter((record) => record.directMapped).length,
    cdnTraceRows: cdnTrace.size,
    wroteWems: options.writeWem,
    decodedOggs: options.decodeOgg,
    downloadMissing: options.downloadMissing,
  };
  const outputs = writeOutputs(rows, options, summary);
  console.log(`Selected events: ${summary.selectedEvents} (${summary.selectedEventsWithWems} with WEMs)`);
  console.log(`Direct XML-mapped selected events: ${summary.selectedDirectMappedEvents}`);
  console.log(`Selected WEM ids: ${summary.selectedWems}`);
  console.log(`Local WEM files matched: ${summary.localWemFiles}`);
  console.log(`Object paths known: ${summary.objectPathsRecovered}`);
  console.log(`CDN traces matched: ${summary.cdnTraceRows}`);
  console.log(`Wrote ${repoRelative(outputs.jsonPath)}`);
  console.log(`Wrote ${repoRelative(outputs.tsvPath)}`);
  console.log(`Wrote ${repoRelative(outputs.jsonlPath)}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});