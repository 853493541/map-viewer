#!/usr/bin/env node
// Forensic analysis of the PakV5 trunk/9 manifest + special-shard payload stream.
// Goals:
//   1. Verify bucket-index <-> manifest-hash relationship.
//   2. Concatenate decoded special-shard bytes in slot order and try to slice
//      them into per-bucket payloads (`u32 header + n*32` records).
//   3. Run hash-identity probes on every record at every 4-byte offset for
//      candidate logical paths (CLI args + a built-in seed list).
//
// Usage: node tools/analyze-pakv5-records.mjs [extraPath ...]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import koffi from 'koffi';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MANIFEST_PATH = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/9';
const HS_ROOT = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/bf/hs';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const NATIVE_BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const HASH_BUCKET_COUNT = 65536;
const SPECIAL_SLOT_COUNT = 16;

const XXP1 = 0x9e3779b185ebca87n;
const XXP2 = 0xc2b2ae3d27d4eb4fn;
const XXP3 = 0x165667b19e3779f9n;
const XXP4 = 0x85ebca77c2b2ae63n;
const XXP5 = 0x27d4eb2f165667c5n;
const M64 = (1n << 64n) - 1n;
const M40 = (1n << 40n) - 1n;
const u64 = (v) => v & M64;
const rol64 = (v, n) => u64((v << BigInt(n)) | (v >> (64n - BigInt(n))));

function djb2Masked22(bytes) {
  let h = 5381;
  for (const b of bytes) h = ((h * 33) + b) & 0x3fffff;
  return h >>> 0;
}

function xxRound(acc, lane) {
  let v = u64(acc + lane * XXP2);
  v = rol64(v, 31);
  return u64(v * XXP1);
}
function xxMerge(acc, v) {
  let m = u64(acc ^ xxRound(0n, v));
  return u64(m * XXP1 + XXP4);
}
function xxHash64(bytes) {
  const len = bytes.length;
  let off = 0;
  let h;
  if (len >= 32) {
    let v1 = u64(XXP1 + XXP2);
    let v2 = XXP2;
    let v3 = 0n;
    let v4 = u64(0n - XXP1);
    const lim = len - 32;
    while (off <= lim) {
      v1 = xxRound(v1, bytes.readBigUInt64LE(off)); off += 8;
      v2 = xxRound(v2, bytes.readBigUInt64LE(off)); off += 8;
      v3 = xxRound(v3, bytes.readBigUInt64LE(off)); off += 8;
      v4 = xxRound(v4, bytes.readBigUInt64LE(off)); off += 8;
    }
    h = u64(rol64(v1, 1) + rol64(v2, 7) + rol64(v3, 12) + rol64(v4, 18));
    h = xxMerge(h, v1); h = xxMerge(h, v2); h = xxMerge(h, v3); h = xxMerge(h, v4);
  } else {
    h = XXP5;
  }
  h = u64(h + BigInt(len));
  while (off <= len - 8) {
    const lane = xxRound(0n, bytes.readBigUInt64LE(off));
    h = u64(h ^ lane);
    h = u64(rol64(h, 27) * XXP1 + XXP4);
    off += 8;
  }
  if (off <= len - 4) {
    h = u64(h ^ (BigInt(bytes.readUInt32LE(off)) * XXP1));
    h = u64(rol64(h, 23) * XXP2 + XXP3);
    off += 4;
  }
  while (off < len) {
    h = u64(h ^ (BigInt(bytes[off]) * XXP5));
    h = u64(rol64(h, 11) * XXP1);
    off += 1;
  }
  h = u64(h ^ (h >> 33n)); h = u64(h * XXP2);
  h = u64(h ^ (h >> 29n)); h = u64(h * XXP3);
  h = u64(h ^ (h >> 32n));
  return h;
}

function composeH2(parentDjb2, fullXx) {
  return u64((BigInt(parentDjb2 >>> 0) << 40n) | (fullXx & M40));
}

function gbk(str) { return iconv.encode(str, 'gbk'); }
function utf8(str) { return Buffer.from(str, 'utf8'); }
function ascii(str) { return Buffer.from(str, 'ascii'); }

function nativeBase32(value) {
  if (value === 0n) return 'a';
  let cur = value;
  let out = '';
  while (cur > 0n) { out = NATIVE_BASE32[Number(cur & 31n)] + out; cur >>= 5n; }
  return out;
}

