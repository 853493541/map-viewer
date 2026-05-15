// Parse a Wwise SoundBank (.bnk) for DIDX (embedded wem index) and HIRC
// (object hierarchy). Provides a brute-force walk from Event objects to
// reachable embedded wem source IDs.
//
// Brute-force here means: instead of decoding every Wwise object body precisely
// (the format depends on the Wwise version and contains variable-length
// NodeBaseParams / RTPC blocks), we scan every byte alignment of each object's
// body for uint32 LE values that match either:
//   - another object's ID (graph edge), or
//   - a wem ID listed in DIDX (terminal source).
// 32-bit FNV-style IDs collide rarely, so false positives are unlikely.

import { readFileSync } from 'node:fs';

const HIRC_TYPE_SOUND = 2;

export function parseBnk(bnkPath) {
  const buf = readFileSync(bnkPath);
  let off = 0;
  let didxStart = -1;
  let didxSize = 0;
  let dataStart = -1;
  let hircStart = -1;
  let hircSize = 0;
  while (off + 8 <= buf.length) {
    const tag = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (tag === 'DIDX') { didxStart = off + 8; didxSize = sz; }
    else if (tag === 'DATA') { dataStart = off + 8; }
    else if (tag === 'HIRC') { hircStart = off + 8; hircSize = sz; }
    if (off + 8 + sz < off + 8) break; // overflow guard
    off += 8 + sz;
  }
  const wems = new Map();
  if (didxStart >= 0 && didxSize > 0) {
    const n = Math.floor(didxSize / 12);
    for (let i = 0; i < n; i++) {
      const id = buf.readUInt32LE(didxStart + i * 12);
      const ofs = buf.readUInt32LE(didxStart + i * 12 + 4);
      const len = buf.readUInt32LE(didxStart + i * 12 + 8);
      wems.set(id, { offset: ofs, size: len });
    }
  }
  const objects = []; // {type,id,body:Buffer}
  if (hircStart >= 0) {
    let p = hircStart;
    const num = buf.readUInt32LE(p); p += 4;
    for (let i = 0; i < num && p < hircStart + hircSize; i++) {
      const type = buf.readUInt8(p); p += 1;
      const objSize = buf.readUInt32LE(p); p += 4;
      if (objSize < 4 || p + objSize > buf.length) break;
      const id = buf.readUInt32LE(p);
      const body = buf.subarray(p + 4, p + objSize);
      objects.push({ type, id, body });
      p += objSize;
    }
  }
  return { buf, wems, objects, dataStart };
}

// Walk events to wem IDs using brute u32 reference scan.
export function mapEventsToWems(parsed) {
  const { wems, objects } = parsed;
  const wemIds = new Set([...wems.keys()]);
  const byId = new Map();
  for (const o of objects) byId.set(o.id, o);
  const events = objects.filter((o) => o.type === 4);
  const result = new Map(); // eventId -> Set<wemId>
  for (const ev of events) {
    const reachableWems = new Set();
    const visited = new Set();
    const stack = [ev];
    while (stack.length) {
      const obj = stack.pop();
      if (!obj || visited.has(obj.id)) continue;
      visited.add(obj.id);
      // Sound: pick first 4-byte aligned u32 inside body matching a DIDX wem id.
      // Sounds in modern Wwise have source_id at offset 5 (plugin_id u32 +
      // stream_type u8). We scan from byte 4..15 to be tolerant of variants.
      if (obj.type === HIRC_TYPE_SOUND) {
        for (let p = 0; p + 4 <= Math.min(obj.body.length, 24); p++) {
          const v = obj.body.readUInt32LE(p);
          if (wemIds.has(v)) { reachableWems.add(v); break; }
        }
        continue;
      }
      // Other objects: scan body for u32s that point to another HIRC object
      // or directly to a wem id (some action/container variants reference
      // wems directly).
      for (let p = 0; p + 4 <= obj.body.length; p++) {
        const v = obj.body.readUInt32LE(p);
        if (v === 0 || v === obj.id) continue;
        if (wemIds.has(v)) { reachableWems.add(v); continue; }
        const child = byId.get(v);
        if (child) stack.push(child);
      }
    }
    result.set(ev.id, reachableWems);
  }
  return result;
}
