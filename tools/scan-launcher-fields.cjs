const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const len = buf.length;

const targets = [
  'KG3D_ParticleMeshLauncher',
  'KG3D_ParticleTrailLauncher',
  'KG3D_ParticleMeshQuoteLauncher',
];

// Find strings >= 4 chars in the entire file once.
const strings = [];
{
  let cur = '';
  let curStart = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      if (cur.length === 0) curStart = i;
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 4) strings.push({ off: curStart, str: cur });
      cur = '';
    }
  }
  if (cur.length >= 4) strings.push({ off: curStart, str: cur });
}

const findAll = (kw) => {
  const kwBuf = Buffer.from(kw, 'ascii');
  const out = [];
  let i = 0;
  while (true) {
    const f = buf.indexOf(kwBuf, i);
    if (f < 0) break;
    out.push(f);
    i = f + 1;
  }
  return out;
};

// For each launcher class, look at distinct f3 / sz / e / b / fSomething style fields
// in a 1KB neighborhood around each occurrence and emit unique discoveries.
const fieldNamePatterns = /^(?:f3|sz|sn|sb|se|s_|b[A-Z]|n[A-Z]|f[A-Z]|d[A-Z]|u[A-Z]|e[A-Z])[A-Za-z0-9_]+$/;

for (const t of targets) {
  console.log(`\n=== ${t} ===`);
  const offs = findAll(t);
  console.log(`occurrences: ${offs.length}`);
  const seen = new Set();
  for (const o of offs.slice(0, 8)) {
    // strings within 2 KB of this occurrence
    const near = strings.filter((s) => Math.abs(s.off - o) < 2048 && fieldNamePatterns.test(s.str));
    for (const s of near) {
      const key = s.str;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`  near 0x${o.toString(16)}: 0x${s.off.toString(16)}: ${s.str}`);
      }
    }
  }
}
