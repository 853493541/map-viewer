// Scan a binary for ASCII + UTF-16LE string occurrences matching a regex.
// Usage: node scan-dll-strings-v2.cjs <dllPath> <regex> [contextBytes]
'use strict';
const fs = require('fs');
const path = require('path');

const dllPath = process.argv[2];
const pattern = new RegExp(process.argv[3] || 'Scale|Position|Offset|Rotation|Bone|Socket|Attach|Transform|Particle|Launcher|MeshQuote|Trail|Eff', 'i');
const ctxBytes = parseInt(process.argv[4] || '64', 10);

if (!dllPath || !fs.existsSync(dllPath)) {
  console.error(`File not found: ${dllPath}`);
  process.exit(1);
}

const buf = fs.readFileSync(dllPath);
console.log(`# Scanning ${dllPath} (${buf.length} bytes) for /${pattern.source}/${pattern.flags}`);

// 1) ASCII strings (printable, length ≥ 4)
function* asciiStrings(b) {
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i] : 0;
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= 4) {
        yield { off: start, str: b.toString('ascii', start, i), kind: 'ascii' };
      }
      start = -1;
    }
  }
}

// 2) UTF-16LE strings (printable ASCII low byte + 0 high byte, length ≥ 4 chars)
function* utf16Strings(b) {
  let start = -1;
  for (let i = 0; i <= b.length - 1; i += 2) {
    const lo = b[i];
    const hi = b[i + 1];
    const printable = hi === 0 && lo >= 0x20 && lo < 0x7f;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && (i - start) / 2 >= 4) {
        const chars = [];
        for (let j = start; j < i; j += 2) chars.push(String.fromCharCode(b[j]));
        yield { off: start, str: chars.join(''), kind: 'utf16' };
      }
      start = -1;
    }
  }
}

const hits = [];
for (const s of asciiStrings(buf)) {
  if (pattern.test(s.str)) hits.push(s);
}
for (const s of utf16Strings(buf)) {
  if (pattern.test(s.str)) hits.push(s);
}
hits.sort((a, b) => a.off - b.off);
console.log(`# Total hits: ${hits.length}`);

// Dedup by string text — keep first offset per unique string
const seen = new Map();
for (const h of hits) {
  if (!seen.has(h.str)) seen.set(h.str, h);
}
const unique = Array.from(seen.values()).sort((a, b) => a.off - b.off);
console.log(`# Unique strings: ${unique.length}`);

for (const h of unique) {
  console.log(`0x${h.off.toString(16).padStart(8, '0')}  ${h.kind}  ${h.str}`);
}
