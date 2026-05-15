import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';

const args = process.argv.slice(2);
const roots = [];
const terms = [];
let maxHits = 50;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--term') terms.push(args[++i]);
  else if (args[i] === '--max') maxHits = Number(args[++i] || maxHits);
  else roots.push(args[i]);
}
if (!roots.length || !terms.length) {
  console.error('usage: node tools/probe-byte-search.mjs <file-or-dir>... --term <text> [--term <text>] [--max 50]');
  process.exit(2);
}

const patterns = [];
for (const term of terms) {
  patterns.push({ term, encoding: 'utf8', bytes: Buffer.from(term, 'utf8') });
  patterns.push({ term, encoding: 'gb18030', bytes: iconv.encode(term, 'gb18030') });
}
patterns.sort((a, b) => b.bytes.length - a.bytes.length);
const maxPatternLength = Math.max(...patterns.map((pattern) => pattern.bytes.length));
const hits = [];

function indexOfBuffer(haystack, needle, start = 0) {
  return haystack.indexOf(needle, start);
}

function previewAt(buffer, absoluteOffset, window = 96) {
  const start = Math.max(0, absoluteOffset - window);
  const end = Math.min(buffer.length, absoluteOffset + window);
  const slice = buffer.subarray(start, end);
  const utf8 = slice.toString('utf8').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const gb = iconv.decode(slice, 'gb18030').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return { utf8, gb18030: gb };
}

function scanFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;
  const chunkSize = 1024 * 1024;
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize + maxPatternLength);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (position < stat.size && hits.length < maxHits) {
      const readLength = fs.readSync(fd, buffer, carry.length, chunkSize, position);
      if (!readLength) break;
      carry.copy(buffer, 0);
      const current = buffer.subarray(0, carry.length + readLength);
      for (const pattern of patterns) {
        let foundAt = 0;
        while ((foundAt = indexOfBuffer(current, pattern.bytes, foundAt)) !== -1) {
          const absolute = position - carry.length + foundAt;
          hits.push({ file: filePath, offset: absolute, term: pattern.term, encoding: pattern.encoding, ...previewAt(current, foundAt) });
          if (hits.length >= maxHits) return;
          foundAt += Math.max(1, pattern.bytes.length);
        }
      }
      const keep = Math.min(maxPatternLength - 1, current.length);
      carry = Buffer.from(current.subarray(current.length - keep));
      position += readLength;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function walk(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    scanFile(root);
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) scanFile(full);
    if (hits.length >= maxHits) return;
  }
}

for (const root of roots) {
  walk(path.resolve(root));
  if (hits.length >= maxHits) break;
}
console.log(JSON.stringify({ roots, terms, hitCount: hits.length, hits }, null, 2));
