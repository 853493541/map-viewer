import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { buildAbilityMatcherSearch, buildAbilityPrefixCache } from './ability-matcher.js';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '..');
const ABILITY_MATCHER_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'ability-matcher');
const TANI_SOUND_CACHE_PATH = join(ABILITY_MATCHER_ROOT, 'ability-tani-sound-cache.json');
const TANI_SOUND_REVIEW_PATH = join(ABILITY_MATCHER_ROOT, 'ability-tani-sound-review.json');
const PUBLIC_TANI_SOUND_JS_PATH = join(REPO_ROOT, 'public', 'ability-tani-sound.js');
const ANIM_SOUND_INDEX_PATH = join(REPO_ROOT, 'log', 'anim-sound-index.json');
const WWISE_INDEX_PATH = join(REPO_ROOT, 'log', 'wwise-soundbank-index.json');
const TANI_EXTRACT_ROOT = join(REPO_ROOT, 'cache-extraction', 'tani-extract');
const TANI_PATHLIST_ROOT = join(ABILITY_MATCHER_ROOT, 'tani-sound-pathlists');
const PAKV4_EXTRACT_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/bin64/PakV4SfxExtract.exe');
const TANI_CATALOG_PATHS = [
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/MovieEditor/ResourcePack/Tani.rt'),
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/movieeditor/resourcepack/tani.rt'),
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4_probe/seasun/editortool/movieeditor/resourcepack/tani.rt'),
];
const CACHE_SCHEMA_VERSION = 2;
const REVIEW_SCHEMA_VERSION = 1;
const PREFIXED_ABILITY_GROUPS = ['\u7EDD\u5883', '\u4F2A\u4F20'];
const REVIEW_STATUSES = new Set(['已确认', '未确认', '丢弃', '未找到', '无需声音']);
const MAX_TANI_RESULTS_PER_ABILITY = 10;
const MAX_EXTRACT_TOTAL = 1200;
const MAX_WEMS_PER_ABILITY = 64;
const MAX_EVENTS_PER_TANI = 24;
const MAX_RELATED_ABILITY_SEARCH_RESULTS = 16;
const MAX_RELATED_ABILITY_TERMS = 64;
const BODY_ORDER = new Map(['f1', 'f2', 'm1', 'm2', 'm3', 'f3'].map((body, index) => [body, index]));
const jsonCache = new Map();
const relatedSearchCache = new Map();
let zcAbilities = null;
let zcSlugByNameNorm = null;

function ensureDir(directoryPath) {
  if (!existsSync(directoryPath)) mkdirSync(directoryPath, { recursive: true });
}

function getFileStamp(filePath) {
  if (!existsSync(filePath)) return 'missing';
  const stats = statSync(filePath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function readJsonFile(filePath, fallback = null) {
  const stamp = getFileStamp(filePath);
  const cached = jsonCache.get(filePath);
  if (cached?.stamp === stamp) return cached.value;
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    jsonCache.set(filePath, { stamp, value });
    return value;
  } catch {
    jsonCache.set(filePath, { stamp, value: fallback });
    return fallback;
  }
}

function readGb18030File(filePath) {
  return iconv.decode(readFileSync(filePath), 'gb18030').replace(/^\uFEFF/, '');
}

function normalizeSlashes(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A,\uFF0C\u3001'"\u201C\u201D\u2018\u2019()\uFF08\uFF09\[\]\u3010\u3011<>\u300A\u300B/\\]/g, '');
}

function stripLeadingId(value) {
  return String(value || '').replace(/^\s*\d+\s*/, '');
}

function aliasCoreName(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:\u4F2A\u4F20|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]+(.+)$/u);
  return match ? match[1] : text;
}

function stripAbilityDecorations(value) {
  return stripLeadingId(value)
    .replace(/^(?:\u4F2A\u4F20|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]+/u, '')
    .replace(/^(?:\u9053\u5177|\u4F2A\u4F20|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]*/u, '')
    .trim();
}

function coreNameTerms(value) {
  const text = stripLeadingId(value).trim();
  if (!text) return [];
  const candidates = [
    aliasCoreName(text),
    stripAbilityDecorations(text),
    text.split(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A/\\]+/u).pop(),
  ];
  const terms = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const label = stripAbilityDecorations(candidate || '').trim();
    const normalized = normalizeName(label);
    if (normalized.length < 2 || /^\d+$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push({ label, normalized });
  }
  return terms;
}

function abilityDisplayName(ability) {
  return ability?.matchAlias?.Name || ability?.skill?.SkillName || ability?.resolvedSkillName || ability?.name || ability?.id || '';
}

