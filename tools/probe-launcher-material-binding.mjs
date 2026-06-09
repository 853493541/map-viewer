// Probe what's actually inside the type-2 launcher blocks of the 4 unbound
// emitters in T_天策龙牙.pss (em#39, #40, #41, #42). We're hunting for the
// real material binding mechanism: embedded .jsondef path, embedded
// KG3D_ParticleMaterialDistribution module marker, or any byte pattern.
//
// Hypothesis (after the explore agent's report):
//   - +260 is the launcher's spawn-pool ordinal (NOT a material index).
//   - The real material binding is inside the launcher block, possibly
//     in the variable section as an embedded module.
import fs from 'node:fs';
import path from 'node:path';

const PSS = process.argv[2] || 'cache-extraction/source/T_天策龙牙.pss';
let buf;
// Try the canonical path; if not, scan cache-extraction for it.
function findFile(name) {
  const stack = ['cache-extraction'];
  while (stack.length) {
    const d = stack.pop();
    if (!fs.existsSync(d)) continue;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name === name) return p;
    }
  }
  return null;
}

let pssPath = PSS;
if (!fs.existsSync(pssPath)) {
  pssPath = findFile('T_天策龙牙.pss');
  if (!pssPath) {
    // Fetch via the running server's static endpoint instead.
    pssPath = null;
  }
}

async function loadBuf() {
  if (pssPath) return fs.readFileSync(pssPath);
  const sp = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss';
  const url = `http://localhost:3015/api/pss/raw?sourcePath=${encodeURIComponent(sp)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('cannot load ' + sp + ': ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

const TARGETS = [39, 40, 41, 42, 34, 22, 23]; // failing + working samples

function readToc(buf) {
  // The PSS file format: scan the file looking for a pattern where blocks
  // are listed. Easier: re-run analyze and parse its output for block
  // offsets if available. Use debug-dump endpoint.
  return null;
}

async function main() {
  const sp = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss';
  const dumpResp = await fetch('http://localhost:3015/api/pss/debug-dump?sourcePath=' + encodeURIComponent(sp));
  const dump = await dumpResp.json();
  if (!dump.ok) { console.error('debug-dump failed'); process.exit(2); }
  // /api/pss/raw not yet — use cache-extraction directly. The probe is on
  // the file at cache-extraction/source/.../T_天策龙牙.pss. We use the
  // dump's per-block offsets to locate each block in the buffer.
  const rawResp = await fetch('http://localhost:3015/api/pss/raw-bytes?sourcePath=' + encodeURIComponent(sp));
  if (!rawResp.ok) { console.error('raw-bytes failed', rawResp.status); process.exit(3); }
  const fileBuf = Buffer.from(await rawResp.arrayBuffer());
  console.log('file size:', fileBuf.length);
  console.log('blocks:', dump.blocks.length);

  for (const targetIdx of TARGETS) {
    const block = dump.blocks.find((b) => b.index === targetIdx);
    if (!block) { console.log('skip', targetIdx); continue; }
    console.log(`\n========= toc#${block.index} type:${block.type} size:${block.size} =========`);
    // we need the offset; the dump probably exposes it
    const off = block.offset != null ? block.offset : null;
    if (off == null) { console.log('no offset; dump shape:', Object.keys(block)); continue; }
    const start = off;
    const end = off + block.size;
    const view = fileBuf.subarray(start, end);
    // 1. Find every occurrence of '.jsondef', '.tga', '.dds' in the block
    const text = view.toString('latin1');
    const jsonRe = /[\w\\\/.]+\.jsondef/gi;
    const tgaRe = /[\w\\\/.]+\.(tga|dds|png)/gi;
    console.log('  .jsondef paths:');
    for (const m of text.matchAll(jsonRe)) console.log('    @+' + m.index, '→', m[0]);
    console.log('  texture paths:');
    for (const m of text.matchAll(tgaRe)) console.log('    @+' + m.index, '→', m[0]);
    // 2. Scan for Chinese module-name strings via GB18030 — any 2..6 byte
    //    runs of bytes 0x81..0xFE which decode to common 材质 / 颜色 /
    //    distribution keywords. A simpler proxy: look for the literal
    //    GB18030 bytes for "材质" = E2 C5, "材质分布" = E2 C5 B7 D6 B2 BC,
    //    "颜色" = D1 D5 C9 AB.
    const needles = [
      { name: 'GB18030:材质', bytes: Buffer.from([0xE2, 0xC5]) },                // 材质
      { name: 'GB18030:颜色', bytes: Buffer.from([0xD1, 0xD5, 0xC9, 0xAB]) },     // 颜色
      { name: 'GB18030:材质分布', bytes: Buffer.from([0xB2, 0xC4, 0xD6, 0xCA, 0xB7, 0xD6, 0xB2, 0xBC]) }, // 材质分布
    ];
    for (const n of needles) {
      let pos = 0; while ((pos = view.indexOf(n.bytes, pos)) !== -1) {
        console.log('  needle ' + n.name + ' @+' + pos);
        pos += n.bytes.length;
      }
    }
    // 3. Scan u32 fields at offsets 256..400 step 4: which look like small
    //    integers (0..50)?
    const cand = [];
    for (let rel = 256; rel < Math.min(420, view.length - 4); rel += 4) {
      const v = view.readUInt32LE(rel);
      if (v < 50) cand.push({ rel, v });
    }
    console.log('  small u32 fields in [256..420]:', cand.map(c => `+${c.rel}=${c.v}`).join(' '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