// ---------- Step 1: parse manifest ----------
const manBuf = readFileSync(MANIFEST_PATH);
if (manBuf.length % 12 !== 0) throw new Error('manifest size not multiple of 12');
const records = [];
for (let off = 0; off < manBuf.length; off += 12) {
  records.push({
    bucket: off / 12,
    hash: manBuf.readBigUInt64LE(off),
    size: manBuf.readUInt32LE(off + 8),
  });
}
const main = records.slice(0, HASH_BUCKET_COUNT);
const special = records.slice(HASH_BUCKET_COUNT);
const activeMain = main.filter((r) => r.hash !== 0n || r.size !== 0);
const activeSpecial = special.filter((r) => r.hash !== 0n || r.size !== 0);

console.log('=== Manifest ===');
console.log(`records=${records.length} activeMain=${activeMain.length} activeSpecial=${activeSpecial.length}`);
console.log(`activeMainPayloadBytes=${activeMain.reduce((s, r) => s + r.size, 0)}`);

// ---------- Step 2: bucket-index vs hash relationship ----------
console.log('\n=== Bucket-index vs hash ===');
{
  const tests = {
    'hash & 0xFFFF': (h) => Number(h & 0xFFFFn),
    '(hash >> 16) & 0xFFFF': (h) => Number((h >> 16n) & 0xFFFFn),
    '(hash >> 32) & 0xFFFF': (h) => Number((h >> 32n) & 0xFFFFn),
    '(hash >> 48) & 0xFFFF': (h) => Number((h >> 48n) & 0xFFFFn),
    '(low32 ^ high32) & 0xFFFF': (h) => Number(((h ^ (h >> 32n)) & 0xFFFFn)),
    '(low32 % 65536)': (h) => Number(h & 0xFFFFFFFFn) % 65536,
    'h2_dirHash >> 24 (top 16 of djb2)': (h) => Number((h >> 56n) & 0xFFFFn), // sanity
  };
  for (const [name, fn] of Object.entries(tests)) {
    let hits = 0;
    for (const r of activeMain) if (fn(r.hash) === r.bucket) hits++;
    console.log(`  ${name}: ${hits}/${activeMain.length}`);
  }
}

// ---------- Step 3: decode special shards ----------
console.log('\n=== Special shards ===');
const lib = koffi.load(LZHAM_DLL);
const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');

const decodedShards = [];
for (const slot of activeSpecial) {
  const dir = Number((slot.hash >> 16n) & 0xFFn);
  const name = nativeBase32(slot.hash);
  const file = `${HS_ROOT}/${dir}/${name}.${slot.size}`;
  const buf = readFileSync(file);
  let decoded;
  let storage;
  if (buf.length === slot.size) { decoded = buf; storage = 'raw'; }
  else {
    const expected = buf.readUInt32LE(4);
    if (expected !== slot.size) throw new Error(`size mismatch in ${file}`);
    const out = Buffer.alloc(expected);
    const lenRef = [expected >>> 0];
    const status = lzhamUncompress(out, lenRef, buf.subarray(8), (buf.length - 8) >>> 0);
    if (status !== 0) throw new Error(`lzham failed for ${file}`);
    decoded = out;
    storage = 'lzham';
  }
  decodedShards.push({ slotBucket: slot.bucket, hash: slot.hash, size: slot.size, dir, name, file, decoded, storage });
}

// Try concatenations in different orders to find one that aligns with main-bucket sizes.
function trySlice(orderName, ordered) {
  const stream = Buffer.concat(ordered.map((s) => s.decoded));
  let pos = 0;
  let bucketsParsed = 0;
  let recordsParsed = 0;
  let firstFailBucket = -1;
  let firstFailReason = '';
  const buckets = [];
  for (const r of activeMain) {
    if (pos + r.size > stream.length) {
      firstFailBucket = r.bucket;
      firstFailReason = `pos+size > stream (${pos}+${r.size}>${stream.length})`;
      break;
    }
    const blob = stream.subarray(pos, pos + r.size);
    if (blob.length < 4 || (blob.length - 4) % 32 !== 0) {
      firstFailBucket = r.bucket;
      firstFailReason = `blob len ${blob.length} not 4 + n*32`;
      break;
    }
    const header = blob.readUInt32LE(0);
    const n = (blob.length - 4) / 32;
    const recs = [];
    for (let i = 0; i < n; i++) {
      recs.push(blob.subarray(4 + i * 32, 4 + (i + 1) * 32));
    }
    buckets.push({ bucket: r.bucket, manifestHash: r.hash, size: r.size, header, recs });
    bucketsParsed++;
    recordsParsed += n;
    pos += r.size;
  }
  return { orderName, streamBytes: stream.length, bucketsParsed, recordsParsed, firstFailBucket, firstFailReason, buckets, stream };
}

// Sort decoded shards multiple ways
const orderings = [
  ['slot order (manifest)', decodedShards.slice()],
  ['by dir asc', decodedShards.slice().sort((a, b) => a.dir - b.dir)],
  ['by hash asc', decodedShards.slice().sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))],
  ['by name asc', decodedShards.slice().sort((a, b) => a.name.localeCompare(b.name))],
];