function loadZcAbilities() {
  if (zcAbilities) return zcAbilities;
  zcAbilities = [];
  try {
    const text = readFileSync(PUBLIC_TANI_SOUND_JS_PATH, 'utf8');
    const body = text.match(/const\s+ZC_ABILITY_PAIRS\s*=\s*\[([\s\S]*?)\];/)?.[1] || '';
    const pairPattern = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g;
    let match;
    while ((match = pairPattern.exec(body))) {
      const nameNorm = normalizeName(match[1]);
      const slug = String(match[2] || '').trim();
      if (nameNorm && slug) zcAbilities.push({ index: zcAbilities.length + 1, name: match[1], slug, key: nameNorm });
    }
  } catch {
  }
  return zcAbilities;
}

function loadZcSlugByNameNorm() {
  if (zcSlugByNameNorm) return zcSlugByNameNorm;
  zcSlugByNameNorm = new Map();
  for (const ability of loadZcAbilities()) zcSlugByNameNorm.set(ability.key, ability.slug);
  return zcSlugByNameNorm;
}

function addSearchTerm(terms, seen, label, source = 'name') {
  const text = String(label || '').trim();
  const normalized = normalizeName(text);
  if (normalized.length < 2 || /^\d+$/.test(normalized) || seen.has(normalized)) return;
  seen.add(normalized);
  terms.push({ label: text, normalized, source });
}

function addFallbackSearchTerm(terms, seen, label) {
  const text = String(label || '').trim();
  const normalized = normalizeName(text);
  if (!normalized || /^\d+$/.test(normalized) || seen.has(normalized)) return;
  seen.add(normalized);
  terms.push({ label: text, normalized, source: 'name' });
}

function addSkillIdSearchTerm(terms, seen, id) {
  const text = String(id || '').trim();
  if (!/^\d{2,6}$/.test(text) || seen.has(text)) return;
  seen.add(text);
  terms.push({ label: text, normalized: text, source: 'skill-id' });
}

