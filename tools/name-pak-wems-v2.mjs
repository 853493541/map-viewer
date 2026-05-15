#!/usr/bin/env node
// Extended pak wem name resolver:
//  1. Collect candidate wem IDs from every .bnk DIDX/HIRC AND from every
//     pak SoundBanksInfo.xml (via <File Id="...">) AND from every pak .txt
//     manifest's "In Memory Audio" / "Streamed Audio" sections.
//  2. For each candidate, try a list of parent dirs (not just
//     `data/wwiseaudio/generatedsoundbanks/windows/base`).
//  3. For each (id, parent) pair: compute djb2(parent) << 40 | xxhash64_low40(parent/<id>.wem),
//     look up h1 in FN tables, match against a per-dat _pak-index.json.
//
// Writes _wem-id-map.json with all hits.
//
// Differences from name-pak-wems.mjs:
//  - Uses XML + TXT IDs in addition to .bnk
//  - Tries multiple parent dirs
//  - Reads DAT for any newly-discovered files (logs a TODO if a parent path
//    has hits but no extracted index entries)

import iconv from 'iconv-lite';
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import koffi from 'koffi';
import { parseBnk } from './parse-wwise-bnk.mjs';

const ROOT = resolve('cache-extraction/wwise-pak-extract/Windows/base');
const PAK_INDEX = join(ROOT, '_pak-index.json');
const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';

// Candidate parent paths to try for each wem id. Order matters only insofar
// as we record the FIRST hit. The standard wwise output dir is the obvious
// guess; the rest are speculation based on observed FN parent dirs that
// contain "wwise"/"audio" in some form.
const CAND_PARENTS = [
  'data/wwiseaudio/generatedsoundbanks/windows/base',
  'data/wwiseaudio/generatedsoundbanks/windows',
  'data/wwiseaudio/windows/base',
  'data/wwiseaudio/windows',
  'data/wwiseaudio/base',
  'data/wwiseaudio',
];

const lib = koffi.load(LZHAM_DLL);
const lzham = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
const CACHE_ENTRY_MARKER = 0x0000E7A4;

// xxhash64
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
  } else { h = (P5 + BigInt(len)) & M; }
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
function djb2Masked(bytes) { let h = 5381n; for (const c of bytes) h = ((h * 33n) + BigInt(c)) & ((1n << 22n) - 1n); return h; }
function composeH2(dirHash, fileHash) { return ((dirHash & ((1n << 22n) - 1n)) << 40n) | (fileHash & ((1n << 40n) - 1n)); }

// Load FN
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

// Load IDX (full) so we can extract on the fly for new parent dirs.
const idxBytes = readFileSync(join(DAT_DIR, '0.idx'));
const idxByH1 = new Map();
for (let off = 36; off + 36 <= idxBytes.length; off += 36) {
  const h1 = idxBytes.readBigUInt64LE(off);
  const offset = Number(idxBytes.readBigUInt64LE(off + 8));
  const origSize = idxBytes.readUInt32LE(off + 16);
  const compSize = idxBytes.readUInt32LE(off + 20);
  const meta = idxBytes.readUInt32LE(off + 32);
  idxByH1.set(h1, { offset, origSize, compSize, datIndex: (meta >>> 12) & 0xf, compType: meta & 0xff });
}
console.log('IDX entries:', idxByH1.size);

// Existing pak-index by h1 (for re-use of already-extracted files).
const pakIndex = JSON.parse(readFileSync(PAK_INDEX, 'utf8'));
const byH1 = new Map();
for (const r of pakIndex) byH1.set(BigInt('0x' + r.h1), r);

// ---------- Candidate IDs ----------
const candidateIds = new Set();

// 1. From .bnk
const allBnks = readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.bnk'));
for (const f of allBnks) {
  let p; try { p = parseBnk(join(ROOT, f)); } catch { continue; }
  for (const o of p.objects) {
    if (o.type === 2 && o.body.length >= 9) {
      const sid = o.body.readUInt32LE(5);
      if (sid) candidateIds.add(sid);
    }
  }
  for (const id of p.wems.keys()) candidateIds.add(id);
}
// also from jx3ac
const AC = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/jx3ac/jx3ac_Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows';
if (existsSync(AC)) {
  for (const f of readdirSync(AC).filter((x) => x.toLowerCase().endsWith('.bnk'))) {
    let p; try { p = parseBnk(join(AC, f)); } catch { continue; }
    for (const o of p.objects) { if (o.type === 2 && o.body.length >= 9) { const sid = o.body.readUInt32LE(5); if (sid) candidateIds.add(sid); } }
    for (const id of p.wems.keys()) candidateIds.add(id);
  }
}

