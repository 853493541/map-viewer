// Probe: scan for the offset of f3MeshScale + f3CenterAdjust inside type-2
// launcher blocks of mesh-emitter (.Mesh-bearing) PSS files.
//
// Strategy: for every mesh emitter in every PSS we can find, dump the 3 f32
// triples at every offset 200..600 within the type-2 block. We're looking
// for a triple that is:
//   - finite, components in [0.001, 50]
//   - NOT a position/rotation (those have wider range)
//   - present consistently at the SAME offset across many emitters
//   - not always (1,1,1) (that would just be the identity default)
//
// Then for f3CenterAdjust: another 3-f32 triple at a different offset, with
// finite components in [-50, 50], that varies per-emitter.

import fs from 'node:fs';
import path from 'node:path';

const CACHE = 'cache-extraction';

function findPssFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) findPssFiles(p, out);
    else if (ent.isFile() && /\.pss$/i.test(ent.name)) out.push(p);
  }
}

const pssFiles = [];
findPssFiles(CACHE, pssFiles);
console.log('PSS files in cache:', pssFiles.length);

// Use server's parser via require? Simpler: re-implement a minimal "find
// type-2 blocks with .Mesh path".

function readU32(b, off) { return off + 4 <= b.length ? b.readUInt32LE(off) : null; }
function readF32(b, off) { return off + 4 <= b.length ? b.readFloatLE(off) : null; }

function parseBlocks(buf) {
  // PSS header: skip first 16 bytes? Actually let's use a known marker.
  // The simplest approach: scan for the type-2 block signature pattern.
  // A type-2 block starts with: u32 type=2, u32 size, u32 ?, then payload
  // beginning with a GB18030 string.
  // Known from server.js: parser starts at offset 0 with header parsing.
  // For a probe, locate ALL .Mesh path occurrences and find the surrounding
  // type-2 block.
  const text = buf.toString('latin1');
  const meshPathRe = /[\w/\\.\u4e00-\u9fff_-]+\.Mesh/gi;
  const blocks = [];
  for (const m of text.matchAll(meshPathRe)) {
    // walk back to find a NUL-terminated string boundary that begins the block.
    // Easier: search for the type-2 header pattern within ~600 bytes before
    // the .Mesh path: a 3-Hanzi (6-byte) GB18030 string at a 32-byte aligned
    // offset is too speculative. Skip detection and just record the .Mesh
    // position; we'll align by SIGNATURE rather than block-start.
    blocks.push({ meshIdx: m.index, mesh: m[0] });
  }
  return blocks;
}

// Hypothesis A: f3MeshScale at +272 (i.e., u32 at 264 launcherClassBytes,
// u32 at 268 featureFlags, then f3MeshScale at 272..283).
// Hypothesis B: f3MeshScale somewhere else; +308 emitterScale already known.
// Let's test the +272..+283 hypothesis first.

// Approach: take EVERY block whose +268 has bit0 set (active type-2) and
// dump 3 f32 at +272, +276, +280, +284, ... — find the offset where the
// triple is "scale-like" (finite, [0.05, 30]) and varies.

import zlib from 'node:zlib';

// Reuse the server's parser by forking it via HTTP /api/pss/debug-dump.
// Server is running on 3015.

async function main() {
  // Pick a mesh-emitter-rich PSS — use red02 since we just verified it.
  const targets = [
    'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红02.pss',
    'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红01.pss',
  ];

  for (const sp of targets) {
    const url = `http://localhost:3015/api/pss/debug-dump?sourcePath=${encodeURIComponent(sp)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.ok) { console.log('skip', sp); continue; }
    const meshBlocks = (data.blocks || []).filter(b => b.type === 2 && (b.fields?.meshes?.length || 0) > 0);
    console.log(`\n=== ${sp} ===  type-2 mesh blocks: ${meshBlocks.length}`);
    for (const b of meshBlocks) {
      console.log(`  block#${b.index} subType="${b.fields?.subTypeName || ''}" mesh=${b.fields?.meshes?.[0]}`);
      // dump u32/f32 at relative offsets we care about
      const dump = b.dump || b.nonZeroDump || null;
      if (!dump) { console.log('    (no dump available — adding to TODO: expose blockBytes in API)'); continue; }
    }
  }
  // The /api/pss/debug-dump endpoint may not expose raw bytes. Instead read
  // the PSS file directly and locate type-2 blocks via the parser.
  // For now, exit and inspect output.
}

main();