function abilityRawNames(ability) {
  return [...new Set([
    abilityDisplayName(ability),
    ability?.resolvedSkillName,
    ability?.skill?.SkillName,
    ability?.matchAlias?.Name,
    ...(ability?.relatedAbilityResults || []).flatMap((item) => abilityRawNames(item)),
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function abilityIds(ability) {
  return [...new Set([
    ability?.id,
    ability?.skill?.SkillID,
    ability?.resolvedSkillId,
    ability?.matchAlias?.ID,
    ability?.primaryRelatedSkill?.id,
    ability?.primaryRelatedSkill?.skill?.SkillID,
    ...(ability?.childIds || []),
    ...(ability?.children || []).flatMap((item) => [item?.id, item?.skill?.SkillID, item?.matchAlias?.ID]),
    ...(ability?.relatedSkillMatches || []).map((item) => item?.id),
    ...(ability?.relatedSkills || []).flatMap((item) => [item?.id, item?.skill?.SkillID]),
    ...(ability?.relatedAbilityResults || []).flatMap((item) => abilityIds(item)),
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function zcSlugForTerms(terms) {
  const slugMap = loadZcSlugByNameNorm();
  for (const term of terms) {
    const slug = slugMap.get(term.normalized);
    if (slug) return slug;
  }
  return '';
}

function baseAbilityTerms(ability) {
  const terms = [];
  const seen = new Set();
  for (const rawName of abilityRawNames(ability)) {
    for (const term of coreNameTerms(rawName)) addSearchTerm(terms, seen, term.label, 'name');
  }
  if (!terms.length) addFallbackSearchTerm(terms, seen, stripAbilityDecorations(abilityDisplayName(ability)));
  for (const term of terms.filter((item) => item.source === 'name')) {
    for (const prefix of PREFIXED_ABILITY_GROUPS) addSearchTerm(terms, seen, `${prefix}·${term.label}`, 'prefixed-name');
  }
  const slug = zcSlugForTerms(terms);
  if (slug && normalizeName(slug).length >= 4) {
    addSearchTerm(terms, seen, slug, 'zc-pinyin');
    addSearchTerm(terms, seen, `juejing_${slug}`, 'zc-pinyin');
    addSearchTerm(terms, seen, `weizhuan_${slug}`, 'zc-pinyin');
    addSearchTerm(terms, seen, `绝境·${slug}`, 'zc-pinyin');
    addSearchTerm(terms, seen, `伪传·${slug}`, 'zc-pinyin');
  }
  if (ability.expandRelated === true) {
    for (const id of abilityIds(ability)) addSkillIdSearchTerm(terms, seen, id);
  }
  return terms;
}

function relatedAbilitySearch(query) {
  const text = String(query || '').trim();
  if (!text) return [];
  if (!relatedSearchCache.has(text)) {
    try {
      const payload = buildAbilityMatcherSearch({ query: text, limit: MAX_RELATED_ABILITY_SEARCH_RESULTS });
      relatedSearchCache.set(text, payload?.results || []);
    } catch {
      relatedSearchCache.set(text, []);
    }
  }
  return relatedSearchCache.get(text) || [];
}

function relatedAbilityResults(ability, baseTerms) {
  const queries = new Set();
  for (const term of baseTerms) {
    if (['name', 'zc-pinyin', 'skill-id'].includes(term.source)) queries.add(term.label);
  }
  for (const id of abilityIds(ability)) queries.add(id);
  const resultsByKey = new Map();
  for (const query of queries) {
    for (const result of relatedAbilitySearch(query)) {
      const key = `${result.kind || 'skill'}:${result.id || result.skill?.SkillID || result.matchAlias?.ID || abilityDisplayName(result)}`;
      if (!resultsByKey.has(key)) resultsByKey.set(key, result);
    }
  }
  return [...resultsByKey.values()];
}

function addRelatedAbilityTerms(terms, seen, ability) {
  let added = 0;
  for (const result of relatedAbilityResults(ability, terms)) {
    for (const rawName of abilityRawNames(result)) {
      for (const term of coreNameTerms(rawName)) {
        const before = terms.length;
        addSearchTerm(terms, seen, term.label, 'similar-name');
        added += terms.length - before;
        if (added >= MAX_RELATED_ABILITY_TERMS) return;
      }
    }
    for (const id of abilityIds(result)) {
      const before = terms.length;
      addSkillIdSearchTerm(terms, seen, id);
      added += terms.length - before;
      if (added >= MAX_RELATED_ABILITY_TERMS) return;
    }
  }
}

function expandedAbilityTerms(ability, startingTerms = baseAbilityTerms(ability)) {
  const terms = startingTerms.map((term) => ({ ...term }));
  const seen = new Set(terms.map((term) => term.normalized));
  addRelatedAbilityTerms(terms, seen, ability);
  return terms;
}

function abilityTerms(ability) {
  return baseAbilityTerms(ability);
}

function abilityTerm(ability) {
  const terms = abilityTerms(ability);
  if (terms[0]) return terms[0];
  return { label: stripAbilityDecorations(abilityDisplayName(ability)), normalized: normalizeName(abilityDisplayName(ability)) };
}

function repoRelativePath(filePath) {
  const text = String(filePath || '').trim();
  if (!text) return '';
  if (isAbsolute(text)) {
    const rel = relative(REPO_ROOT, text);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return normalizeSlashes(rel);
    return text.replace(/\\/g, '/');
  }
  return normalizeSlashes(text);
}

function localTaniPath(logicalPath) {
  return join(TANI_EXTRACT_ROOT, normalizeSlashes(logicalPath).replace(/\//g, '\\'));
}

function dataSourceKey(value) {
  const normalized = normalizeSlashes(value).toLowerCase();
  const marker = normalized.indexOf('data/source/');
  return marker >= 0 ? normalized.slice(marker) : normalized;
}

function slugForPath(value) {
  return normalizeSlashes(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'path';
}

function findTaniCatalogPath() {
  return TANI_CATALOG_PATHS.find((filePath) => existsSync(filePath)) || '';
}

function loadTaniCatalog() {
  const catalogPath = findTaniCatalogPath();
  if (!catalogPath) return { path: '', items: [] };
  const text = readGb18030File(catalogPath);
  const seen = new Set();
  const items = [];
  const re = /data[\\/]+source[\\/]+player[\\/][^\u0000\r\n\t"]{1,240}?\.tani/giu;
  let match;
  while ((match = re.exec(text))) {
    const logicalPath = normalizeSlashes(match[0]);
    const key = logicalPath.toLowerCase();
    if (!logicalPath || seen.has(key)) continue;
    seen.add(key);
    items.push({
      path: logicalPath,
      name: basename(logicalPath),
      baseName: basename(logicalPath).replace(/\.tani$/i, ''),
      normalizedText: normalizeName(logicalPath),
      dataKey: dataSourceKey(logicalPath),
    });
  }
  return { path: catalogPath, items };
}

function bodyRank(pathValue) {
  const match = normalizeSlashes(pathValue).toLowerCase().match(/data\/source\/player\/([^/]+)/);
  return BODY_ORDER.has(match?.[1]) ? BODY_ORDER.get(match[1]) : 99;
}

function scoreTaniCandidate(item, term) {
  if (!term?.normalized) return 0;
  const baseNorm = normalizeName(item.baseName || item.name || item.path);
  if (baseNorm.includes(term.normalized)) {
    let score = 1000 + term.normalized.length;
    if (baseNorm === term.normalized) score += 200;
    return score;
  }
  if (item.normalizedText.includes(term.normalized)) return 500 + term.normalized.length;
  return 0;
}

function sortTaniCandidates(matches) {
  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const bodyDelta = bodyRank(left.path) - bodyRank(right.path);
    if (bodyDelta !== 0) return bodyDelta;
    return left.path.localeCompare(right.path, 'zh-Hans-CN');
  });
  return matches;
}

function findTaniCandidates(catalog, terms, limit = MAX_TANI_RESULTS_PER_ABILITY) {
  const searchTerms = (Array.isArray(terms) ? terms : [terms]).filter((term) => term?.normalized);
  const matchesByPath = new Map();
  for (const item of catalog.items || []) {
    let best = null;
    for (const term of searchTerms) {
      const score = scoreTaniCandidate(item, term);
      if (!score || (best && score <= best.score)) continue;
      best = { score, term };
    }
    if (!best) continue;
    const reason = `${best.term.source || 'name'} term ${best.term.label}`;
    const existing = matchesByPath.get(item.path);
    if (!existing || best.score > existing.score) matchesByPath.set(item.path, { ...item, score: best.score, reason });
  }
  return sortTaniCandidates([...matchesByPath.values()]).slice(0, limit);
}

function mergeTaniCandidates(...groups) {
  const byPath = new Map();
  for (const candidate of groups.flat()) {
    if (!candidate?.path) continue;
    const existing = byPath.get(candidate.path);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) byPath.set(candidate.path, candidate);
  }
  return sortTaniCandidates([...byPath.values()]);
}

function extractTaniPaths(logicalPaths, maxCount = MAX_EXTRACT_TOTAL) {
  const pending = [...new Set((logicalPaths || []).map(normalizeSlashes))]
    .filter((value) => value && !value.split('/').includes('..'))
    .filter((value) => !existsSync(localTaniPath(value)))
    .slice(0, maxCount);
  const requested = (logicalPaths || []).length;
  if (!pending.length || !existsSync(PAKV4_EXTRACT_EXE)) return { requested, attempted: 0, extracted: 0 };
  ensureDir(TANI_EXTRACT_ROOT);
  ensureDir(TANI_PATHLIST_ROOT);
  const pathlist = join(TANI_PATHLIST_ROOT, `_tani_sound_${Date.now()}_${slugForPath(pending[0])}.txt`);
  writeFileSync(pathlist, iconv.encode(pending.map((value) => value.split('/').join('\\')).join('\r\n') + '\r\n', 'gb18030'));
  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlist, TANI_EXTRACT_ROOT], {
      cwd: dirname(PAKV4_EXTRACT_EXE),
      timeout: Math.max(30000, pending.length * 1200),
      windowsHide: true,
    });
  } catch {
  }
  const extracted = pending.filter((value) => existsSync(localTaniPath(value))).length;
  return { requested, attempted: pending.length, extracted, pathlist: repoRelativePath(pathlist) };
}

function rebuildAnimSoundIndex() {
  try {
    execFileSync(process.execPath, [join(TOOL_DIR, 'build-anim-sound-index.mjs')], {
      cwd: REPO_ROOT,
      timeout: 120000,
      windowsHide: true,
      stdio: 'ignore',
    });
    jsonCache.delete(ANIM_SOUND_INDEX_PATH);
    return true;
  } catch {
    return false;
  }
}

function loadAnimSoundIndex() {
  const items = readJsonFile(ANIM_SOUND_INDEX_PATH, { items: [] })?.items || [];
  const byDataKey = new Map();
  const searchItems = [];
  for (const item of items) {
    const key = dataSourceKey(item.file || '');
    if (key && !byDataKey.has(key)) byDataKey.set(key, item);
    const searchItem = animIndexSearchItem(item);
    if (searchItem) searchItems.push(searchItem);
  }
  return { items, byDataKey, searchItems };
}

function animIndexSearchText(item) {
  return [
    item?.file,
    item?.refAni,
    ...(item?.pss || []),
    ...(item?.sounds || []).flatMap((sound) => [
      sound?.event,
      sound?.system,
      sound?.bank,
      ...(sound?.candidates || []).map((candidate) => candidate?.name || candidate?.id),
      ...(sound?.wwise || []).map((candidate) => candidate?.name || candidate?.id),
    ]),
  ].filter(Boolean).join(' ');
}

function animIndexSearchItem(item) {
  const path = dataSourceKey(item?.file || '');
  if (!/\.tani$/i.test(path)) return null;
  return {
    path,
    name: basename(path),
    baseName: basename(path).replace(/\.tani$/i, ''),
    normalizedText: normalizeName(animIndexSearchText(item)),
    dataKey: dataSourceKey(path),
  };
}

function findAnimTaniCandidates(animIndex, terms, limit = MAX_TANI_RESULTS_PER_ABILITY) {
  return findTaniCandidates({ items: animIndex?.searchItems || [] }, terms, limit)
    .map((candidate) => ({ ...candidate, reason: `sound ${candidate.reason}` }));
}

function loadWwiseIndex() {
  const index = readJsonFile(WWISE_INDEX_PATH, {});
  const events = index.events || {};
  const byHash = index.byHash || {};
  const eventsByLowerName = new Map();
  const eventsById = new Map();
  for (const [eventName, event] of Object.entries(events)) {
    eventsByLowerName.set(eventName.toLowerCase(), { name: eventName, event });
    if (Number.isFinite(Number(event.id))) eventsById.set(String(event.id), { name: eventName, event });
    if (Number.isFinite(Number(event.taniHash))) eventsById.set(String(event.taniHash), { name: eventName, event });
  }
  for (const [eventId, eventName] of Object.entries(byHash)) {
    if (events[eventName]) eventsById.set(String(eventId), { name: eventName, event: events[eventName] });
  }
  return { index, eventsByLowerName, eventsById, wems: index.wems || {}, stats: index.stats || {} };
}

function eventLookupKeys(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const normalizedPath = text.replace(/[\\/]+/g, '_');
  const compact = normalizedPath.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const keys = new Set([text.toLowerCase(), normalizedPath.toLowerCase(), compact.toLowerCase()]);
  if (!/^play_/i.test(compact)) keys.add(`play_${compact}`.toLowerCase());
  return [...keys].filter(Boolean);
}

function lookupWwiseEvent(wwise, value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text) && wwise.eventsById.has(text)) return wwise.eventsById.get(text);
  for (const key of eventLookupKeys(text)) {
    const match = wwise.eventsByLowerName.get(key);
    if (match) return match;
  }
  return null;
}

function resolveSoundEvent(wwise, sound) {
  const direct = lookupWwiseEvent(wwise, sound?.event || '');
  if (direct) return { ...direct, rawEvent: sound?.event || '', confidence: 'exact' };
  const candidates = [...(sound?.wwise || [])]
    .filter((candidate) => candidate?.name || candidate?.id)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const bestScore = Number(candidates[0]?.score || 0);
  if (bestScore < 40) return null;
  for (const candidate of candidates.filter((item) => Number(item.score || 0) === bestScore)) {
    const match = lookupWwiseEvent(wwise, candidate.name || candidate.id);
    if (match) return { ...match, rawEvent: sound?.event || '', confidence: 'candidate' };
  }
  return null;
}

function compactWemInfo(wwise, wemId) {
  const id = String(wemId || '').trim();
  const wemInfo = wwise.wems?.[id] || {};
  return {
    id,
    name: wemInfo.name || `${id}.wem`,
    bank: wemInfo.bank || '',
    streamed: wemInfo.streamed === true,
    localFile: repoRelativePath(wemInfo.file || ''),
  };
}

function addWem(wemMap, wwise, wemId, source) {
  const id = String(wemId || '').trim();
  if (!id) return;
  if (!wemMap.has(id)) wemMap.set(id, { ...compactWemInfo(wwise, id), eventNames: [], sources: [] });
  const wem = wemMap.get(id);
  if (source.eventName && !wem.eventNames.includes(source.eventName)) wem.eventNames.push(source.eventName);
  if (!wem.sources.some((item) => item.taniPath === source.taniPath && item.eventName === source.eventName)) wem.sources.push(source);
}

function taniCandidatesForTerms(catalog, animIndex, terms) {
  return mergeTaniCandidates(
    findTaniCandidates(catalog, terms, MAX_TANI_RESULTS_PER_ABILITY),
    findAnimTaniCandidates(animIndex, terms, MAX_TANI_RESULTS_PER_ABILITY),
  ).slice(0, MAX_TANI_RESULTS_PER_ABILITY);
}

function resolveTaniCandidates(taniCandidates, animIndex, wwise) {
  const wemMap = new Map();
  const eventMap = new Map();
  const taniResults = [];

  for (const candidate of taniCandidates) {
    const localPath = localTaniPath(candidate.path);
    const anim = animIndex.byDataKey.get(candidate.dataKey) || null;
    const events = [];
    const unresolvedEvents = [];
    for (const sound of anim?.sounds || []) {
      const resolved = resolveSoundEvent(wwise, sound);
      if (!resolved) {
        if (sound?.event) unresolvedEvents.push({ rawEvent: sound.event, system: sound.system || '', bank: sound.bank || '' });
        continue;
      }
      const eventName = resolved.name;
      const wems = [...(resolved.event?.wems?.streamed || []), ...(resolved.event?.wems?.inMemory || [])].map((value) => String(value));
      const eventRow = {
        rawEvent: resolved.rawEvent || '',
        name: eventName,
        id: resolved.event?.id ?? null,
        taniHash: resolved.event?.taniHash ?? null,
        system: sound.system || '',
        bank: sound.bank || '',
        confidence: resolved.confidence,
        wems,
      };
      events.push(eventRow);
      if (!eventMap.has(eventName)) eventMap.set(eventName, { ...eventRow, taniPaths: [] });
      const eventSummary = eventMap.get(eventName);
      if (!eventSummary.taniPaths.includes(candidate.path)) eventSummary.taniPaths.push(candidate.path);
      for (const wemId of wems) addWem(wemMap, wwise, wemId, { taniPath: candidate.path, eventName, rawEvent: resolved.rawEvent || '' });
    }

    taniResults.push({
      path: candidate.path,
      name: candidate.name,
      score: candidate.score,
      reason: candidate.reason,
      extracted: existsSync(localPath),
      localPath: existsSync(localPath) ? repoRelativePath(localPath) : '',
      indexFile: anim?.file || '',
      refAni: anim?.refAni || '',
      pss: (anim?.pss || []).slice(0, 8),
      events: events.slice(0, MAX_EVENTS_PER_TANI),
      unresolvedEvents: unresolvedEvents.slice(0, MAX_EVENTS_PER_TANI),
    });
  }

  const wems = [...wemMap.values()].slice(0, MAX_WEMS_PER_ABILITY);
  const events = [...eventMap.values()].slice(0, MAX_EVENTS_PER_TANI * MAX_TANI_RESULTS_PER_ABILITY);
  return { taniResults, events, wems };
}

function buildAbilityTaniEntry(ability, catalog, animIndex, wwise) {
  const name = abilityDisplayName(ability);
  let terms = baseAbilityTerms(ability);
  let taniCandidates = taniCandidatesForTerms(catalog, animIndex, terms);
  let resolved = resolveTaniCandidates(taniCandidates, animIndex, wwise);
  if (!resolved.wems.length && ability.expandRelated === true) {
    const expandedTerms = expandedAbilityTerms(ability, terms);
    if (expandedTerms.length > terms.length) {
      const expandedCandidates = taniCandidatesForTerms(catalog, animIndex, expandedTerms);
      const expandedResolved = resolveTaniCandidates(expandedCandidates, animIndex, wwise);
      if (expandedResolved.wems.length || expandedCandidates.length > taniCandidates.length) {
        terms = expandedTerms;
        taniCandidates = expandedCandidates;
        resolved = expandedResolved;
      }
    }
  }
  const term = terms[0] || abilityTerm(ability);
  const { taniResults, events, wems } = resolved;
  return {
    id: String(ability.id || ''),
    prefix: ability.prefix || '',
    kind: ability.kind || 'skill',
    name,
    ...(ability.zcAbility ? { zcAbility: ability.zcAbility } : {}),
    term,
    terms,
    found: wems.length > 0,
    status: wems.length > 0 ? 'sound-yes' : 'sound-no',
    counts: {
      tani: taniResults.length,
      extractedTani: taniResults.filter((item) => item.extracted).length,
      indexedTani: taniResults.filter((item) => item.indexFile).length,
      events: events.length,
      wems: wems.length,
    },
    taniResults,
    events,
    wems,
  };
}

function flattenPrefixCache(prefixCache) {
  if (Array.isArray(prefixCache?.results)) return prefixCache.results;
  return PREFIXED_ABILITY_GROUPS.flatMap((group) => prefixCache?.groups?.[group] || []);
}

function zcKeyForEntry(entry) {
  return normalizeName(stripAbilityDecorations(abilityDisplayName(entry)));
}

function zcFallbackAbilities(abilities) {
  const zcByKey = new Map(loadZcAbilities().map((ability) => [ability.key, ability]));
  const matchedKeys = new Set(abilities.map(zcKeyForEntry).filter((key) => zcByKey.has(key)));
  return loadZcAbilities()
    .filter((ability) => !matchedKeys.has(ability.key))
    .map((ability) => ({
      id: ability.slug,
      prefix: 'ZC',
      kind: 'unmatched',
      name: ability.name,
      zcAbility: ability,
      expandRelated: true,
      relatedAbilityResults: zcRelatedAbilityResults(ability),
    }));
}

function zcRelatedAbilityResults(ability) {
  const queries = new Set([ability.name, stripAbilityDecorations(ability.name), ability.slug]);
  for (const part of String(ability.name || '').split(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A/\\]+/u)) {
    if (part) queries.add(part);
  }
  const resultsByKey = new Map();
  for (const query of queries) {
    for (const result of relatedAbilitySearch(query)) {
      const key = `${result.kind || 'skill'}:${result.id || result.skill?.SkillID || result.matchAlias?.ID || abilityDisplayName(result)}`;
      if (!resultsByKey.has(key)) resultsByKey.set(key, result);
    }
  }
  return [...resultsByKey.values()];
}

function buildStats(entries) {
  const make = () => ({ total: 0, yes: 0, no: 0, tani: 0, indexedTani: 0, wems: 0 });
  const groups = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, make()]));
  const total = make();
  for (const entry of entries) {
    const statsList = [total, groups[entry.prefix] || total];
    for (const stats of statsList) {
      stats.total += 1;
      if (entry.found) stats.yes += 1;
      else stats.no += 1;
      stats.tani += entry.counts.tani;
      stats.indexedTani += entry.counts.indexedTani;
      stats.wems += entry.counts.wems;
    }
  }
  return { total, groups };
}

