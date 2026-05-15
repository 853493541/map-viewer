#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import koffi from 'koffi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DEFAULT_MANIFEST_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/9');
const DEFAULT_BF_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/zsCache/ver/trunk/bf');
const DEFAULT_LZHAM_DLL_PATH = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');
const HASH_BUCKET_COUNT = 65536;
const SPECIAL_SLOT_COUNT = 16;
const RECORD_SIZE = 12;
const NATIVE_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const UINT64_MASK = (1n << 64n) - 1n;
const H2_FILE_HASH_MASK = (1n << 40n) - 1n;
const XXHASH64_PRIME_1 = 0x9e3779b185ebca87n;
const XXHASH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const XXHASH64_PRIME_3 = 0x165667b19e3779f9n;
const XXHASH64_PRIME_4 = 0x85ebca77c2b2ae63n;
const XXHASH64_PRIME_5 = 0x27d4eb2f165667c5n;

const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const manifestArgIdx = argv.indexOf('--manifest');
const bfArgIdx = argv.indexOf('--bf-root');
const lzhamArgIdx = argv.indexOf('--lzham-dll');
const pathArgIdx = argv.indexOf('--path');
const manifestPath = manifestArgIdx >= 0 ? resolve(argv[manifestArgIdx + 1]) : DEFAULT_MANIFEST_PATH;
const bfRoot = bfArgIdx >= 0 ? resolve(argv[bfArgIdx + 1]) : DEFAULT_BF_ROOT;
const lzhamDllPath = lzhamArgIdx >= 0 ? resolve(argv[lzhamArgIdx + 1]) : DEFAULT_LZHAM_DLL_PATH;
const logicalPathProbe = pathArgIdx >= 0 ? argv[pathArgIdx + 1] : null;
let lzhamZUncompress = null;

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
  return String(logicalPath || '').replace(/\\/g, '/').trim().toLowerCase();
}

function preserveLogicalPath(logicalPath) {
  return String(logicalPath || '').replace(/\\/g, '/').trim();
}

function toHex64(value) {
  return `0x${value.toString(16).padStart(16, '0')}`;
}

function toBase36(value) {
  return value.toString(36);
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

function getLzhamZUncompress() {
  if (!lzhamZUncompress) {
    const library = koffi.load(lzhamDllPath);
    lzhamZUncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
  }
  return lzhamZUncompress;
}

function decodeSpecialShard(absPath, expectedSize) {
  const buffer = readFileSync(absPath);
  if (buffer.length === expectedSize) {
    return {
      storage: 'raw',
      actualFileBytes: buffer.length,
      decodedPayloadBytes: buffer.length,
      headerWord0Hex: null,
      headerExpectedBytes: null,
    };
  }

  if (buffer.length < 8) {
    throw new Error(`Special shard ${absPath} is only ${buffer.length} bytes, too small for wrapped payload`);
  }

  const headerWord0 = buffer.readUInt32LE(0);
  const headerExpectedBytes = buffer.readUInt32LE(4);
  if (headerExpectedBytes !== expectedSize) {
    throw new Error(`Special shard ${absPath} header expected size ${headerExpectedBytes} does not match manifest size ${expectedSize}`);
  }

  const output = Buffer.alloc(headerExpectedBytes);
  const outputLen = [headerExpectedBytes >>> 0];
  const status = getLzhamZUncompress()(output, outputLen, buffer.subarray(8), (buffer.length - 8) >>> 0);
  if (status !== 0) {
    throw new Error(`Special shard ${absPath} LZHAM decode failed with status ${status}`);
  }

  return {
    storage: 'lzham-header-8',
    actualFileBytes: buffer.length,
    decodedPayloadBytes: outputLen[0],
    headerWord0Hex: `0x${headerWord0.toString(16)}`,
    headerExpectedBytes,
  };
}

function parseManifest(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length % RECORD_SIZE !== 0) {
    throw new Error(`Manifest size ${buffer.length} is not divisible by ${RECORD_SIZE}`);
  }

  const records = [];
  for (let off = 0; off < buffer.length; off += RECORD_SIZE) {
    const hash = buffer.readBigUInt64LE(off);
    const size = buffer.readUInt32LE(off + 8);
    records.push({
      bucket: off / RECORD_SIZE,
      offset: off,
      hash,
      size,
      active: hash !== 0n || size !== 0,
      regularPayload: size >= 4 && (size - 4) % 32 === 0,
      regularRecordCount: size >= 4 && (size - 4) % 32 === 0 ? (size - 4) / 32 : null,
      sizeMod32: size % 32,
    });
  }

  return {
    filePath,
    byteLength: buffer.length,
    recordCount: records.length,
    records,
  };
}

