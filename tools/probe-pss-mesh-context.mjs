#!/usr/bin/env node
// Scan whole PSS for .jsondef refs and report context.
import { readFile } from 'node:fs/promises';

const sourcePath = process.argv[2];
if (!sourcePath) { console.error('usage: <sourcePath>'); process.exit(1); }

const r = await fetch(`http://localhost:3015/api/pss/raw-bytes?sourcePath=${encodeURIComponent(sourcePath)}`);
const buf = Buffer.from(await r.arrayBuffer());
console.log('size:', buf.length);

const dec = new TextDecoder('gb18030');
function isPathTerminator(b) { return b === 0 || b < 0x20 || b === 0x22 || b === 0x27 || b === 0x3C || b === 0x3E || b === 0x7C || b === 0x3F || b === 0x2A || b === 0x7B || b === 0x7D || b === 0x5B || b === 0x5D; }

// Find ALL "data/" paths, not extension-filtered, with their absolute offsets.
const paths = [];
for (let i = 0; i < buf.length - 5; i++) {
  if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61 && (buf[i+4] === 0x2f || buf[i+4] === 0x5c)) {
    let p = i;
    while (p < buf.length && !isPathTerminator(buf[p])) p++;
    if (p - i > 260) { i = p; continue; }
    const str = dec.decode(buf.subarray(i, p)).replace(/\\/g, '/');
    if (/[\\/]{2,}/.test(str)) { i = p; continue; }
    const ext = (str.split('.').pop() || '').toLowerCase();
    paths.push({ off: i, ext, str });
    i = p;
  }
}

// Parse TOC for type-2 block ranges.
const emitterCount = buf.readUInt32LE(12);
const toc = [];
for (let i = 0; i < emitterCount; i++) {
  const b = 16 + i * 12;
  toc.push({ idx: i, type: buf.readUInt32LE(b), offset: buf.readUInt32LE(b+4), size: buf.readUInt32LE(b+8) });
}

console.log('emitterCount:', emitterCount);
console.log('\nAll paths in file (count by ext):');
const byExt = {};
for (const p of paths) byExt[p.ext] = (byExt[p.ext] || 0) + 1;
console.log(byExt);

console.log('\nMesh-emitter blocks and what .jsondef paths fall NEAR them (±block size or whole file):');
for (const e of toc) {
  if (e.type !== 2) continue;
  const blockStart = e.offset, blockEnd = e.offset + e.size;
  const meshes = paths.filter(p => p.off >= blockStart && p.off < blockEnd && p.ext === 'mesh');
  if (meshes.length === 0) continue;
  const meshOff = meshes[0].off;
  console.log(`\n#${e.idx} block@${blockStart}+${e.size}: ${meshes.map(m => m.str.split('/').pop()).join(',')} @${meshOff - blockStart}`);
  // Nearby .jsondef in whole file, sorted by distance to mesh ref offset.
  const jsondefs = paths.filter(p => p.ext === 'jsondef').map(p => ({ ...p, dist: p.off - meshOff }));
  jsondefs.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  console.log(`  nearest 5 .jsondef refs:`);
  for (const j of jsondefs.slice(0, 5)) {
    console.log(`    @${j.off} (dist ${j.dist >= 0 ? '+' : ''}${j.dist}) ${j.str}`);
  }
  // Same for .tga
  const tgas = paths.filter(p => p.ext === 'tga' || p.ext === 'dds').map(p => ({ ...p, dist: p.off - meshOff }));
  tgas.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  console.log(`  nearest 5 .tga/dds refs:`);
  for (const t of tgas.slice(0, 5)) {
    console.log(`    @${t.off} (dist ${t.dist >= 0 ? '+' : ''}${t.dist}) ${t.str.split('/').pop()}`);
  }
}