function sourceStamp(prefixCache) {
  const catalogPath = findTaniCatalogPath();
  return [
    `schema:${CACHE_SCHEMA_VERSION}`,
    `prefix:${prefixCache?.sourceStamp || ''}`,
    `zcList:${getFileStamp(PUBLIC_TANI_SOUND_JS_PATH)}`,
    `taniCatalog:${repoRelativePath(catalogPath)}:${getFileStamp(catalogPath)}`,
    `animSound:${getFileStamp(ANIM_SOUND_INDEX_PATH)}`,
    `wwise:${getFileStamp(WWISE_INDEX_PATH)}`,
  ].join('|');
}

function cacheIsCurrent(cache, expectedSourceStamp = '') {
  if (!cache?.ok || cache.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  return !expectedSourceStamp || cache.sourceStamp === expectedSourceStamp;
}

export async function buildAbilityTaniSoundCache(options = {}) {
  options.onProgress?.({ phase: 'prefix-cache' });
  const prefixCache = options.prefixCache || buildAbilityPrefixCache({ force: options.forcePrefix ? '1' : '' });
  const abilities = flattenPrefixCache(prefixCache);
  options.onProgress?.({ phase: 'tani-catalog' });
  const catalog = loadTaniCatalog();
  const missing = [];
  for (const ability of abilities) {
    for (const candidate of findTaniCandidates(catalog, abilityTerms(ability), MAX_TANI_RESULTS_PER_ABILITY)) {
      if (!existsSync(localTaniPath(candidate.path))) missing.push(candidate.path);
    }
  }
  let taniExtraction = { requested: missing.length, attempted: 0, extracted: 0 };
  if (options.extractTani === true && missing.length) {
    options.onProgress?.({ phase: 'extract-tani', candidates: missing.length });
    taniExtraction = extractTaniPaths(missing, options.maxTaniExtract || MAX_EXTRACT_TOTAL);
    if (taniExtraction.extracted > 0) {
      options.onProgress?.({ phase: 'rebuild-anim-sound-index', extracted: taniExtraction.extracted });
      taniExtraction.rebuiltAnimSoundIndex = rebuildAnimSoundIndex();
    }
  }
  options.onProgress?.({ phase: 'load-indexes' });
  const animIndex = loadAnimSoundIndex();
  const wwise = loadWwiseIndex();
  options.onProgress?.({ phase: 'resolve', abilities: abilities.length });
  const entries = abilities.map((ability) => buildAbilityTaniEntry(ability, catalog, animIndex, wwise));
  const zcFallbacks = zcFallbackAbilities(abilities).map((ability) => buildAbilityTaniEntry(ability, catalog, animIndex, wwise));
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  const byKey = Object.fromEntries(entries.map((entry) => [`${entry.prefix}:${entry.id}`, entry]));
  const payload = {
    ok: true,
    schemaVersion: CACHE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceStamp: sourceStamp(prefixCache),
    cachePath: relative(REPO_ROOT, TANI_SOUND_CACHE_PATH).replace(/\\/g, '/'),
    prefixCachePath: prefixCache.cachePath || '',
    dataRoots: {
      taniCatalog: repoRelativePath(catalog.path || ''),
      taniExtractRoot: relative(REPO_ROOT, TANI_EXTRACT_ROOT).replace(/\\/g, '/'),
      animSoundIndex: relative(REPO_ROOT, ANIM_SOUND_INDEX_PATH).replace(/\\/g, '/'),
      wwiseIndex: relative(REPO_ROOT, WWISE_INDEX_PATH).replace(/\\/g, '/'),
    },
    taniExtraction,
    wwiseStats: wwise.stats,
    total: entries.length,
    stats: buildStats(entries),
    results: entries,
    zcFallbacks,
    byId,
    byKey,
  };
  ensureDir(ABILITY_MATCHER_ROOT);
  writeFileSync(TANI_SOUND_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function readAbilityTaniSoundCache() {
  return readJsonFile(TANI_SOUND_CACHE_PATH, null);
}

function emptyReviewPayload() {
  return {
    ok: true,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: null,
    updatedAt: null,
    reviewPath: relative(REPO_ROOT, TANI_SOUND_REVIEW_PATH).replace(/\\/g, '/'),
    entries: {},
  };
}

function normalizeReviewStatus(value) {
  const text = String(value || '').trim();
  return REVIEW_STATUSES.has(text) ? text : '未确认';
}

function reviewAbilityMeta(update = {}) {
  const ability = update.ability || update.entry || update;
  const prefix = String(ability.prefix || update.prefix || '').trim();
  const id = String(ability.id || ability.abilityId || update.id || update.abilityId || '').trim();
  const kind = String(ability.kind || update.kind || 'skill').trim() || 'skill';
  const name = String(ability.name || ability.abilityName || update.name || update.abilityName || '').trim();
  const abilityKey = String(update.abilityKey || ability.abilityKey || `${prefix}:${id}:${kind}`).trim();
  return { abilityKey, abilityId: id, prefix, kind, abilityName: name };
}

function normalizeConfirmedWems(wems = [], abilityMeta, existingById = new Map()) {
  const seen = new Set();
  const normalized = [];
  for (const wem of Array.isArray(wems) ? wems : []) {
    const id = String(typeof wem === 'object' ? wem.id : wem).trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const existing = existingById.get(id) || {};
    normalized.push({
      id,
      source: wem?.source === 'manual' ? 'manual' : 'candidate',
      abilityKey: abilityMeta.abilityKey,
      abilityId: abilityMeta.abilityId,
      prefix: abilityMeta.prefix,
      kind: abilityMeta.kind,
      abilityName: abilityMeta.abilityName,
      addedAt: wem?.addedAt || existing.addedAt || new Date().toISOString(),
    });
  }
  return normalized;
}

function writeAbilityTaniSoundReview(payload) {
  ensureDir(ABILITY_MATCHER_ROOT);
  writeFileSync(TANI_SOUND_REVIEW_PATH, JSON.stringify(payload, null, 2), 'utf8');
  jsonCache.set(TANI_SOUND_REVIEW_PATH, { stamp: getFileStamp(TANI_SOUND_REVIEW_PATH), value: payload });
}

export function getAbilityTaniSoundReview() {
  const payload = readJsonFile(TANI_SOUND_REVIEW_PATH, null);
  if (!payload || payload.schemaVersion !== REVIEW_SCHEMA_VERSION || typeof payload.entries !== 'object') {
    return emptyReviewPayload();
  }
  return {
    ...emptyReviewPayload(),
    ...payload,
    ok: true,
    reviewPath: relative(REPO_ROOT, TANI_SOUND_REVIEW_PATH).replace(/\\/g, '/'),
    entries: payload.entries || {},
  };
}

export function updateAbilityTaniSoundReview(update = {}) {
  const abilityMeta = reviewAbilityMeta(update);
  if (!abilityMeta.abilityId) throw new Error('ability id required');
  const review = getAbilityTaniSoundReview();
  const existing = review.entries[abilityMeta.abilityKey] || {};
  const existingById = new Map((existing.confirmedWems || []).map((wem) => [String(wem.id), wem]));
  const confirmedWems = Array.isArray(update.confirmedWems)
    ? normalizeConfirmedWems(update.confirmedWems, abilityMeta, existingById)
    : normalizeConfirmedWems(existing.confirmedWems || [], abilityMeta, existingById);
  let status = update.status == null ? normalizeReviewStatus(existing.status) : normalizeReviewStatus(update.status);
  if (confirmedWems.length && (update.status == null || status === '未确认')) status = '已确认';
  const entries = { ...(review.entries || {}) };
  if (status === '未确认' && confirmedWems.length === 0) {
    delete entries[abilityMeta.abilityKey];
  } else {
    entries[abilityMeta.abilityKey] = {
      ...abilityMeta,
      status,
      confirmedWems,
      updatedAt: new Date().toISOString(),
    };
  }
  const next = {
    ...review,
    ok: true,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: review.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries,
  };
  writeAbilityTaniSoundReview(next);
  return next;
}

export async function getAbilityTaniSoundCache(options = {}) {
  const prefixCache = buildAbilityPrefixCache({ force: options.forcePrefix ? '1' : '' });
  const expectedSourceStamp = sourceStamp(prefixCache);
  const cache = readAbilityTaniSoundCache();
  if (!options.force && cacheIsCurrent(cache, expectedSourceStamp)) return cache;
  if (options.force || options.buildIfMissing || !cacheIsCurrent(cache)) {
    return buildAbilityTaniSoundCache({ ...options, prefixCache });
  }
  return { ok: false, error: `Ability TANI sound cache missing: ${relative(REPO_ROOT, TANI_SOUND_CACHE_PATH).replace(/\\/g, '/')}` };
}

export function getAbilityTaniSoundEntry(cache, abilityId, prefix = '') {
  const id = String(abilityId || '').trim();
  if (!cacheIsCurrent(cache) || !id) return null;
  if (prefix && cache.byKey?.[`${prefix}:${id}`]) return cache.byKey[`${prefix}:${id}`];
  return cache.byId?.[id] || null;
}

export { TANI_SOUND_CACHE_PATH, TANI_SOUND_REVIEW_PATH };