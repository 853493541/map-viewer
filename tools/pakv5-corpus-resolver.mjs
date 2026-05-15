#!/usr/bin/env node
// Path-corpus reverse lookup for PakV5 manifest records.
//
// Builds q0 = composeH2(djb2_22(parent_lower), xxHash64(fullPath_lower_utf8))
// for every candidate logical path derived from local install trees and tries
// to match it against records parsed out of the manifest + special shards.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import koffi from 'koffi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_BASE = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4';
const DEFAULT_MANIFEST_PATH = `${ROOT_BASE}/seasun/zscache/ver/trunk/2`;
const DEFAULT_HS_ROOT = `${ROOT_BASE}/seasun/zscache/ver/trunk/bf/hs`;
const DEFAULT_LZHAM_DLL = `${ROOT_BASE}/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll`;
const DEFAULT_OUT_PATH = resolve(`${__dirname}/../log/pakv5-resolved-v2.json`);
const NATIVE_BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const HASH_BUCKET_COUNT = 65536;
let CONFIG = null;

const XXP1 = 0x9e3779b185ebca87n;
const XXP2 = 0xc2b2ae3d27d4eb4fn;
const XXP3 = 0x165667b19e3779f9n;
const XXP4 = 0x85ebca77c2b2ae63n;
const XXP5 = 0x27d4eb2f165667c5n;
const M64 = (1n << 64n) - 1n;
const M40 = (1n << 40n) - 1n;
const u64 = (v) => v & M64;
const rol64 = (v, n) => u64((v << BigInt(n)) | (v >> (64n - BigInt(n))));

function djb2_22(bytes) {
  let h = 5381;
  for (const b of bytes) h = ((h * 33) + b) & 0x3fffff;
  return h >>> 0;
}

function xxRound(acc, lane) { let v = u64(acc + lane * XXP2); v = rol64(v, 31); return u64(v * XXP1); }
function xxMerge(acc, v) { let m = u64(acc ^ xxRound(0n, v)); return u64(m * XXP1 + XXP4); }
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
  } else h = XXP5;
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

function composeH2(dirHash, fullXx) {
  return u64((BigInt(dirHash >>> 0) << 40n) | (fullXx & M40));
}

function nativeBase32(value) {
  if (value === 0n) return 'a';
  let cur = value;
  let out = '';
  while (cur > 0n) { out = NATIVE_BASE32[Number(cur & 31n)] + out; cur >>= 5n; }
  return out;
}

function parseArgs(argv) {
  const args = [...argv];
  const config = {
    manifestPath: resolve(DEFAULT_MANIFEST_PATH),
    hsRoot: resolve(DEFAULT_HS_ROOT),
    lzhamDllPath: resolve(DEFAULT_LZHAM_DLL),
    outPath: DEFAULT_OUT_PATH,
    rootBase: ROOT_BASE,
    corpusRoots: [],
    listFiles: [],
  };

  while (args.length) {
    const arg = args.shift();
    if (arg === '--manifest') {
      config.manifestPath = resolve(args.shift());
      continue;
    }
    if (arg === '--hs-root') {
      config.hsRoot = resolve(args.shift());
      continue;
    }
    if (arg === '--lzham-dll') {
      config.lzhamDllPath = resolve(args.shift());
      continue;
    }
    if (arg === '--out') {
      config.outPath = resolve(args.shift());
      continue;
    }
    if (arg === '--root-base') {
      config.rootBase = resolve(args.shift());
      continue;
    }
    if (arg === '--list-file') {
      config.listFiles.push(resolve(args.shift()));
      continue;
    }
    config.corpusRoots.push(resolve(arg));
  }

  return config;
}

// ---------- Decode manifest + shards ----------
function loadRecords() {
  const buf = readFileSync(CONFIG.manifestPath);
  const recs = [];
  for (let off = 0; off < buf.length; off += 12) {
    recs.push({
      bucket: off / 12,
      hash: buf.readBigUInt64LE(off),
      size: buf.readUInt32LE(off + 8),
    });
  }
  const main = recs.slice(0, HASH_BUCKET_COUNT);
  const special = recs.slice(HASH_BUCKET_COUNT);
  const activeMain = main.filter((r) => r.hash !== 0n || r.size !== 0);
  const activeSpecial = special.filter((r) => r.hash !== 0n || r.size !== 0);
  return { activeMain, activeSpecial };
}

