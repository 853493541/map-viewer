import { readFileSync } from 'node:fs';

const [, , dllPath, ...rvaArgs] = process.argv;

if (!dllPath || !rvaArgs.length) {
  console.error('usage: node tools/pe-rva-dump.mjs <dll> <rva> [rva...] | --find <ascii> [ascii...] | --xref-rva <rva> [rva...] | --near-code <rva> [rva...]');
  process.exit(2);
}

const buf = readFileSync(dllPath);
if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not an MZ image');
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x4550) throw new Error('not a PE image');

const coffOff = peOff + 4;
const numSections = buf.readUInt16LE(coffOff + 2);
const sizeOptHdr = buf.readUInt16LE(coffOff + 16);
const optOff = coffOff + 20;
const sectOff = optOff + sizeOptHdr;

const sections = [];
for (let i = 0; i < numSections; i++) {
  const off = sectOff + i * 40;
  sections.push({
    name: buf.subarray(off, off + 8).toString('ascii').replace(/\0+$/, ''),
    virtualSize: buf.readUInt32LE(off + 8),
    virtualAddress: buf.readUInt32LE(off + 12),
    rawSize: buf.readUInt32LE(off + 16),
    rawPtr: buf.readUInt32LE(off + 20),
    characteristics: buf.readUInt32LE(off + 36),
  });
}

function parseRva(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  return Number(/^0x/i.test(text) ? BigInt(text) : BigInt(`0x${text}`));
}

function sectionForRva(rva) {
  return sections.find((section) => {
    const start = section.virtualAddress;
    const end = start + Math.max(section.virtualSize, section.rawSize);
    return rva >= start && rva < end;
  }) || null;
}

function rvaToOff(rva) {
  const section = sectionForRva(rva);
  if (!section) return -1;
  return section.rawPtr + (rva - section.virtualAddress);
}