console.log('\n=== Concatenation order trials ===');
let best = null;
for (const [name, ordered] of orderings) {
  const r = trySlice(name, ordered);
  console.log(`  ${name}: bucketsParsed=${r.bucketsParsed}/${activeMain.length} recordsParsed=${r.recordsParsed} fail@bucket=${r.firstFailBucket} reason=${r.firstFailReason}`);
  if (!best || r.bucketsParsed > best.bucketsParsed) best = r;
}

if (best.bucketsParsed === activeMain.length) {
  console.log(`\n=> Using ordering "${best.orderName}", all ${best.bucketsParsed} buckets sliced cleanly.`);
} else {
  console.log(`\n=> Best ordering "${best.orderName}" only sliced ${best.bucketsParsed}/${activeMain.length}; analysis below uses partial data.`);
}

// ---------- Step 4: bucket header analysis ----------
console.log('\n=== Bucket header (first 4 bytes of payload) ===');
{
  const sample = best.buckets.slice(0, 8);
  for (const b of sample) {
    console.log(`  bucket=${b.bucket} manifestHash=0x${b.manifestHash.toString(16).padStart(16,'0')} size=${b.size} n=${b.recs.length} header=0x${b.header.toString(16).padStart(8,'0')} (${b.header})`);
  }
  // Check if bucket header equals record-count
  let headerEqualsCount = 0;
  let headerEqualsBucket = 0;
  let headerEqualsManifestLow = 0;
  let headerEqualsManifestHigh = 0;
  for (const b of best.buckets) {
    if (b.header === b.recs.length) headerEqualsCount++;
    if (b.header === b.bucket) headerEqualsBucket++;
    if (b.header === Number(b.manifestHash & 0xFFFFFFFFn)) headerEqualsManifestLow++;
    if (b.header === Number((b.manifestHash >> 32n) & 0xFFFFFFFFn)) headerEqualsManifestHigh++;
  }
  console.log(`  headers matching recordCount: ${headerEqualsCount}/${best.buckets.length}`);
  console.log(`  headers matching bucketIdx:   ${headerEqualsBucket}/${best.buckets.length}`);
  console.log(`  headers matching manifestLo32: ${headerEqualsManifestLow}/${best.buckets.length}`);
  console.log(`  headers matching manifestHi32: ${headerEqualsManifestHigh}/${best.buckets.length}`);
}

// ---------- Step 5: candidate-path hash identity probe ----------
const argPaths = process.argv.slice(2);
const seedPaths = [
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/Init.txt',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/SoundbanksInfo.xml',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/init.txt',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/soundbanksinfo.xml',
  'init.txt',
  'soundbanksinfo.xml',
  'data/source/version.ini',
  'data/Settings/RegisterMap.tab',
  'data/source/setting/global/define/version.ini',
];
const candidatePaths = [...new Set([...seedPaths, ...argPaths])];