function decodeShards(activeSpecial) {
  const lib = koffi.load(CONFIG.lzhamDllPath);
  const lzhamUncompress = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  const out = [];
  for (const slot of activeSpecial) {
    const dir = Number((slot.hash >> 16n) & 0xFFn);
    const file = `${CONFIG.hsRoot}/${dir}/${nativeBase32(slot.hash)}.${slot.size}`;
    const buf = readFileSync(file);
    if (buf.length === slot.size) { out.push(buf); continue; }
    const expected = buf.readUInt32LE(4);
    const dest = Buffer.alloc(expected);
    const lenRef = [expected >>> 0];
    const status = lzhamUncompress(dest, lenRef, buf.subarray(8), (buf.length - 8) >>> 0);
    if (status !== 0) throw new Error(`lzham failed for ${file}`);
    out.push(dest);
  }
  return Buffer.concat(out);
}

function sliceRecords(activeMain, stream) {
  const records = [];
  let pos = 0;
  for (const b of activeMain) {
    const blob = stream.subarray(pos, pos + b.size);
    pos += b.size;
    const n = (blob.length - 4) / 32;
    for (let i = 0; i < n; i++) {
      const r = blob.subarray(4 + i * 32, 4 + (i + 1) * 32);
      records.push({
        bucket: b.bucket,
        q0: r.readBigUInt64LE(0),
        q1: r.readBigUInt64LE(8),
        a: r.readUInt32LE(16),
        c: r.readUInt32LE(20),
        t0: r.readUInt32LE(24),
        t1: r.readUInt32LE(28),
      });
    }
  }
  return records;
}

// ---------- Corpus walk ----------
function walk(root) {
  const files = [];
  const dirs = [];
  function rec(abs, rel) {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const a = `${abs}/${e.name}`;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push(r);
        rec(a, r);
      } else {
        files.push(r);
      }
    }
  }
  rec(root, '');
  return { files, dirs };
}

// ---------- Candidate generators ----------
function* candidates(filesByRoot, fileListings) {
  // From corpus walks, with multiple prefix variants per file.
  for (const { rootName, files } of filesByRoot) {
    for (const f of files) {
      const lower = f.toLowerCase();
      yield lower;
      yield `${rootName}/${lower}`;
      yield `seasun/${rootName}/${lower}`;
    }
  }
  // From discovered file-list resources (lines are bare names; pair with known prefixes).
  const PREFIXES = [
    '',
    'client/bin64/',
    'seasun/client/bin64/',
    'seasun/client/',
    'editortool/qmodeleditor/',
    'editortool/movieeditor/bin64/',
    'editortool/qseasuneditor/seasunapp/httppacking/',
    'data/',
    'data/source/',
    'data/source/setting/',
    'data/source/scripts/',
    'data/scripts/',
    'data/settings/',
    'data/setting/',
    'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/',
    'data/wwiseaudio/generatedsoundbanks/windows/base/',
    'init/',
    'shaders/',
    'plugin/',
    'mainfest/',
    'manifest/',
  ];
  for (const lines of fileListings) {
    for (const name of lines) {
      const lname = name.trim().toLowerCase();
      if (!lname) continue;
      for (const p of PREFIXES) {
        yield p + lname;
      }
    }
  }
}

// ---------- Main ----------
CONFIG = parseArgs(process.argv.slice(2));
const corpusRoots = CONFIG.corpusRoots.length ? CONFIG.corpusRoots : [
  `${CONFIG.rootBase}/seasun`,
  `${CONFIG.rootBase}/config`,
  resolve(`${__dirname}/../source`),
];

console.log('Loading manifest + decoding shards...');
const { activeMain, activeSpecial } = loadRecords();
const stream = decodeShards(activeSpecial);
const records = sliceRecords(activeMain, stream);
console.log(`records=${records.length} buckets=${activeMain.length}`);

// Build q0 -> record index
const byQ0 = new Map();
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  if (!byQ0.has(r.q0)) byQ0.set(r.q0, []);
  byQ0.get(r.q0).push(i);
}
console.log(`unique q0 keys: ${byQ0.size}`);

// Build prefix bucket fast-pre-filter (top 22 bits of q0 == djb2_22(parent))
const buckets22 = new Set();
for (const r of records) buckets22.add(Number((r.q0 >> 40n) & 0x3fFFFFn));
console.log(`unique parent-djb2 buckets used: ${buckets22.size}`);

