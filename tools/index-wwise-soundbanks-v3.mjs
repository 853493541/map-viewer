#!/usr/bin/env node
// Wwise SoundBank indexer v3 — cross-bank HIRC graph.
//
// v2 walked each bank's HIRC in isolation, which missed events whose Actions
// target Sounds/Containers in OTHER banks (e.g. TianCe.bnk only contains the
// Event/Action/Sound HIRC; the actual WEM media is embedded in anonymous
// pak_NNNN.bnk files extracted from PakV5).
//
// v3:
//   1. Walks all *.bnk under every root (incl. anonymous pak banks without .txt).
//   2. Builds a GLOBAL hirc byId map (id -> {type, body, hostBank}) across
//      every bank.
//   3. Builds a GLOBAL wemId -> hostBank map from every DIDX chunk.
//   4. For each named Event (.txt manifest), brute-walks the global graph
//      collecting any reachable wem id.
//   5. Emits the same JSON shape v2 emitted, plus stats.
//
// Output: log/wwise-soundbank-index.json

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, resolve, extname } from 'node:path';
import { parseBnk } from './parse-wwise-bnk.mjs';

const DEFAULT_ROOTS = [
  'C:/SeasunGame/Game/JX3/bin/zhcn_hd/jx3ac/jx3ac_Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows',
  resolve('cache-extraction/wwise-pak-extract/Windows/base'),
  resolve('cache-extraction/wwise-pak-extract/extra-dirs'),
];
const ROOTS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS).filter((r) => existsSync(r));
const OUT = resolve('log/wwise-soundbank-index.json');

if (ROOTS.length === 0) { console.error('No roots'); process.exit(1); }

function wwiseHash(str) {
  let h = 0x811C9DC5n; const M = 0xFFFFFFFFn; const P = 0x01000193n;
  for (const c of Buffer.from(str.toLowerCase(), 'utf8')) { h = (h * P) & M; h = h ^ BigInt(c); }
  return Number(h & M);
}

