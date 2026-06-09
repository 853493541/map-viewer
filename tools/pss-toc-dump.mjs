import fs from 'node:fs';
import iconv from 'iconv-lite';

const file = process.argv[2];
const buf = fs.readFileSync(file);
console.log('size', buf.length, 'magic', buf.slice(0, 4).toString('latin1'));

// Header layout: offset 0..7 = magic; offset 8 = u32 (count?); offset 16 = TOC
const u32_at_8 = buf.readUInt32LE(8);
const u32_at_12 = buf.readUInt32LE(12);
console.log('u32@8', u32_at_8, 'u32@12', u32_at_12);

// Try TOC at offset 16
let off = 16;
const toc = [];
while (off + 12 <= buf.length) {
  const t = buf.readUInt32LE(off);
  const o = buf.readUInt32LE(off + 4);
  const s = buf.readUInt32LE(off + 8);
  if (t > 10 || o > buf.length || o + s > buf.length || s === 0) break;
  toc.push({ type: t, offset: o, size: s, tocOffset: off });
  off += 12;
}

console.log('TOC entries:', toc.length);
for (const e of toc) {
  console.log(`  type=${e.type} off=0x${e.offset.toString(16)} size=${e.size}`);
}

// For each block, find embedded jsondef paths (GBK length-prefixed strings)
function findGbkPaths(start, end) {
  const out = [];
  for (let i = start; i + 4 < end; i++) {
    const len = buf.readUInt32LE(i);
    if (len < 4 || len > 512) continue;
    if (i + 4 + len > end) continue;
    const slice = buf.slice(i + 4, i + 4 + len);
    let zero = -1;
    for (let k = 0; k < slice.length; k++) if (slice[k] === 0) { zero = k; break; }
    const trimmed = zero >= 0 ? slice.slice(0, zero) : slice;
    // Heuristic: must contain '\\' (0x5c) and a known extension or 'data'
    const text = iconv.decode(trimmed, 'gbk');
    if (/\.(jsondef|tga|dds|jsoninspack|inspack|mesh|ani|fx)\b/i.test(text) && /[\\\/]/.test(text)) {
      out.push({ off: i, len, text });
      i += 4 + len - 1; // skip past
    }
  }
  return out;
}

console.log('\n=== Per-block path dump ===');
for (const e of toc) {
  const paths = findGbkPaths(e.offset, e.offset + e.size);
  console.log(`block type=${e.type} off=0x${e.offset.toString(16)} size=${e.size}: ${paths.length} paths`);
  for (const p of paths.slice(0, 30)) {
    console.log(`   +${(p.off - e.offset).toString().padStart(5)} (len=${p.len}): ${p.text}`);
  }
}
