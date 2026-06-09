// Find which directories in the pak host RIFF wems by:
// 1. Scanning IDX for entries with size matching one of TianCe's Sound inMemSizes.
// 2. For each candidate, look up its dirHash via FN.
// 3. Read the payload and check magic == 'RIFF'.
// 4. Report dirHash → count, with examples.
import iconv from 'iconv-lite';
import { readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const lib = koffi.load(LZHAM_DLL);
const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');

const CACHE_ENTRY_MARKER = 0x0000E7A4;

// Sizes (bytes) from TianCe.bnk Sound HIRC entries.
const targetSizes = new Set([24734, 12594, 26115, 21442, 18933, 12791, 18827, 14721]);

const idxBytes = readFileSync(join(DAT_DIR, '0.idx'));
const idxByH1 = new Map();
const candidatesByH1 = new Map();
for (let off = 36; off + 36 <= idxBytes.length; off += 36) {
  const h1 = idxBytes.readBigUInt64LE(off);
  const offset = Number(idxBytes.readBigUInt64LE(off + 8));
  const origSize = idxBytes.readUInt32LE(off + 16);
  const compSize = idxBytes.readUInt32LE(off + 20);
  const meta = idxBytes.readUInt32LE(off + 32);
  const e = { offset, origSize, compSize, meta, datIndex: (meta >>> 12) & 0xf, compType: meta & 0xff };
  idxByH1.set(h1, e);
  if (targetSizes.has(origSize)) candidatesByH1.set(h1, e);
}
console.log('IDX entries matching target sizes:', candidatesByH1.size);

// FN: for each candidate h1, find its h2 (dirHash).
const fnByH1 = new Map();
for (const f of readdirSync(DAT_DIR).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h1 = b.readBigUInt64LE(off);
    if (candidatesByH1.has(h1)) {
      const h2 = b.readBigUInt64LE(off + 8);
      fnByH1.set(h1, h2);
    }
  }
}
console.log('FN matches for candidates:', fnByH1.size);

function readDatRange(datIndex, offset, length) {
  const fd = openSync(join(DAT_DIR, datIndex + '.dat'), 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const n = readSync(fd, buf, read, length - read, offset + read); if (n <= 0) break; read += n; }
    return buf;
  } finally { closeSync(fd); }
}

function expandEntry(ie, comp) {
  if (ie.compType === 0) return comp;
  for (const hSize of [16, 20]) {
    if (comp.length === ie.origSize + hSize && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8); const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) return comp.subarray(hSize, hSize + ie.origSize);
    }
  }
  if (ie.compType !== 10) return null;
  const payload = comp.subarray(20);
  const out = Buffer.alloc(ie.origSize);
  const outLen = [ie.origSize >>> 0];
  const status = lzhamUncompress(out, outLen, payload, payload.length >>> 0);
  if (status !== 0) return null;
  return outLen[0] === out.length ? out : out.subarray(0, outLen[0]);
}

const dirHashHits = new Map();
for (const [h1, ie] of candidatesByH1) {
  const h2 = fnByH1.get(h1);
  if (!h2) continue;
  const dh = Number(h2 >> 40n);
  let raw;
  try { raw = readDatRange(ie.datIndex, ie.offset, ie.compSize); } catch { continue; }
  const exp = expandEntry(ie, raw);
  if (!exp) continue;
  const m = exp.slice(0, 4).toString('ascii');
  if (m !== 'RIFF') continue;
  if (!dirHashHits.has(dh)) dirHashHits.set(dh, { count: 0, sizes: [] });
  const e = dirHashHits.get(dh);
  e.count++;
  if (e.sizes.length < 5) e.sizes.push(ie.origSize);
}
console.log('dirHashes hosting RIFF wems with target sizes:');
for (const [dh, info] of [...dirHashHits.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log('  dirHash=', dh, 'count=', info.count, 'sample sizes=', info.sizes);
}
