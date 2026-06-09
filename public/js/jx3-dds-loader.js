import { DDSLoader as ThreeDDSLoader } from '/vendor/three/examples/jsm/loaders/DDSLoader.js';

const DDS_MAGIC = 0x20534444;
const HEADER_LENGTH_INT = 31;
const DX10_HEADER_BYTES = 20;
const OFF_MAGIC = 0;
const OFF_SIZE = 1;
const OFF_FOURCC = 21;
const OFF_DXGI_FORMAT = 0;

function fourCCToInt32(value) {
  return value.charCodeAt(0)
    + (value.charCodeAt(1) << 8)
    + (value.charCodeAt(2) << 16)
    + (value.charCodeAt(3) << 24);
}

const FOURCC_DX10 = fourCCToInt32('DX10');
const FOURCC_DXT1 = fourCCToInt32('DXT1');
const FOURCC_DXT3 = fourCCToInt32('DXT3');
const FOURCC_DXT5 = fourCCToInt32('DXT5');

const DXGI_TO_LEGACY_FOURCC = new Map([
  [70, FOURCC_DXT1],
  [71, FOURCC_DXT1],
  [72, FOURCC_DXT1],
  [73, FOURCC_DXT3],
  [74, FOURCC_DXT3],
  [75, FOURCC_DXT3],
  [76, FOURCC_DXT5],
  [77, FOURCC_DXT5],
  [78, FOURCC_DXT5],
]);

function stripDX10Header(buffer, fourCC) {
  const source = new Uint8Array(buffer);
  const headerBytes = 128;
  const patched = new Uint8Array(source.byteLength - DX10_HEADER_BYTES);
  patched.set(source.subarray(0, headerBytes), 0);
  patched.set(source.subarray(headerBytes + DX10_HEADER_BYTES), headerBytes);
  const header = new Int32Array(patched.buffer, 0, HEADER_LENGTH_INT);
  header[OFF_FOURCC] = fourCC;
  return patched.buffer;
}

export class DDSLoader extends ThreeDDSLoader {
  parse(buffer, loadMipmaps) {
    const header = new Int32Array(buffer, 0, HEADER_LENGTH_INT);
    if (header[OFF_MAGIC] === DDS_MAGIC && header[OFF_FOURCC] === FOURCC_DX10) {
      const dx10Offset = (header[OFF_SIZE] + 4) || 128;
      const extendedHeader = new Int32Array(buffer, dx10Offset, 5);
      const replacement = DXGI_TO_LEGACY_FOURCC.get(extendedHeader[OFF_DXGI_FORMAT]);
      if (replacement) {
        return super.parse(stripDX10Header(buffer, replacement), loadMipmaps);
      }
    }
    return super.parse(buffer, loadMipmaps);
  }
}