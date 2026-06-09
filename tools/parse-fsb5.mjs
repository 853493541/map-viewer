// Parse FSB5 v1 header + name table.
// Header (60 bytes for v1):
//   0  "FSB5"
//   4  version (1 or 0)
//   8  numSamples
//  12  sampleHeadersSize
//  16  nameTableSize
//  20  sampleDataSize
//  24  mode (codec)
//  28  zero / version-specific (for v1: 32 bytes flags etc.)
// Then samples headers, then name table, then sample data.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const path = process.argv[2];
if (!path) { console.error('usage: parse-fsb5.mjs <file>'); process.exit(1); }
const b = readFileSync(path);
const magic = b.slice(0, 4).toString('ascii');
if (magic !== 'FSB5') { console.error('not FSB5:', magic); process.exit(1); }
const version = b.readUInt32LE(4);
const numSamples = b.readUInt32LE(8);
const sampleHeadersSize = b.readUInt32LE(12);
const nameTableSize = b.readUInt32LE(16);
const sampleDataSize = b.readUInt32LE(20);
const codec = b.readUInt32LE(24);
console.log({ version, numSamples, sampleHeadersSize, nameTableSize, sampleDataSize, codec });

const headerSize = version === 0 ? 60 : 60;
const nameTableOff = headerSize + sampleHeadersSize;
const nameTable = b.subarray(nameTableOff, nameTableOff + nameTableSize);

// Name table: numSamples × u32 offsets, then null-terminated strings starting at the offsets relative to the name table start.
const names = [];
for (let i = 0; i < numSamples; i++) {
  const off = nameTable.readUInt32LE(i * 4);
  let end = off;
  while (end < nameTable.length && nameTable[end] !== 0) end++;
  names.push(nameTable.subarray(off, end).toString('utf8'));
}
console.log('Names:');
for (const n of names) console.log(' -', n);
