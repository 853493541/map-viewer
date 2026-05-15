// Bulk-extract entries at given dirHash list (mirrors extract-wwise-pak-bulk.mjs).
import { readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const TARGETS = process.argv.slice(2).map(Number);
if (!TARGETS.length) { console.error('usage: node extract-by-dirhash.mjs <dh1> <dh2> ...'); process.exit(1); }

const lib = koffi.load(LZHAM_DLL);
const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
const CACHE_ENTRY_MARKER = 0x0000E7A4;

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

const targetSet = new Set(TARGETS);
const matches = []; // {h1, h2, dirHash}
for (const f of readdirSync(DAT_DIR).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h2 = b.readBigUInt64LE(off + 8);
    const dh = Number((h2 >> 40n) & 0x3FFFFFn);
    if (targetSet.has(dh)) matches.push({ h1: b.readBigUInt64LE(off), h2, dirHash: dh });
  }
}
console.log('Matches:', matches.length);

const fdCache = new Map();
function readDatRange(datIndex, offset, length) {
  let fd = fdCache.get(datIndex);
  if (fd === undefined) { fd = openSync(join(DAT_DIR, datIndex + '.dat'), 'r'); fdCache.set(datIndex, fd); }
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return buf;
}
function expandEntry(ie, comp) {
  if (ie.compType === 0) return comp;
  for (const hSize of [16, 20]) {
    if (comp.length === ie.origSize + hSize && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8);
      const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) return comp.subarray(hSize, hSize + ie.origSize);
    }
  }
  if (ie.compType !== 10) throw new Error('compType ' + ie.compType);
  const payload = comp.subarray(20);
  const out = Buffer.alloc(ie.origSize);
  const outLen = [ie.origSize >>> 0];
  const status = lzhamUncompress(out, outLen, payload, payload.length >>> 0);
  if (status !== 0) throw new Error('lzham ' + status);
  return outLen[0] === out.length ? out : out.subarray(0, outLen[0]);
}

const OUT = resolve('cache-extraction/wwise-pak-extract/extra-dirs');
mkdirSync(OUT, { recursive: true });
let i = 0;
for (const m of matches) {
  const ie = idxMap.get(m.h1);
  if (!ie) continue;
  try {
    const raw = readDatRange(ie.datIndex, ie.offset, ie.compSize);
    const payload = expandEntry(ie, raw);
    const m4 = payload.slice(0, 4).toString('ascii').replace(/[^\x20-\x7e]/g, '_');
    let ext = 'bin';
    if (m4 === 'RIFF') ext = 'wem';
    else if (m4 === 'BKHD') ext = 'bnk';
    else if (payload.slice(0, 4).toString('ascii') === 'OggS') ext = 'ogg';
    const fname = `dh${m.dirHash}_${String(i).padStart(3, '0')}_${m4}_${payload.length}.${ext}`;
    writeFileSync(join(OUT, fname), payload);
    console.log(' ', fname);
    i++;
  } catch (err) { console.warn(' fail', err.message); }
}
for (const fd of fdCache.values()) closeSync(fd);
