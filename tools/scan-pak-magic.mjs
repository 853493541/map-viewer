// Sample first 8 bytes of every FN entry to find FMOD/Wwise magic bytes,
// regardless of dirHash naming. Self-contained.
import { readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';

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

const byDir = new Map();
for (const e of fnEntries) {
  if (!byDir.has(e.dirHash)) byDir.set(e.dirHash, []);
  byDir.get(e.dirHash).push(e);
}
console.log('Distinct dirHashes:', byDir.size);

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

function expandEntryHead(ie, comp, headBytes) {
  if (ie.compType === 0) return comp.subarray(0, Math.min(headBytes, comp.length));
  for (const hSize of [16, 20]) {
    if (comp.length === ie.origSize + hSize && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8);
      const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) return comp.subarray(hSize, hSize + Math.min(headBytes, ie.origSize));
    }
  }
  if (ie.compType !== 10) return null;
  const payload = comp.subarray(20);
  const out = Buffer.alloc(ie.origSize);
  const outLen = [ie.origSize >>> 0];
  const status = lzhamUncompress(out, outLen, payload, payload.length >>> 0);
  if (status !== 0) return null;
  return out.subarray(0, Math.min(headBytes, outLen[0]));
}

const magicByDir = new Map();
const fmodHits = [];

let processed = 0;
for (const [dh, entries] of byDir) {
  const sample = entries.slice(0, Math.min(3, entries.length));
  for (const e of sample) {
    const ie = idxMap.get(e.h1);
    if (!ie) continue;
    try {
      const raw = readDatRange(ie.datIndex, ie.offset, ie.compSize);
      const head = expandEntryHead(ie, raw, 8);
      if (!head || head.length < 4) continue;
      const m4 = head.subarray(0, 4).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
      if (!magicByDir.has(dh)) magicByDir.set(dh, new Map());
      const inner = magicByDir.get(dh);
      inner.set(m4, (inner.get(m4) || 0) + 1);
      if (/FSB|FEV|FMOD/i.test(m4)) {
        fmodHits.push({ dh, magic: m4, origSize: ie.origSize, h1: e.h1.toString(16), h2: e.h2.toString(16) });
      }
    } catch (err) {}
  }
  processed++;
  if (processed % 500 === 0) console.log(`  ${processed}/${byDir.size} dirs scanned, fmodHits=${fmodHits.length}`);
}

const overall = new Map();
for (const inner of magicByDir.values()) for (const [m, c] of inner) overall.set(m, (overall.get(m) || 0) + c);

console.log('\n=== Overall magic histogram (top 30) ===');
for (const [m, c] of [...overall.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${JSON.stringify(m)}: ${c}`);
}
console.log('\n=== FMOD/FSB hits:', fmodHits.length, '===');
for (const h of fmodHits.slice(0, 100)) console.log(' ', h);

const audioDirs = [...magicByDir.entries()].filter(([, m]) => [...m.keys()].some((mm) => /RIFF|BKHD|FSB|OggS|FEV/i.test(mm)));
console.log('\n=== Dirs with audio-looking magic:', audioDirs.length, '===');
for (const [dh, inner] of audioDirs.slice(0, 20)) console.log(' dh=', dh, [...inner.entries()]);

writeFileSync('log/pak-magic-histogram.json', JSON.stringify({
  overall: [...overall.entries()].sort((a, b) => b[1] - a[1]),
  fmodHits,
  audioDirs: audioDirs.map(([dh, inner]) => ({ dh, magics: [...inner.entries()], totalCount: byDir.get(dh).length })),
}, null, 2));
console.log('\nWrote log/pak-magic-histogram.json');

for (const fd of fdCache.values()) closeSync(fd);