function collectFiles(root) {
  const out = [];
  walk(root);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const size = statSync(abs).size;
      out.push({
        absPath: abs,
        relativePath: relative(root, abs).replace(/\\/g, '/'),
        size,
      });
    }
  }
}

function summarize(manifest, bfFiles) {
  const mainBuckets = manifest.records.slice(0, HASH_BUCKET_COUNT);
  const specialSlots = manifest.records.slice(HASH_BUCKET_COUNT, HASH_BUCKET_COUNT + SPECIAL_SLOT_COUNT);
  const activeMainBuckets = mainBuckets.filter((record) => record.active);
  const regularMainBuckets = activeMainBuckets.filter((record) => record.regularPayload);
  const irregularMainBuckets = activeMainBuckets.filter((record) => !record.regularPayload);
  const activeSpecialSlots = specialSlots.filter((record) => record.active);
  const activeMainPayloadBytes = activeMainBuckets.reduce((sum, record) => sum + record.size, 0);
  const sizeFrequencies = new Map();
  const bfFilesByRelativePath = new Map();

  for (const record of activeMainBuckets) {
    sizeFrequencies.set(record.size, (sizeFrequencies.get(record.size) || 0) + 1);
  }

  for (const file of bfFiles) {
    bfFilesByRelativePath.set(file.relativePath, file);
  }

  const bfTotalBytes = bfFiles.reduce((sum, file) => sum + file.size, 0);
  const regularRecordTotal = regularMainBuckets.reduce((sum, record) => sum + record.regularRecordCount, 0);
  const formattedSpecialSlots = activeSpecialSlots.map((record) => formatRecord(record));
  const hashLookup = new Map();

  for (const record of manifest.records.filter((entry) => entry.active)) {
    const key = toHex64(record.hash);
    const list = hashLookup.get(key) || [];
    list.push(formatRecord(record));
    hashLookup.set(key, list);
  }

  const matchedSpecialSlots = formattedSpecialSlots
    .filter((record) => bfFilesByRelativePath.has(record.specialShardRelativePath))
    .map((record) => ({
      ...record,
      ...decodeSpecialShard(bfFilesByRelativePath.get(record.specialShardRelativePath).absPath, record.size),
      suffixMatchesActualBytes: bfFilesByRelativePath.get(record.specialShardRelativePath).size === record.size,
    }));
  const missingSpecialSlots = formattedSpecialSlots
    .filter((record) => !bfFilesByRelativePath.has(record.specialShardRelativePath));
  const decodedSpecialSlotBytes = matchedSpecialSlots.reduce((sum, record) => sum + record.decodedPayloadBytes, 0);
  const rawSpecialSlotCount = matchedSpecialSlots.filter((record) => record.storage === 'raw').length;
  const wrappedSpecialSlotCount = matchedSpecialSlots.filter((record) => record.storage === 'lzham-header-8').length;

  return {
    manifestPath: manifest.filePath,
    manifestBytes: manifest.byteLength,
    recordCount: manifest.recordCount,
    expectedHashBuckets: HASH_BUCKET_COUNT,
    expectedSpecialSlots: SPECIAL_SLOT_COUNT,
    activeMainBucketCount: activeMainBuckets.length,
    activeMainPayloadBytes,
    regularMainBucketCount: regularMainBuckets.length,
    irregularMainBucketCount: irregularMainBuckets.length,
    totalRegularPayloadRecords: regularRecordTotal,
    activeSpecialSlotCount: activeSpecialSlots.length,
    specialSlotBytes: formattedSpecialSlots.reduce((sum, record) => sum + record.size, 0),
    decodedSpecialSlotBytes,
    rawSpecialSlotCount,
    wrappedSpecialSlotCount,
    decodedSpecialStreamMatchesActiveMainPayloadBytes: decodedSpecialSlotBytes === activeMainPayloadBytes,
    topMainBucketSizes: [...sizeFrequencies.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 20)
      .map(([size, count]) => ({ size, count })),
    largestMainBuckets: activeMainBuckets
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 30)
      .map((record) => formatRecord(record)),
    irregularMainBuckets: irregularMainBuckets.map((record) => formatRecord(record)),
    specialSlots: formattedSpecialSlots,
    matchedSpecialSlots,
    missingSpecialSlots,
    hashLookup,
    bfTotalBytes,
    bfFiles,
  };
}

