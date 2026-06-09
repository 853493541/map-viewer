#!/usr/bin/env node
/**
 * extract-jsoninspack-from-pakv5.mjs
 *
 * Bulk-extracts `.JsonInspack` companion files for every `.mesh` referenced
 * by the PSS files in this workspace. Reads them out of the JX3 cache (PakV5)
 * via tools/jx3-cache-reader.js and writes them into the PSS asset cache
 * directory at `tools/pss-cache/_assets/<logical/path>.JsonInspack`.
 *
 * Usage (from workspace root, with the dev server NOT running on PakV4 lock):
 *   node tools/extract-jsoninspack-from-pakv5.mjs
 *   node tools/extract-jsoninspack-from-pakv5.mjs --dry-run
 *   node tools/extract-jsoninspack-from-pakv5.mjs --pss data/source/.../foo.pss
 *
 * Why: PakV4 export is incomplete for many `.JsonInspack` companions, leaving
 * mesh emitters as MeshStandardMaterial/white. With these extracted, the GLB
 * converter writes proper `extras.pssMaterial` and the renderer drops the
 * fallback path entirely.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createJx3CacheReader } from './jx3-cache-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PSS_ASSET_EXTRACT_DIR = join(ROOT, 'tools', 'pss-cache', '_assets');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const verbose = argv.includes('--verbose') || argv.includes('-v');
const pssArgIdx = argv.indexOf('--pss');
const onlyPss = pssArgIdx >= 0 ? argv[pssArgIdx + 1] : null;

const reader = createJx3CacheReader();

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// Walk PSS roots to collect every .pss file's absolute path + logical path.
// Mirrors server.js /api/pss/find logic.
function collectPssFiles() {
  const roots = [
    { absRoot: join(ROOT, 'tools', 'pss-cache', 'data'), logicalPrefix: 'data' },
    { absRoot: PSS_ASSET_EXTRACT_DIR, logicalPrefix: '' },
    { absRoot: join(ROOT, 'source'), logicalPrefix: 'data/source' },
  ];
  const seen = new Map(); // logical -> abs
  for (const r of roots) {
    if (!existsSync(r.absRoot)) continue;
    walk(r.absRoot, r.logicalPrefix);
  }
  return [...seen.values()];

  function walk(dir, logicalRel) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const next = join(dir, e.name);
      const nextLogical = logicalRel ? `${logicalRel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(next, nextLogical); continue; }
      if (!/\.pss$/i.test(e.name)) continue;
      // Skip _悟 variants — match server-side filter.
      if (/_悟\.pss$/i.test(e.name)) continue;
      const lower = nextLogical.toLowerCase().replace(/\\/g, '/');
      if (seen.has(lower)) continue;
      seen.set(lower, { abs: next, logical: nextLogical.replace(/\\/g, '/') });
    }
  }
}

// Scan a PSS buffer for `data/.../*.Mesh` references. Strings inside PSS are
// GB18030; we use a Latin-1 (binary) decode here because we only need to find
// the ASCII prefix `data/source/` and the `.mesh` extension. The chinese
// bytes between are passed through untouched and will be written exactly as
// they appear in the file.
function extractMeshPaths(buf) {
  // Decode bytes-to-string using latin1 (1:1 mapping) so we don't lose the
  // raw bytes. Then convert each found span back to bytes for GB18030 decode.
  const str = buf.toString('latin1');
  const re = /data[/\\][^\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f"<>|]+?\.[Mm]esh/g;
  const results = new Set();
  let m;
  while ((m = re.exec(str)) !== null) {
    const span = m[0];
    // Re-encode to bytes via latin1, then decode as GB18030 to get the real
    // logical path.
    const bytes = Buffer.from(span, 'latin1');
    let logical;
    try {
      logical = new TextDecoder('gb18030').decode(bytes);
    } catch {
      logical = span;
    }
    logical = logical.replace(/\\/g, '/');
    if (logical.length < 12) continue;
    results.add(logical);
  }
  return [...results];
}

function jsonInspackFor(meshLogical) {
  return meshLogical.replace(/\.[^/.]+$/i, '.JsonInspack');
}

function tryExtract(logical) {
  const expectedAbs = join(PSS_ASSET_EXTRACT_DIR, logical.replace(/\//g, '\\'));
  if (existsSync(expectedAbs)) {
    return { status: 'already', abs: expectedAbs };
  }
  if (dryRun) return { status: 'would-extract', abs: expectedAbs };
  let out;
  try {
    const result = reader.readEntry(logical);
    out = result.output;
  } catch (err) {
    return { status: 'cache-miss', error: err?.message || String(err) };
  }
  if (!out || !out.length) return { status: 'empty' };
  ensureDir(dirname(expectedAbs));
  writeFileSync(expectedAbs, out);
  return { status: 'extracted', abs: expectedAbs, bytes: out.length };
}

function main() {
  const pssFiles = collectPssFiles();
  let pssTargets = pssFiles;
  if (onlyPss) {
    pssTargets = pssFiles.filter(p => p.logical.endsWith(onlyPss) || p.logical === onlyPss);
    if (!pssTargets.length) {
      console.error(`[pakv5-jsoninspack] no PSS file matched: ${onlyPss}`);
      process.exit(2);
    }
  }
  console.log(`[pakv5-jsoninspack] PSS files: ${pssTargets.length}${onlyPss ? ` (filter=${onlyPss})` : ''}`);

  const seenMesh = new Set();
  const counts = {
    pssScanned: 0,
    pssReadFailed: 0,
    meshTotal: 0,
    jipExtracted: 0,
    jipAlready: 0,
    jipMissing: 0,
    jipEmpty: 0,
  };
  const missingSamples = [];

  for (const { abs, logical } of pssTargets) {
    let buf;
    try {
      buf = readFileSync(abs);
    } catch (err) {
      counts.pssReadFailed++;
      continue;
    }
    counts.pssScanned++;
    const meshes = extractMeshPaths(buf);
    for (const mesh of meshes) {
      if (seenMesh.has(mesh)) continue;
      seenMesh.add(mesh);
      counts.meshTotal++;
      const jip = jsonInspackFor(mesh);
      const result = tryExtract(jip);
      if (result.status === 'extracted') {
        counts.jipExtracted++;
        if (verbose) console.log(`  + ${jip} (${result.bytes} B)`);
      } else if (result.status === 'already') {
        counts.jipAlready++;
      } else if (result.status === 'cache-miss') {
        counts.jipMissing++;
        if (missingSamples.length < 10) missingSamples.push({ jip, error: result.error });
      } else if (result.status === 'empty') {
        counts.jipEmpty++;
      } else if (result.status === 'would-extract' && verbose) {
        console.log(`  ? would-extract ${jip}`);
      }
    }
  }

  console.log('[pakv5-jsoninspack] summary:', JSON.stringify(counts, null, 2));
  if (missingSamples.length) {
    console.log('[pakv5-jsoninspack] sample misses:');
    for (const s of missingSamples) console.log(`  - ${s.jip}: ${s.error}`);
  }
  if (dryRun) console.log('[pakv5-jsoninspack] dry-run: no files written');
}

main();
