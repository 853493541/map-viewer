import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import iconv from 'iconv-lite';
import koffi from 'koffi';

const UINT64_MASK = (1n << 64n) - 1n;
const H2_FILE_HASH_MASK = (1n << 40n) - 1n;
const XXHASH64_PRIME_1 = 0x9e3779b185ebca87n;
const XXHASH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const XXHASH64_PRIME_3 = 0x165667b19e3779f9n;
const XXHASH64_PRIME_4 = 0x85ebca77c2b2ae63n;
const XXHASH64_PRIME_5 = 0x27d4eb2f165667c5n;
const FN_RECORD_SIZE = 20;
const IDX_RECORD_SIZE = 36;
const IDX_HEADER_SIZE = 36;
const RAW_CACHE_HEADER_SIZE = 16;
const LZHAM_HEADER_SIZE = 20;
const CACHE_ENTRY_MARKER = 0x0000E7A4;

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

function formatHex64(value) {
  return `0x${BigInt.asUintN(64, value).toString(16).padStart(16, '0')}`;
}

function countEntries(counts, keyName) {
  return [...counts.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count || String(left[keyName]).localeCompare(String(right[keyName])));
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

function readSlice(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let totalRead = 0;
  while (totalRead < length) {
    const bytesRead = readSync(fd, buffer, totalRead, length - totalRead, offset + totalRead);
    if (bytesRead <= 0) {
      throw new Error(`Expected ${length} bytes at offset ${offset} but only read ${totalRead}`);
    }
    totalRead += bytesRead;
  }
  return buffer;
}

export function createJx3CacheReader(options = {}) {
  const cacheRoot = resolve(options.cacheRoot || 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/dat');
  const lzhamDllPath = resolve(options.lzhamDllPath || 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll');

  let fnIndex = null;
  let idxIndex = null;
  let lzhamUncompress = null;

  function ensureCacheRoot() {
    if (!existsSync(cacheRoot)) {
      throw new Error(`Cache root not found: ${cacheRoot}`);
    }
  }

  function ensureFnIndex() {
    if (fnIndex) return fnIndex;
    ensureCacheRoot();

    const map = new Map();
    const fnFiles = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^fn\d+\.1$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

    for (const fileName of fnFiles) {
      const filePath = join(cacheRoot, fileName);
      const bytes = readFileSync(filePath);
      for (let offset = 4; offset + FN_RECORD_SIZE <= bytes.length; offset += FN_RECORD_SIZE) {
        const h1 = readUInt64LE(bytes, offset);
        const h2 = readUInt64LE(bytes, offset + 8);
        if (!map.has(h2)) {
          map.set(h2, {
            h1,
            h2,
            fnFile: filePath,
            fnOffset: offset,
            chain: bytes.readUInt32LE(offset + 16),
          });
        }
      }
    }

    fnIndex = map;
    return fnIndex;
  }

  function ensureIdxIndex() {
    if (idxIndex) return idxIndex;
    ensureCacheRoot();

    const idxPath = join(cacheRoot, '0.idx');
    if (!existsSync(idxPath)) {
      throw new Error(`IDX file not found: ${idxPath}`);
    }

    const bytes = readFileSync(idxPath);
    const map = new Map();
    for (let offset = IDX_HEADER_SIZE; offset + IDX_RECORD_SIZE <= bytes.length; offset += IDX_RECORD_SIZE) {
      const h1 = readUInt64LE(bytes, offset);
      const meta = bytes.readUInt32LE(offset + 32);
      map.set(h1, {
        h1,
        idxPath,
        idxOffset: offset,
        offset: Number(readUInt64LE(bytes, offset + 8)),
        originalSize: bytes.readUInt32LE(offset + 16),
        compressedSize: bytes.readUInt32LE(offset + 20),
        sequence: bytes.readUInt32LE(offset + 24),
        blocks: bytes.readUInt32LE(offset + 28),
        meta,
        compressionType: meta & 0xff,
        datIndex: (meta >>> 12) & 0xf,
      });
    }

    idxIndex = map;
    return idxIndex;
  }

  function ensureLzham() {
    if (lzhamUncompress) return lzhamUncompress;
    if (!existsSync(lzhamDllPath)) {
      throw new Error(`LZHAM DLL not found: ${lzhamDllPath}`);
    }

    const library = koffi.load(lzhamDllPath);
    lzhamUncompress = library.func('int lzham_z_uncompress(_Out_ uint8_t *dest, _Inout_ uint32_t *destLen, const uint8_t *src, uint32_t srcLen)');
    return lzhamUncompress;
  }

  function buildResolvedEntry(candidatePath, parentPath, dirHash, fileHash, h2, fnEntry, idxEntry) {
    const datPath = join(cacheRoot, `${idxEntry.datIndex}.dat`);
    return {
      logicalPath: candidatePath,
      parentPath,
      dirHash,
      fileHash,
      h2,
      h1: fnEntry.h1,
      fnFile: fnEntry.fnFile,
      fnOffset: fnEntry.fnOffset,
      idxPath: idxEntry.idxPath,
      idxOffset: idxEntry.idxOffset,
      datPath,
      datIndex: idxEntry.datIndex,
      datOffset: idxEntry.offset,
      originalSize: idxEntry.originalSize,
      compressedSize: idxEntry.compressedSize,
      compressionType: idxEntry.compressionType,
      sequence: idxEntry.sequence,
      blocks: idxEntry.blocks,
    };
  }

  function findEntry(logicalPath) {
    const rawPath = preserveLogicalPath(logicalPath);
    const candidates = [...new Set([normalizeLogicalPath(rawPath), rawPath].filter(Boolean))];

    for (const candidatePath of candidates) {
      const slashIndex = candidatePath.lastIndexOf('/');
      if (slashIndex < 0) continue;

      const parentPath = candidatePath.slice(0, slashIndex);
      const fullPathBytes = iconv.encode(candidatePath, 'gbk');
      const parentBytes = iconv.encode(parentPath, 'gbk');
      const dirHash = djb2Masked(parentBytes);
      const fileHash = xxHash64(fullPathBytes);
      const h2 = composeH2(dirHash, fileHash);
      const fnEntry = ensureFnIndex().get(h2);
      if (!fnEntry) continue;

      const idxEntry = ensureIdxIndex().get(fnEntry.h1);
      if (!idxEntry) continue;
      return buildResolvedEntry(candidatePath, parentPath, dirHash, fileHash, h2, fnEntry, idxEntry);
    }

    return null;
  }

  function resolveEntry(logicalPath) {
    const rawPath = preserveLogicalPath(logicalPath);
    const candidates = [...new Set([normalizeLogicalPath(rawPath), rawPath].filter(Boolean))];
    let lastError = null;

    for (const candidatePath of candidates) {
      const slashIndex = candidatePath.lastIndexOf('/');
      if (slashIndex < 0) {
        throw new Error('LogicalPath must include at least one parent directory');
      }

      const parentPath = candidatePath.slice(0, slashIndex);
      const fullPathBytes = iconv.encode(candidatePath, 'gbk');
      const parentBytes = iconv.encode(parentPath, 'gbk');
      const dirHash = djb2Masked(parentBytes);
      const fileHash = xxHash64(fullPathBytes);
      const h2 = composeH2(dirHash, fileHash);
      const fnEntry = ensureFnIndex().get(h2);
      if (!fnEntry) {
        lastError = new Error(`No FN mapping found for ${candidatePath}`);
        continue;
      }

      const idxEntry = ensureIdxIndex().get(fnEntry.h1);
      if (!idxEntry) {
        lastError = new Error(`No IDX entry found for h1=${fnEntry.h1.toString(16)}`);
        continue;
      }

      return buildResolvedEntry(candidatePath, parentPath, dirHash, fileHash, h2, fnEntry, idxEntry);
    }

    throw lastError || new Error(`No FN mapping found for ${rawPath}`);
  }

  function readCompressedEntry(entry) {
    const fd = openSync(entry.datPath, 'r');
    try {
      return readSlice(fd, entry.datOffset, entry.compressedSize);
    } finally {
      closeSync(fd);
    }
  }

  function unwrapRawEntry(entry, compressedEntry) {
    for (const headerSize of [RAW_CACHE_HEADER_SIZE, LZHAM_HEADER_SIZE]) {
      if (compressedEntry.length !== entry.originalSize + headerSize) {
        continue;
      }
      if (compressedEntry.length < RAW_CACHE_HEADER_SIZE) {
        continue;
      }
      if (compressedEntry.readUInt32LE(4) !== CACHE_ENTRY_MARKER) {
        continue;
      }

      const storedOriginalSize = compressedEntry.readUInt32LE(8);
      const storedPayloadSize = compressedEntry.readUInt32LE(12);
      if (storedOriginalSize !== entry.originalSize || storedPayloadSize !== entry.originalSize) {
        continue;
      }

      return {
        output: compressedEntry.subarray(headerSize, headerSize + entry.originalSize),
        storageMode: 'raw',
        cacheHeaderSize: headerSize,
      };
    }

    return null;
  }

  function expandEntry(entry, compressedEntry) {
    if (entry.compressionType === 0) {
      return {
        output: compressedEntry,
        storageMode: 'stored',
        cacheHeaderSize: 0,
      };
    }

    const rawEntry = unwrapRawEntry(entry, compressedEntry);
    if (rawEntry) {
      return rawEntry;
    }

    if (entry.compressionType !== 10) {
      throw new Error(`Unsupported compression type: ${entry.compressionType}`);
    }

    if (compressedEntry.length < LZHAM_HEADER_SIZE) {
      throw new Error('Compressed cache entry is too small to contain the expected LZHAM header');
    }

    const payload = compressedEntry.subarray(LZHAM_HEADER_SIZE);
    const output = Buffer.alloc(entry.originalSize);
    const outputLength = [entry.originalSize >>> 0];
    const status = ensureLzham()(output, outputLength, payload, payload.length >>> 0);
    if (status !== 0) {
      throw new Error(`lzham_z_uncompress failed with status ${status}`);
    }

    return {
      output: outputLength[0] === output.length ? output : output.subarray(0, outputLength[0]),
      storageMode: 'lzham',
      cacheHeaderSize: LZHAM_HEADER_SIZE,
    };
  }

  function readEntry(logicalPath) {
    const entry = resolveEntry(logicalPath);
    const compressed = readCompressedEntry(entry);
    const expanded = expandEntry(entry, compressed);
    return {
      entry: {
        ...entry,
        storageMode: expanded.storageMode,
        cacheHeaderSize: expanded.cacheHeaderSize,
      },
      compressed,
      output: expanded.output,
    };
  }

  function buildCacheRecord(rowIndex, h2, fnEntry, idxEntry) {
    const datPath = idxEntry ? join(cacheRoot, `${idxEntry.datIndex}.dat`) : null;
    return {
      index: rowIndex,
      h1: formatHex64(fnEntry.h1),
      h2: formatHex64(h2),
      fnFile: basename(fnEntry.fnFile),
      fnOffset: fnEntry.fnOffset,
      chain: fnEntry.chain,
      missingIdx: !idxEntry,
      idxFile: idxEntry ? basename(idxEntry.idxPath) : null,
      idxOffset: idxEntry?.idxOffset ?? null,
      datFile: datPath ? basename(datPath) : null,
      datIndex: idxEntry?.datIndex ?? null,
      datOffset: idxEntry?.offset ?? null,
      originalSize: idxEntry?.originalSize ?? null,
      compressedSize: idxEntry?.compressedSize ?? null,
      compressionType: idxEntry?.compressionType ?? null,
      sequence: idxEntry?.sequence ?? null,
      blocks: idxEntry?.blocks ?? null,
    };
  }

  function getStats() {
    const fn = ensureFnIndex();
    const idx = ensureIdxIndex();
    const fnFileCounts = new Map();
    const datIndexCounts = new Map();
    const compressionCounts = new Map();
    const referencedH1 = new Set();
    let missingIdxMappings = 0;
    let totalOriginalSize = 0;
    let totalCompressedSize = 0;

    for (const fnEntry of fn.values()) {
      const fnFileName = basename(fnEntry.fnFile);
      fnFileCounts.set(fnFileName, (fnFileCounts.get(fnFileName) || 0) + 1);
      if (idx.has(fnEntry.h1)) {
        referencedH1.add(fnEntry.h1);
      } else {
        missingIdxMappings += 1;
      }
    }

    for (const idxEntry of idx.values()) {
      totalOriginalSize += idxEntry.originalSize;
      totalCompressedSize += idxEntry.compressedSize;
      datIndexCounts.set(idxEntry.datIndex, (datIndexCounts.get(idxEntry.datIndex) || 0) + 1);
      compressionCounts.set(idxEntry.compressionType, (compressionCounts.get(idxEntry.compressionType) || 0) + 1);
    }

    const datFiles = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+\.dat$/i.test(entry.name))
      .map((entry) => {
        const filePath = join(cacheRoot, entry.name);
        const stats = statSync(filePath);
        return { file: entry.name, size: stats.size, mtime: stats.mtimeMs };
      })
      .sort((left, right) => left.file.localeCompare(right.file, undefined, { numeric: true, sensitivity: 'base' }));

    return {
      cacheRoot,
      lzhamDllPath,
      fnMappings: fn.size,
      idxRecords: idx.size,
      referencedIdxRecords: referencedH1.size,
      missingIdxMappings,
      duplicateContentMappings: Math.max(0, fn.size - referencedH1.size),
      unreferencedIdxRecords: Math.max(0, idx.size - referencedH1.size),
      totalOriginalSize,
      totalCompressedSize,
      fnFiles: countEntries(fnFileCounts, 'file'),
      datFiles,
      datIndexes: countEntries(datIndexCounts, 'datIndex'),
      compressionTypes: countEntries(compressionCounts, 'compressionType'),
    };
  }

  function listEntries(options = {}) {
    const fn = ensureFnIndex();
    const idx = ensureIdxIndex();
    const search = String(options.search || '').trim().toLowerCase();
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(5000, Math.max(1, Number(options.limit) || 200));
    const items = [];
    let rowIndex = 0;
    let matched = 0;

    for (const [h2, fnEntry] of fn.entries()) {
      rowIndex += 1;
      const record = buildCacheRecord(rowIndex, h2, fnEntry, idx.get(fnEntry.h1));
      if (search) {
        const haystack = `${record.h1} ${record.h2} ${record.fnFile} ${record.idxFile || ''} ${record.datFile || ''} ${record.datIndex ?? ''} ${record.compressionType ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      if (matched >= offset && items.length < limit) {
        items.push(record);
      }
      matched += 1;
    }

    return {
      ok: true,
      source: 'local-pakv5-fn-idx',
      cacheRoot,
      totalItems: fn.size,
      totalFiltered: matched,
      offset,
      limit,
      hasNextPage: offset + items.length < matched,
      items,
    };
  }

  return {
    cacheRoot,
    lzhamDllPath,
    findEntry,
    formatHex64,
    getStats,
    listEntries,
    resolveEntry,
    readEntry,
  };
}