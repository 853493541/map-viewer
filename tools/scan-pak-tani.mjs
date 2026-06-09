// Find all .tani files (magic 'GATA') in PakV5.
// Walks every FN entry, decompresses head, keeps GATA hits.
import { readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const OUT_DIR = 'cache-extraction/tani-extract';
const OUT_INDEX = 'log/tani-pak-index.json';
const CACHE_ENTRY_MARKER = 0x0000E7A4;

const lib = koffi.load(LZHAM_DLL);
const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');

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
console.log('IDX entries:', idxMap.size);

const fnEntries = [];
for (const f of readdirSync(DAT_DIR).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h1 = b.readBigUInt64LE(off);
    const h2 = b.readBigUInt64LE(off + 8);
    fnEntries.push({ h1, h2, dirHash: Number((h2 >> 40n) & 0x3FFFFFn) });
  }
}
console.log('FN entries:', fnEntries.length);

const fdCache = new Map();
function readDatRange(datIndex, offset, length) {
  let fd = fdCache.get(datIndex);
  if (fd === undefined) { fd = openSync(join(DAT_DIR, datIndex + '.dat'), 'r'); fdCache.set(datIndex, fd); }
  const buf = Buffer.alloc(length);
  let r = 0;
  while (r < length) { const n = readSync(fd, buf, r, length - r, offset + r); if (n <= 0) break; r += n; }
  return buf;
}
function expandEntry(ie, comp, full = false, headBytes = 8) {
  if (ie.compType === 0) return full ? comp : comp.subarray(0, Math.min(headBytes, comp.length));
  for (const hSize of [16, 20]) {
    if (comp.length === ie.origSize + hSize && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8); const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) {
        return full ? comp.subarray(hSize, hSize + ie.origSize) : comp.subarray(hSize, hSize + Math.min(headBytes, ie.origSize));
      }
    }
  }
  if (ie.compType !== 10) return null;
  const payload = comp.subarray(20);
  const out = Buffer.alloc(ie.origSize);
  const outLen = [ie.origSize >>> 0];
  const s = lzhamUncompress(out, outLen, payload, payload.length >>> 0);
  if (s !== 0) return null;
  const real = outLen[0] === out.length ? out : out.subarray(0, outLen[0]);
  return full ? real : real.subarray(0, Math.min(headBytes, real.length));
}

mkdirSync(OUT_DIR, { recursive: true });
const hits = [];
let scanned = 0, errors = 0, gata = 0;
const t0 = Date.now();
for (const e of fnEntries) {
  scanned++;
  if (scanned % 50000 === 0) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`  ${scanned}/${fnEntries.length} scanned, gata=${gata}, ${(scanned / dt).toFixed(0)}/s`);
  }
  const ie = idxMap.get(e.h1);
  if (!ie) continue;
  // Quick filter: tani files are typically 300B - 500KB.
  if (ie.origSize < 16 || ie.origSize > 2 * 1024 * 1024) continue;
  try {
    const raw = readDatRange(ie.datIndex, ie.offset, ie.compSize);
    const head = expandEntry(ie, raw, false, 4);
    if (!head || head.length < 4) continue;
    if (head.toString('ascii', 0, 4) !== 'GATA') continue;
    gata++;
    // Decompress full
    const full = expandEntry(ie, raw, true);
    if (!full) continue;
    const fname = `tani_${e.dirHash}_${e.h1.toString(16).padStart(16, '0')}.tani`;
    writeFileSync(join(OUT_DIR, fname), full);
    hits.push({
      file: fname,
      dirHash: e.dirHash,
      h1: e.h1.toString(16),
      h2: e.h2.toString(16),
      size: ie.origSize,
    });
  } catch (err) { errors++; }
}
for (const fd of fdCache.values()) closeSync(fd);

console.log(`Done: ${gata} GATA hits, ${errors} errors, ${scanned} scanned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
mkdirSync('log', { recursive: true });
writeFileSync(OUT_INDEX, JSON.stringify({
  scanned, gata, errors, hits,
}, null, 2));
console.log('Wrote', OUT_INDEX, 'and', hits.length, 'tani files to', OUT_DIR);
