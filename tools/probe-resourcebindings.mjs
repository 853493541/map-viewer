import fs from 'node:fs';
import path from 'node:path';
import koffi from 'koffi';
import iconv from 'iconv-lite';

const packageName = 'nixatq46eogaf';
const memberPath = 'data/resourcebindings.xml';
const downloadDir = path.resolve('cache-extraction/online-cdn/downloads');
const outPath = path.resolve('cache-extraction/online-cdn/extracted', packageName, 'data', 'ResourceBindings.xml');
const dllPath = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll';
const lzham = koffi.load(dllPath).func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');

function decodePath(bytes) {
  const utf8 = bytes.toString('utf8');
  return utf8.includes('\uFFFD') ? iconv.decode(bytes, 'gb18030') : utf8;
}

function readCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  return decodePath(buffer.subarray(start, stop));
}

const hpkgName = fs.readdirSync(downloadDir).find((name) => name.endsWith(`_${packageName}.hpkg`) || name === `${packageName}.hpkg`);
if (!hpkgName) throw new Error(`missing downloaded package ${packageName}`);
const hpkgPath = path.join(downloadDir, hpkgName);
const hpkg = fs.readFileSync(hpkgPath);
const count = hpkg.readUInt32LE(0x10);
const indexSize = hpkg.readUInt32LE(0x20);
const packedIndexSize = hpkg.readUInt32LE(0x28);
const payloadSize = hpkg.readUInt32LE(0x30);
const payloadStart = 64 + packedIndexSize;
const index = Buffer.alloc(indexSize);
let indexLength = [indexSize >>> 0];
const indexStatus = lzham(index, indexLength, hpkg.subarray(68, payloadStart), (packedIndexSize - 4) >>> 0);
console.log(JSON.stringify({ hpkgPath, count, indexSize, packedIndexSize, payloadSize, payloadStart, indexStatus, indexLength: indexLength[0] }, null, 2));
if (indexStatus !== 0) throw new Error(`index decode failed ${indexStatus}`);

const recordSize = indexSize / count;
for (let row = 0; row < count; row += 1) {
  const base = row * recordSize;
  const pathText = readCString(index, base + 4, base + 260).replace(/\\/g, '/').toLowerCase();
  if (pathText !== memberPath) continue;
  const originalSize = index.readUInt32LE(base + 280);
  const storedSize = index.readUInt32LE(base + 284);
  const payloadOffset = index.readUInt32LE(base + 288);
  const flags = index.readUInt32LE(base + 292);
  console.log(JSON.stringify({ row, pathText, originalSize, storedSize, payloadOffset, flags }, null, 2));
  const stored = hpkg.subarray(payloadStart + payloadOffset, payloadStart + payloadOffset + storedSize);
  for (const skip of [0, 4, 8, 12, 16, 20, 24, 32]) {
    const output = Buffer.alloc(originalSize);
    const outputLength = [originalSize >>> 0];
    const status = lzham(output, outputLength, stored.subarray(skip), (stored.length - skip) >>> 0);
    console.log(JSON.stringify({ skip, status, outputLength: outputLength[0], preview: output.subarray(0, Math.min(80, outputLength[0])).toString('utf8') }));
    if (status === 0) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, output.subarray(0, outputLength[0]));
      console.log(`wrote ${outPath}`);
      console.log(output.subarray(0, Math.min(1200, outputLength[0])).toString('utf8'));
      break;
    }
  }
}
