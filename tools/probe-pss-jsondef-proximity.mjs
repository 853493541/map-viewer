#!/usr/bin/env node
// Probe (a): scan each PSS file for .jsondef and texture refs INSIDE each
// type-2 (launcher) block range, compute byte-distance from each found
// .jsondef to the .Mesh ref in the same block, and look for proximity
// patterns that could authoritatively pair mesh emitters with materials.
//
// Output: per-PSS-file CSV-ish dump: emitterIdx, mesh, jsondef-list, tga-list.
//
// Usage:  node tools/probe-pss-jsondef-proximity.mjs [--pss <substring>]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/jx3-web-map-viewer';
const filter = process.argv.includes('--pss') ? process.argv[process.argv.indexOf('--pss') + 1] : null;

const pssRes = await fetch('http://localhost:3015/api/pss/find?q=&limit=500').then(r => r.json());
let pssList = (pssRes.items || []).map(x => x.sourcePath);
if (filter) pssList = pssList.filter(p => p.includes(filter));
console.log('PSS files to probe:', pssList.length);

function readU32(buf, o) { return buf.readUInt32LE(o); }
function isPathTerminator(b) {
  return b === 0 || b < 0x20 || b === 0x22 || b === 0x27 || b === 0x3C || b === 0x3E || b === 0x7C || b === 0x3F || b === 0x2A || b === 0x7B || b === 0x7D || b === 0x5B || b === 0x5D;
}
function findPathsInRange(buf, start, end, extRe) {
  const out = [];
  for (let i = start; i < end - 5; i++) {
    if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61 && (buf[i+4] === 0x2f || buf[i+4] === 0x5c)) {
      let p = i;
      while (p < end && !isPathTerminator(buf[p])) p++;
      if (p - i > 260) { i = p; continue; }
      const raw = buf.subarray(i, p).toString('binary'); // ascii-safe inspection
      // Decode GB18030 properly
      const dec = new TextDecoder('gb18030');
      let str;
      try { str = dec.decode(buf.subarray(i, p)); } catch { str = raw; }
      const ext = str.split('.').pop().toLowerCase();
      if (!extRe || extRe.test(ext)) {
        if (!/[\\/]{2,}/.test(str.replace(/\\/g, '/'))) {
          out.push({ path: str.replace(/\\/g, '/'), offset: i });
        }
      }
      i = p;
    }
  }
  return out;
}

// Get raw PSS bytes via the find endpoint? No, let's use the analyze endpoint
// to get blocks, then re-read the raw PSS via /api/pss/raw. Check if such
// endpoint exists; otherwise use analyze cache file paths.
//
// Simpler: use server's /api/pss/analyze + a side fetch of the PSS bytes via
// the server's static asset endpoint. The PSS files live in a known root —
// use the source meta.
//
// We'll request /api/pss/raw?sourcePath=... and if 404 fall back to direct
// disk read. Try resolving the file path via /api/pss/find result.

async function fetchPssBytes(sourcePath) {
  const u = `http://localhost:3015/api/pss/raw-bytes?sourcePath=${encodeURIComponent(sourcePath)}`;
  const r = await fetch(u);
  if (r.ok) return Buffer.from(await r.arrayBuffer());
  return null;
}

// Fallback: scan analyze response and directly read disk.
// PSS files are typically under PSS_EXTRACT_DIR. Without that knowledge,
// rely on /api/pss/raw — if it doesn't exist, error out.

const summary = { totalMeshEmitters: 0, withJsondefInBlock: 0, withTgaInBlock: 0, files: 0 };
const findings = [];

for (let i = 0; i < pssList.length; i++) {
  const pss = pssList[i];
  const fname = pss.split('/').pop();
  process.stdout.write(`[${i+1}/${pssList.length}] ${fname}\n`);
  const bytes = await fetchPssBytes(pss);
  if (!bytes) { console.warn('  no bytes'); continue; }
  // Parse TOC
  if (bytes.length < 16) continue;
  const emitterCount = readU32(bytes, 12);
  const tocEnd = 16 + emitterCount * 12;
  if (tocEnd > bytes.length) continue;
  const toc = [];
  for (let k = 0; k < emitterCount; k++) {
    const base = 16 + k * 12;
    toc.push({ type: readU32(bytes, base), offset: readU32(bytes, base+4), size: readU32(bytes, base+8) });
  }
  // For each type-2 block, find .Mesh + .jsondef + .tga/.dds in block range.
  for (let k = 0; k < toc.length; k++) {
    const e = toc[k];
    if (e.type !== 2) continue;
    const start = e.offset;
    const end = e.offset + e.size;
    const meshes = findPathsInRange(bytes, start, end, /^mesh$/i);
    if (meshes.length === 0) continue;
    summary.totalMeshEmitters++;
    const jsondefs = findPathsInRange(bytes, start, end, /^jsondef$/i);
    const tgas = findPathsInRange(bytes, start, end, /^(tga|dds|png)$/i);
    if (jsondefs.length) summary.withJsondefInBlock++;
    if (tgas.length) summary.withTgaInBlock++;
    findings.push({
      pss: fname,
      emitterIdx: k,
      blockStart: start,
      blockSize: e.size,
      mesh: meshes.map(m => ({ name: m.path.split('/').pop(), off: m.offset - start })),
      jsondef: jsondefs.map(j => ({ name: j.path.split('/').pop(), off: j.offset - start })),
      tga: tgas.map(t => ({ name: t.path.split('/').pop(), off: t.offset - start })),
    });
  }
  summary.files++;
}

console.log('\n=== summary ===');
console.log(JSON.stringify(summary, null, 2));
console.log('\n=== findings (first 50) ===');
for (const f of findings.slice(0, 50)) {
  console.log(`${f.pss} #${f.emitterIdx} (block@${f.blockStart}+${f.blockSize}):`);
  console.log(`  mesh:    ${f.mesh.map(m => `${m.name}@+${m.off}`).join(', ')}`);
  if (f.jsondef.length) console.log(`  jsondef: ${f.jsondef.map(j => `${j.name}@+${j.off}`).join(', ')}`);
  if (f.tga.length)     console.log(`  tga:     ${f.tga.map(t => `${t.name}@+${t.off}`).join(', ')}`);
}

// Aggregate stats: how many mesh-emitters have at least one .jsondef AND/OR .tga in their block?
const meshWithEither = findings.filter(f => f.jsondef.length > 0 || f.tga.length > 0);
const meshWithJsondef = findings.filter(f => f.jsondef.length > 0);
const meshWithTga = findings.filter(f => f.tga.length > 0);
console.log(`\nmesh emitters total:           ${findings.length}`);
console.log(`  with .jsondef in own block:  ${meshWithJsondef.length}`);
console.log(`  with .tga/dds in own block:  ${meshWithTga.length}`);
console.log(`  with EITHER in own block:    ${meshWithEither.length}`);