// 2. From XML <File Id="...">
for (const f of readdirSync(ROOT).filter((x) => x.startsWith('pak_') && x.endsWith('.xml'))) {
  const c = readFileSync(join(ROOT, f), 'utf8');
  const ms = c.match(/<File Id="(\d+)"/g) || [];
  for (const m of ms) candidateIds.add(Number(m.match(/\d+/)[0]));
}

// 3. From .txt manifests (Streamed Audio + In Memory Audio sections)
for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.txt'))) {
  const c = readFileSync(join(ROOT, f), 'utf8');
  let cur = null;
  for (const line of c.split(/\r?\n/)) {
    if (line.trim() === '') { cur = null; continue; }
    const lo = line.toLowerCase();
    if (lo.startsWith('streamed audio') || lo.startsWith('in memory audio')) { cur = 'm'; continue; }
    if (lo.startsWith('event') || lo.startsWith('switch ') || lo.startsWith('state ') || lo.startsWith('game parameter') || lo.startsWith('trigger') || lo.startsWith('bus') || lo.startsWith('soundbank')) { cur = null; continue; }
    if (cur === 'm') {
      const c0 = line.split('\t').filter(Boolean)[0];
      if (/^\d+$/.test(c0)) candidateIds.add(Number(c0));
    }
  }
}

console.log('candidate wem ids:', candidateIds.size);

// ---------- Resolve ----------
function unwrap(ie, comp) {
  if (ie.compType === 0) return comp;
  for (const h of [16, 20]) {
    if (comp.length === ie.origSize + h && comp.length >= 16 && comp.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const so = comp.readUInt32LE(8); const sp = comp.readUInt32LE(12);
      if (so === ie.origSize && sp === ie.origSize) return comp.subarray(h, h + ie.origSize);
    }
  }
  if (ie.compType !== 10) return null;
  const payload = comp.subarray(20);
  const out = Buffer.alloc(ie.origSize); const outLen = [ie.origSize >>> 0];
  if (lzham(out, outLen, payload, payload.length >>> 0) !== 0) return null;
  return outLen[0] === out.length ? out : out.subarray(0, outLen[0]);
}

function readDat(d, o, l) {
  const fd = openSync(join(DAT_DIR, d + '.dat'), 'r');
  try {
    const buf = Buffer.alloc(l); let r = 0;
    while (r < l) { const n = readSync(fd, buf, r, l - r, o + r); if (n <= 0) break; r += n; }
    return buf;
  } finally { closeSync(fd); }
}

const parentInfo = CAND_PARENTS.map((p) => {
  const dirHash = djb2Masked(iconv.encode(p, 'gbk'));
  return { path: p, dirHash };
});

let extractedNew = 0;
let copiedFromExisting = 0;
let alreadyNamed = 0;
const map = [];
const parentHits = new Map();

for (const id of candidateIds) {
  const target = join(ROOT, `${id}.wem`);
  if (existsSync(target)) {
    alreadyNamed++;
    map.push({ id, status: 'already' });
    continue;
  }
  for (const pi of parentInfo) {
    const fileBytes = iconv.encode(`${pi.path}/${id}.wem`, 'gbk');
    const fh = xxHash64(fileBytes);
    const h2 = composeH2(pi.dirHash, fh);
    const h1 = fnByH2.get(h2);
    if (h1 === undefined) continue;
    parentHits.set(pi.path, (parentHits.get(pi.path) || 0) + 1);
    // Try existing extracted file first.
    const rec = byH1.get(h1);
    if (rec && existsSync(join(ROOT, rec.file))) {
      copyFileSync(join(ROOT, rec.file), target);
      copiedFromExisting++;
      map.push({ id, h1: h1.toString(16), file: rec.file, parent: pi.path, status: 'copied' });
      break;
    }
    // Otherwise extract from DAT directly.
    const ie = idxByH1.get(h1);
    if (!ie) { map.push({ id, h1: h1.toString(16), parent: pi.path, status: 'no-idx' }); break; }
    try {
      const comp = readDat(ie.datIndex, ie.offset, ie.compSize);
      const out = unwrap(ie, comp);
      if (!out) { map.push({ id, h1: h1.toString(16), parent: pi.path, status: 'unwrap-failed' }); break; }
      writeFileSync(target, out);
      extractedNew++;
      map.push({ id, h1: h1.toString(16), parent: pi.path, status: 'extracted' });
    } catch (err) {
      map.push({ id, h1: h1.toString(16), parent: pi.path, status: 'err:' + err.message });
    }
    break;
  }
}

writeFileSync(join(ROOT, '_wem-id-map.json'), JSON.stringify(map, null, 2));
console.log('parent hit counts:', Object.fromEntries(parentHits));
console.log(`extractedNew=${extractedNew}, copiedFromExisting=${copiedFromExisting}, alreadyNamed=${alreadyNamed}, total=${map.length}`);
