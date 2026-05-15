#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import koffi from 'koffi';

const HASH_BUCKET_COUNT = 65536;
const SPECIAL_SLOT_COUNT = 16;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const manifestPath = resolve(process.argv[2] || 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/ver/trunk/2');
const hsRoot = resolve(process.argv[3] || 'cache-extraction/online-cdn/live-hs');
const lzhamDllPath = resolve(process.argv[4] || 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');

function nativeBase32(value) {
  let current = BigInt(value);
  if (current === 0n) return 'a';
  let output = '';
  while (current > 0n) {
    output = ALPHABET[Number(current & 31n)] + output;
    current >>= 5n;
  }
  return output;
}

function readManifest(pathValue) {
  const buffer = readFileSync(pathValue);
  const records = [];
  for (let bucket = 0; bucket < HASH_BUCKET_COUNT + SPECIAL_SLOT_COUNT; bucket += 1) {
    const offset = bucket * 12;
    const hash = buffer.readBigUInt64LE(offset);
    const size = buffer.readUInt32LE(offset + 8);
    records.push({ bucket, hash, size });
  }
  return records;
}

function decodeShards(activeSpecial) {
  const library = koffi.load(lzhamDllPath);
  const uncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  const decoded = [];
  for (const slot of activeSpecial) {
    const dir = Number((slot.hash >> 16n) & 0xffn);
    const shardPath = resolve(hsRoot, String(dir), `${nativeBase32(slot.hash)}.${slot.size}`);
    if (!existsSync(shardPath)) throw new Error(`Missing shard ${shardPath}`);
    const input = readFileSync(shardPath);
    if (input.length === slot.size) {
      decoded.push(input);
      continue;
    }
    const expectedSize = input.readUInt32LE(4);
    const output = Buffer.alloc(expectedSize);
    const outputLength = [expectedSize >>> 0];
    const status = uncompress(output, outputLength, input.subarray(8), (input.length - 8) >>> 0);
    if (status !== 0) throw new Error(`lzham_z_uncompress failed for ${shardPath}: ${status}`);
    decoded.push(output.subarray(0, outputLength[0]));
  }
  return Buffer.concat(decoded);
}

function wantedValues() {
  return new Map([
    ['wem.q0', 0x0ea12950c20824f6n],
    ['wem.q1', 0x02b87a1cdb8c0a7bn],
    ['wem.pkg', 0x14450bed8dff26f7n],
    ['bnk.q0', 0x0ea12969b52fa485n],
    ['bnk.q1', 0x07d48c621df58073n],
    ['bnk.pkg', 0x1802e12f1a005255n],
  ]);
}

const manifest = readManifest(manifestPath);
const activeMain = manifest.slice(0, HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0);
const activeSpecial = manifest.slice(HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0);
const stream = decodeShards(activeSpecial);
const wanted = wantedValues();
const matches = [];

let offset = 0;
for (const bucket of activeMain) {
  const blob = stream.subarray(offset, offset + bucket.size);
  const header = blob.readUInt32LE(0);
  const count = (blob.length - 4) / 32;
  for (let index = 0; index < count; index += 1) {
    const recordOffset = 4 + index * 32;
    const q0 = blob.readBigUInt64LE(recordOffset);
    const q1 = blob.readBigUInt64LE(recordOffset + 8);
    const t0 = blob.readUInt32LE(recordOffset + 24);
    const t1 = blob.readUInt32LE(recordOffset + 28);
    const pkg = (BigInt(t1) << 32n) | BigInt(t0 >>> 0);
    for (const [label, value] of wanted) {
      if (q0 !== value && q1 !== value && pkg !== value) continue;
      matches.push({
        label,
        matchedField: q0 === value ? 'q0' : q1 === value ? 'q1' : 'pkg',
        bucket: bucket.bucket,
        index,
        header,
        q0: `0x${q0.toString(16).padStart(16, '0')}`,
        q1: `0x${q1.toString(16).padStart(16, '0')}`,
        a: blob.readUInt32LE(recordOffset + 16),
        c: blob.readUInt32LE(recordOffset + 20),
        t0,
        t1,
      });
    }
  }
  offset += bucket.size;
}

console.log(JSON.stringify({ manifestPath, hsRoot, records: 3160771, matches }, null, 2));