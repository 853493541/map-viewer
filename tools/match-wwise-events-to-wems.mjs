// Rebuild size→wem map by also walking DATA chunks of every extracted bnk.
// Then match menpai bank Sound source_ids first by source_id (DIDX entry id),
// then fall back to size match.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBnk } from './parse-wwise-bnk.mjs';

const EXTRACT_DIR = resolve('cache-extraction/wwise-pak-extract/Windows/base');
const allBnkFiles = readdirSync(EXTRACT_DIR).filter((f) => f.endsWith('.bnk'));
const allWemFiles = readdirSync(EXTRACT_DIR).filter((f) => f.startsWith('pak_') && f.endsWith('.wem'));

const sourceIdToEmbedded = new Map();
const dataBnks = [];
for (const f of allBnkFiles) {
  const p = parseBnk(join(EXTRACT_DIR, f));
  if (p.wems.size === 0) continue;
  dataBnks.push({ file: f, count: p.wems.size });
  for (const [id, info] of p.wems) {
    if (!sourceIdToEmbedded.has(id)) {
      sourceIdToEmbedded.set(id, { bank: f, offset: info.offset, size: info.size });
    }
  }
}
console.log('DATA-bearing bnks:', dataBnks);
console.log('Unique source IDs in DATA chunks:', sourceIdToEmbedded.size);

const sizeMap = new Map();
for (const f of allWemFiles) {
  const sz = readFileSync(join(EXTRACT_DIR, f)).length;
  if (!sizeMap.has(sz)) sizeMap.set(sz, []);
  sizeMap.get(sz).push(f);
}
console.log('Standalone wems:', allWemFiles.length, 'distinct sizes:', sizeMap.size);

const BANKS = ['TianCe', 'ShaoLin', 'QiXiu', 'WuDu', 'TangMen', 'CangJian', 'GaiBang', 'ChangGe', 'BaDao', 'CangYun', 'UI', 'Common'];
const eventWemMap = {};
const stats = { soundsTotal: 0, soundsViaDidx: 0, soundsViaSize: 0, soundsUnmapped: 0, eventsTotal: 0, eventsMapped: 0 };

for (const bank of BANKS) {
  const bnkPath = join(EXTRACT_DIR, `${bank}.bnk`);
  const txtPath = join(EXTRACT_DIR, `${bank}.txt`);
  const parsed = parseBnk(bnkPath);
  const sourceToWem = new Map();
  for (const obj of parsed.objects) {
    if (obj.type !== 2) continue;
    stats.soundsTotal++;
    const sourceId = obj.body.readUInt32LE(5);
    const inMemSize = obj.body.readUInt32LE(9);
    if (sourceIdToEmbedded.has(sourceId)) {
      sourceToWem.set(sourceId, { kind: 'embedded', ref: sourceIdToEmbedded.get(sourceId), sourceId });
      stats.soundsViaDidx++;
    } else {
      const cands = sizeMap.get(inMemSize);
      if (cands && cands.length === 1) {
        sourceToWem.set(sourceId, { kind: 'standalone', ref: cands[0], sourceId });
        stats.soundsViaSize++;
      } else {
        stats.soundsUnmapped++;
      }
    }
  }
  const byId = new Map(parsed.objects.map((o) => [o.id, o]));
  const events = parsed.objects.filter((o) => o.type === 4);
  const txt = readFileSync(txtPath, 'utf8');
  const idToName = new Map();
  let inEvent = false;
  for (const line of txt.split(/\r?\n/)) {
    if (/^Event\b/i.test(line)) { inEvent = true; continue; }
    if (line.trim() === '') { inEvent = false; continue; }
    if (!inEvent) continue;
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2 && /^\d+$/.test(cols[0])) idToName.set(Number(cols[0]), cols[1]);
  }
  for (const ev of events) {
    stats.eventsTotal++;
    const reachable = [];
    const visited = new Set();
    const stack = [ev];
    while (stack.length) {
      const obj = stack.pop();
      if (!obj || visited.has(obj.id)) continue;
      visited.add(obj.id);
      if (obj.type === 2) {
        const sourceId = obj.body.readUInt32LE(5);
        const m = sourceToWem.get(sourceId);
        if (m) reachable.push(m);
        continue;
      }
      for (let p = 0; p + 4 <= obj.body.length; p++) {
        const v = obj.body.readUInt32LE(p);
        if (v === 0 || v === obj.id) continue;
        const child = byId.get(v);
        if (child) stack.push(child);
      }
    }
    if (reachable.length > 0) stats.eventsMapped++;
    const name = idToName.get(ev.id);
    if (name) eventWemMap[name] = { id: ev.id, bank, wems: reachable };
  }
}

console.log('Stats:', stats);
const out = resolve('log/wwise-pak-event-wem-map.json');
writeFileSync(out, JSON.stringify({ stats, dataBnks, eventWemMap }, null, 2));
console.log('Wrote', out);

const samples = ['TianCe_TianCe_Skill_xiaoruhu', 'BaDao_BaDao_Skill_shenwu', 'TianCe_TianCe_Skill_yu', 'ShaoLin_ShaoLin_Skill_haichao', 'CangJian_CangJian_Skill_jian'];
for (const s of samples) {
  const v = eventWemMap[s];
  if (v) console.log(' ', s, '→ wems:', v.wems.length, v.wems.map((w) => `${w.kind}:${typeof w.ref === 'string' ? w.ref : w.ref.bank}@${w.sourceId}`).slice(0, 3).join(', '));
}
