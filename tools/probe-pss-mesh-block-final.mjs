#!/usr/bin/env node
// Final summary: scan ALL 65 PSS files; for each mesh emitter block, count
// .jsondef and .tga refs found INSIDE that block's byte range.
import { TextDecoder } from 'node:util';

const pssRes = await fetch('http://localhost:3015/api/pss/find?q=&limit=500').then(r => r.json());
const pssList = (pssRes.items || []).map(x => x.sourcePath);
console.log('Total PSS:', pssList.length);

function isPathTerm(b) { return b === 0 || b < 0x20 || b === 0x22 || b === 0x27 || b === 0x3C || b === 0x3E || b === 0x7C || b === 0x3F || b === 0x2A || b === 0x7B || b === 0x7D || b === 0x5B || b === 0x5D; }

const dec = new TextDecoder('gb18030');
let totalMesh = 0, withJsondef = 0, withTga = 0, withEither = 0;
const failingMeshes = [];

for (let i = 0; i < pssList.length; i++) {
  const pss = pssList[i];
  const r = await fetch(`http://localhost:3015/api/pss/raw-bytes?sourcePath=${encodeURIComponent(pss)}`);
  if (!r.ok) continue;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 16) continue;
  const ec = buf.readUInt32LE(12);
  if (16 + ec * 12 > buf.length) continue;

  for (let k = 0; k < ec; k++) {
    const base = 16 + k * 12;
    const t = buf.readUInt32LE(base);
    if (t !== 2) continue;
    const off = buf.readUInt32LE(base + 4);
    const sz = buf.readUInt32LE(base + 8);
    const start = off, end = off + sz;
    let hasMesh = false, hasJsondef = false, hasTga = false;
    let meshName = '';
    for (let j = start; j < end - 5; j++) {
      if (buf[j] === 0x64 && buf[j+1] === 0x61 && buf[j+2] === 0x74 && buf[j+3] === 0x61 && (buf[j+4] === 0x2f || buf[j+4] === 0x5c)) {
        let p = j;
        while (p < end && !isPathTerm(buf[p])) p++;
        if (p - j > 260) { j = p; continue; }
        const s = dec.decode(buf.subarray(j, p));
        const ext = (s.split('.').pop() || '').toLowerCase();
        if (ext === 'mesh') { hasMesh = true; if (!meshName) meshName = s.split(/[\\/]/).pop(); }
        else if (ext === 'jsondef') hasJsondef = true;
        else if (ext === 'tga' || ext === 'dds') hasTga = true;
        j = p;
      }
    }
    if (!hasMesh) continue;
    totalMesh++;
    if (hasJsondef) withJsondef++;
    if (hasTga) withTga++;
    if (hasJsondef || hasTga) withEither++;
    else failingMeshes.push({ pss: pss.split('/').pop(), mesh: meshName });
  }
  if ((i+1) % 10 === 0) process.stdout.write(`  [${i+1}/${pssList.length}]\n`);
}

console.log(`\n=== FINAL ===`);
console.log(`mesh emitters total:        ${totalMesh}`);
console.log(`  with .jsondef in block:   ${withJsondef}`);
console.log(`  with .tga/dds in block:   ${withTga}`);
console.log(`  with EITHER in block:     ${withEither}`);
console.log(`  with NEITHER:             ${totalMesh - withEither} (= cannot be paired by byte-proximity)`);
console.log(`\nUnique failing mesh names (first 30):`);
const uniq = new Set(failingMeshes.map(f => f.mesh));
for (const m of [...uniq].slice(0, 30)) console.log('  ', m);
