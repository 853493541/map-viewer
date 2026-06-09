#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import koffi from 'koffi';
import iconv from 'iconv-lite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const WW2OGG_EXE = join(REPO_ROOT, 'tools', 'bin', 'ww2ogg', 'ww2ogg.exe');
const WW2OGG_CODEBOOKS = join(REPO_ROOT, 'tools', 'bin', 'ww2ogg', 'packed_codebooks_aoTuV_603.bin');

function parseArgs(argv) {
  const args = { hpkg: null, outDir: join(REPO_ROOT, 'cache-extraction', 'online-cdn', 'extracted-audio'), match: '', ogg: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--out') args.outDir = resolve(argv[++i]);
    else if (value === '--wem' || value === '--match') args.match = String(argv[++i] || '');
    else if (value === '--ogg') args.ogg = true;
    else if (value === '--list') args.list = true;
    else if (!args.hpkg) args.hpkg = resolve(value);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  if (!args.hpkg) throw new Error('Usage: node tools/extract-hpkg-audio.mjs <file.hpkg> [--wem 1041767640] [--ogg] [--out dir]');
  return args;
}

function getLzhamUncompress() {
  const library = koffi.load(LZHAM_DLL);
  return library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
}

function readCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  const bytes = buffer.subarray(start, stop);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf8' };
  return { text: iconv.decode(bytes, 'gb18030'), encoding: 'gb18030' };
}

function decodeIndex(hpkg) {
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
  const status = getLzhamUncompress()(index, outputLength, hpkg.subarray(packedStart + 4, payloadStart), (packedIndexSize - 4) >>> 0);
  if (status !== 0) throw new Error(`HPKG index LZHAM decode failed: ${status}`);

  const recordSize = indexSize / count;
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * recordSize;
    const pathInfo = readCString(index, base + 4, base + 260);
    records.push({
      index: index.readUInt32LE(base),
      path: pathInfo.text,
      pathEncoding: pathInfo.encoding,
      originalSize: index.readUInt32LE(base + 280),
      storedSize: index.readUInt32LE(base + 284),
      payloadOffset: index.readUInt32LE(base + 288),
      flags: index.readUInt32LE(base + 292),
    });
  }
  return { count, indexSize, packedIndexSize, payloadSize, payloadStart, recordSize, records };
}

function extractRecord(hpkg, decoded, record, outDir) {
  const storedStart = decoded.payloadStart + record.payloadOffset;
  const storedEnd = storedStart + record.storedSize;
  if (storedEnd > hpkg.length) throw new Error(`Record payload extends beyond file: ${record.path}`);
  const stored = hpkg.subarray(storedStart, storedEnd);
  const memberHeaderSize = record.storedSize - record.originalSize;
  if (memberHeaderSize < 0 || memberHeaderSize > 64) throw new Error(`Unexpected member header size ${memberHeaderSize} for ${record.path}`);
  const raw = stored.subarray(memberHeaderSize, memberHeaderSize + record.originalSize);
  mkdirSync(outDir, { recursive: true });
  const wemPath = join(outDir, basename(record.path));
  writeFileSync(wemPath, raw);
  return {
    record,
    memberHeaderSize,
    wemPath,
    wemSize: raw.length,
    wemHeadAscii: raw.subarray(0, 16).toString('ascii'),
    wemHeadHex: raw.subarray(0, 32).toString('hex'),
  };
}

function decodeOgg(wemPath) {
  if (!existsSync(WW2OGG_EXE)) throw new Error(`ww2ogg.exe not found: ${WW2OGG_EXE}`);
  const oggPath = wemPath.replace(/\.wem$/i, '.ogg');
  execFileSync(WW2OGG_EXE, [wemPath, '-o', oggPath, '--pcb', WW2OGG_CODEBOOKS], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { oggPath, oggSize: statSync(oggPath).size, oggHeadAscii: readFileSync(oggPath).subarray(0, 16).toString('ascii') };
}

const args = parseArgs(process.argv.slice(2));
const hpkg = readFileSync(args.hpkg);
const decoded = decodeIndex(hpkg);
const lowerMatch = args.match.toLowerCase();
const audioRecords = decoded.records.filter((record) => /\.(wem|bnk)$/i.test(record.path));
if (args.list) {
  console.log(JSON.stringify({ hpkg: args.hpkg, ...decoded, records: audioRecords }, null, 2));
  process.exit(0);
}
const record = audioRecords.find((entry) => !lowerMatch || entry.path.toLowerCase().includes(lowerMatch));
if (!record) throw new Error(`No audio record matched ${JSON.stringify(args.match)} in ${args.hpkg}`);
const extracted = extractRecord(hpkg, decoded, record, args.outDir);
const result = { hpkg: args.hpkg, packageSize: hpkg.length, list: { count: decoded.count, payloadStart: decoded.payloadStart }, ...extracted };
if (args.ogg && /\.wem$/i.test(record.path)) Object.assign(result, decodeOgg(extracted.wemPath));
console.log(JSON.stringify(result, null, 2));