// Minimal PE export-table dumper (no deps).
import { readFileSync } from 'node:fs';

const dll = process.argv[2] || 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/LibPak5.dll';
const buf = readFileSync(dll);
if (buf.readUInt16LE(0) !== 0x5A4D) throw new Error('not MZ');
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('no PE');
const coffOff = peOff + 4;
const numSections = buf.readUInt16LE(coffOff + 2);
const sizeOptHdr = buf.readUInt16LE(coffOff + 16);
const optOff = coffOff + 20;
const magic = buf.readUInt16LE(optOff);
const isPE32Plus = magic === 0x20b;
const ddOff = optOff + (isPE32Plus ? 112 : 96);
const exportRVA = buf.readUInt32LE(ddOff);
const exportSize = buf.readUInt32LE(ddOff + 4);
const sectOff = optOff + sizeOptHdr;

const sections = [];
for (let i = 0; i < numSections; i++) {
  const so = sectOff + i * 40;
  sections.push({
    name: buf.subarray(so, so + 8).toString('ascii').replace(/\0+$/, ''),
    virtualSize: buf.readUInt32LE(so + 8),
    virtualAddress: buf.readUInt32LE(so + 12),
    rawSize: buf.readUInt32LE(so + 16),
    rawPtr: buf.readUInt32LE(so + 20),
  });
}

function rvaToOff(rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
      return s.rawPtr + (rva - s.virtualAddress);
    }
  }
  return -1;
}

const expOff = rvaToOff(exportRVA);
const numFunctions = buf.readUInt32LE(expOff + 20);
const numNames = buf.readUInt32LE(expOff + 24);
const addrFuncRVA = buf.readUInt32LE(expOff + 28);
const addrNamesRVA = buf.readUInt32LE(expOff + 32);
const addrOrdRVA = buf.readUInt32LE(expOff + 36);
const addrFuncOff = rvaToOff(addrFuncRVA);
const addrNamesOff = rvaToOff(addrNamesRVA);
const addrOrdOff = rvaToOff(addrOrdRVA);

console.log(`Exports: numFunctions=${numFunctions} numNames=${numNames}`);
const exports = [];
for (let i = 0; i < numNames; i++) {
  const nameRVA = buf.readUInt32LE(addrNamesOff + i * 4);
  const nameOff = rvaToOff(nameRVA);
  let end = nameOff;
  while (buf[end] !== 0) end++;
  const name = buf.subarray(nameOff, end).toString('ascii');
  const ord = buf.readUInt16LE(addrOrdOff + i * 2);
  const funcRVA = buf.readUInt32LE(addrFuncOff + ord * 4);
  exports.push({ name, ord, funcRVA });
}
exports.sort((a, b) => a.name.localeCompare(b.name));
for (const e of exports) console.log(`  [${e.ord.toString().padStart(3)}] 0x${e.funcRVA.toString(16).padStart(8,'0')}  ${e.name}`);
