// Survey all PSS files: count mesh emitters and how many remain untextured
// after the current name-match pairing in server.js.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

function collectPss() {
  const roots = [
    { absRoot: join(ROOT, 'tools', 'pss-cache', 'data'), prefix: 'data' },
    { absRoot: join(ROOT, 'tools', 'pss-cache', '_assets'), prefix: '' },
    { absRoot: join(ROOT, 'source'), prefix: 'data/source' },
  ];
  const seen = new Map();
  for (const r of roots) {
    if (!existsSync(r.absRoot)) continue;
    walk(r.absRoot, r.prefix);
  }
  return [...seen.values()];

  function walk(dir, rel) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const next = join(dir, e.name);
      const nextLogical = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(next, nextLogical); continue; }
      if (!/\.pss$/i.test(e.name)) continue;
      if (/_悟\.pss$/i.test(e.name)) continue;
      const lower = nextLogical.toLowerCase();
      if (seen.has(lower)) continue;
      seen.set(lower, nextLogical.replace(/\\/g, '/'));
    }
  }
}

const pssList = collectPss();
console.log(`Total PSS files: ${pssList.length}`);

let totalMeshEmitters = 0;
let textured = 0;
let untextured = 0;
const untexturedDetails = [];

let i = 0;
for (const pss of pssList) {
  i++;
  process.stdout.write(`[${i}/${pssList.length}] ${pss.split('/').pop()}\n`);
  let res;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`http://localhost:3015/api/pss/analyze?sourcePath=${encodeURIComponent(pss)}`, { signal: ctrl.signal });
    res = await r.json();
  } catch (err) {
    console.warn(`fetch failed ${pss}: ${err.message}`);
    continue;
  } finally {
    clearTimeout(t);
  }
  if (!res?.ok) continue;
  for (const em of res.emitters || []) {
    if (em.type !== 'mesh' || !em.meshes?.length) continue;
    totalMeshEmitters++;
    if ((em.texturePaths || []).length > 0) {
      textured++;
    } else {
      untextured++;
      untexturedDetails.push({ pss: pss.split('/').pop(), mesh: em.meshes[0].split('/').pop() });
    }
  }
}

console.log(`Mesh emitters total: ${totalMeshEmitters}`);
console.log(`  textured (paired): ${textured}`);
console.log(`  untextured:        ${untextured}`);
console.log('Untextured samples (up to 20):');
for (const d of untexturedDetails.slice(0, 20)) console.log(`  ${d.pss} -> ${d.mesh}`);

// Group meshes by name
const meshGroup = new Map();
for (const d of untexturedDetails) {
  meshGroup.set(d.mesh, (meshGroup.get(d.mesh) || 0) + 1);
}
console.log('\nUntextured mesh asset frequencies:');
[...meshGroup.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, c]) => console.log(`  ${c}x ${m}`));