console.log('\n=== Candidate-path identity probes ===');
for (const path of candidatePaths) {
  const variants = [];
  const norm = path.replace(/\\/g, '/').trim();
  const lower = norm.toLowerCase();
  const upper = norm.toUpperCase();
  const slash = '/' + lower;
  const back = lower.replace(/\//g, '\\');
  const back2 = '\\' + back;
  for (const [vname, vstr] of [
    ['raw-utf8', norm], ['lower-utf8', lower], ['upper-utf8', upper],
    ['lead-slash', slash], ['back', back], ['back-lead', back2],
  ]) {
    const enc = utf8(vstr);
    const xx = xxHash64(enc);
    const dirH = djb2Masked22(gbk(lower.split('/').slice(0, -1).join('/')));
    const h2 = composeH2(dirH, xx);
    variants.push({ vname, vstr, enc: 'utf8', xx, dirH, h2 });
    const encG = gbk(vstr);
    const xxG = xxHash64(encG);
    const dirHG = djb2Masked22(gbk(lower.split('/').slice(0, -1).join('/')));
    const h2G = composeH2(dirHG, xxG);
    variants.push({ vname, vstr, enc: 'gbk', xx: xxG, dirH: dirHG, h2: h2G });
  }
  // Search every record at all 4-byte offsets for any of the candidate hashes (xx low/high, h2 low/high, dirH).
  const targetU64 = new Set();
  const targetU32 = new Set();
  for (const v of variants) {
    targetU64.add(v.xx);
    targetU64.add(v.h2);
    targetU32.add(Number(v.xx & 0xFFFFFFFFn));
    targetU32.add(Number((v.xx >> 32n) & 0xFFFFFFFFn));
    targetU32.add(Number(v.h2 & 0xFFFFFFFFn));
    targetU32.add(Number((v.h2 >> 32n) & 0xFFFFFFFFn));
    if (v.dirH !== 5381) targetU32.add(v.dirH);
  }
  // strip the djb2-seed contaminator (matches when path has no slash -> dirH=5381)
  targetU32.delete(5381);
  targetU32.delete(0);
  let hits = 0;
  const hitSamples = [];
  for (const b of best.buckets) {
    // also test bucket header
    if (targetU32.has(b.header)) hitSamples.push({ bucket: b.bucket, where: 'bucketHeader', value: '0x' + b.header.toString(16) });
    for (const rec of b.recs) {
      for (let off = 0; off + 8 <= 32; off += 4) {
        const v64 = rec.readBigUInt64LE(off);
        if (targetU64.has(v64)) {
          hits++;
          if (hitSamples.length < 5) hitSamples.push({ bucket: b.bucket, recOff: off, kind: 'u64', value: '0x' + v64.toString(16) });
        }
      }
      for (let off = 0; off + 4 <= 32; off += 4) {
        const v32 = rec.readUInt32LE(off);
        if (targetU32.has(v32)) {
          hits++;
          if (hitSamples.length < 8) hitSamples.push({ bucket: b.bucket, recOff: off, kind: 'u32', value: '0x' + v32.toString(16) });
        }
      }
    }
  }
  console.log(`  "${path}" -> hits=${hits}`);
  for (const s of hitSamples) console.log(`     ${JSON.stringify(s)}`);
}

// ---------- Step 6: structural patterns at offsets +0..+31 ----------
console.log('\n=== Field statistics across all records ===');
{
  const flat = [];
  for (const b of best.buckets) for (const r of b.recs) flat.push(r);
  console.log(`  total records: ${flat.length}`);
  // For each 4-byte offset, count how often value is 0, small (<=65535), large, or matches bucket header
  for (let off = 0; off <= 28; off += 4) {
    let zero = 0, small = 0, mid = 0, big = 0;
    let min = 0xFFFFFFFF, max = 0;
    for (const r of flat) {
      const v = r.readUInt32LE(off);
      if (v === 0) zero++;
      else if (v < 0x10000) small++;
      else if (v < 0x10000000) mid++;
      else big++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    console.log(`  off+${off}: zero=${zero} small<2^16=${small} mid<2^28=${mid} big=${big} min=0x${min.toString(16)} max=0x${max.toString(16)}`);
  }
}

// ---------- Step 7: do trailing 8 bytes (off +24,+28) repeat across buckets? ----------
console.log('\n=== Trailing-tail (off +24..+31) repetition check ===');
{
  let bucketsWithIdenticalTail = 0;
  let bucketsWithNonIdentical = 0;
  const tailValues = new Map(); // tail-hex -> count of buckets where ALL records share that tail
  for (const b of best.buckets) {
    if (b.recs.length < 2) continue;
    const tail0 = b.recs[0].subarray(24, 32).toString('hex');
    let same = true;
    for (let i = 1; i < b.recs.length; i++) {
      if (b.recs[i].subarray(24, 32).toString('hex') !== tail0) { same = false; break; }
    }
    if (same) {
      bucketsWithIdenticalTail++;
      tailValues.set(tail0, (tailValues.get(tail0) || 0) + 1);
    } else {
      bucketsWithNonIdentical++;
    }
  }
  console.log(`  buckets >=2 records with identical tail: ${bucketsWithIdenticalTail}`);
  console.log(`  buckets >=2 records with non-identical tail: ${bucketsWithNonIdentical}`);
  console.log(`  unique tail values: ${tailValues.size}`);
}

// ---------- Step 8: dump first few records of first few buckets ----------
console.log('\n=== Sample dump (first 4 buckets, all records) ===');
for (const b of best.buckets.slice(0, 4)) {
  console.log(`  bucket=${b.bucket} manifestHash=0x${b.manifestHash.toString(16).padStart(16,'0')} header=0x${b.header.toString(16).padStart(8,'0')} n=${b.recs.length}`);
  for (let i = 0; i < b.recs.length; i++) {
    const r = b.recs[i];
    const q0 = r.readBigUInt64LE(0);
    const q1 = r.readBigUInt64LE(8);
    const a = r.readUInt32LE(16);
    const c = r.readUInt32LE(20);
    const t0 = r.readUInt32LE(24);
    const t1 = r.readUInt32LE(28);
    console.log(`    [${i}] q0=0x${q0.toString(16).padStart(16,'0')} q1=0x${q1.toString(16).padStart(16,'0')} a=${a} c=${c} t0=0x${t0.toString(16)} t1=0x${t1.toString(16)}`);
  }
}
