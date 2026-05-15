// Verify whether the source IDs from TianCe Sound HIRC entries map to FN
// records when hashed as `<dir>/<id>.wem`.
import iconv from 'iconv-lite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
function djb2(s) { let h = 5381; for (const c of iconv.encode(s, 'gbk')) h = ((h * 33) + c) & 0x3fffff; return h >>> 0; }

const P1 = 0x9e3779b185ebca87n, P2 = 0xc2b2ae3d27d4eb4fn, P3 = 0x165667b19e3779f9n, P4 = 0x85ebca77c2b2ae63n, P5 = 0x27d4eb2f165667c5n;
function u64(v) { return BigInt.asUintN(64, v); }
function rl(v, n) { return u64((v << BigInt(n)) | (v >> (64n - BigInt(n)))); }
function round(a, i) { let v = u64(a + i * P2); v = rl(v, 31); return u64(v * P1); }
function merge(a, v) { return u64(u64(a ^ round(0n, v)) * P1 + P4); }
function xxh64(b) {
  let off = 0, h;
  if (b.length >= 32) {
    let v1 = u64(P1 + P2), v2 = P2, v3 = 0n, v4 = u64(0n - P1);
    while (off <= b.length - 32) {
      v1 = round(v1, b.readBigUInt64LE(off)); off += 8;
      v2 = round(v2, b.readBigUInt64LE(off)); off += 8;
      v3 = round(v3, b.readBigUInt64LE(off)); off += 8;
      v4 = round(v4, b.readBigUInt64LE(off)); off += 8;
    }
    h = u64(rl(v1, 1) + rl(v2, 7) + rl(v3, 12) + rl(v4, 18));
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = P5;
  h = u64(h + BigInt(b.length));
  while (off <= b.length - 8) { const l = round(0n, b.readBigUInt64LE(off)); h = u64(h ^ l); h = u64(rl(h, 27) * P1 + P4); off += 8; }
  if (off <= b.length - 4) { h = u64(h ^ (BigInt(b.readUInt32LE(off)) * P1)); h = u64(rl(h, 23) * P2 + P3); off += 4; }
  while (off < b.length) { h = u64(h ^ (BigInt(b[off]) * P5)); h = u64(rl(h, 11) * P1); off += 1; }
  h = u64(h ^ (h >> 33n)); h = u64(h * P2); h = u64(h ^ (h >> 29n)); h = u64(h * P3); h = u64(h ^ (h >> 32n)); return h;
}
const MASK40 = (1n << 40n) - 1n;
function h2(parent, full) {
  const dh = BigInt(djb2(parent) >>> 0);
  const fh = xxh64(iconv.encode(full, 'gbk'));
  return u64((dh << 40n) | (fh & MASK40));
}

const fnMap = new Map();
for (const f of readdirSync(dir).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(dir, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h1 = b.readBigUInt64LE(off);
    const hh2 = b.readBigUInt64LE(off + 8);
    if (!fnMap.has(hh2)) fnMap.set(hh2, h1);
  }
}
console.log('fnMap size:', fnMap.size);

const ids = [5509581, 80672905, 307459863, 813169054, 616148047, 698142795, 255810322, 763293796];
const extensions = ['.wem', '.WEM', '.bnk', '.BNK'];
const dirs = [
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/SFX/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/Voice/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/Streamed/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/Cache/',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/Media/',
  'data/Wwiseaudio/GeneratedSoundBanks/',
  'data/Wwiseaudio/',
  'data/Wwiseaudio/Windows/base/',
];
for (const id of ids) {
  // Try as decimal, hex, padded
  const names = [
    String(id), id.toString(16), id.toString(16).padStart(8, '0'),
    String(id).padStart(10, '0'),
    `wem_${id}`, `${id}_wem`,
  ];
  for (const d of dirs) {
    for (const n of names) {
      for (const e of extensions) {
        const p = d + n + e;
        const lower = p.toLowerCase();
        const lp = lower.lastIndexOf('/');
        const h = h2(lower.slice(0, lp), lower);
        if (fnMap.has(h)) console.log('HIT', p);
      }
    }
  }
}

// Also: known-good path Init.bnk
const test = 'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/Init.bnk';
const tParent = test.slice(0, test.lastIndexOf('/'));
const th = h2(tParent, test);
console.log('Init.bnk uppercase h2=', th.toString(16), fnMap.has(th) ? 'HIT' : 'miss');
const lower = test.toLowerCase();
const lh = h2(lower.slice(0, lower.lastIndexOf('/')), lower);
console.log('Init.bnk lowercase h2=', lh.toString(16), fnMap.has(lh) ? 'HIT' : 'miss');
