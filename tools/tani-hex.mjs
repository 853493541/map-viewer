// Hex/structure probe for .tani GATA files.
// Usage: node tools/tani-hex.mjs <path> [maxBytes]
import fs from 'fs';
import iconv from 'iconv-lite';

const p = process.argv[2];
if (!p) { console.error('usage: tani-hex.mjs <file>'); process.exit(1); }
const max = Number(process.argv[3] || 0x800);
const buf = fs.readFileSync(p);
console.log(`size=${buf.length}`);
const dump = (off, n) => {
  for (let row = off; row < Math.min(off + n, buf.length); row += 16) {
    const slice = buf.slice(row, Math.min(row + 16, buf.length));
    const hex = [...slice].map(b => b.toString(16).padStart(2,'0')).join(' ').padEnd(48);
    const ascii = [...slice].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
    console.log(`${row.toString(16).padStart(6,'0')}  ${hex}  ${ascii}`);
  }
};
dump(0, max);

// also print every "u32-prefixed string" we can find: where lenU32 < 1024 and payload is ASCII or GBK.
console.log('\n-- u32-prefixed string candidates --');
for (let i = 0; i + 4 < buf.length; i++) {
  const len = buf.readUInt32LE(i);
  if (len < 4 || len > 1024) continue;
  if (i + 4 + len > buf.length) continue;
  const s = buf.slice(i + 4, i + 4 + len);
  // require last byte to be 0 or printable
  let ok = true;
  for (let j = 0; j < len; j++) {
    const b = s[j];
    if (b === 0 && j === len - 1) continue;
    if (b < 0x20 && b !== 0x09) { ok = false; break; }
    if (b >= 0x7f && (b < 0x81 || b > 0xfe)) { ok = false; break; }
  }
  if (!ok) continue;
  // require at least one letter or CJK lead byte
  let good = false;
  for (let j = 0; j < len; j++) {
    const b = s[j];
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x81 && b <= 0xfe)) { good = true; break; }
  }
  if (!good) continue;
  let str;
  try { str = iconv.decode(s, 'gbk').replace(/\0+$/, ''); } catch { str = s.toString('latin1'); }
  console.log(`@0x${i.toString(16)} len=${len}  ${JSON.stringify(str)}`);
}
