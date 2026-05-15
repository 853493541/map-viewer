#!/usr/bin/env node
// Build an index of Wwise SoundBanks shipped under jx3ac/StreamingAssets.
//
// Output: log/wwise-soundbank-index.json
//   {
//     events: { [eventName]: { id, banks: string[], wems: { streamed: string[], inMemory: string[] }, taniHash: number } },
//     wems: { [wemId]: { file: string, name: string, bank: string, streamed: boolean } },
//     banks: { [bankName]: { txt: string, bnk: string, events: string[], wems: string[] } },
//     stats: {...}
//   }
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';

const DEFAULT_ROOT = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/jx3ac/jx3ac_Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows';
const ROOT = process.argv[2] || DEFAULT_ROOT;
const OUT = resolve('log/wwise-soundbank-index.json');

// Wwise FNV-1 (32-bit), input lowercased UTF-8.
function wwiseHash(str) {
  let h = 0x811C9DC5n;
  const M = 0xFFFFFFFFn;
  const P = 0x01000193n;
  const buf = Buffer.from(str.toLowerCase(), 'utf8');
  for (const c of buf) {
    h = (h * P) & M;
    h = h ^ BigInt(c);
  }
  return Number(h & M);
}

if (!existsSync(ROOT)) {
  console.error(`SoundBanks root not found: ${ROOT}`);
  process.exit(1);
}

const files = readdirSync(ROOT);
const txts = files.filter((f) => f.toLowerCase().endsWith('.txt'));
console.log(`Indexing ${txts.length} SoundBank manifests from ${ROOT}...`);

const events = {};
const wems = {};
const banks = {};
let totalEvents = 0;
let totalStreamedWems = 0;
let totalInMemoryWems = 0;

// Each .txt has 3 sections separated by blank lines:
//   Event\tID\tName\tWwise Object Path\tNotes
//   In Memory Audio\tID\tName\tAudio source file\tWwise Object Path\tNotes\tData Size
//   Streamed Audio\tID\tName\tAudio source file\tGenerated audio file\tWwise Object Path\tNotes
function parseTxt(txt) {
  const lines = txt.split(/\r?\n/);
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length > 0) {
        sections.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length > 0) sections.push(cur);
  const out = { events: [], inMemory: [], streamed: [] };
  for (const sec of sections) {
    if (sec.length < 2) continue;
    const header = sec[0].trim().toLowerCase();
    const rows = sec.slice(1).map((r) => r.split('\t').map((c) => c.trim()));
    if (header.startsWith('event')) {
      // Event\tID\tName\tWwise Object Path\tNotes
      // Rows have a leading empty cell (matching the leading tab on the header).
      for (const r of rows) {
        // Skip comment/section divider rows.
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

for (const f of txts) {
  const bankName = f.replace(/\.txt$/i, '');
  const txtPath = join(ROOT, f);
  const bnkPath = join(ROOT, `${bankName}.bnk`);
  const parsed = parseTxt(readFileSync(txtPath, 'utf8'));
  const bankEntry = {
    txt: txtPath,
    bnk: existsSync(bnkPath) ? bnkPath : null,
    events: [],
    wems: [],
  };
  banks[bankName] = bankEntry;
  for (const ev of parsed.events) {
    if (!events[ev.name]) {
      events[ev.name] = { id: ev.id, banks: [], wems: { streamed: [], inMemory: [] }, path: ev.path };
    }
    if (!events[ev.name].banks.includes(bankName)) events[ev.name].banks.push(bankName);
    bankEntry.events.push(ev.name);
    totalEvents++;
  }
  for (const im of parsed.inMemory) {
    const wemFile = null; // In-memory audio lives inside the .bnk.
    wems[im.id] = wems[im.id] || { name: im.name, bank: bankName, streamed: false, file: null, size: im.size };
    bankEntry.wems.push(`im:${im.id}`);
    totalInMemoryWems++;
  }
  for (const st of parsed.streamed) {
    const wemFile = join(ROOT, `${st.id}.wem`);
    const exists = existsSync(wemFile);
    wems[st.id] = { name: st.name, bank: bankName, streamed: true, file: exists ? wemFile : null };
    bankEntry.wems.push(`st:${st.id}`);
    if (exists) totalStreamedWems++;
  }
}

// Cross-reference: assign wem IDs to events. Wwise events trigger Sound objects
// inside the .bnk hierarchy; the .txt only tells us which IDs belong to the
// bank as a whole, not which specific wems an event plays. For now, attach all
// streamed wems whose `name` starts with the event name's pinyin core (best-
// effort heuristic).
function eventCore(name) {
  // "Play_AiLi_Skill02" -> "AiLi_Skill02"
  return name.replace(/^Play_/i, '');
}
for (const [evName, ev] of Object.entries(events)) {
  const core = eventCore(evName).toLowerCase();
  for (const [wemId, wem] of Object.entries(wems)) {
    if (wem.bank !== ev.banks[0] && !ev.banks.includes(wem.bank)) continue;
    const wn = (wem.name || '').toLowerCase();
    if (!wn) continue;
    // Match if the wem name equals the core or starts with `<core>_` (e.g. AiLi_At01_a vs AiLi_At01).
    if (wn === core || wn.startsWith(core + '_') || core.startsWith(wn + '_')) {
      const bucket = wem.streamed ? ev.wems.streamed : ev.wems.inMemory;
      if (!bucket.includes(Number(wemId))) bucket.push(Number(wemId));
    }
  }
  ev.taniHash = wwiseHash(evName);
}

// Reverse FNV index for tani->event matching (events are keyed by FNV hash in
// engine state, but our .tani strings are usually plain event names already).
const byHash = {};
for (const [evName, ev] of Object.entries(events)) {
  byHash[ev.taniHash] = evName;
  // Also index by id (Wwise stores both: id == hash for events).
  byHash[ev.id] = byHash[ev.id] || evName;
}

const out = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  stats: {
    bankCount: Object.keys(banks).length,
    eventCount: Object.keys(events).length,
    streamedWemFiles: totalStreamedWems,
    inMemoryWems: totalInMemoryWems,
  },
  events,
  wems,
  banks: Object.fromEntries(Object.entries(banks).map(([k, v]) => [k, { ...v, txt: basename(v.txt), bnk: v.bnk ? basename(v.bnk) : null }])),
  byHash,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Stats: banks=${out.stats.bankCount} events=${out.stats.eventCount} streamedWems=${out.stats.streamedWemFiles} inMemWems=${out.stats.inMemoryWems}`);

// Sanity samples.
const sample = Object.entries(events).slice(0, 5);
for (const [name, ev] of sample) {
  console.log(`  ${name}  id=${ev.id}  banks=${ev.banks.join(',')}  streamedWems=${ev.wems.streamed.join(',') || '—'}  inMemWems=${ev.wems.inMemory.join(',') || '—'}`);
}