function parseTxt(txt) {
  const lines = txt.split(/\r?\n/);
  const sections = []; let cur = [];
  for (const line of lines) {
    if (line.trim() === '') { if (cur.length) sections.push(cur); cur = []; continue; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur);
  const out = { events: [], inMemory: [], streamed: [] };
  for (const sec of sections) {
    if (sec.length < 2) continue;
    const header = sec[0].trim().toLowerCase();
    const rows = sec.slice(1).map((r) => r.split('\t').map((c) => c.trim()));
    if (header.startsWith('event')) {
      for (const r of rows) {
        const cols = r[0] === '' ? r.slice(1) : r;
        if (cols.length < 2) continue;
        const [id, name, path] = cols;
        if (!/^\d+$/.test(id)) continue;
        out.events.push({ id: Number(id), name, path: path || '' });
      }
    } else if (header.startsWith('in memory audio')) {
      for (const r of rows) {
        const cols = r[0] === '' ? r.slice(1) : r;
        if (cols.length < 2) continue;
        const [id, name, source, , , size] = cols;
        if (!/^\d+$/.test(id)) continue;
        out.inMemory.push({ id: Number(id), name, source: source || '', size: size ? Number(size) : null });
      }
    } else if (header.startsWith('streamed audio')) {
      for (const r of rows) {
        const cols = r[0] === '' ? r.slice(1) : r;
        if (cols.length < 2) continue;
        const [id, name, source, generated] = cols;
        if (!/^\d+$/.test(id)) continue;
        out.streamed.push({ id: Number(id), name, source: source || '', generated: generated || '' });
      }
    }
  }
  return out;
}

function walkRecursive(root, out = []) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

const events = {};   // name -> { id, banks[], wems:{streamed,inMemory}, path }
const wems = {};     // wemId -> { name, bank, streamed, file, size }
const banks = {};    // bankName -> { txt, bnk, events[], wems[], root, hasManifest }
const globalById = new Map(); // hircId -> { type, body, hostBank }
const allWemIds = new Set();

let totalBnk = 0, parsedBnk = 0;

for (const ROOT of ROOTS) {
  const allFiles = walkRecursive(ROOT);
  const bnkFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.bnk'));
  const txtByBaseName = new Map();
  for (const f of allFiles) {
    if (f.toLowerCase().endsWith('.txt')) txtByBaseName.set(basename(f, extname(f)), f);
  }
  console.log(`[${ROOT}] ${bnkFiles.length} .bnk, ${txtByBaseName.size} .txt manifests`);

  for (const bnkPath of bnkFiles) {
    totalBnk++;
    const bankName = basename(bnkPath, extname(bnkPath));
    if (banks[bankName]) continue; // first root wins; jx3ac authoritative
    const txtPath = txtByBaseName.get(bankName) || null;
    const bankEntry = { txt: txtPath, bnk: bnkPath, events: [], wems: [], root: ROOT, hasManifest: !!txtPath };
    banks[bankName] = bankEntry;

    // Parse manifest first for event/wem naming.
    if (txtPath) {
      const parsed = parseTxt(readFileSync(txtPath, 'utf8'));
      for (const ev of parsed.events) {
        if (!events[ev.name]) events[ev.name] = { id: ev.id, banks: [], wems: { streamed: [], inMemory: [] }, path: ev.path };
        if (!events[ev.name].banks.includes(bankName)) events[ev.name].banks.push(bankName);
        bankEntry.events.push(ev.name);
      }
      for (const im of parsed.inMemory) {
        wems[im.id] = wems[im.id] || { name: im.name, bank: bankName, streamed: false, file: null, size: im.size };
        bankEntry.wems.push(`im:${im.id}`);
      }
      for (const st of parsed.streamed) {
        const wemFile = join(ROOT, `${st.id}.wem`);
        const exists = existsSync(wemFile);
        wems[st.id] = { name: st.name, bank: bankName, streamed: true, file: exists ? wemFile : null };
        bankEntry.wems.push(`st:${st.id}`);
      }
    }

    // Parse the .bnk for DIDX (embedded wems) and HIRC (objects).
    let p;
    try { p = parseBnk(bnkPath); parsedBnk++; }
    catch (err) { console.warn(`  parseBnk failed for ${bankName}: ${err.message}`); continue; }

    // Register every embedded wem id with its host bank (anonymous bank wins
    // if no manifest claimed the id yet).
    for (const [wemId, info] of p.wems) {
      allWemIds.add(wemId);
      if (!wems[wemId]) wems[wemId] = { name: `${bankName}_${wemId}`, bank: bankName, streamed: false, file: null, size: info.size };
      else if (!wems[wemId].bank) wems[wemId].bank = bankName;
      if (!bankEntry.wems.includes(`im:${wemId}`)) bankEntry.wems.push(`im:${wemId}`);
    }

    // Add objects to GLOBAL by-id map (later events from any bank can reach them).
    for (const obj of p.objects) {
      if (!globalById.has(obj.id)) globalById.set(obj.id, { type: obj.type, body: obj.body, hostBank: bankName });
    }
  }

  // Phase B: also ingest orphan .txt manifests (no paired .bnk). These come
  // from the bulk pak extract (`pak_*.txt`) — they list events + media
  // sections for banks whose .bnk we don't have on disk under their original
  // name. Treat each orphan as a virtual bank named after the .txt.
  for (const [base, txtPath] of txtByBaseName) {
    if (banks[base]) continue;
    const parsed = parseTxt(readFileSync(txtPath, 'utf8'));
    if (!parsed.events.length && !parsed.inMemory.length && !parsed.streamed.length) continue;
    const bankEntry = { txt: txtPath, bnk: null, events: [], wems: [], root: ROOT, hasManifest: true };
    banks[base] = bankEntry;
    for (const ev of parsed.events) {
      if (!events[ev.name]) events[ev.name] = { id: ev.id, banks: [], wems: { streamed: [], inMemory: [] }, path: ev.path };
      if (!events[ev.name].banks.includes(base)) events[ev.name].banks.push(base);
      bankEntry.events.push(ev.name);
    }
    for (const im of parsed.inMemory) {
      wems[im.id] = wems[im.id] || { name: im.name, bank: base, streamed: false, file: null, size: im.size };
      bankEntry.wems.push(`im:${im.id}`);
    }
    for (const st of parsed.streamed) {
      const wemFile = join(ROOT, `${st.id}.wem`);
      const exists = existsSync(wemFile);
      // Don't overwrite an existing entry that already has a known file.
      if (!wems[st.id] || (!wems[st.id].file && exists)) {
        wems[st.id] = { name: st.name, bank: base, streamed: true, file: exists ? wemFile : null };
      }
      bankEntry.wems.push(`st:${st.id}`);
    }
  }

  // Phase C: ingest SoundBanksInfo.xml files. These give a DETERMINISTIC
  // bank → event → wem-file mapping (better than HIRC walking, which is
  // brittle for events whose .bnk we don't have parsed).
  const xmlFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.xml'));
  for (const xmlPath of xmlFiles) {
    const c = readFileSync(xmlPath, 'utf8');
    if (!c.includes('<SoundBanksInfo')) continue;
    // Walk per-bank: each <SoundBank>...<ShortName>X</ShortName>...
    // <IncludedEvents>...<Event Id Name>...<File Id>... in either
    // <ExcludedMemoryFiles> (=streamed/external) or <IncludedMemoryFiles>
    // (=embedded in .bnk).
    const bankRe = /<SoundBank\b[^>]*>([\s\S]*?)<\/SoundBank>/g;
    let mb;
    while ((mb = bankRe.exec(c))) {
      const block = mb[1];
      const shortMatch = block.match(/<ShortName>([^<]+)<\/ShortName>/);
      const bname = shortMatch ? shortMatch[1].trim() : null;
      if (!bname) continue;
      if (!banks[bname]) banks[bname] = { txt: null, bnk: null, events: [], wems: [], root: ROOT, hasManifest: false, fromXml: true };
      const bankEntry = banks[bname];
      bankEntry.fromXml = true;
      const evRe = /<Event\s+Id="(\d+)"\s+Name="([^"]+)"(?:\s+ObjectPath="([^"]*)")?[\s\S]*?(?:<\/Event>|\/>)/g;
      let me;
      while ((me = evRe.exec(block))) {
        const evId = Number(me[1]);
        const evName = me[2];
        const evPath = me[3] || '';
        const evBlock = me[0];
        const evRec = events[evName] || (events[evName] = { id: evId, banks: [], wems: { streamed: [], inMemory: [] }, path: evPath });
        if (!evRec.banks.includes(bname)) evRec.banks.push(bname);
        if (!bankEntry.events.includes(evName)) bankEntry.events.push(evName);
        // Extract <File Id="..."> entries inside this <Event> block.
        const inExcluded = evBlock.includes('<ExcludedMemoryFiles>');
        const inIncluded = evBlock.includes('<IncludedMemoryFiles>');
        const inStreamed = evBlock.includes('<ReferencedStreamedFiles>');
        const fileRe = /<File\s+Id="(\d+)"[^>]*>([\s\S]*?)<\/File>/g;
        let mf;
        while ((mf = fileRe.exec(evBlock))) {
          const fid = Number(mf[1]);
          const fbody = mf[2];
          const sn = (fbody.match(/<ShortName>([^<]+)<\/ShortName>/) || [])[1] || `${fid}`;
          // Streamed if ReferencedStreamedFiles section, otherwise it's
          // either embedded in the .bnk (Included) or external streamed
          // (Excluded). Wwise "ExcludedMemoryFiles" means the file is NOT
          // packed in this bank but referenced — typically streamed.
          const streamed = inStreamed || inExcluded;
          const wemFile = join(ROOT, `${fid}.wem`);
          const exists = existsSync(wemFile);
          if (!wems[fid] || (!wems[fid].file && exists)) {
            wems[fid] = { name: sn, bank: bname, streamed, file: exists ? wemFile : null };
          } else {
            // already there — keep file path if we have it; just refine name
            if (!wems[fid].name || wems[fid].name === `${fid}`) wems[fid].name = sn;
          }
          // Wire the wem directly into the event (skip HIRC walk).
          const bucket = streamed ? evRec.wems.streamed : evRec.wems.inMemory;
          if (!bucket.includes(fid)) bucket.push(fid);
          if (!bankEntry.wems.includes(`${streamed ? 'st' : 'im'}:${fid}`)) bankEntry.wems.push(`${streamed ? 'st' : 'im'}:${fid}`);
        }
      }
    }
  }
}

