// Pure JS DDS to PNG converter. Reads uncompressed DDS (DXT1/3/5, RGBA8) and outputs PNG.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import zlib from 'zlib';

const dir = process.argv[2];
if (!dir) { console.log('Usage: node dds2png.mjs <dir>'); process.exit(1); }

// Minimal PNG encoder
function writePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = createChunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(width, 0);
    b.writeUInt32BE(height, 4);
    b[8] = 8; // bit depth
    b[9] = 6; // color type (RGBA)
    b[10] = 0; b[11] = 0; b[12] = 0;
    return b;
  })());
  // Build raw scanlines with filter byte 0
  const rawLines = [];
  for (let y = 0; y < height; y++) {
    rawLines.push(0); // filter none
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawLines.push(rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]);
    }
  }
  const raw = Buffer.from(rawLines);
  const compressed = zlib.deflateSync(raw);
  const idat = createChunk('IDAT', compressed);
  const iend = createChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function decodeDDS(buf) {
  if (buf.readUInt32LE(0) !== 0x20534444) throw new Error('Not DDS');
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const mipmapCount = Math.max(1, buf.readUInt32LE(28));
  const pfFlags = buf.readUInt32LE(76);
  const fourCC = buf.readUInt32LE(84);
  const bitCount = buf.readUInt32LE(88);
  const rMask = buf.readUInt32LE(92);
  const gMask = buf.readUInt32LE(96);
  const bMask = buf.readUInt32LE(100);
  const aMask = buf.readUInt32LE(104);

  let offset = 128; // skip header
  const rgba = Buffer.alloc(width * height * 4);

  // BC1 (DXT1)
  if (fourCC === 0x31545844) {
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const c0 = buf.readUInt16LE(offset);
        const c1 = buf.readUInt16LE(offset + 2);
        const lookup = buf.readUInt32LE(offset + 4);
        offset += 8;

        const color0 = rgb565(c0);
        const color1 = rgb565(c1);
        color0.push(255); color1.push(255);
        let color2, color3;
        if (c0 > c1) {
          color2 = lerpColor(color0, color1, 1 / 3); color2.push(255);
          color3 = lerpColor(color0, color1, 2 / 3); color3.push(255);
        } else {
          color2 = lerpColor(color0, color1, 0.5); color2.push(255);
          color3 = [0, 0, 0, 0];
        }
        const colors = [color0, color1, color2, color3];
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const px = x + bx, py = y + by;
            if (px >= width || py >= height) continue;
            const ci = (lookup >> ((by * 4 + bx) * 2)) & 3;
            const c = colors[ci];
            const idx = (py * width + px) * 4;
            rgba[idx] = c[0]; rgba[idx + 1] = c[1]; rgba[idx + 2] = c[2]; rgba[idx + 3] = c[3];
          }
        }
      }
    }
  }
  // BC3 (DXT5)
  else if (fourCC === 0x35545844) {
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        // Alpha block
        const a0 = buf[offset], a1 = buf[offset + 1];
        // Read 48-bit alpha lookup (6 bytes, little-endian)
        let aLookup = 0n;
        for (let i = 5; i >= 0; i--) aLookup = (aLookup << 8n) | BigInt(buf[offset + 2 + i]);
        offset += 8;

        // Color block
        const c0 = buf.readUInt16LE(offset);
        const c1 = buf.readUInt16LE(offset + 2);
        const cLookup = buf.readUInt32LE(offset + 4);
        offset += 8;

        const color0 = rgb565(c0);
        const color1 = rgb565(c1);
        const color2 = lerpColor(color0, color1, 1 / 3);
        const color3 = lerpColor(color0, color1, 2 / 3);

        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const px = x + bx, py = y + by;
            if (px >= width || py >= height) continue;
            const bitIdx = by * 4 + bx;

            let alpha;
            if (a0 > a1) {
              const aVals = [a0, a1, ...Array.from({length: 6}, (_, i) => 
                Math.round(((7 - i) * a0 + (i + 1) * a1) / 7))];
              const aIdx = Number((BigInt(aLookup) >> BigInt(bitIdx * 3)) & 7n);
              alpha = aVals[aIdx];
            } else {
              const aVals = [a0, a1, ...Array.from({length: 4}, (_, i) => 
                Math.round(((5 - i) * a0 + (i + 1) * a1) / 5)), 0, 255];
              const aIdx = Number((BigInt(aLookup) >> BigInt(bitIdx * 3)) & 7n);
              alpha = aVals[aIdx];
            }

            const ci = (cLookup >> (bitIdx * 2)) & 3;
            let col;
            if (ci === 0) col = [...color0, alpha];
            else if (ci === 1) col = [...color1, alpha];
            else if (ci === 2) col = [...color2, alpha];
            else col = [...color3, alpha];

            const idx = (py * width + px) * 4;
            rgba[idx] = col[0]; rgba[idx + 1] = col[1]; rgba[idx + 2] = col[2]; rgba[idx + 3] = col[3];
          }
        }
      }
    }
  }
  // Uncompressed RGBA (A8R8G8B8)
  else if (pfFlags & 0x41 && bitCount === 32) {
    offset = 128;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const b = buf[offset];
        const g = buf[offset + 1];
        const r = buf[offset + 2];
        const a = buf[offset + 3];
        const idx = (y * width + x) * 4;
        rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = a;
        offset += 4;
      }
    }
  }
  // Uncompressed RGB (X8R8G8B8) or other uncompressed 
  else if (pfFlags & 0x40) {
    offset = 128;
    const bpp = Math.max(1, bitCount / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 255;
        if (bitCount >= 24) {
          b = buf[offset]; g = buf[offset + 1]; r = buf[offset + 2];
          a = bitCount >= 32 ? buf[offset + 3] : 255;
        } else if (bitCount === 8) {
          r = g = b = buf[offset]; a = 255;
        }
        const idx = (y * width + x) * 4;
        rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = a;
        offset += bpp;
      }
    }
  } else {
    throw new Error(`Unsupported DDS format: fourCC=0x${fourCC.toString(16)} pf=${pfFlags} bpp=${bitCount}`);
  }

  return { width, height, rgba };
}

function rgb565(v) {
  return [
    ((v >> 11) & 0x1F) * 255 / 31 | 0,
    ((v >> 5) & 0x3F) * 255 / 63 | 0,
    (v & 0x1F) * 255 / 31 | 0,
  ];
}

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Main
const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.dds'));
let converted = 0, skipped = 0, failed = 0;

for (const f of files) {
  const ddsPath = join(dir, f);
  const pngPath = join(dir, f.replace(/\.dds$/i, '.png'));
  if (statSync(pngPath, { throwIfNoEntry: false })) { skipped++; continue; }
  try {
    const buf = readFileSync(ddsPath);
    const { width, height, rgba } = decodeDDS(buf);
    const png = writePNG(width, height, rgba);
    writeFileSync(pngPath, png);
    converted++;
  } catch (e) {
    failed++;
    if (failed <= 3) console.log('FAIL:', f, e.message);
  }
}

console.log(`Converted: ${converted}, Skipped (already PNG): ${skipped}, Failed: ${failed}`);
