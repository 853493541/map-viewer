#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';
import koffi from 'koffi';

const HASH_BUCKET_COUNT = 65536;
const SPECIAL_SLOT_COUNT = 16;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ROOT = 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/';

const manifestPath = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/ver/trunk/2');
const hsRoot = resolve('cache-extraction/online-cdn/live-hs');
const lzhamDllPath = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');
const maxRecords = Math.max(1, Number(process.argv[2] || 5000));
const stride = Math.max(1, Number(process.argv[3] || 997));
const concurrency = Math.max(1, Math.min(32, Number(process.argv[4] || 12)));

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
    records.push({ bucket, hash: buffer.readBigUInt64LE(offset), size: buffer.readUInt32LE(offset + 8) });
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

function candidatePaths(record) {
  const values = [
    ['q1', record.q1],
    ['q0', record.q0],
  ];
  const sizes = [
    ['c', record.c],
    ['a', record.a],
  ];
  const paths = [];
  for (const [field, value] of values) {
    const name = nativeBase32(value);
    const dir = Number((value >> 16n) & 0xffn);
    for (const [sizeField, size] of sizes) {
      paths.push({ path: `h/${dir}/${name}.${size}`, field, sizeField });
    }
  }
  return paths;
}

function head(relativePath) {
  return new Promise((resolvePromise) => {
    const request = https.request(`${ROOT}${relativePath}`, { method: 'HEAD' }, (response) => {
      const contentLength = response.headers['content-length'] || '';
      response.resume();
      resolvePromise({ path: relativePath, status: response.statusCode, contentLength });
    });
    request.setTimeout(2500, () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolvePromise({ path: relativePath, status: 0, error: error.message }));
    request.end();
  });
}

async function mapConcurrent(items, worker) {
  let cursor = 0;
  const output = [];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

const manifest = readManifest(manifestPath);
const activeMain = manifest.slice(0, HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0);
const activeSpecial = manifest.slice(HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0);
const stream = decodeShards(activeSpecial);
const records = [];
let streamOffset = 0;
let seen = 0;

for (const bucket of activeMain) {
  const blob = stream.subarray(streamOffset, streamOffset + bucket.size);
  const header = blob.readUInt32LE(0);
  const count = (blob.length - 4) / 32;
  for (let index = 0; index < count; index += 1) {
    if (seen % stride === 0) {
      const recordOffset = 4 + index * 32;
      records.push({
        bucket: bucket.bucket,
        index,
        header,
        q0: blob.readBigUInt64LE(recordOffset),
        q1: blob.readBigUInt64LE(recordOffset + 8),
        a: blob.readUInt32LE(recordOffset + 16),
        c: blob.readUInt32LE(recordOffset + 20),
        t0: blob.readUInt32LE(recordOffset + 24),
        t1: blob.readUInt32LE(recordOffset + 28),
      });
      if (records.length >= maxRecords) break;
    }
    seen += 1;
  }
  streamOffset += bucket.size;
  if (records.length >= maxRecords) break;
}

const candidates = [];
const candidateSeen = new Set();
for (const record of records) {
  for (const candidate of candidatePaths(record)) {
    if (candidateSeen.has(candidate.path)) continue;
    candidateSeen.add(candidate.path);
    candidates.push({ ...candidate, record });
  }
}

const results = await mapConcurrent(candidates, async (candidate) => ({ ...await head(candidate.path), candidate }));
const hits = results.filter((result) => result.status && result.status !== 404);
console.log(JSON.stringify({ maxRecords, stride, sampledRecords: records.length, checked: candidates.length, hits }, null, 2));