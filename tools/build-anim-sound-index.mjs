// Extract animation->sound info from .tani files using string anchors.
// Output: log/anim-sound-index.json
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { resolveFmodToWwise } from './fmod-to-wwise.mjs';

const ROOT = path.resolve('.');
let WWISE_BY_HASH = {};
let WWISE_PLAYABLE_IDS = new Set();
let WWISE_EVENTS = {};
try {
  const wj = JSON.parse(fs.readFileSync(path.join(ROOT, 'log', 'wwise-soundbank-index.json'), 'utf8'));
  WWISE_BY_HASH = wj.byHash || {};
  WWISE_EVENTS = wj.events || {};
  const WWISE_WEMS = wj.wems || {};
  // An event is playable iff at least one of its referenced WEM IDs has a
  // file on disk (.bnk-embedded counts because the .bnk itself is on disk).
  for (const [hStr, name] of Object.entries(WWISE_BY_HASH)) {
    const ev = WWISE_EVENTS[name];
    if (!ev) continue;
    const ids = [...(ev.wems?.streamed || []), ...(ev.wems?.inMemory || [])];
    let playable = false;
    for (const id of ids) {
      const w = WWISE_WEMS[id];
      if (!w) continue;
      if (!w.streamed) { playable = true; break; }   // embedded in a parsed .bnk
      if (w.file) { playable = true; break; }         // streamed wem present on disk
    }
    if (playable) WWISE_PLAYABLE_IDS.add(Number(hStr));
  }
  console.log(`loaded wwise index: ${Object.keys(WWISE_BY_HASH).length} names, ${WWISE_PLAYABLE_IDS.size} playable (have WEMs)`);
} catch (err) {
  console.warn('no wwise index, fmod->wwise resolution disabled:', err.message);
}
const TANI_DIRS = [
  path.join(ROOT, 'cache-extraction', 'actor-assets'),
  path.join(ROOT, 'cache-extraction', 'tani-extract'),
];
const OUT = path.join(ROOT, 'log', 'anim-sound-index.json');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (p.toLowerCase().endsWith('.tani')) out.push(p);
  }
  return out;
}

// Decode a NUL-terminated GBK string starting at offset `off` (max 256 bytes).
function readCStrGBK(buf, off, max = 256) {
  let end = off;
  while (end < buf.length && end < off + max && buf[end] !== 0) end++;
  return iconv.decode(buf.slice(off, end), 'gbk');
}

// Heuristic: is byte b a printable string char (ASCII or GBK lead)?
function isStrByte(b) {
  return (b >= 0x20 && b < 0x7f) || (b >= 0x81 && b <= 0xfe);
}

// Find NUL-terminated runs of >= minLen printable bytes; return [{off,len,str}].
function findStrings(buf, minLen = 4) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (!isStrByte(buf[i])) { i++; continue; }
    let j = i;
    while (j < buf.length && isStrByte(buf[j])) j++;
    if (j - i >= minLen) {
      const s = iconv.decode(buf.slice(i, j), 'gbk');
      out.push({ off: i, len: j - i, str: s });
    }
    i = j + 1;
  }
  return out;
}

// Classify and extract.
function parseTani(buf, file) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'GATA') return null;
  const version = buf.readUInt32LE(4);
  // ref-ani is at offset 8 (NUL-terminated GBK).
  const refAni = readCStrGBK(buf, 8, 512);

  const strings = findStrings(buf, 4);
  const seen = new Set();
  const dedup = (s) => { if (seen.has(s)) return false; seen.add(s); return true; };

  const pss = [];
  const sounds = [];
  for (let k = 0; k < strings.length; k++) {
    const s = strings[k].str;
    const lower = s.toLowerCase();
    // PSS effect paths
    if (/\.pss$/i.test(s) && lower.includes('source') && dedup(s)) {
      pss.push(s.replace(/\\/g, '/'));
      continue;
    }
    // Sound system markers
    if (s === 'FMOD' || s === 'Wwise') {
      // Look ahead for the next "long" string that looks like a path/event name.
      let evt = null;
      let bank = null;
      const cands = [];
      for (let m = k + 1; m < strings.length && m < k + 12; m++) {
        const t = strings[m].str;
        if (t.length < 3) continue;
        // skip noise like "chu", "ster", garbage
        if (!/^[A-Za-z0-9_\/\-]{3,}$/.test(t)) continue;
        if (!evt && t.includes('/')) { evt = t; continue; }
        if (!evt && /^[A-Za-z][A-Za-z0-9_]+$/.test(t) && t.length <= 24 && !bank) {
          // could be bank name e.g. "JX3_Skill"
          bank = t; continue;
        }
        cands.push(t);
      }
      sounds.push({ system: s, bank, event: evt, candidates: cands.slice(0, 8) });
    }
  }

  // Resolve FMOD/Wwise sound paths to actual playable Wwise event IDs.
  for (const snd of sounds) {
    if (!snd.event) continue;
    const cands = resolveFmodToWwise(snd.event, WWISE_BY_HASH, snd.candidates || [], 8, WWISE_PLAYABLE_IDS);
    snd.wwise = cands.map(c => ({ id: c.id, name: c.name, score: c.score, playable: WWISE_PLAYABLE_IDS.has(c.id) }));
  }

  return { file: path.relative(ROOT, file).replace(/\\/g, '/'), version, refAni: refAni.replace(/\\/g, '/'), pss, sounds };
}