// Walk corpus
console.log('\nWalking corpus...');
const corpus = [];
for (const root of corpusRoots) {
  const rootName = root.split(/[\\/]/).pop();
  const w = walk(root);
  console.log(`  ${root}: files=${w.files.length} dirs=${w.dirs.length}`);
  corpus.push({ rootName, files: w.files });
}

// Collect signfilelist.txt-style listings
const fileListings = [];
function tryReadList(path) {
  try {
    const txt = readFileSync(path, 'utf8');
    fileListings.push(txt.split(/\r?\n/));
    console.log(`  read list ${path}: ${fileListings[fileListings.length - 1].length} lines`);
  } catch {}
}
tryReadList(`${CONFIG.rootBase}/seasun/client/bin64/signfilelist.txt`);
tryReadList(`${CONFIG.rootBase}/seasun/editortool/movieeditor/bin64/signfilelist.txt`);
for (const listFile of CONFIG.listFiles) {
  tryReadList(listFile);
}

// Match
console.log('\nMatching candidates...');
const matched = new Map(); // recordIndex -> path
let tested = 0;
let lastReport = 0;
const report = () => {
  const pct = ((matched.size / records.length) * 100).toFixed(1);
  process.stdout.write(`  tested=${tested} matched=${matched.size}/${records.length} (${pct}%)\r`);
};

for (const path of candidates(corpus, fileListings)) {
  tested++;
  if (tested - lastReport >= 50000) { report(); lastReport = tested; }
  const slash = path.lastIndexOf('/');
  const parent = slash >= 0 ? path.slice(0, slash) : '';
  const dirH = djb2_22(Buffer.from(parent, 'utf8'));
  if (!buckets22.has(dirH)) continue; // fast prefilter
  const fileH = xxHash64(Buffer.from(path, 'utf8'));
  const q0 = composeH2(dirH, fileH);
  const idxs = byQ0.get(q0);
  if (!idxs) continue;
  for (const i of idxs) if (!matched.has(i)) matched.set(i, path);
}
report();
process.stdout.write('\n');

// Also try GBK encoding for any remaining unmatched (cheap retry)
let gbkExtra = 0;
for (const path of candidates(corpus, fileListings)) {
  if (matched.size === records.length) break;
  const slash = path.lastIndexOf('/');
  const parent = slash >= 0 ? path.slice(0, slash) : '';
  const dirH = djb2_22(iconv.encode(parent, 'gbk'));
  if (!buckets22.has(dirH)) continue;
  const fileH = xxHash64(iconv.encode(path, 'gbk'));
  const q0 = composeH2(dirH, fileH);
  const idxs = byQ0.get(q0);
  if (!idxs) continue;
  for (const i of idxs) if (!matched.has(i)) { matched.set(i, '[gbk] ' + path); gbkExtra++; }
}
console.log(`gbk extras: ${gbkExtra}`);

const pct = ((matched.size / records.length) * 100).toFixed(2);
console.log(`\n=== TOTAL MATCHED: ${matched.size}/${records.length} (${pct}%) ===`);

// Per-bucket-22 coverage
const bucketsCovered = new Set();
for (const i of matched.keys()) bucketsCovered.add(Number((records[i].q0 >> 40n) & 0x3fFFFFn));
console.log(`parent-djb2 buckets covered: ${bucketsCovered.size}/${buckets22.size}`);

// Sample a few matched
const matchedArr = [...matched.entries()].slice(0, 30);
console.log('\nSample matched records:');
for (const [i, p] of matchedArr) {
  const r = records[i];
  console.log(`  bucket=${r.bucket} q0=0x${r.q0.toString(16).padStart(16,'0')} a=${r.a} c=${r.c} -> ${p}`);
}

// Write JSON dump
const outPath = CONFIG.outPath;
const payload = {
  manifestPath: CONFIG.manifestPath,
  hsRoot: CONFIG.hsRoot,
  totalRecords: records.length,
  matched: matched.size,
  matches: [...matched.entries()].map(([i, p]) => ({
    bucket: records[i].bucket,
    q0Hex: '0x' + records[i].q0.toString(16).padStart(16, '0'),
    q1Hex: '0x' + records[i].q1.toString(16).padStart(16, '0'),
    a: records[i].a,
    c: records[i].c,
    path: p,
  })),
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`\nWrote ${outPath}`);