function probeLogicalPath(summary, logicalPath) {
  const rawPath = preserveLogicalPath(logicalPath);
  const candidates = [...new Set([normalizeLogicalPath(rawPath), rawPath].filter(Boolean))];

  return {
    requestedPath: logicalPath,
    candidates: candidates.map((candidatePath) => {
      const slashIndex = candidatePath.lastIndexOf('/');
      const parentPath = slashIndex >= 0 ? candidatePath.slice(0, slashIndex) : '';
      const fullPathBytes = iconv.encode(candidatePath, 'gbk');
      const parentBytes = iconv.encode(parentPath, 'gbk');
      const dirHash = djb2Masked(parentBytes);
      const fileHash = xxHash64(fullPathBytes);
      const h2 = composeH2(dirHash, fileHash);
      const hashCandidates = [
        { label: 'xxHash64(fullPath)', value: fileHash },
        { label: 'composeH2(djb2(parent), xxHash64(fullPath))', value: h2 },
      ];

      return {
        candidatePath,
        parentPath,
        dirHash,
        dirHashHex: `0x${dirHash.toString(16)}`,
        hashes: hashCandidates.map((item) => ({
          label: item.label,
          hashHex: toHex64(item.value),
          hashBase36: toBase36(item.value),
          matches: summary.hashLookup.get(toHex64(item.value)) || [],
        })),
      };
    }),
  };
}

function formatRecord(record) {
  const formatted = {
    bucket: record.bucket,
    offset: record.offset,
    hashHex: toHex64(record.hash),
    hashBase36: toBase36(record.hash),
    hashBase32: toNativeBase32(record.hash),
    size: record.size,
    sizeMod32: record.sizeMod32,
    regularPayload: record.regularPayload,
    regularRecordCount: record.regularRecordCount,
  };

  if (record.bucket >= HASH_BUCKET_COUNT) {
    const shardDir = Number((record.hash >> 16n) & 0xffn);
    formatted.specialShardDir = shardDir;
    formatted.specialShardFile = `${formatted.hashBase32}.${record.size}`;
    formatted.specialShardRelativePath = `hs/${shardDir}/${formatted.specialShardFile}`;
  }

  return formatted;
}

