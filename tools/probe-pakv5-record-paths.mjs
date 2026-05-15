#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import iconv from 'iconv-lite';
import koffi from 'koffi';
import { createJx3CacheReader } from './jx3-cache-reader.js';

const HASH_BUCKET_COUNT = 65536;
const UINT64_MASK = (1n << 64n) - 1n;
const H2_FILE_HASH_MASK = (1n << 40n) - 1n;
const XXHASH64_PRIME_1 = 0x9e3779b185ebca87n;
const XXHASH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const XXHASH64_PRIME_3 = 0x165667b19e3779f9n;
const XXHASH64_PRIME_4 = 0x85ebca77c2b2ae63n;
const XXHASH64_PRIME_5 = 0x27d4eb2f165667c5n;
const NATIVE_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const DEFAULT_MANIFEST_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/ver/trunk/2');
const DEFAULT_HS_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/ver/trunk/bf/hs');
const DEFAULT_LZHAM_DLL_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');
const DEFAULT_CACHE_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat');

function toUint64(value) {
  return BigInt.asUintN(64, value);
}

function rotateLeft64(value, count) {
  const amount = BigInt(count);
  return toUint64((value << amount) | (value >> (64n - amount)));
}

function xxHashRound(accumulator, input) {
  let value = toUint64(accumulator + input * XXHASH64_PRIME_2);
  value = rotateLeft64(value, 31);
  value = toUint64(value * XXHASH64_PRIME_1);
  return value;
}

function xxHashMergeRound(accumulator, value) {
  let merged = toUint64(accumulator ^ xxHashRound(0n, value));
  merged = toUint64(merged * XXHASH64_PRIME_1 + XXHASH64_PRIME_4);
  return merged;
}

function readUInt64LE(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function djb2Masked(bytes) {
  let hash = 5381;
  for (const value of bytes) {
    hash = ((hash * 33) + value) & 0x3fffff;
  }
  return hash >>> 0;
}

function xxHash64(bytes) {
  if (!bytes) {
    throw new Error('xxHash64 requires a byte buffer');
  }

  const length = bytes.length;
  let offset = 0;
  let hash;

  if (length >= 32) {
    let v1 = toUint64(XXHASH64_PRIME_1 + XXHASH64_PRIME_2);
    let v2 = XXHASH64_PRIME_2;
    let v3 = 0n;
    let v4 = toUint64(0n - XXHASH64_PRIME_1);
    const limit = length - 32;

    while (offset <= limit) {
      v1 = xxHashRound(v1, readUInt64LE(bytes, offset));
      offset += 8;
      v2 = xxHashRound(v2, readUInt64LE(bytes, offset));
      offset += 8;
      v3 = xxHashRound(v3, readUInt64LE(bytes, offset));
      offset += 8;
      v4 = xxHashRound(v4, readUInt64LE(bytes, offset));
      offset += 8;
    }

    hash = toUint64(
      rotateLeft64(v1, 1)
      + rotateLeft64(v2, 7)
      + rotateLeft64(v3, 12)
      + rotateLeft64(v4, 18),
    );
    hash = xxHashMergeRound(hash, v1);
    hash = xxHashMergeRound(hash, v2);
    hash = xxHashMergeRound(hash, v3);
    hash = xxHashMergeRound(hash, v4);
  } else {
    hash = XXHASH64_PRIME_5;
  }

  hash = toUint64(hash + BigInt(length));

  while (offset <= length - 8) {
    const lane = xxHashRound(0n, readUInt64LE(bytes, offset));
    hash = toUint64(hash ^ lane);
    hash = toUint64(rotateLeft64(hash, 27) * XXHASH64_PRIME_1 + XXHASH64_PRIME_4);
    offset += 8;
  }

  if (offset <= length - 4) {
    hash = toUint64(hash ^ (BigInt(bytes.readUInt32LE(offset)) * XXHASH64_PRIME_1));
    hash = toUint64(rotateLeft64(hash, 23) * XXHASH64_PRIME_2 + XXHASH64_PRIME_3);
    offset += 4;
  }

  while (offset < length) {
    hash = toUint64(hash ^ (BigInt(bytes[offset]) * XXHASH64_PRIME_5));
    hash = toUint64(rotateLeft64(hash, 11) * XXHASH64_PRIME_1);
    offset += 1;
  }

  hash = toUint64(hash ^ (hash >> 33n));
  hash = toUint64(hash * XXHASH64_PRIME_2);
  hash = toUint64(hash ^ (hash >> 29n));
  hash = toUint64(hash * XXHASH64_PRIME_3);
  hash = toUint64(hash ^ (hash >> 32n));
  return hash;
}

function composeH2(dirHash, fullPathHash) {
  return toUint64((BigInt(dirHash >>> 0) << 40n) | (fullPathHash & H2_FILE_HASH_MASK));
}

function normalizeLogicalPath(logicalPath) {
  return String(logicalPath || '').replace(/\\/g, '/').trim();
}

function toHex64(value) {
  return `0x${value.toString(16).padStart(16, '0')}`;
}

function toNativeBase32(value) {
  if (value === 0n) return 'a';
  let current = value;
  let out = '';
  while (current > 0n) {
    out = NATIVE_BASE32_ALPHABET[Number(current & 31n)] + out;
    current >>= 5n;
  }
  return out;
}

function parseArgs(argv) {
  const args = [...argv];
  const config = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    hsRoot: DEFAULT_HS_ROOT,
    lzhamDllPath: DEFAULT_LZHAM_DLL_PATH,
    cacheRoot: DEFAULT_CACHE_ROOT,
    json: false,
    paths: [],
  };

  while (args.length) {
    const arg = args.shift();
    if (arg === '--manifest') {
      config.manifestPath = resolve(args.shift());
      continue;
    }
    if (arg === '--hs-root') {
      config.hsRoot = resolve(args.shift());
      continue;
    }
    if (arg === '--lzham-dll') {
      config.lzhamDllPath = resolve(args.shift());
      continue;
    }
    if (arg === '--cache-root') {
      config.cacheRoot = resolve(args.shift());
      continue;
    }
    if (arg === '--json') {
      config.json = true;
      continue;
    }
    config.paths.push(arg);
  }

  return config;
}

