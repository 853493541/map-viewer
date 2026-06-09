#!/usr/bin/env node
// Recover original wem filenames for the anonymous `pak_NNNN_<size>.wem`
// files extracted by extract-wwise-pak-bulk.mjs.
//
// Strategy:
//   1. Walk every .bnk we have, read every Sound HIRC's source_id (= wem id).
//   2. For each candidate id, compute the FN h2 of
//      `data/wwiseaudio/generatedsoundbanks/windows/base/<id>.wem`.
//   3. Look up h1 in the PakV5 FN tables.
//   4. Match h1 to the entry recorded in _pak-index.json (h1-stamped during
//      bulk extraction).
//   5. Copy/symlink the anonymous file as `<id>.wem` next to it so the
//      streamed-wem code path can find it.
//
// Output: rename map written next to the bnk extracts; .wem files renamed
// in-place (or copied if they back multiple ids).

import iconv from 'iconv-lite';
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBnk } from './parse-wwise-bnk.mjs';

const ROOT = resolve('cache-extraction/wwise-pak-extract/Windows/base');
const PAK_INDEX = join(ROOT, '_pak-index.json');
const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const PAK_DIR = 'data/wwiseaudio/generatedsoundbanks/windows/base';

if (!existsSync(PAK_INDEX)) { console.error('Missing', PAK_INDEX); process.exit(1); }
const pakIndex = JSON.parse(readFileSync(PAK_INDEX, 'utf8'));
const byH1 = new Map();
for (const r of pakIndex) byH1.set(BigInt('0x' + r.h1), r);
console.log('pak entries:', pakIndex.length);

// xxhash64 (port of jx3-cache-reader.js).
const P1 = 0x9e3779b185ebca87n; const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n; const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n; const M = (1n << 64n) - 1n;
function rot(x, n) { x &= M; return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M; }
function round(acc, inp) { acc = (acc + (inp & M) * P2) & M; acc = rot(acc, 31); return (acc * P1) & M; }
function merge(acc, v) { v = round(0n, v); acc = (acc ^ v) & M; return ((acc * P1 + P4) & M); }
function xxHash64(bytes) {
  const len = bytes.length; let off = 0; let h;
  if (len >= 32) {
    let v1 = (P1 + P2) & M, v2 = P2, v3 = 0n, v4 = (0n - P1) & M;
    while (off + 32 <= len) {
      v1 = round(v1, BigInt(bytes.readBigUInt64LE(off))); off += 8;
      v2 = round(v2, BigInt(bytes.readBigUInt64LE(off))); off += 8;
      v3 = round(v3, BigInt(bytes.readBigUInt64LE(off))); off += 8;
      v4 = round(v4, BigInt(bytes.readBigUInt64LE(off))); off += 8;
    }
    h = (rot(v1, 1) + rot(v2, 7) + rot(v3, 12) + rot(v4, 18)) & M;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else {
    h = (P5 + BigInt(len)) & M;
  }
  h = (h + BigInt(len)) & M;
  while (off + 8 <= len) {
    const v = bytes.readBigUInt64LE(off); off += 8;
    h = (h ^ round(0n, v)) & M; h = ((rot(h, 27) * P1 + P4) & M);
  }
  if (off + 4 <= len) {
    const v = BigInt(bytes.readUInt32LE(off)) & M; off += 4;
    h = (h ^ (v * P1) & M) & M; h = ((rot(h, 23) * P2 + P3) & M);
  }
  while (off < len) {
    const v = BigInt(bytes[off++]) & 0xffn;
    h = (h ^ (v * P5) & M) & M; h = ((rot(h, 11) * P1) & M);
  }
  h ^= h >> 33n; h = (h * P2) & M;
  h ^= h >> 29n; h = (h * P3) & M;
  h ^= h >> 32n;
  return h & M;
}
function djb2Masked(bytes) {
  let h = 5381n;
  for (const c of bytes) h = ((h * 33n) + BigInt(c)) & ((1n << 22n) - 1n);
  return h;
}
function composeH2(dirHash, fileHash) {
  return ((dirHash & ((1n << 22n) - 1n)) << 40n) | (fileHash & ((1n << 40n) - 1n));
}

// Build full FN map keyed by h2 -> h1.
console.log('loading FN files...');
const fnDir = readdirSync(DAT_DIR).filter((f) => /^fn\d+\.1$/i.test(f));
const fnByH2 = new Map();
for (const f of fnDir) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h1 = b.readBigUInt64LE(off);
    const h2 = b.readBigUInt64LE(off + 8);
    fnByH2.set(h2, h1);
  }
}
console.log('FN h2 entries:', fnByH2.size);

const dirBytes = iconv.encode(PAK_DIR, 'gbk');
const dirHash = djb2Masked(dirBytes);

// Collect candidate wem ids from every parsed bnk.
const candidateIds = new Set();
const allBnks = readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.bnk'));
for (const f of allBnks) {
  let p;
  try { p = parseBnk(join(ROOT, f)); } catch { continue; }
  for (const o of p.objects) {
    if (o.type === 2 && o.body.length >= 9) {
      const sid = o.body.readUInt32LE(5);
      if (sid) candidateIds.add(sid);
    }
    // also pick wem ids straight from DIDX
  }
  for (const id of p.wems.keys()) candidateIds.add(id);
}
console.log('candidate wem ids:', candidateIds.size);

let resolved = 0;
let alreadyNamed = 0;
let nameClashes = 0;
const map = []; // {id, h1, file}
for (const id of candidateIds) {
  const path = `${PAK_DIR}/${id}.wem`;
  const fileBytes = iconv.encode(path, 'gbk');
  const fh = xxHash64(fileBytes);
  const h2 = composeH2(dirHash, fh);
  const h1 = fnByH2.get(h2);
  if (h1 === undefined) continue;
  const rec = byH1.get(h1);
  if (!rec) continue;
  const target = join(ROOT, `${id}.wem`);
  const src = join(ROOT, rec.file);
  if (existsSync(target)) { alreadyNamed++; map.push({ id, h1: h1.toString(16), file: rec.file, status: 'already' }); continue; }
  if (!existsSync(src)) continue;
  // Multiple wem ids may share a file (same h1 collision); copy not rename.
  copyFileSync(src, target);
  resolved++;
  map.push({ id, h1: h1.toString(16), file: rec.file, status: 'copied' });
}

writeFileSync(join(ROOT, '_wem-id-map.json'), JSON.stringify(map, null, 2));
console.log(`resolved=${resolved}, already=${alreadyNamed}, total mapped=${map.length}`);
console.log(`Wrote: ${join(ROOT, '_wem-id-map.json')}`);
