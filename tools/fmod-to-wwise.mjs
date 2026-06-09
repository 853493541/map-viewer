// FMOD path -> Wwise event fuzzy resolver.
// Wwise events use semantic skill keywords (e.g. "longya", "longya8chi"); FMOD paths
// embed the same keyword inside longer hierarchical paths (e.g.
// "skillremake/tiance/skill/s04tcjineng13_qicheng_longyahd"). The runtime mapping
// table that the engine uses isn't exposed in any plain-text config we can read,
// so we use keyword overlap with faction context as a best-effort resolver.
//
// Exports: { resolveFmodToWwise, addAlternativeKeywords }

const FACTION_MAP = {
  tiance: 'TianCe', shaolin: 'ShaoLin', qixiu: 'QiXiu', wudu: 'WuDu',
  tangmen: 'TangMen', cangjian: 'CangJian', gaibang: 'GaiBang', mingjiao: 'MingJiao',
  cangyun: 'CangYun', changge: 'ChangGe', badao: 'BaDao', wanhua: 'WanHua',
  chunyang: 'ChunYang', chunyangqinggong: 'ChunYang',
  // common npc/system buckets
  jx3_skill: 'JX3_Skill', jx3_ui: 'JX3_UI',
};

function deriveKeywords(fmodPath, extras = []) {
  const lower = String(fmodPath || '').toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const all = [last, ...extras.map(s => String(s || '').toLowerCase())];
  // Extract alpha runs >= 3 chars from last segment + any provided alt names.
  const seen = new Set();
  const keywords = [];
  for (const seg of all) {
    const matches = seg.match(/[a-z]+/g) || [];
    for (const m of matches) {
      if (m.length < 3) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      keywords.push(m);
      // also add common stem variants (drop trailing 'hd', drop digits suffix)
      const stem = m.replace(/hd$/, '');
      if (stem.length >= 4 && !seen.has(stem)) { seen.add(stem); keywords.push(stem); }
    }
  }
  let faction = null;
  for (const k of Object.keys(FACTION_MAP)) {
    if (lower.includes(k)) { faction = FACTION_MAP[k]; break; }
  }
  return { faction, keywords, last };
}

function resolveFmodToWwise(fmodPath, byHash, extras = [], limit = 8, playableSet = null) {
  if (!fmodPath || !byHash) return [];
  const t = deriveKeywords(fmodPath, extras);
  const out = [];
  for (const [hStr, name] of Object.entries(byHash)) {
    const nl = name.toLowerCase();
    let score = 0;
    let kwHits = 0;
    if (t.faction && nl.includes(t.faction.toLowerCase())) score += 10;
    for (const k of t.keywords) {
      if (nl.includes(k)) {
        score += k.length;
        kwHits++;
        // Bonus when wwise event name ENDS with the keyword (best alignment).
        if (nl.endsWith(k)) score += 6;
        if (nl.endsWith('_' + k)) score += 4;
      }
    }
    if (kwHits === 0) continue;
    const id = Number(hStr);
    const playable = !!(playableSet && playableSet.has(id));
    // Modest boost for playable candidates: enough to promote a playable
    // event over an unplayable one with very similar keyword overlap, but
    // not enough to override a strongly-matched unplayable event over a
    // weakly-matched playable one.
    if (playable) score += 20;
    out.push({ id, name, score, playable });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.playable !== b.playable) return a.playable ? -1 : 1;
    return a.name.length - b.name.length;
  });
  return out.slice(0, limit);
}

export { resolveFmodToWwise, deriveKeywords };