// Also register loose streamed .wem files (numeric filenames) discovered on
// disk under each root. This catches streamed wems that no .txt referenced.
for (const ROOT of ROOTS) {
  let entries;
  try { entries = readdirSync(ROOT); } catch { continue; }
  for (const f of entries) {
    const m = /^(\d+)\.wem$/i.exec(f);
    if (!m) continue;
    const id = Number(m[1]);
    if (!wems[id]) wems[id] = { name: `${id}`, bank: null, streamed: true, file: join(ROOT, f) };
    else if (!wems[id].file) { wems[id].file = join(ROOT, f); wems[id].streamed = true; }
  }
}

console.log(`Parsed ${parsedBnk}/${totalBnk} banks. Global HIRC objects: ${globalById.size}. Embedded wems: ${allWemIds.size}.`);

// Cross-bank event walk. For each named event we collect every reachable wem.
const HIRC_TYPE_SOUND = 2;
const HIRC_TYPE_ACTION = 3;
const HIRC_TYPE_EVENT = 4;

function walkEvent(eventObj) {
  const reachable = new Set();
  const visited = new Set();
  const stack = [eventObj];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || visited.has(obj.body)) continue;
    visited.add(obj.body);

    if (obj.type === HIRC_TYPE_SOUND) {
      // AkBankSourceData: u4 plugin_id, u1 stream_type, u4 source_id (wem id).
      if (obj.body.length >= 9) {
        const sid = obj.body.readUInt32LE(5);
        if (sid && (allWemIds.has(sid) || wems[sid])) reachable.add(sid);
      }
      // Be tolerant of variants — also brute-scan first 24 bytes.
      const lim = Math.min(obj.body.length, 24);
      for (let p = 0; p + 4 <= lim; p++) {
        const v = obj.body.readUInt32LE(p);
        if (v && (allWemIds.has(v) || (wems[v] && wems[v].streamed))) reachable.add(v);
      }
      continue;
    }

    // Brute scan body for u32 references to other HIRC objects (actions,
    // containers, sounds across banks) and to wem ids directly.
    for (let p = 0; p + 4 <= obj.body.length; p++) {
      const v = obj.body.readUInt32LE(p);
      if (!v) continue;
      if (allWemIds.has(v) || (wems[v] && wems[v].streamed)) {
        reachable.add(v);
        continue;
      }
      const child = globalById.get(v);
      if (child && !visited.has(child.body)) stack.push(child);
    }
  }
  return reachable;
}