function offToRva(off) {
  const section = sections.find((item) => off >= item.rawPtr && off < item.rawPtr + item.rawSize);
  if (!section) return -1;
  return section.virtualAddress + (off - section.rawPtr);
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function ascii(bytes) {
  return Array.from(bytes, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');
}

function readI32(off) {
  return off >= 0 && off + 4 <= buf.length ? buf.readInt32LE(off) : null;
}

function readU32(off) {
  return off >= 0 && off + 4 <= buf.length ? buf.readUInt32LE(off) : null;
}

function findAllBytes(needle) {
  const out = [];
  for (let index = buf.indexOf(needle); index >= 0; index = buf.indexOf(needle, index + 1)) {
    out.push(index);
    if (out.length >= 200) break;
  }
  return out;
}

function findRipXrefsToRva(targetRva) {
  const out = [];
  for (const section of sections) {
    if ((section.characteristics & 0x20000000) === 0) continue;
    const start = section.rawPtr;
    const end = Math.min(section.rawPtr + section.rawSize, buf.length - 7);
    for (let off = start; off < end; off++) {
      const rva = offToRva(off);
      const b0 = buf[off];
      const b1 = buf[off + 1];
      const b2 = buf[off + 2];
      let dispOff = -1;
      let kind = '';
      if (b0 >= 0x48 && b0 <= 0x4f && b1 === 0x8d && (b2 & 0xc7) === 0x05) { dispOff = off + 3; kind = 'lea-rip'; }
      else if (b0 >= 0x48 && b0 <= 0x4f && b1 === 0x8b && (b2 & 0xc7) === 0x05) { dispOff = off + 3; kind = 'mov-rip'; }
      else if (b0 === 0xe8 || b0 === 0xe9) { dispOff = off + 1; kind = b0 === 0xe8 ? 'call-rel32' : 'jmp-rel32'; }
      if (dispOff < 0) continue;
      const disp = readI32(dispOff);
      const nextRva = rva + (dispOff - off) + 4;
      const resolved = nextRva + disp;
      if (resolved !== targetRva) continue;
      out.push({ kind, rva: `0x${rva.toString(16)}`, bytesHex: hex(buf.subarray(off, Math.min(off + 16, buf.length))) });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

function looksLikeFunctionStart(off) {
  const b0 = buf[off];
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];
  if ([0x40, 0x41].includes(b0) && [0x53, 0x55, 0x56, 0x57].includes(b1)) return true;
  if (b0 === 0x48 && b1 === 0x89 && b2 === 0x5c && b3 === 0x24) return true;
  if (b0 === 0x48 && b1 === 0x8b && b2 === 0xc4) return true;
  if (b0 === 0x48 && b1 === 0x83 && b2 === 0xec) return true;
  if (b0 === 0x48 && b1 === 0x81 && b2 === 0xec) return true;
  if (b0 === 0x4c && b1 === 0x8b && b2 === 0xdc) return true;
  return false;
}

function findNearbyCode(rva, windowBytes = 768) {
  const off = rvaToOff(rva);
  const section = sectionForRva(rva);
  if (off < 0 || !section) return { ok: false };
  const sectionStart = section.rawPtr;
  const start = Math.max(sectionStart, off - windowBytes);
  const prologues = [];
  for (let cursor = off; cursor >= start; cursor--) {
    if (!looksLikeFunctionStart(cursor)) continue;
    const candidateRva = offToRva(cursor);
    prologues.push({
      rva: `0x${candidateRva.toString(16)}`,
      distance: `-0x${(rva - candidateRva).toString(16)}`,
      bytesHex: hex(buf.subarray(cursor, Math.min(cursor + 32, buf.length))),
      ascii: ascii(buf.subarray(cursor, Math.min(cursor + 32, buf.length))),
      hint: hintInstruction(buf.subarray(cursor, Math.min(cursor + 32, buf.length)), candidateRva, cursor),
    });
    if (prologues.length >= 16) break;
  }
  const around = [];
  for (const delta of [-64, -32, 0, 32, 64]) {
    const cursorRva = rva + delta;
    const cursorOff = rvaToOff(cursorRva);
    if (cursorOff < 0) continue;
    around.push({
      rva: `0x${cursorRva.toString(16)}`,
      bytesHex: hex(buf.subarray(cursorOff, Math.min(cursorOff + 32, buf.length))),
      ascii: ascii(buf.subarray(cursorOff, Math.min(cursorOff + 32, buf.length))),
      hint: hintInstruction(buf.subarray(cursorOff, Math.min(cursorOff + 32, buf.length)), cursorRva, cursorOff),
    });
  }
  return { ok: true, section: section.name, prologues, around };
}

function hintInstruction(bytes, rva, off) {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xe9 || b0 === 0xe8) {
    const rel = readI32(off + 1);
    return `${b0 === 0xe9 ? 'jmp' : 'call'} rel32 -> rva 0x${(rva + 5 + rel).toString(16)}`;
  }
  if (b0 === 0xeb) {
    const rel = bytes[1] << 24 >> 24;
    return `jmp rel8 -> rva 0x${(rva + 2 + rel).toString(16)}`;
  }
  if (b0 === 0xff && b1 === 0x25) {
    const disp = readI32(off + 2);
    const iatRva = rva + 6 + disp;
    const iatOff = rvaToOff(iatRva);
    const lo = readU32(iatOff);
    const hi = readU32(iatOff + 4);
    const target = lo == null || hi == null ? '' : ` file-qword=0x${(BigInt(hi) << 32n | BigInt(lo)).toString(16)}`;
    return `jmp [rip+0x${disp.toString(16)}] -> rva 0x${iatRva.toString(16)}${target}`;
  }
  if (b0 === 0xcc) return 'int3 padding/trap at entry';
  if (b0 === 0x00) return 'zero byte at entry';
  if (b0 === 0x40 || b0 === 0x48 || b0 === 0x4c || b0 === 0x55 || b0 === 0x53 || b0 === 0x56 || b0 === 0x57) return 'normal x64 prologue candidate';
  return '';
}

if (rvaArgs[0] === '--find') {
  for (const text of rvaArgs.slice(1)) {
    const needle = Buffer.from(text, 'ascii');
    const hits = findAllBytes(needle).map((off) => ({
      fileOffset: `0x${off.toString(16)}`,
      rva: `0x${offToRva(off).toString(16)}`,
      section: sectionForRva(offToRva(off))?.name || '',
      preview: ascii(buf.subarray(Math.max(0, off - 24), Math.min(buf.length, off + needle.length + 80))),
      xrefs: findRipXrefsToRva(offToRva(off)).slice(0, 20),
    }));
    console.log(JSON.stringify({ text, hits }));
  }
  process.exit(0);
}

if (rvaArgs[0] === '--xref-rva') {
  for (const rvaArg of rvaArgs.slice(1)) {
    const rva = parseRva(rvaArg);
    console.log(JSON.stringify({ rva: `0x${rva.toString(16)}`, xrefs: findRipXrefsToRva(rva) }));
  }
  process.exit(0);
}

if (rvaArgs[0] === '--near-code') {
  for (const rvaArg of rvaArgs.slice(1)) {
    const rva = parseRva(rvaArg);
    console.log(JSON.stringify({ rva: `0x${rva.toString(16)}`, ...findNearbyCode(rva) }));
  }
  process.exit(0);
}

for (const rvaArg of rvaArgs) {
  const rva = parseRva(rvaArg);
  const section = sectionForRva(rva);
  const off = rvaToOff(rva);
  if (!Number.isFinite(rva) || !section || off < 0) {
    console.log(JSON.stringify({ rva: rvaArg, ok: false }));
    continue;
  }
  const bytes = buf.subarray(off, Math.min(off + 96, buf.length));
  console.log(JSON.stringify({
    rva: `0x${rva.toString(16)}`,
    fileOffset: `0x${off.toString(16)}`,
    section: {
      name: section.name,
      virtualAddress: `0x${section.virtualAddress.toString(16)}`,
      virtualSize: section.virtualSize,
      rawSize: section.rawSize,
      characteristics: `0x${section.characteristics.toString(16)}`,
    },
    bytesHex: hex(bytes.subarray(0, 64)),
    ascii: ascii(bytes.subarray(0, 64)),
    hint: hintInstruction(bytes, rva, off),
  }));
}