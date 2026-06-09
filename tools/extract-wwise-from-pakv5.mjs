#!/usr/bin/env node
// Extract the full game's Wwise SoundBanks (.bnk, .txt, and referenced .wem
// streams) from the PakV5 archive at seasun/zscache/dat/ via
// tools/jx3-cache-reader.js. Writes them flat into
// cache-extraction/wwise-pak-extract/Windows/base/ so the existing
// index-wwise-soundbanks.mjs pipeline can index them.
//
// Bank list was discovered by brute-forcing JX3 menpai (sect) Pin-Yin names
// against the cache reader. The Wwise migration covers 10 menpai plus the
// engine init bank, master UI bank, and a Common bank.

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createJx3CacheReader } from './jx3-cache-reader.js';

const PAK_DIR = 'data/Wwiseaudio/GeneratedSoundBanks/Windows/base/';
const OUT_DIR = resolve('cache-extraction/wwise-pak-extract/Windows/base');

const BANKS = [
  'Init',
  'UI',
  'Common',
  'skillremake',
  'pak_0001_429947',
  'TianCe',
  'ShaoLin',
  'QiXiu',
  'WuDu',
  'TangMen',
  'CangJian',
  'GaiBang',
  'ChangGe',
  'BaDao',
  'CangYun',
];

mkdirSync(OUT_DIR, { recursive: true });

const reader = createJx3CacheReader();

function tryRead(pakPath) {
  try {
    return reader.readEntry(pakPath);
  } catch (err) {
    return null;
  }
}

function writeIfChanged(outPath, buffer) {
  if (existsSync(outPath) && statSync(outPath).size === buffer.length) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  return true;
}

// Parse a SoundBanks .txt and return all wem IDs (streamed + in-memory).
function collectWemIds(txt) {
  const lines = txt.split(/\r?\n/);
  const ids = new Set();
  let section = null;
  for (const line of lines) {
    if (line.trim() === '') { section = null; continue; }
    const head = line.toLowerCase();
    if (head.startsWith('event')) { section = 'event'; continue; }
    if (head.startsWith('in memory audio')) { section = 'mem'; continue; }
    if (head.startsWith('streamed audio')) { section = 'stream'; continue; }
    if (section === 'mem' || section === 'stream') {
      const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
      if (cols.length && /^\d+$/.test(cols[0])) ids.add(cols[0]);
    }
  }
  return [...ids];
}

const summary = {
  banks: {},
  wemTotal: 0,
  wemHits: 0,
  wemMisses: [],
};

for (const bank of BANKS) {
  const bnkPath = `${PAK_DIR}${bank}.bnk`;
  const txtPath = `${PAK_DIR}${bank}.txt`;
  const bnk = tryRead(bnkPath);
  const txt = tryRead(txtPath);
  if (!bnk || !txt) {
    console.warn(`[skip] ${bank}: bnk=${!!bnk} txt=${!!txt}`);
    continue;
  }
  writeIfChanged(join(OUT_DIR, `${bank}.bnk`), bnk.output);
  writeIfChanged(join(OUT_DIR, `${bank}.txt`), txt.output);
  const wemIds = collectWemIds(txt.output.toString('utf8'));
  let hits = 0;
  let misses = 0;
  for (const id of wemIds) {
    summary.wemTotal++;
    const wem = tryRead(`${PAK_DIR}${id}.wem`);
    if (!wem) {
      misses++;
      summary.wemMisses.push(`${bank}:${id}`);
      continue;
    }
    writeIfChanged(join(OUT_DIR, `${id}.wem`), wem.output);
    hits++;
    summary.wemHits++;
  }
  summary.banks[bank] = { bnk: bnk.output.length, txt: txt.output.length, wemIds: wemIds.length, wemHits: hits, wemMisses: misses };
  console.log(`[ok]   ${bank.padEnd(10)} bnk=${bnk.output.length}B txt=${txt.output.length}B wems=${hits}/${wemIds.length}`);
}

console.log('\n=== summary ===');
console.log(`Banks extracted: ${Object.keys(summary.banks).length}/${BANKS.length}`);
console.log(`Wem files: ${summary.wemHits}/${summary.wemTotal}`);
if (summary.wemMisses.length) {
  console.log(`First 10 misses: ${summary.wemMisses.slice(0, 10).join(', ')}`);
}
console.log(`Output: ${OUT_DIR}`);