let resolvedNew = 0;
for (const [evName, evRec] of Object.entries(events)) {
  const evObj = globalById.get(evRec.id);
  if (!evObj || evObj.type !== HIRC_TYPE_EVENT) continue;
  const reachable = walkEvent(evObj);
  let added = false;
  for (const sid of reachable) {
    const w = wems[sid];
    if (!w) continue;
    const bucket = w.streamed ? evRec.wems.streamed : evRec.wems.inMemory;
    if (!bucket.includes(sid)) { bucket.push(sid); added = true; }
  }
  if (added) resolvedNew++;
}

let totalStreamedWems = 0, totalInMemoryWems = 0;
for (const wem of Object.values(wems)) {
  if (wem.streamed) { if (wem.file && existsSync(wem.file)) totalStreamedWems++; }
  else totalInMemoryWems++;
}

const byHash = {};
for (const [evName, ev] of Object.entries(events)) {
  ev.taniHash = wwiseHash(evName);
  byHash[ev.taniHash] = evName;
  byHash[ev.id] = byHash[ev.id] || evName;
}

let eventsWithAnyWem = 0;
for (const ev of Object.values(events)) {
  if (ev.wems.streamed.length || ev.wems.inMemory.length) eventsWithAnyWem++;
}

const out = {
  generatedAt: new Date().toISOString(),
  generator: 'index-wwise-soundbanks-v3',
  roots: ROOTS,
  root: ROOTS[0],
  stats: {
    bankCount: Object.keys(banks).length,
    eventCount: Object.keys(events).length,
    eventsWithAnyWem,
    streamedWemFiles: totalStreamedWems,
    inMemoryWems: totalInMemoryWems,
    bnkFilesParsed: parsedBnk,
    bnkFilesTotal: totalBnk,
    globalHircObjects: globalById.size,
  },
  events,
  wems,
  banks: Object.fromEntries(Object.entries(banks).map(([k, v]) => [k, {
    txt: v.txt ? basename(v.txt) : null,
    bnk: v.bnk || null,
    events: v.events,
    wems: v.wems,
    root: v.root,
    hasManifest: v.hasManifest,
  }])),
  byHash,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Stats:`, out.stats);

const sample = Object.entries(events).filter(([n]) => /longya|skill_yu|skill_xiaoruhu|aili_at01|behit_flesh/i.test(n)).slice(0, 10);
for (const [name, ev] of sample) {
  console.log(`  ${name}  banks=${ev.banks.join(',')}  streamed=${ev.wems.streamed.length}  inMem=${ev.wems.inMemory.length}`);
}
