// Extract every PakV5 entry whose parent dirHash equals the dirHash of
// `data/wwiseaudio/generatedsoundbanks/windows/base`. We don't know the
// original filenames, so we name files by sequence index plus magic, e.g.
// `0042_RIFF_24734.wem`. Pair them later by exact byte size against the
// inMem sizes carried in each Sound HIRC entry.
import iconv from 'iconv-lite';
import { readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const OUT_DIR = resolve('cache-extraction/wwise-pak-extract/Windows/base');
mkdirSync(OUT_DIR, { recursive: true });

const lib = koffi.load(LZHAM_DLL);
const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');

const CACHE_ENTRY_MARKER = 0x0000E7A4;
const RAW_HEADER_16 = 16;
const RAW_HEADER_20 = 20;
const LZHAM_HEADER_SIZE = 20;

function djb2(s) { let h = 5381; for (const c of iconv.encode(s, 'gbk')) h = ((h * 33) + c) & 0x3fffff; return h >>> 0; }
const TARGET_DIR_HASH = djb2('data/wwiseaudio/generatedsoundbanks/windows/base');
console.log('Target dirHash:', TARGET_DIR_HASH);

// Build IDX map (h1 → entry)
const idxBytes = readFileSync(join(DAT_DIR, '0.idx'));
const idxMap = new Map();
for (let off = 36; off + 36 <= idxBytes.length; off += 36) {
  const h1 = idxBytes.readBigUInt64LE(off);
  const offset = Number(idxBytes.readBigUInt64LE(off + 8));
  const origSize = idxBytes.readUInt32LE(off + 16);
  const compSize = idxBytes.readUInt32LE(off + 20);
  const meta = idxBytes.readUInt32LE(off + 32);
  idxMap.set(h1, { offset, origSize, compSize, meta, datIndex: (meta >>> 12) & 0xf, compType: meta & 0xff });
}

// Walk FN files, collect entries with matching dirHash
const matches = [];
for (const f of readdirSync(DAT_DIR).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h2 = b.readBigUInt64LE(off + 8);
    const dirH = Number(h2 >> 40n);
    if (dirH === TARGET_DIR_HASH) {
      matches.push({ h1: b.readBigUInt64LE(off), h2 });
    }
  }
}
console.log('Matches:', matches.length);

function readDatRange(datIndex, offset, length) {
  const fd = openSync(join(DAT_DIR, datIndex + '.dat'), 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return buf;
  } finally { closeSync(fd); }
}

function expandEntry(ie, comp) {
  if (ie.compType === 0) return comp;
  // raw-wrapped check
  for (const hSize of [RAW_HEADER_16, RAW_HEADER_20]) {
    if (comp.length === ie.origSize + hSize && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8);
      const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) return comp.subarray(hSize, hSize + ie.origSize);
    }
  }
  if (ie.compType !== 10) throw new Error('unknown compType ' + ie.compType);
  const payload = comp.subarray(LZHAM_HEADER_SIZE);
  const out = Buffer.alloc(ie.origSize);
  const outLen = [ie.origSize >>> 0];
  const status = lzhamUncompress(out, outLen, payload, payload.length >>> 0);
  if (status !== 0) throw new Error('lzham status ' + status);
  return outLen[0] === out.length ? out : out.subarray(0, outLen[0]);
}

let written = 0;
let skippedFailed = 0;
const sizeIndex = []; // {sizeBytes, kind, file}
for (let i = 0; i < matches.length; i++) {
  const ie = idxMap.get(matches[i].h1);
  if (!ie) continue;
  let raw;
  try {
    raw = readDatRange(ie.datIndex, ie.offset, ie.compSize);
  } catch (err) {
    skippedFailed++; continue;
  }
  let payload;
  try {
    payload = expandEntry(ie, raw);
  } catch (err) {
    skippedFailed++; continue;
  }
  const magic4 = payload.slice(0, 4).toString('ascii');
  const isRiff = magic4 === 'RIFF';
  const isBkhd = magic4 === 'BKHD';
  if (!isRiff && !isBkhd) continue; // ignore other types
  const ext = isRiff ? 'wem' : 'bnk';
  const idxSeq = String(i).padStart(4, '0');
  const fname = `pak_${idxSeq}_${payload.length}.${ext}`;
  const outPath = join(OUT_DIR, fname);
  if (!existsSync(outPath) || statSync(outPath).size !== payload.length) {
    writeFileSync(outPath, payload);
  }
  sizeIndex.push({ size: payload.length, kind: ext, file: fname, h1: matches[i].h1.toString(16) });
  written++;
  if (written % 50 === 0) console.log('  written', written);
}
console.log('Wrote', written, 'failed', skippedFailed);
writeFileSync(join(OUT_DIR, '_pak-index.json'), JSON.stringify(sizeIndex, null, 2));
console.log('Index:', join(OUT_DIR, '_pak-index.json'));
