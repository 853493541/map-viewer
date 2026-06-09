// Enumerate all PakV5 entries whose parent dirHash matches the Wwise audio dirs,
// regardless of filename. This lets us count how many .bnk/.wem/.txt files
// actually exist in the pak even though we can't recover their original names.
import iconv from 'iconv-lite';
import { readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

function djb2(str) {
  let h = 5381;
  for (const c of iconv.encode(str, 'gbk')) h = ((h * 33) + c) & 0x3fffff;
  return h >>> 0;
}

const baseDirs = [
  'data/Wwiseaudio/GeneratedSoundBanks/Windows/base',
  'data/Wwiseaudio/GeneratedSoundBanks/Windows',
  'data/Wwiseaudio/GeneratedSoundBanks',
  'data/Wwiseaudio',
  'data/Wwiseaudio/Windows',
  'data/Wwiseaudio/Windows/base',
  'Wwiseaudio/GeneratedSoundBanks/Windows/base',
  'Wwiseaudio',
];
const targetDirs = [...new Set([...baseDirs, ...baseDirs.map((d) => d.toLowerCase())])];
const dirSet = new Map(targetDirs.map((d) => [djb2(d), d]));
console.log('Target dirHashes:', [...dirSet]);

const dir = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat';
const fnFiles = readdirSync(dir).filter((f) => /^fn\d+\.1$/i.test(f)).sort();

let total = 0;
const matches = [];
for (const f of fnFiles) {
  const b = readFileSync(join(dir, f));
  for (let off = 4; off + 20 <= b.length; off += 20) {
    const h2 = b.readBigUInt64LE(off + 8);
    const dirH = Number(h2 >> 40n);
    if (dirSet.has(dirH)) {
      const h1 = b.readBigUInt64LE(off);
      matches.push({ h1, h2, dir: dirSet.get(dirH) });
    }
    total++;
  }
}
console.log('Total FN records:', total, 'matches:', matches.length);

const idxBytes = readFileSync(join(dir, '0.idx'));
const idxMap = new Map();
for (let off = 36; off + 36 <= idxBytes.length; off += 36) {
  const h1 = idxBytes.readBigUInt64LE(off);
  const offset = Number(idxBytes.readBigUInt64LE(off + 8));
  const origSize = idxBytes.readUInt32LE(off + 16);
  const compSize = idxBytes.readUInt32LE(off + 20);
  const meta = idxBytes.readUInt32LE(off + 32);
  idxMap.set(h1, { offset, origSize, compSize, meta, datIndex: (meta >>> 12) & 0xf, compType: meta & 0xff });
}

const byDir = {};
for (const ma of matches) byDir[ma.dir] = (byDir[ma.dir] || 0) + 1;
console.log('matches by dir:', byDir);

// Read first bytes for each match to detect file type. Mimic the reader's
// expandEntry: stored entries (compType=0) start at datOffset; raw-wrapped
// entries have a CACHE_ENTRY_MARKER (0x0000E7A4) at offset 4; LZHAM entries
// must be decompressed. Skip LZHAM here for speed.
const CACHE_ENTRY_MARKER = 0x0000E7A4;
const magicCounts = {};
const magicByDir = {};
const sizesByDir = {};
const compTypeCounts = {};
const sampleByMagic = {};
let inspected = 0;
for (const ma of matches) {
  const ie = idxMap.get(ma.h1);
  if (!ie) continue;
  compTypeCounts[ie.compType] = (compTypeCounts[ie.compType] || 0) + 1;
  const datPath = join(dir, ie.datIndex + '.dat');
  // Read enough to cover possible 20-byte header + 16-byte magic.
  const head = Buffer.alloc(40);
  const fd = openSync(datPath, 'r');
  try {
    readSync(fd, head, 0, 40, ie.offset);
  } finally {
    closeSync(fd);
  }
  let payloadStart = 0;
  if (ie.compType === 0) {
    payloadStart = 0;
  } else if (ie.compType === 10) {
    // Raw-wrapped (uncompressed but cache-wrapped) if marker present and sizes match.
    if (head.length >= 16 && head.readUInt32LE(4) === CACHE_ENTRY_MARKER) {
      const storedOrig = head.readUInt32LE(8);
      const storedPayload = head.readUInt32LE(12);
      if (storedOrig === ie.origSize && storedPayload === ie.origSize) {
        // could be 16- or 20-byte header. Check both: if compressedSize == origSize+16 -> 16, else +20 -> 20.
        if (ie.compSize === ie.origSize + 16) payloadStart = 16;
        else if (ie.compSize === ie.origSize + 20) payloadStart = 20;
        else continue;
      } else {
        continue;
      }
    } else {
      // True LZHAM-compressed; skip (would need lzham to decode). Mark as such.
      const m = 'LZHAM';
      magicCounts[m] = (magicCounts[m] || 0) + 1;
      magicByDir[ma.dir] = magicByDir[ma.dir] || {};
      magicByDir[ma.dir][m] = (magicByDir[ma.dir][m] || 0) + 1;
      sizesByDir[ma.dir] = (sizesByDir[ma.dir] || 0) + ie.origSize;
      inspected++;
      continue;
    }
  }
  const m4 = head.slice(payloadStart, payloadStart + 4);
  const ascii = m4.toString('ascii');
  const magic = /^[\x20-\x7E]{4}$/.test(ascii) ? ascii : m4.toString('hex');
  magicCounts[magic] = (magicCounts[magic] || 0) + 1;
  magicByDir[ma.dir] = magicByDir[ma.dir] || {};
  magicByDir[ma.dir][magic] = (magicByDir[ma.dir][magic] || 0) + 1;
  sizesByDir[ma.dir] = (sizesByDir[ma.dir] || 0) + ie.origSize;
  if (!sampleByMagic[magic]) sampleByMagic[magic] = { dir: ma.dir, h1: ma.h1.toString(16), origSize: ie.origSize, compSize: ie.compSize, compType: ie.compType, datIndex: ie.datIndex };
  inspected++;
}
console.log('Compression types:', compTypeCounts);
console.log('Inspected:', inspected);
console.log('Magic counts:', magicCounts);
console.log('Magic by dir:', JSON.stringify(magicByDir, null, 2));
console.log('Total bytes by dir:', Object.fromEntries(Object.entries(sizesByDir).map(([k, v]) => [k, (v / 1024 / 1024).toFixed(1) + ' MB'])));
