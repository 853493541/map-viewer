import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const MAP_DATA = join(PUBLIC_DIR, 'map-data');
const ENTITIES_DIR = join(MAP_DATA, 'entities');
const MESH_MAP_PATH = join(MAP_DATA, 'mesh-map.json');
const VERDICTS_PATH = join(MAP_DATA, 'verdicts.json');

const args = process.argv.slice(2);
const exportName = args[0] || 'c-test-v2';
const excludeDenied = args.includes('--no-denied');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// Convert source-lh-row-major to Three.js runtime column-major
function toRuntimeMatrix(e) {
  return [
    e[0], e[1], -e[2], e[3],
    e[4], e[5], -e[6], e[7],
    -e[8], -e[9], e[10], -e[11],
    e[12], e[13], -e[14], e[15],
  ];
}

function normalizeGlbName(raw) {
  let name = basename(String(raw || '').replace(/\\/g, '/')).trim();
  if (!name) return '';
  if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
  return name;
}

// Read denied meshes from verdicts
const deniedSet = new Set();
if (excludeDenied && existsSync(VERDICTS_PATH)) {
  const verdicts = readJson(VERDICTS_PATH);
  if (Array.isArray(verdicts.denied)) {
    for (const name of verdicts.denied) {
      deniedSet.add(String(name).toLowerCase().replace(/\\/g, '/').split('/').pop());
    }
    console.log(`Denied meshes loaded: ${deniedSet.size}`);
  }
} else if (excludeDenied) {
  console.log('verdicts.json not found, all meshes included');
}

// Read mesh-map (mesh path → glb path)
console.log('Reading mesh-map...');
const meshMapRaw = JSON.parse(readFileSync(MESH_MAP_PATH, 'utf8'));
const meshToGlb = new Map();
for (const [key, value] of Object.entries(meshMapRaw)) {
  if (typeof value !== 'string') continue;
  const glbName = normalizeGlbName(value);
  if (glbName) meshToGlb.set(key.toLowerCase(), glbName);
}
console.log(`Mesh map entries: ${meshToGlb.size}`);

// Read all source entities
const entityFiles = readdirSync(ENTITIES_DIR)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .sort();

console.log(`Entity files: ${entityFiles.length}`);

const allEntities = [];
let skippedNoGlb = 0;
let skippedNoMatrix = 0;
let skippedDenied = 0;

for (const file of entityFiles) {
  const arr = readJson(join(ENTITIES_DIR, file));
  if (!Array.isArray(arr)) continue;
  for (const ent of arr) {
    if (!Array.isArray(ent?.matrix) || ent.matrix.length !== 16) {
      skippedNoMatrix++;
      continue;
    }
    const meshKey = String(ent.mesh || '').trim();
    const glbName = meshToGlb.get(meshKey.toLowerCase());
    if (!glbName) {
      skippedNoGlb++;
      continue;
    }

    if (excludeDenied && deniedSet.has(glbName.toLowerCase())) {
      skippedDenied++;
      continue;
    }

    const runtimeMat = toRuntimeMatrix(ent.matrix.map(Number));
    if (!runtimeMat.every(Number.isFinite)) continue;

    allEntities.push({
      mesh: glbName,
      matrix: runtimeMat,
      worldPos: { x: runtimeMat[12], y: runtimeMat[13], z: runtimeMat[14] },
    });
  }
}

console.log(`Total entities: ${allEntities.length} (skipped no-matrix: ${skippedNoMatrix}, no-glb: ${skippedNoGlb}, denied: ${skippedDenied})`);

// Same region as c-test
const region = {
  minX: -1022,
  maxX: 43962,
  minZ: -146511,
  maxZ: -105993,
};

const filtered = allEntities.filter((e) => {
  const p = e.worldPos;
  return p.x >= region.minX && p.x <= region.maxX
    && p.z >= region.minZ && p.z <= region.maxZ;
});

console.log(`Entities in region: ${filtered.length}`);

if (filtered.length === 0) {
  console.error('No entities in region. Exiting.');
  process.exit(1);
}

await postExport(region, filtered);

async function postExport(region, entities) {
  const body = JSON.stringify({
    name: exportName,
    sourceMapPath: 'map-data',
    region,
    regionCorners: [
      { x: region.minX, z: region.minZ },
      { x: region.maxX, z: region.minZ },
      { x: region.maxX, z: region.maxZ },
      { x: region.minX, z: region.maxZ },
    ],
    entities,
    attachMeshCollision: true,
  });

  const spanX = region.maxX - region.minX;
  const spanZ = region.maxZ - region.minZ;
  console.log(`Region: ${(spanX/1000).toFixed(1)}k × ${(spanZ/1000).toFixed(1)}k`);
  console.log(`Posting ${entities.length} entities to export API...`);

  const res = await fetch('http://localhost:3015/api/export-full-with-collision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await res.json();
  console.log('Response:', JSON.stringify(data, null, 2));

  if (data.ok) {
    console.log(`\nExport created: ${data.packageName}`);
  } else {
    console.error('Export failed:', data.error || 'Unknown');
    process.exit(1);
  }
}