function loadManifest(manifestPath) {
  const buffer = readFileSync(manifestPath);
  if (buffer.length % 12 !== 0) {
    throw new Error(`Manifest size ${buffer.length} is not divisible by 12`);
  }

  const records = [];
  for (let offset = 0; offset < buffer.length; offset += 12) {
    records.push({
      bucket: offset / 12,
      hash: buffer.readBigUInt64LE(offset),
      size: buffer.readUInt32LE(offset + 8),
    });
  }

  return {
    records,
    activeMain: records.slice(0, HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0),
    activeSpecial: records.slice(HASH_BUCKET_COUNT).filter((record) => record.hash !== 0n || record.size !== 0),
  };
}

function getLzhamZUncompress(lzhamDllPath) {
  const library = koffi.load(lzhamDllPath);
  return library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
}

function decodeShards(activeSpecial, hsRoot, lzhamDllPath) {
  const lzhamZUncompress = getLzhamZUncompress(lzhamDllPath);
  const decoded = [];

  for (const slot of activeSpecial) {
    const shardDir = Number((slot.hash >> 16n) & 0xffn);
    const shardPath = `${hsRoot}/${shardDir}/${toNativeBase32(slot.hash)}.${slot.size}`;
    const buffer = readFileSync(shardPath);
    if (buffer.length === slot.size) {
      decoded.push(buffer);
      continue;
    }
    if (buffer.length < 8) {
      throw new Error(`Shard ${shardPath} is too small to decode`);
    }

    const expectedSize = buffer.readUInt32LE(4);
    if (expectedSize !== slot.size) {
      throw new Error(`Shard ${shardPath} expected ${expectedSize} bytes but manifest says ${slot.size}`);
    }

    const output = Buffer.alloc(expectedSize);
    const outputLength = [expectedSize >>> 0];
    const status = lzhamZUncompress(output, outputLength, buffer.subarray(8), (buffer.length - 8) >>> 0);
    if (status !== 0) {
      throw new Error(`lzham_z_uncompress failed for ${shardPath} with status ${status}`);
    }
    decoded.push(output);
  }

  return Buffer.concat(decoded);
}

function sliceRecords(activeMain, stream) {
  const records = [];
  let offset = 0;

  for (const bucket of activeMain) {
    const blob = stream.subarray(offset, offset + bucket.size);
    if (blob.length !== bucket.size) {
      throw new Error(`Bucket ${bucket.bucket} expected ${bucket.size} bytes but only ${blob.length} remain`);
    }
    if (blob.length < 4 || (blob.length - 4) % 32 !== 0) {
      throw new Error(`Bucket ${bucket.bucket} has invalid payload size ${blob.length}`);
    }

    const header = blob.readUInt32LE(0);
    const recordCount = (blob.length - 4) / 32;
    for (let index = 0; index < recordCount; index += 1) {
      const record = blob.subarray(4 + index * 32, 4 + (index + 1) * 32);
      records.push({
        bucket: bucket.bucket,
        header,
        q0: record.readBigUInt64LE(0),
        q1: record.readBigUInt64LE(8),
        a: record.readUInt32LE(16),
        c: record.readUInt32LE(20),
        t0: record.readUInt32LE(24),
        t1: record.readUInt32LE(28),
      });
    }

    offset += bucket.size;
  }

  if (offset !== stream.length) {
    throw new Error(`Consumed ${offset} bytes but decoded stream is ${stream.length} bytes`);
  }

  return records;
}

