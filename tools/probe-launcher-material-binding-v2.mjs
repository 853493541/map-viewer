// Probe v2: dump +260 / +292 / +296 unconditionally for every type-2
// launcher across multiple PSS files, then check whether +292 < #materials
// for every launcher AND varies independently of +260 (= ordinal).
import fs from 'node:fs';

const FILES = [
  'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss',
  'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红02.pss',
  'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红01.pss',
];

async function probe(sp) {
  const dumpResp = await fetch('http://localhost:3015/api/pss/debug-dump?sourcePath=' + encodeURIComponent(sp));
  const dump = await dumpResp.json();
  if (!dump.ok) { console.log('skip ' + sp + ' (no dump)'); return; }
  const rawResp = await fetch('http://localhost:3015/api/pss/raw-bytes?sourcePath=' + encodeURIComponent(sp));
  if (!rawResp.ok) { console.log('skip ' + sp + ' (no raw)'); return; }
  const buf = Buffer.from(await rawResp.arrayBuffer());

  // count type-1 (materials) and type-2 (launchers)
  const t1 = dump.blocks.filter((b) => b.type === 1);
  const t2 = dump.blocks.filter((b) => b.type === 2);
  console.log(`\n=== ${sp.split('/').pop()} === blocks=${dump.blocks.length} #materials(t1)=${t1.length} #launchers(t2)=${t2.length}`);
  console.log('  toc#  size  +260  +292  +296  delta(260-292)  ord');
  let ord = 0;
  for (const b of t2) {
    const off = b.offset;
    const view = buf.subarray(off, off + b.size);
    const v260 = view.length >= 264 ? view.readUInt32LE(260) : -1;
    const v292 = view.length >= 296 ? view.readUInt32LE(292) : -1;
    const v296 = view.length >= 300 ? view.readUInt32LE(296) : -1;
    const delta = v260 - v292;
    const valid292 = v292 >= 0 && v292 < t1.length;
    const flag = valid292 ? 'OK' : 'OOB';
    console.log(`  ${String(b.index).padStart(4)} ${String(b.size).padStart(5)} ${String(v260).padStart(5)} ${String(v292).padStart(5)} ${String(v296).padStart(5)}  ${String(delta).padStart(4)}  ord=${ord}  v292inRange?=${flag}`);
    ord++;
  }
}

for (const sp of FILES) {
  try { await probe(sp); } catch (e) { console.log('err', sp, e.message); }
}