// Infer faction/character from refAni path tokens.
const FACTION_TOKENS = [
  // skill prefixes -> faction
  { re: /[\\/]?f1[\\/_]/i, key: 'TianCe' },        // 天策
  { re: /[\\/]?f2[\\/_]/i, key: 'ShaoLin' },       // 少林
  { re: /[\\/]?f3[\\/_]/i, key: 'WanHua' },        // 万花
  { re: /[\\/]?f4[\\/_]/i, key: 'QiXiu' },         // 七秀
  { re: /[\\/]?f5[\\/_]/i, key: 'WuDu' },          // 五毒
  { re: /[\\/]?f6[\\/_]/i, key: 'TangMen' },       // 唐门
  { re: /[\\/]?f7[\\/_]/i, key: 'CangJian' },      // 纯阳/藏剑
  { re: /[\\/]?f8[\\/_]/i, key: 'GaiBang' },       // 丐帮
  { re: /[\\/]?f9[\\/_]/i, key: 'MingJiao' },      // 明教
  { re: /[\\/]?f10[\\/_]/i, key: 'CangYun' },
  { re: /[\\/]?f11[\\/_]/i, key: 'ChangGe' },
  { re: /[\\/]?f12[\\/_]/i, key: 'BaDao' },
];
const SKILL_TOKENS = [
  { re: /tiance|s04tc/i, key: 'TianCe' },
  { re: /shaolin|s07sl|s08sl/i, key: 'ShaoLin' },
  { re: /qixiu|s10qx/i, key: 'QiXiu' },
  { re: /wudu/i, key: 'WuDu' },
  { re: /tangmen/i, key: 'TangMen' },
  { re: /cangjian/i, key: 'CangJian' },
  { re: /gaibang/i, key: 'GaiBang' },
  { re: /mingjiao/i, key: 'MingJiao' },
];

function inferFaction(refAni, sounds) {
  for (const { re, key } of FACTION_TOKENS) if (re.test(refAni)) return key;
  for (const s of sounds) {
    if (!s.event) continue;
    for (const { re, key } of SKILL_TOKENS) if (re.test(s.event)) return key;
  }
  return 'Other';
}

const files = [...new Set([...TANI_DIRS.flatMap(walk)])];
console.log(`scanning ${files.length} .tani files...`);
const items = [];
for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const r = parseTani(buf, f);
  if (!r) continue;
  r.faction = inferFaction(r.refAni, r.sounds);
  items.push(r);
}
items.sort((a, b) => a.refAni.localeCompare(b.refAni));

// Group by faction.
const byFaction = {};
for (const it of items) (byFaction[it.faction] ||= []).push(it);
const summary = Object.fromEntries(
  Object.entries(byFaction).map(([k, v]) => [k, {
    count: v.length,
    withSound: v.filter(x => x.sounds.length > 0).length,
    withFmod: v.filter(x => x.sounds.some(s => s.system === 'FMOD')).length,
    withWwise: v.filter(x => x.sounds.some(s => s.system === 'Wwise')).length,
    resolved: v.filter(x => x.sounds.some(s => (s.wwise || []).some(w => w.playable))).length,
  }])
);

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: items.length, summary, items }, null, 2));
console.log(`wrote ${OUT}`);
console.log('summary:', JSON.stringify(summary, null, 2));