function buildIndex(records) {
  const byQ0 = new Map();
  const byQ1 = new Map();
  const bySizePair = new Map();

  for (const record of records) {
    const q0List = byQ0.get(record.q0) || [];
    q0List.push(record);
    byQ0.set(record.q0, q0List);

    const q1List = byQ1.get(record.q1) || [];
    q1List.push(record);
    byQ1.set(record.q1, q1List);

    const sizeKey = `${record.a}|${record.c}`;
    const sizeList = bySizePair.get(sizeKey) || [];
    sizeList.push(record);
    bySizePair.set(sizeKey, sizeList);
  }

  return { byQ0, byQ1, bySizePair };
}

function uniquePush(list, seen, item) {
  if (seen.has(item.key)) {
    return;
  }
  seen.add(item.key);
  list.push(item);
}

function buildCandidates(logicalPath) {
  const rawPath = normalizeLogicalPath(logicalPath);
  const lowerPath = rawPath.toLowerCase();
  const pathVariants = [...new Set([rawPath, lowerPath].filter(Boolean))];
  const candidates = [];
  const seen = new Set();

  for (const candidatePath of pathVariants) {
    const slashIndex = candidatePath.lastIndexOf('/');
    if (slashIndex < 0) {
      continue;
    }

    const rawParent = candidatePath.slice(0, slashIndex);
    const lowerParent = rawParent.toLowerCase();
    const parentVariants = [...new Set([rawParent, lowerParent])];

    for (const fullEncoding of ['gbk', 'utf8']) {
      for (const parentEncoding of ['gbk', 'utf8']) {
        for (const parentPath of parentVariants) {
          const fullBytes = fullEncoding === 'gbk'
            ? iconv.encode(candidatePath, 'gbk')
            : Buffer.from(candidatePath, 'utf8');
          const parentBytes = parentEncoding === 'gbk'
            ? iconv.encode(parentPath, 'gbk')
            : Buffer.from(parentPath, 'utf8');
          const fileHash = xxHash64(fullBytes);
          const dirHash = djb2Masked(parentBytes);
          const h2 = composeH2(dirHash, fileHash);
          uniquePush(candidates, seen, {
            key: `${candidatePath}|${fullEncoding}|${parentPath}|${parentEncoding}`,
            candidatePath,
            parentPath,
            fullEncoding,
            parentEncoding,
            dirHash,
            fileHash,
            h2,
          });
        }
      }
    }
  }

  return candidates;
}

function serializeRecord(record) {
  return {
    bucket: record.bucket,
    header: record.header,
    q0Hex: toHex64(record.q0),
    q1Hex: toHex64(record.q1),
    a: record.a,
    c: record.c,
    t0: record.t0,
    t1: record.t1,
  };
}

function serializeLocalEntry(entry) {
  return {
    logicalPath: entry.logicalPath,
    h1Hex: toHex64(entry.h1),
    h2Hex: toHex64(entry.h2),
    fileHashHex: toHex64(entry.fileHash),
    dirHashHex: `0x${entry.dirHash.toString(16)}`,
    datIndex: entry.datIndex,
    datOffset: entry.datOffset,
    originalSize: entry.originalSize,
    compressedSize: entry.compressedSize,
    compressionType: entry.compressionType,
  };
}

