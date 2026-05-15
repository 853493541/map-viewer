#!/usr/bin/env node
// Build an index of Wwise SoundBanks across multiple roots, including:
//   - jx3ac character preview banks (loose .bnk + .txt + streamed .wem files)
//   - PakV5-extracted banks under cache-extraction/wwise-pak-extract/Windows/base
//
// Compared to the legacy single-root indexer this one also:
//   - parses each .bnk DIDX chunk to register *embedded* wem ids (Wwise stores
//     in-memory media size in the Sound HIRC object; the .txt may not list
//     them when only the Event section was generated)
//   - walks each .bnk HIRC chunk to map Event id -> set of source wem ids
//     via the Sound objects reachable from the event
//   - emits absolute paths for `bank.bnk` so the resolver can locate them
//     regardless of which root they came from
//
// Output: log/wwise-soundbank-index.json
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { parseBnk } from './parse-wwise-bnk.mjs';

// CLI: node tools/index-wwise-soundbanks.mjs [root1] [root2] ...
const DEFAULT_ROOTS = [
  'C:/SeasunGame/Game/JX3/bin/zhcn_hd/jx3ac/jx3ac_Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows',
  resolve('cache-extraction/wwise-pak-extract/Windows/base'),
];
const ROOTS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS).filter((r) => existsSync(r));
const OUT = resolve('log/wwise-soundbank-index.json');

if (ROOTS.length === 0) { console.error('No roots'); process.exit(1); }

function wwiseHash(str) {
  let h = 0x811C9DC5n;
  const M = 0xFFFFFFFFn;
  const P = 0x01000193n;
  for (const c of Buffer.from(str.toLowerCase(), 'utf8')) { h = (h * P) & M; h = h ^ BigInt(c); }
  return Number(h & M);
}

function parseTxt(txt) {
  const lines = txt.split(/\r?\n/);
  const sections = [];
  let cur = [];
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
        const [id, name, source, wwisePath, notes, size] = cols;
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

const events = {};       // name -> { id, banks[], wems:{streamed,inMemory}, path }
const wems = {};         // wemId -> { name, bank, streamed, file, size }
const banks = {};        // bankName -> { txt, bnk, events[], wems[], root }

for (const ROOT of ROOTS) {
  const files = readdirSync(ROOT);
  const txts = files.filter((f) => f.toLowerCase().endsWith('.txt'));
  console.log(`[${ROOT}] indexing ${txts.length} manifests`);
  for (const f of txts) {
    const bankName = f.replace(/\.txt$/i, '');
    const txtPath = join(ROOT, f);
    const bnkPath = join(ROOT, `${bankName}.bnk`);
    const parsed = parseTxt(readFileSync(txtPath, 'utf8'));

    // Skip if duplicate bank already registered (jx3ac wins over pak when both have it).
    if (banks[bankName]) {
      console.log(`  skip duplicate bank ${bankName} from ${ROOT}`);
      continue;
    }

    const bankEntry = { txt: txtPath, bnk: existsSync(bnkPath) ? bnkPath : null, events: [], wems: [], root: ROOT };
    banks[bankName] = bankEntry;

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

    // Walk DIDX/HIRC of the .bnk to: (a) register every embedded wem id with its
    // host bank, (b) build event -> wem source-id mapping.
    if (bankEntry.bnk) {
      let parsedBnk;
      try { parsedBnk = parseBnk(bankEntry.bnk); } catch (err) { console.warn(`  parseBnk failed for ${bankName}: ${err.message}`); continue; }
      // Register embedded wems from this bank's DATA chunk.
      for (const [wemId, info] of parsedBnk.wems) {
        if (!wems[wemId]) wems[wemId] = { name: `${bankName}_${wemId}`, bank: bankName, streamed: false, file: null, size: info.size };
        if (!bankEntry.wems.includes(`im:${wemId}`)) bankEntry.wems.push(`im:${wemId}`);
      }
      // HIRC event -> wem walk.
      const byId = new Map(parsedBnk.objects.map((o) => [o.id, o]));
      const eventsInBnk = parsedBnk.objects.filter((o) => o.type === 4);
      for (const ev of eventsInBnk) {
        const reachable = new Set();
        const visited = new Set();
        const stack = [ev];
        while (stack.length) {
          const obj = stack.pop();
          if (!obj || visited.has(obj.id)) continue;
          visited.add(obj.id);
          if (obj.type === 2) {
            // Sound: read source_id at offset 5 (after plugin_id u32 + stream_type u8).
            if (obj.body.length >= 9) {
              const sourceId = obj.body.readUInt32LE(5);
              reachable.add(sourceId);
            }
            continue;
          }
          for (let p = 0; p + 4 <= obj.body.length; p++) {
            const v = obj.body.readUInt32LE(p);
            if (v === 0 || v === obj.id) continue;
            const child = byId.get(v);
            if (child) stack.push(child);
          }
        }
        // Find the event by its id and attach wems whose data we actually have.
        // Find event name from the parsed events (the .txt parser already populated `events[name].id`).
        for (const evName of bankEntry.events) {
          const evRec = events[evName];
          if (evRec && evRec.id === ev.id) {
            for (const sid of reachable) {
              const w = wems[sid];
              if (!w) continue;
              const bucket = w.streamed ? evRec.wems.streamed : evRec.wems.inMemory;
              if (!bucket.includes(sid)) bucket.push(sid);
            }
          }
        }
      }
    }
  }
}

// Compute hash and stats.
let totalStreamedWems = 0;
let totalInMemoryWems = 0;
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
  roots: ROOTS,
  // legacy single-root field for backward compat with the resolver
  root: ROOTS[0],
  stats: {
    bankCount: Object.keys(banks).length,
    eventCount: Object.keys(events).length,
    eventsWithAnyWem,
    streamedWemFiles: totalStreamedWems,
    inMemoryWems: totalInMemoryWems,
  },
  events,
  wems,
  banks: Object.fromEntries(Object.entries(banks).map(([k, v]) => [k, {
    txt: basename(v.txt),
    // store ABSOLUTE path so the resolver can use it directly
    bnk: v.bnk || null,
    events: v.events,
    wems: v.wems,
    root: v.root,
  }])),
  byHash,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Stats: banks=${out.stats.bankCount} events=${out.stats.eventCount} eventsWithWem=${eventsWithAnyWem} streamedWems=${totalStreamedWems} inMemWems=${totalInMemoryWems}`);

const sample = Object.entries(events).filter(([n]) => /skill_yu|skill_xiaoruhu|aili_at01|behit_flesh/i.test(n)).slice(0, 5);
for (const [name, ev] of sample) {
  console.log(`  ${name}  banks=${ev.banks.join(',')}  streamed=${ev.wems.streamed.length}  inMem=${ev.wems.inMemory.length}`);
}
