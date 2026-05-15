const fs = require('fs');
const path = process.argv[2];
const buf = fs.readFileSync(path);
const len = buf.length;
console.log(`DLL: ${path}, size: ${len}`);

const keywords = [
  'f3CenterAdjust', 'f3MeshScale', 'szMeshPath', 'SceneNodeFactory',
  'ParticleTrailLauncher', 'ParticleMeshQuoteLauncher', 'ParticleMeshLauncher',
  'f3RotateAdjust', 'f3Scale', 'f3Translation', 'KG3D_SceneNodeFactory',
  'KG3DSceneNode', 'f3Position', 'f3Pivot', 'f3MeshOffset', 'eUpAxis', 'eForwardAxis',
  'fScale', 'KG3D_PARSYS_MESH_LAUNCHER', 'KG3D_PARSYS_TRAIL_LAUNCHER',
];

for (const kw of keywords) {
  const kwBuf = Buffer.from(kw, 'ascii');
  const offsets = [];
  let i = 0;
  while (i < len - kwBuf.length) {
    const found = buf.indexOf(kwBuf, i);
    if (found < 0) break;
    offsets.push(found);
    i = found + 1;
    if (offsets.length > 30) break;
  }
  console.log(`${kw.padEnd(34)} count=${offsets.length} first=${offsets.slice(0, 5).map(o => '0x' + o.toString(16)).join(',')}`);
}

// Now extract neighborhood ASCII strings around f3MeshScale + f3CenterAdjust
const target = 'f3CenterAdjust';
const kwBuf = Buffer.from(target, 'ascii');
let pos = 0;
while ((pos = buf.indexOf(kwBuf, pos)) >= 0) {
  // Find ASCII strings within 256 bytes before/after
  const start = Math.max(0, pos - 256);
  const end = Math.min(len, pos + 256);
  const strings = [];
  let cur = '';
  let curStart = start;
  for (let k = start; k < end; k++) {
    const b = buf[k];
    if (b >= 0x20 && b < 0x7f) {
      if (cur.length === 0) curStart = k;
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 4) strings.push({ off: curStart, str: cur });
      cur = '';
    }
  }
  if (cur.length >= 4) strings.push({ off: curStart, str: cur });
  console.log(`\n--- neighborhood of ${target} @ 0x${pos.toString(16)} ---`);
  for (const s of strings) console.log(`  0x${s.off.toString(16)}: ${s.str}`);
  pos++;
}
