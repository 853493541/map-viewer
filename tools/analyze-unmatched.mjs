import { readFileSync } from 'node:fs';
import koffi from 'koffi';

const M = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/9';
const HS = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/bf/hs';
const ALPH = 'abcdefghijklmnopqrstuvwxyz234567';

const buf = readFileSync(M);
const recs = [];
for (let o = 0; o < buf.length; o += 12) recs.push({ bucket: o/12, hash: buf.readBigUInt64LE(o), size: buf.readUInt32LE(o+8) });
const main = recs.slice(0, 65536).filter(r => r.hash !== 0n || r.size !== 0);
const sp = recs.slice(65536).filter(r => r.hash !== 0n || r.size !== 0);
const lib = koffi.load('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');
const lz = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
function nb32(v) { if (v === 0n) return 'a'; let c = v, o = ''; while (c > 0n) { o = ALPH[Number(c & 31n)] + o; c >>= 5n; } return o; }

const parts = [];
for (const s of sp) {
  const dir = Number((s.hash >> 16n) & 0xFFn);
  const f = `${HS}/${dir}/${nb32(s.hash)}.${s.size}`;
  const b = readFileSync(f);
  if (b.length === s.size) { parts.push(b); continue; }
  const exp = b.readUInt32LE(4);
  const d = Buffer.alloc(exp);
  const ref = [exp >>> 0];
  lz(d, ref, b.subarray(8), (b.length - 8) >>> 0);
  parts.push(d);
}
const stream = Buffer.concat(parts);
const allRecs = [];
let pos = 0;
for (const b of main) {
  const blob = stream.subarray(pos, pos + b.size);
  pos += b.size;
  const n = (blob.length - 4) / 32;
  for (let i = 0; i < n; i++) {
    const r = blob.subarray(4 + i * 32, 4 + (i + 1) * 32);
    allRecs.push({ bucket: b.bucket, q0: r.readBigUInt64LE(0), q1: r.readBigUInt64LE(8), a: r.readUInt32LE(16), c: r.readUInt32LE(20), t0: r.readUInt32LE(24), t1: r.readUInt32LE(28) });
  }
}

const matched = new Set(JSON.parse(readFileSync('log/pakv5-resolved.json', 'utf8')).matches.map(m => m.q0Hex));
const unmatched = allRecs.filter(r => !matched.has('0x' + r.q0.toString(16).padStart(16, '0')));
console.log(`unmatched: ${unmatched.length}`);

const byDir = new Map();
for (const r of unmatched) {
  const d = Number((r.q0 >> 40n) & 0x3fffffn);
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push(r);
}
console.log(`unique parent buckets in unmatched: ${byDir.size}`);

// Cross-reference unmatched parent buckets against MATCHED parent buckets
const matchedDirsByDjb = new Map();
const allMatches = JSON.parse(readFileSync('log/pakv5-resolved.json', 'utf8')).matches;
function djb2_22(bytes) { let h = 5381; for (const b of bytes) h = ((h * 33) + b) & 0x3fffff; return h >>> 0; }
const iconv = (await import('iconv-lite')).default;
for (const m of allMatches) {
  const p = m.path.replace(/^\[gbk\] /, '');
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash) : '';
  const useGbk = m.path.startsWith('[gbk] ');
  const enc = useGbk ? iconv.encode(dir, 'gbk') : Buffer.from(dir, 'utf8');
  const d = djb2_22(enc);
  if (!matchedDirsByDjb.has(d)) matchedDirsByDjb.set(d, []);
  if (!matchedDirsByDjb.get(d).includes(dir)) matchedDirsByDjb.get(d).push(dir);
}

for (const [d, rs] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  djb2_22=0x${d.toString(16)}  count=${rs.length}`);
  if (matchedDirsByDjb.has(d)) {
    console.log(`    sibling dirs (same djb2): ${matchedDirsByDjb.get(d).slice(0, 3).join(' | ')}`);
  }
  for (const r of rs) console.log(`    bucket=${r.bucket} q0=0x${r.q0.toString(16).padStart(16,'0')} q1=0x${r.q1.toString(16).padStart(16,'0')} a=${r.a} c=${r.c}`);
}