function resolveLocalEntry(logicalPath, reader) {
  try {
    return serializeLocalEntry(reader.resolveEntry(logicalPath));
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probePath(logicalPath, index, reader) {
  const candidates = buildCandidates(logicalPath);
  let localEntryRaw = null;
  let localEntry;
  try {
    localEntryRaw = reader.resolveEntry(logicalPath);
    localEntry = serializeLocalEntry(localEntryRaw);
  } catch (error) {
    localEntry = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    requestedPath: logicalPath,
    localEntry,
    candidates: candidates.map((candidate) => ({
      candidatePath: candidate.candidatePath,
      parentPath: candidate.parentPath,
      fullEncoding: candidate.fullEncoding,
      parentEncoding: candidate.parentEncoding,
      dirHashHex: `0x${candidate.dirHash.toString(16)}`,
      fileHashHex: toHex64(candidate.fileHash),
      h2Hex: toHex64(candidate.h2),
      sizePairMatches: localEntryRaw ? (index.bySizePair.get(`${localEntryRaw.originalSize}|${localEntryRaw.compressedSize}`) || []).map(serializeRecord) : [],
      swappedSizePairMatches: localEntryRaw ? (index.bySizePair.get(`${localEntryRaw.compressedSize}|${localEntryRaw.originalSize}`) || []).map(serializeRecord) : [],
      q0H1Matches: localEntryRaw ? (index.byQ0.get(localEntryRaw.h1) || []).map(serializeRecord) : [],
      q1H1Matches: localEntryRaw ? (index.byQ1.get(localEntryRaw.h1) || []).map(serializeRecord) : [],
      q0Matches: (index.byQ0.get(candidate.h2) || []).map(serializeRecord),
      q1Matches: (index.byQ1.get(candidate.h2) || []).map(serializeRecord),
      q0FileHashMatches: (index.byQ0.get(candidate.fileHash) || []).map(serializeRecord),
      q1FileHashMatches: (index.byQ1.get(candidate.fileHash) || []).map(serializeRecord),
    })),
  };
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(config.manifestPath);
  const decodedStream = decodeShards(manifest.activeSpecial, config.hsRoot, config.lzhamDllPath);
  const records = sliceRecords(manifest.activeMain, decodedStream);
  const index = buildIndex(records);
  const reader = createJx3CacheReader({
    cacheRoot: config.cacheRoot,
    lzhamDllPath: config.lzhamDllPath,
  });
  const result = {
    manifestPath: config.manifestPath,
    hsRoot: config.hsRoot,
    cacheRoot: config.cacheRoot,
    activeMainBuckets: manifest.activeMain.length,
    activeSpecialSlots: manifest.activeSpecial.length,
    decodedStreamBytes: decodedStream.length,
    recordCount: records.length,
    probes: config.paths.map((logicalPath) => probePath(logicalPath, index, reader)),
  };

  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`manifest=${result.manifestPath}`);
  console.log(`hsRoot=${result.hsRoot}`);
  console.log(`cacheRoot=${result.cacheRoot}`);
  console.log(`activeMainBuckets=${result.activeMainBuckets}`);
  console.log(`activeSpecialSlots=${result.activeSpecialSlots}`);
  console.log(`decodedStreamBytes=${result.decodedStreamBytes}`);
  console.log(`recordCount=${result.recordCount}`);

  for (const probe of result.probes) {
    console.log(`\nPATH ${probe.requestedPath}`);
    if (probe.localEntry.error) {
      console.log(`  localCache=${probe.localEntry.error}`);
    } else {
      console.log(`  localCache h1=${probe.localEntry.h1Hex} h2=${probe.localEntry.h2Hex} fileHash=${probe.localEntry.fileHashHex} dirHash=${probe.localEntry.dirHashHex} dat=${probe.localEntry.datIndex}@${probe.localEntry.datOffset} size=${probe.localEntry.originalSize}/${probe.localEntry.compressedSize}`);
    }
    for (const candidate of probe.candidates) {
      const counts = [
        candidate.q0Matches.length,
        candidate.q1Matches.length,
        candidate.q0FileHashMatches.length,
        candidate.q1FileHashMatches.length,
      ].join('/');
      if (counts === '0/0/0/0') {
        continue;
      }
      console.log(`  candidate=${candidate.candidatePath}`);
      console.log(`  fullEncoding=${candidate.fullEncoding} parent=${candidate.parentPath} parentEncoding=${candidate.parentEncoding}`);
      console.log(`  dirHash=${candidate.dirHashHex} fileHash=${candidate.fileHashHex} h2=${candidate.h2Hex}`);
      if (candidate.q0Matches.length) {
        console.log(`  q0(h2) matches=${candidate.q0Matches.length}`);
        for (const match of candidate.q0Matches.slice(0, 8)) {
          console.log(`    bucket=${match.bucket} q1=${match.q1Hex} a=${match.a} c=${match.c} t0=${match.t0} t1=${match.t1}`);
        }
      }
      if (candidate.q1Matches.length) {
        console.log(`  q1(h2) matches=${candidate.q1Matches.length}`);
        for (const match of candidate.q1Matches.slice(0, 8)) {
          console.log(`    bucket=${match.bucket} q0=${match.q0Hex} a=${match.a} c=${match.c} t0=${match.t0} t1=${match.t1}`);
        }
      }
      if (candidate.q0FileHashMatches.length) {
        console.log(`  q0(fileHash) matches=${candidate.q0FileHashMatches.length}`);
        for (const match of candidate.q0FileHashMatches.slice(0, 8)) {
          console.log(`    bucket=${match.bucket} q1=${match.q1Hex} a=${match.a} c=${match.c} t0=${match.t0} t1=${match.t1}`);
        }
      }
      if (candidate.q1FileHashMatches.length) {
        console.log(`  q1(fileHash) matches=${candidate.q1FileHashMatches.length}`);
        for (const match of candidate.q1FileHashMatches.slice(0, 8)) {
          console.log(`    bucket=${match.bucket} q0=${match.q0Hex} a=${match.a} c=${match.c} t0=${match.t0} t1=${match.t1}`);
        }
      }
    }
  }
}

main();