function printSummary(summary) {
  console.log('PakV5 version-manifest probe');
  console.log(`manifest: ${summary.manifestPath}`);
  console.log(`manifest bytes: ${summary.manifestBytes}`);
  console.log(`records: ${summary.recordCount} = ${summary.expectedHashBuckets} hash buckets + ${summary.expectedSpecialSlots} special slots`);
  console.log(`active main buckets: ${summary.activeMainBucketCount}`);
  console.log(`active main payload bytes: ${summary.activeMainPayloadBytes}`);
  console.log(`regular main buckets (4 + 32*n): ${summary.regularMainBucketCount}`);
  console.log(`irregular main buckets: ${summary.irregularMainBucketCount}`);
  console.log(`total regular payload records: ${summary.totalRegularPayloadRecords}`);
  console.log(`active special slots: ${summary.activeSpecialSlotCount}`);
  console.log(`special-slot bytes: ${summary.specialSlotBytes}`);
  console.log(`decoded special-slot bytes: ${summary.decodedSpecialSlotBytes}`);
  console.log(`special-slot storage modes: raw=${summary.rawSpecialSlotCount} wrapped=${summary.wrappedSpecialSlotCount}`);
  console.log(`decoded special-slot stream matches active main payload bytes: ${summary.decodedSpecialStreamMatchesActiveMainPayloadBytes}`);
  console.log(`bf files: ${summary.bfFiles.length} total, ${summary.bfTotalBytes} bytes`);

  console.log('\nTop main-bucket sizes:');
  for (const item of summary.topMainBucketSizes) {
    console.log(`  size=${item.size} count=${item.count}`);
  }

  console.log('\nSpecial slots:');
  for (const item of summary.specialSlots) {
    console.log(`  bucket=${item.bucket} hash=${item.hashHex} base32=${item.hashBase32} size=${item.size} mod32=${item.sizeMod32} path=${item.specialShardRelativePath}`);
  }

  console.log('\nSpecial-slot local matches:');
  if (!summary.matchedSpecialSlots.length) {
    console.log('  none');
  } else {
    for (const item of summary.matchedSpecialSlots) {
      console.log(`  bucket=${item.bucket} suffix=${item.size} actual=${item.actualFileBytes} decoded=${item.decodedPayloadBytes} storage=${item.storage}${item.headerWord0Hex ? ` header0=${item.headerWord0Hex}` : ''} suffixEqActual=${item.suffixMatchesActualBytes} path=${item.specialShardRelativePath}`);
    }
  }

  if (summary.missingSpecialSlots.length) {
    console.log('\nSpecial slots without local bf file-size match:');
    for (const item of summary.missingSpecialSlots) {
      console.log(`  bucket=${item.bucket} hash=${item.hashHex} size=${item.size} mod32=${item.sizeMod32} expected=${item.specialShardRelativePath}`);
    }
  }

  if (summary.irregularMainBuckets.length) {
    console.log('\nIrregular main buckets:');
    for (const item of summary.irregularMainBuckets) {
      console.log(`  bucket=${item.bucket} hash=${item.hashHex} base36=${item.hashBase36} size=${item.size} mod32=${item.sizeMod32}`);
    }
  }

  console.log('\nLargest main buckets:');
  for (const item of summary.largestMainBuckets) {
    console.log(`  bucket=${item.bucket} hash=${item.hashHex} size=${item.size} mod32=${item.sizeMod32} regular=${item.regularPayload}${item.regularRecordCount == null ? '' : ` n=${item.regularRecordCount}`}`);
  }

  console.log('\nBF files:');
  for (const file of summary.bfFiles) {
    console.log(`  ${file.relativePath} (${file.size} bytes)`);
  }

  if (summary.pathProbe) {
    console.log('\nLogical path hash probe:');
    console.log(`  requested=${summary.pathProbe.requestedPath}`);
    for (const candidate of summary.pathProbe.candidates) {
      console.log(`  candidate=${candidate.candidatePath}`);
      console.log(`    parent=${candidate.parentPath}`);
      console.log(`    dirHash=${candidate.dirHashHex}`);
      for (const hash of candidate.hashes) {
        console.log(`    ${hash.label}: ${hash.hashHex} base36=${hash.hashBase36} matches=${hash.matches.length}`);
        for (const match of hash.matches) {
          console.log(`      bucket=${match.bucket} size=${match.size} mod32=${match.sizeMod32}`);
        }
      }
    }
  }
}

function main() {
  const manifest = parseManifest(manifestPath);
  const bfFiles = collectFiles(bfRoot);
  const summary = summarize(manifest, bfFiles);
  if (logicalPathProbe) {
    summary.pathProbe = probeLogicalPath(summary, logicalPathProbe);
  }
  if (jsonMode) {
    delete summary.hashLookup;
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printSummary(summary);
}

main();