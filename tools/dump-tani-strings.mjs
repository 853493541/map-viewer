// Dump tani file strings + structure
import fs from 'fs';
import iconv from 'iconv-lite';
const f = process.argv[2];
const b = fs.readFileSync(f);
console.log('size', b.length);
console.log('magic', b.toString('ascii', 0, 4), 'bytes:', [...b.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join(' '));

function gbk(buf) { return iconv.decode(buf, 'gbk'); }

// Walk byte by byte; group ascii or 0x81-0xFE GBK lead
let cur = [];
let curStart = 0;
let isGbk = false;
const out = [];
for (let i = 0; i < b.length; i++) {
  const c = b[i];
  const isAscii = c >= 0x20 && c <= 0x7e;
  const isLead = c >= 0x81 && c <= 0xfe;
  if (isAscii || isLead) {
    if (cur.length === 0) curStart = i;
    cur.push(c);
    if (isLead && i + 1 < b.length) { cur.push(b[i + 1]); i++; isGbk = true; }
  } else {
    if (cur.length >= 4) {
      const s = isGbk ? gbk(Buffer.from(cur)) : Buffer.from(cur).toString('ascii');
      out.push({ off: curStart, len: cur.length, s });
    }
    cur = []; isGbk = false;
  }
}
if (cur.length >= 4) {
  const s = isGbk ? gbk(Buffer.from(cur)) : Buffer.from(cur).toString('ascii');
  out.push({ off: curStart, len: cur.length, s });
}

for (const r of out) {
  if (r.s.length < 4) continue;
  // skip pure float-noise: require at least one letter
  if (!/[A-Za-z\u4e00-\u9fff]/.test(r.s)) continue;
  console.log(`@0x${r.off.toString(16).padStart(6, '0')} (${r.len})  ${r.s}`);
}
