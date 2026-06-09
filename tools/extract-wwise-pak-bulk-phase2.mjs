#!/usr/bin/env node
// Phase 2 of bulk Wwise pak extraction: extract the .txt manifests and the
// SoundBank.xml descriptors (magic "Even" and "<?xm") that the original
// extract-wwise-pak-bulk.mjs skipped because it filtered to RIFF/BKHD only.

import iconv from 'iconv-lite';
import { readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import koffi from 'koffi';

const DAT_DIR = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const LZHAM_DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const OUT_DIR = resolve('cache-extraction/wwise-pak-extract/Windows/base');
mkdirSync(OUT_DIR, { recursive: true });

const lib = koffi.load(LZHAM_DLL);
const lzham = lib.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
const CACHE_ENTRY_MARKER = 0x0000E7A4;

function djb2(s) { let h = 5381; for (const c of iconv.encode(s, 'gbk')) h = ((h * 33) + c) & 0x3fffff; return h >>> 0; }
const TARGET = djb2('data/wwiseaudio/generatedsoundbanks/windows/base');

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

const matches = [];
for (const f of readdirSync(DAT_DIR).filter((x) => /^fn\d+\.1$/i.test(x))) {
  const b = readFileSync(join(DAT_DIR, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h2 = b.readBigUInt64LE(off + 8);
    if (Number(h2 >> 40n) === TARGET) matches.push({ h1: b.readBigUInt64LE(off), h2 });
  }
}

function readDat(d, o, l) {
  const fd = openSync(join(DAT_DIR, d + '.dat'), 'r');
  try { const buf = Buffer.alloc(l); let r = 0; while (r < l) { const n = readSync(fd, buf, r, l - r, o + r); if (n <= 0) break; r += n; } return buf; }
  finally { closeSync(fd); }
}
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

let txtWritten = 0; let xmlWritten = 0; let other = 0;
const newRecords = [];
for (let i = 0; i < matches.length; i++) {
  const ie = idxMap.get(matches[i].h1);
  if (!ie) continue;
  let raw; try { raw = readDat(ie.datIndex, ie.offset, ie.compSize); } catch { continue; }
  const payload = unwrap(ie, raw); if (!payload) continue;
  const head = payload.slice(0, 16).toString('utf8');
  let ext = null;
  if (head.startsWith('Event\t') || head.startsWith('Switch Group\t') || head.startsWith('State Group\t') || head.startsWith('Game Parameter\t') || head.startsWith('Trigger\t') || head.startsWith('Bus\t') || head.startsWith('SoundBank\t') || head.startsWith('In Memory ') || head.startsWith('Streamed Audio\t')) ext = 'txt';
  else if (head.startsWith('<?xml')) ext = 'xml';
  if (!ext) { other++; continue; }
  const fname = `pak_${String(i).padStart(4, '0')}_${payload.length}.${ext}`;
  const out = join(OUT_DIR, fname);
  if (!existsSync(out) || statSync(out).size !== payload.length) writeFileSync(out, payload);
  if (ext === 'txt') txtWritten++; else xmlWritten++;
  newRecords.push({ size: payload.length, kind: ext, file: fname, h1: matches[i].h1.toString(16) });
}
console.log(`txt=${txtWritten} xml=${xmlWritten} other=${other}`);

// Append to existing _pak-index.json.
const indexPath = join(OUT_DIR, '_pak-index.json');
const existing = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
const existingFiles = new Set(existing.map((r) => r.file));
for (const r of newRecords) if (!existingFiles.has(r.file)) existing.push(r);
writeFileSync(indexPath, JSON.stringify(existing, null, 2));
console.log('updated index:', indexPath, 'now', existing.length);
