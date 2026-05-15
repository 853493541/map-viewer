import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { buildAbilityPrefixCache } from './ability-matcher.js';
import { resolveFmodToWwise } from './fmod-to-wwise.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '..');
const ABILITY_MATCHER_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'ability-matcher');
const SKILL_TABLE_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'logic-skill-prefixed-out', 'settings', 'skill');
const REPRESENT_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'skill-tables-out', 'Represent');
const PLAYER_ANIMATION_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'player-animation-out', 'Represent', 'player');
const SOUND_CACHE_PATH = join(ABILITY_MATCHER_ROOT, 'ability-sound-cache.json');
const WWISE_INDEX_PATH = join(REPO_ROOT, 'log', 'wwise-soundbank-index.json');
const ANIM_SOUND_INDEX_PATH = join(REPO_ROOT, 'log', 'anim-sound-index.json');
const AUDIO_CACHE_DIR = join(TOOL_DIR, 'audio-cache');
const TANI_EXTRACT_ROOT = join(REPO_ROOT, 'cache-extraction', 'tani-extract');
const TANI_PATHLIST_ROOT = join(ABILITY_MATCHER_ROOT, 'tani-pathlists');
const PAKV4_EXTRACT_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/bin64/PakV4SfxExtract.exe');
const TANI_CATALOG_PATHS = [
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/MovieEditor/ResourcePack/Tani.rt'),
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/editortool/movieeditor/resourcepack/tani.rt'),
  resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4_probe/seasun/editortool/movieeditor/resourcepack/tani.rt'),
];
const CACHE_SCHEMA_VERSION = 8;
const PREFIXED_ABILITY_GROUPS = ['\u7EDD\u5883', '\u4F2A\u4F20'];
const PLAYER_ANIMATION_BODIES = ['f1', 'f2', 'm1', 'm2', 'm3', 'f3'];
const AUDIO_EXTENSIONS = new Set(['.wem', '.bnk', '.wav', '.ogg', '.mp3']);
const EFFECT_EXTENSIONS = new Set(['.pss', '.sfx']);
const BROWSER_AUDIO_EXTENSIONS = new Set(['.ogg', '.wav', '.mp3']);
const MAX_FUZZY_EVENTS_PER_SOUND = 0;
const MAX_PLAYABLE_PER_ABILITY = 24;
const MAX_EVENTS_PER_ABILITY = 48;
const MAX_TRIGGER_EVENTS_PER_ABILITY = 16;
const MAX_WEMS_PER_ABILITY = 96;
const MAX_TRIGGER_WEMS_PER_ABILITY = 32;
const MAX_BANKS_PER_EVENT = 8;
const MAX_WEM_IDS_PER_EVENT = 32;
const MAX_TRACKED_EVENTS_PER_ABILITY = 128;
const MAX_TRACKED_WEMS_PER_ABILITY = 256;
const MAX_UNRESOLVED_EVENTS_PER_ABILITY = 48;
const MAX_EFFECT_REFS_PER_ABILITY = 96;
const MAX_DIRECT_AUDIO_REFS_PER_ABILITY = 48;
const MAX_TANI_CANDIDATES_PER_ABILITY = 16;
const MAX_CAST_ACTION_REFS_PER_ABILITY = 32;
const MAX_CORE_ACTION_SKILLS = 4;
const MAX_PROPERTY_REFS_PER_ABILITY = 96;
const MAX_TANI_EXTRACT_TOTAL = 800;
const TABLE_CACHE = new Map();
let CORE_SKILL_INDEX_CACHE = null;
let ACTION_ANIMATION_MAP_CACHE = null;
let PLAYER_ANIMATION_BY_ID_CACHE = null;

function ensureDir(directoryPath) {
  if (!existsSync(directoryPath)) mkdirSync(directoryPath, { recursive: true });
}

function getFileStamp(filePath) {
  if (!existsSync(filePath)) return 'missing';
  const stats = statSync(filePath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readGb18030File(filePath) {
  return iconv.decode(readFileSync(filePath), 'gb18030').replace(/^\uFEFF/, '');
}

function readTableFile(filePath) {
  const stamp = `${filePath}:${getFileStamp(filePath)}`;
  const cached = TABLE_CACHE.get(filePath);
  if (cached?.stamp === stamp) return cached.value;
  if (!existsSync(filePath)) {
    const empty = { headers: [], rows: [] };
    TABLE_CACHE.set(filePath, { stamp, value: empty });
    return empty;
  }
  const lines = readGb18030File(filePath).split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headers = (lines[0] || '').split('\t').map((header, index) => header || `col${index}`);
  const rows = lines.slice(1).map((line, index) => {
    const cells = line.split('\t');
    const row = { __lineNo: index + 2, __rawLine: line, __cells: cells };
    headers.forEach((header, cellIndex) => {
      row[header] = cells[cellIndex] ?? '';
    });
    return row;
  });
  const value = { headers, rows };
  TABLE_CACHE.set(filePath, { stamp, value });
  return value;
}

function skillRows() {
  return readTableFile(join(SKILL_TABLE_ROOT, 'skills.tab')).rows;
}

function representRows(relPath) {
  return readTableFile(join(REPRESENT_ROOT, relPath)).rows;
}

function playerAnimationRows(body) {
  return readTableFile(join(PLAYER_ANIMATION_ROOT, `player_animation_${body}.txt`)).rows;
}

function normalizeSlashes(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function localTaniPath(logicalPath) {
  return join(TANI_EXTRACT_ROOT, normalizeSlashes(logicalPath).replace(/\//g, '\\'));
}

function slugForPath(value) {
  return normalizeSlashes(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'path';
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A,\uFF0C\u3001'"\u201C\u201D\u2018\u2019()\uFF08\uFF09\[\]\u3010\u3011<>\u300A\u300B/\\]/g, '');
}

function isHanText(value) {
  return /[\u4e00-\u9fff]/u.test(String(value || ''));
}

function aliasCoreName(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:\u4F2A\u4F20|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]+(.+)$/u);
  return match ? match[1] : text;
}

function stripLeadingId(value) {
  return String(value || '').replace(/^\s*\d+\s*/, '');
}

function stripAbilityDecorations(value) {
  return stripLeadingId(value)
    .replace(/^(?:\u4F2A\u4F20|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]+/u, '')
    .replace(/^(?:\u9053\u5177|\u7EDD\u5883)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]*/u, '')
    .trim();
}

function coreNameTerms(value, options = {}) {
  const text = stripLeadingId(value).trim();
  if (!text) return [];
  const candidates = [
    text,
    aliasCoreName(text),
    stripAbilityDecorations(text),
    text.split(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A/\\]+/u).pop(),
  ];
  const terms = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const label = stripAbilityDecorations(candidate || '').trim();
    const normalized = normalizeName(label);
    const allowSingle = options.allowSingleHan === true && isHanText(label);
    if ((!allowSingle && normalized.length < 2) || (allowSingle && normalized.length < 1) || /^\d+$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push({ label, normalized });
  }
  return terms;
}

function buildAbilityCoreTerms(ability) {
  const rawTerms = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    rawTerms.push(node.matchAlias?.Name, node.skill?.SkillName, node.resolvedSkillName);
  };
  collect(ability);
  const terms = [];
  const seen = new Set();
  for (const rawValue of rawTerms) {
    for (const term of coreNameTerms(rawValue, { allowSingleHan: true })) {
      if (seen.has(term.normalized)) continue;
      seen.add(term.normalized);
      terms.push(term);
    }
  }
  return terms;
}

function dataSourceKey(value) {
  const normalized = normalizeSlashes(value).toLowerCase();
  const marker = normalized.indexOf('data/source/');
  return marker >= 0 ? normalized.slice(marker) : normalized;
}

function displayAbilityName(ability) {
  return ability?.matchAlias?.Name || ability?.skill?.SkillName || ability?.resolvedSkillName || ability?.id || '';
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

function sourceKey(source) {
  return `${source.kind || ''}:${source.path || ''}:${source.name || ''}:${source.id || ''}`;
}

function pushUnique(list, value, keyGetter, limit = 20) {
  const key = keyGetter(value);
  if (!key) return;
  if (list.some((item) => keyGetter(item) === key)) return;
  if (list.length < limit) list.push(value);
}

function loadAnimSoundIndex() {
  return readJsonFile(ANIM_SOUND_INDEX_PATH, { items: [] })?.items || [];
}

function taniCatalogStamp() {
  return TANI_CATALOG_PATHS.map((filePath) => `${repoRelativePath(filePath)}:${getFileStamp(filePath)}`).join(';');
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
    if (!logicalPath || seen.has(logicalPath.toLowerCase())) continue;
    seen.add(logicalPath.toLowerCase());
    items.push({
      path: logicalPath,
      name: basename(logicalPath),
      normalizedText: normalizeName(logicalPath),
    });
  }
  return { path: catalogPath, items };
}

function taniCandidateScore(state, item) {
  let score = 0;
  let reason = '';
  const textNorm = item.normalizedText || normalizeName(item.path);
  for (const term of state.matchTerms || []) {
    if (!term.normalized || term.normalized.length < 2) continue;
    if (textNorm.includes(term.normalized)) {
      const candidateScore = 600 + term.normalized.length;
      if (candidateScore > score) {
        score = candidateScore;
        reason = `Tani.rt term ${term.label}`;
      }
    }
  }
  return { score, reason };
}

function attachTaniCatalogCandidates(states, catalog) {
  if (!catalog?.items?.length) return [];
  const extractPaths = new Set();
  for (const state of states) {
    const matches = [];
    for (const item of catalog.items) {
      const scored = taniCandidateScore(state, item);
      if (!scored.score) continue;
      matches.push({ ...item, score: scored.score, reason: scored.reason });
    }
    matches.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.path.localeCompare(right.path, 'zh-Hans-CN');
    });
    for (const match of matches.slice(0, MAX_TANI_CANDIDATES_PER_ABILITY)) {
      const localPath = localTaniPath(match.path);
      const candidate = {
        path: match.path,
        name: match.name,
        reason: match.reason,
        score: match.score,
        extracted: existsSync(localPath),
        localPath: existsSync(localPath) ? repoRelativePath(localPath) : '',
      };
      pushUnique(state.taniCatalogRefs, candidate, (item) => item.path, MAX_TANI_CANDIDATES_PER_ABILITY);
      if (!candidate.extracted) extractPaths.add(match.path);
    }
  }
  return [...extractPaths];
}

function refreshTaniCatalogExtractionFlags(states) {
  for (const state of states) {
    for (const candidate of state.taniCatalogRefs || []) {
      const localPath = localTaniPath(candidate.path);
      candidate.extracted = existsSync(localPath);
      candidate.localPath = candidate.extracted ? repoRelativePath(localPath) : '';
    }
  }
}

function extractTaniPaths(logicalPaths, maxCount = MAX_TANI_EXTRACT_TOTAL) {
  const pending = [...new Set((logicalPaths || []).map(normalizeSlashes))]
    .filter((value) => value && !value.split('/').includes('..'))
    .filter((value) => !existsSync(localTaniPath(value)))
    .slice(0, maxCount);
  const requested = (logicalPaths || []).length;
  if (!pending.length || !existsSync(PAKV4_EXTRACT_EXE)) return { requested, attempted: 0, extracted: 0 };
  ensureDir(TANI_EXTRACT_ROOT);
  ensureDir(TANI_PATHLIST_ROOT);
  const pathlist = join(TANI_PATHLIST_ROOT, `_tani_${Date.now()}_${slugForPath(pending[0])}.txt`);
  writeFileSync(pathlist, iconv.encode(pending.map((value) => value.split('/').join('\\')).join('\r\n') + '\r\n', 'gb18030'));
  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlist, TANI_EXTRACT_ROOT], {
      cwd: dirname(PAKV4_EXTRACT_EXE),
      timeout: Math.max(30000, pending.length * 1200),
      windowsHide: true,
    });
  } catch {
    // The extractor returns partial results even when some requested paths miss.
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
    return true;
  } catch {
    return false;
  }
}

function eventHasWems(event) {
  return Boolean((event?.wems?.streamed || []).length || (event?.wems?.inMemory || []).length);
}

function loadWwiseIndex() {
  const index = readJsonFile(WWISE_INDEX_PATH, {});
  const events = index.events || {};
  const byHash = index.byHash || {};
  const eventsByLowerName = new Map();
  const eventsById = new Map();
  const playableIds = new Set();

  for (const [eventName, event] of Object.entries(events)) {
    eventsByLowerName.set(eventName.toLowerCase(), { name: eventName, event });
    if (Number.isFinite(Number(event.id))) eventsById.set(String(event.id), { name: eventName, event });
    if (Number.isFinite(Number(event.taniHash))) eventsById.set(String(event.taniHash), { name: eventName, event });
    if (eventHasWems(event)) {
      if (Number.isFinite(Number(event.id))) playableIds.add(Number(event.id));
      if (Number.isFinite(Number(event.taniHash))) playableIds.add(Number(event.taniHash));
    }
  }

  for (const [eventId, eventName] of Object.entries(byHash)) {
    if (events[eventName]) {
      eventsById.set(String(eventId), { name: eventName, event: events[eventName] });
      if (eventHasWems(events[eventName])) playableIds.add(Number(eventId));
    }
  }

  return {
    index,
    events,
    byHash,
    eventsByLowerName,
    eventsById,
    playableIds,
    wems: index.wems || {},
    banks: index.banks || {},
    stats: index.stats || {},
  };
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

function soundEventLookupValues(sound) {
  const eventName = String(sound?.event || '').trim();
  if (!eventName) return [];
  const values = [eventName];
  const bankName = String(sound?.bank || '').trim();
  if (bankName && !normalizeName(eventName).startsWith(normalizeName(bankName))) {
    values.push(`${bankName}/${eventName}`);
    values.push(`${bankName}_${eventName}`);
  }
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addSoundEvent(state, wwise, sound, source, options = {}) {
  const lookupValues = soundEventLookupValues(sound);
  for (const value of lookupValues) {
    if (lookupWwiseEvent(wwise, value)) {
      return addEvent(state, wwise, value, { ...source, bank: sound.bank || '', rawEvent: sound.event || '' }, options);
    }
  }
  const eventKeys = eventLookupKeys(sound?.event || '').filter((key) => !key.startsWith('play_'));
  for (const candidate of sound?.wwise || []) {
    const candidateName = String(candidate.name || candidate.id || '').trim();
    const candidateKey = candidateName.toLowerCase();
    if (!candidateKey || !eventKeys.some((key) => candidateKey === key || candidateKey.endsWith(`_${key}`))) continue;
    if (lookupWwiseEvent(wwise, candidateName)) {
      return addEvent(state, wwise, candidateName, { ...source, bank: sound.bank || '', rawEvent: sound.event || '', name: sound.event || candidateName }, options);
    }
  }
  if (lookupValues.length) addUnresolvedEvent(state, lookupValues[0], source);
  return false;
}

function bankPathForWem(wwise, wemInfo) {
  const bankName = String(wemInfo?.bank || '').trim();
  if (!bankName) return '';
  const bank = wwise.banks?.[bankName];
  const rawPath = bank?.bnk || '';
  if (!rawPath) return '';
  if (isAbsolute(rawPath)) return rawPath;
  const root = bank?.root || wwise.index?.root || '';
  return root ? join(root, rawPath) : rawPath;
}

function localWemFiles(wwise, wemId) {
  const id = String(wemId || '').trim();
  const wemInfo = wwise.wems?.[id] || {};
  const files = [];
  const cachedOgg = join(AUDIO_CACHE_DIR, `${id}.ogg`);
  if (existsSync(cachedOgg)) {
    files.push({ kind: 'decoded-ogg', path: repoRelativePath(cachedOgg), exists: true });
  }
  if (wemInfo.file) {
    files.push({ kind: 'streamed-wem', path: repoRelativePath(wemInfo.file), exists: existsSync(wemInfo.file) });
  }
  const bankPath = bankPathForWem(wwise, wemInfo);
  if (bankPath) {
    files.push({ kind: 'bank', bank: wemInfo.bank || '', path: repoRelativePath(bankPath), exists: existsSync(bankPath) });
  }
  return files;
}

function hasLocalWemSource(wwise, wemId) {
  return localWemFiles(wwise, wemId).some((file) => file.exists);
}

function addUnresolvedEvent(state, rawEvent, source) {
  const eventName = String(rawEvent || '').trim();
  if (!eventName) return;
  const key = eventName.toLowerCase();
  if (!state.unresolvedEventMap.has(key)) {
    state.unresolvedEventMap.set(key, { name: eventName, sources: [] });
  }
  pushUnique(state.unresolvedEventMap.get(key).sources, source, sourceKey, 12);
}

function addWem(state, wwise, wemId, source) {
  const id = String(wemId || '').trim();
  if (!id) return;
  if (!state.wemMap.has(id) && state.wemMap.size >= MAX_TRACKED_WEMS_PER_ABILITY) return;
  if (!state.wemMap.has(id)) {
    const wemInfo = wwise.wems?.[id] || {};
    state.wemMap.set(id, {
      id,
      name: wemInfo.name || `${id}.wem`,
      bank: wemInfo.bank || '',
      streamed: wemInfo.streamed === true,
      file: repoRelativePath(wemInfo.file || ''),
      localFiles: [],
      eventNames: [],
      sources: [],
      playable: [],
    });
  }
  const wem = state.wemMap.get(id);
  if (source.eventName) pushUnique(wem.eventNames, source.eventName, (value) => value, 40);
  pushUnique(wem.sources, source, sourceKey, 20);
}

function addEvent(state, wwise, rawEvent, source, options = {}) {
  const resolved = lookupWwiseEvent(wwise, rawEvent);
  if (!resolved) {
    addUnresolvedEvent(state, rawEvent, source);
    return false;
  }
  const eventName = resolved.name;
  if (!state.eventMap.has(eventName) && state.eventMap.size >= MAX_TRACKED_EVENTS_PER_ABILITY) return true;
  if (!state.eventMap.has(eventName)) {
    state.eventMap.set(eventName, {
      name: eventName,
      id: resolved.event.id ?? null,
      banks: resolved.event.banks || [],
      wems: {
        streamed: resolved.event.wems?.streamed || [],
        inMemory: resolved.event.wems?.inMemory || [],
      },
      sources: [],
      confidence: options.confidence || 'exact',
    });
  }
  const event = state.eventMap.get(eventName);
  if (options.confidence === 'candidate' && event.confidence !== 'exact') event.confidence = 'candidate';
  pushUnique(event.sources, source, sourceKey, 24);
  for (const wemId of event.wems.streamed || []) addWem(state, wwise, wemId, { ...source, eventName, wemType: 'streamed' });
  for (const wemId of event.wems.inMemory || []) addWem(state, wwise, wemId, { ...source, eventName, wemType: 'inMemory' });
  return true;
}

function addPlaySfxRef(state, ref, ownerAbility) {
  const id = String(ref?.id || '').trim();
  if (!id) return;
  pushUnique(state.playSfxRefs, {
    id,
    name: ref?.skill?.SkillName || '',
    effectPlayType: ref?.skill?.EffectPlayType || '',
    scriptFile: ref?.skill?.ScriptFile || '',
    source: ref?.source || `trace ${ownerAbility?.id || state.id}`,
  }, (item) => `${item.id}:${item.source}`, 80);
}

function addTaniRef(state, source) {
  pushUnique(state.taniRefs, source, (item) => `${item.kind || ''}:${item.path || item.source || ''}`, 80);
}

function addSoundTag(state, hint, sound, context = '') {
  pushUnique(state.soundTags, {
    system: sound.system || '',
    bank: sound.bank || '',
    event: sound.event || '',
    soundIndex: Number.isFinite(sound.soundIndex) ? sound.soundIndex : null,
    triggerSound: sound.triggerSound === true,
    candidates: (sound.candidates || []).slice(0, 12),
    source: hint.file || '',
    reason: hint.reason || '',
    context,
  }, (item) => `${item.source}:${item.system}:${item.event}:${item.soundIndex ?? ''}:${item.context || ''}`, 100);
}

function addDirectAudioRef(state, recordOrFile, source) {
  const pathValue = normalizeSlashes(recordOrFile.path || recordOrFile.memberPath || '');
  if (!pathValue) return;
  const key = pathValue.toLowerCase();
  if (!state.directAudioMap.has(key)) {
    const extension = String(recordOrFile.extension || extname(pathValue)).toLowerCase();
    state.directAudioMap.set(key, {
      path: pathValue,
      name: recordOrFile.name || basename(pathValue),
      extension,
      localPath: normalizeSlashes(recordOrFile.localPath || ''),
      extracted: recordOrFile.extracted === true,
      sources: [],
      playable: [],
    });
  }
  const directAudio = state.directAudioMap.get(key);
  pushUnique(directAudio.sources, source, sourceKey, 16);
}

function addClientEffectRef(state, recordOrFile, source) {
  const pathValue = normalizeSlashes(recordOrFile.path || recordOrFile.memberPath || '');
  if (!pathValue) return;
  const key = pathValue.toLowerCase();
  if (!state.clientEffectMap.has(key)) {
    state.clientEffectMap.set(key, {
      path: pathValue,
      name: recordOrFile.name || basename(pathValue),
      extension: String(recordOrFile.extension || extname(pathValue)).toLowerCase(),
      localPath: normalizeSlashes(recordOrFile.localPath || ''),
      extracted: recordOrFile.extracted === true,
      sources: [],
    });
  }
  pushUnique(state.clientEffectMap.get(key).sources, source, sourceKey, 24);
}

function addPropertyEffectRef(state, recordOrFile, source) {
  const pathValue = normalizeSlashes(recordOrFile.path || recordOrFile.memberPath || '');
  if (!pathValue) return;
  const key = pathValue.toLowerCase();
  if (!state.propertyEffectMap.has(key)) {
    state.propertyEffectMap.set(key, {
      path: pathValue,
      name: recordOrFile.name || basename(pathValue),
      category: recordOrFile.category || '',
      extension: String(recordOrFile.extension || extname(pathValue)).toLowerCase(),
      localPath: normalizeSlashes(recordOrFile.localPath || ''),
      extracted: recordOrFile.extracted === true,
      sources: [],
    });
  }
  pushUnique(state.propertyEffectMap.get(key).sources, source, sourceKey, 24);
}

function addCastActionRef(state, ref) {
  pushUnique(state.castActionRefs, ref, (item) => `${item.coreSkillId || ''}:${item.animationId || ''}:${item.path || ''}:${item.body || ''}`, MAX_CAST_ACTION_REFS_PER_ABILITY);
}

function buildAbilityTerms(ability) {
  const rawTerms = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    rawTerms.push(node.matchAlias?.Name, node.skill?.SkillName, node.resolvedSkillName);
    for (const relatedSkill of node.relatedSkills || []) collect(relatedSkill);
    for (const child of node.children || []) collect(child);
  };
  collect(ability);
  const terms = [];
  const seen = new Set();
  for (const rawValue of rawTerms) {
    const text = String(rawValue || '').trim();
    if (!text) continue;
    for (const candidate of [text, aliasCoreName(text), stripAbilityDecorations(text), text.split(/[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A/\\]+/u).pop()]) {
      const label = stripAbilityDecorations(candidate || '');
      const normalized = normalizeName(label);
      if (normalized.length < 2 || /^\d+$/.test(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      terms.push({ label, normalized });
    }
  }
  return terms;
}

function createState(ability) {
  return {
    id: String(ability.id || ''),
    prefix: ability.prefix || '',
    kind: ability.kind || 'skill',
    name: displayAbilityName(ability),
    matchTerms: buildAbilityTerms(ability),
    coreTerms: buildAbilityCoreTerms(ability),
    eventMap: new Map(),
    wemMap: new Map(),
    unresolvedEventMap: new Map(),
    directAudioMap: new Map(),
    clientEffectMap: new Map(),
    propertyEffectMap: new Map(),
    castActionRefs: [],
    playSfxRefs: [],
    taniRefs: [],
    taniCatalogRefs: [],
    soundTags: [],
    notes: [],
  };
}

function walkTrace(ability, visitor, seen = new Set()) {
  if (!ability || typeof ability !== 'object') return;
  const key = `${ability.kind || 'skill'}:${ability.id || ''}:${ability.skill?.SkillID || ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  visitor(ability);
  for (const child of ability.children || []) walkTrace(child, visitor, seen);
  for (const relatedSkill of ability.relatedSkills || []) walkTrace(relatedSkill, visitor, seen);
}

function addFuzzyEventCandidates(state, wwise, hint, sound) {
  if (!sound.event || MAX_FUZZY_EVENTS_PER_SOUND <= 0) return;
  const candidates = resolveFmodToWwise(
    sound.event,
    wwise.byHash,
    sound.candidates || [],
    MAX_FUZZY_EVENTS_PER_SOUND,
    wwise.playableIds,
  );
  for (const candidate of candidates) {
    addEvent(state, wwise, candidate.name || candidate.id, {
      kind: 'tani-fuzzy-wwise',
      path: hint.file || '',
      name: candidate.name || '',
      id: String(candidate.id || ''),
    }, { confidence: 'candidate' });
  }
}

function addTriggerTerm(list, seen, term) {
  const label = String(term?.label || term || '').trim();
  const normalized = normalizeName(term?.normalized || label);
  if (!label || !normalized || seen.has(normalized)) return;
  if (normalized.length < 2 && !isHanText(label)) return;
  seen.add(normalized);
  list.push({ label, normalized });
}

function triggerRelevanceTerms(state, hint) {
  const terms = [];
  const seen = new Set();
  for (const term of state.matchTerms || []) addTriggerTerm(terms, seen, term);
  for (const term of state.coreTerms || []) addTriggerTerm(terms, seen, term);
  const castAction = hint?.castAction || {};
  addTriggerTerm(terms, seen, castAction.matchedTerm || '');
  for (const term of coreNameTerms(castAction.coreSkillName || '', { allowSingleHan: true })) addTriggerTerm(terms, seen, term);
  return terms;
}

function triggerRelevanceText(hint, sound) {
  return normalizeName([
    hint?.file || '',
    hint?.refAni || '',
    ...(hint?.pss || []),
    sound?.system || '',
    sound?.bank || '',
    sound?.event || '',
    ...(sound?.candidates || []),
    ...(sound?.wwise || []).map((candidate) => candidate.name || candidate.id || ''),
  ].join(' '));
}

function castActionTriggerMatch(state, hint, sound) {
  const textNorm = triggerRelevanceText(hint, sound);
  const terms = triggerRelevanceTerms(state, hint);
  const matched = terms.find((term) => term.normalized && textNorm.includes(term.normalized));
  if (matched) return { accepted: true, term: matched.label };
  return { accepted: false, term: '' };
}

function collectSoundHint(state, wwise, hint, options = {}) {
  const context = options.context || '';
  const includeCandidates = options.includeCandidates === true;
  const taniKind = context === 'cast-action' ? 'cast-action-tani' : 'anim-sound-index';
  const eventKind = context === 'cast-action' ? 'cast-action-tani-event' : 'tani-event';
  addTaniRef(state, { kind: taniKind, path: hint.file || '', name: hint.reason || '' });
  for (const [index, rawSound] of (hint.sounds || []).entries()) {
    const soundIndex = Number.isFinite(rawSound.soundIndex) ? rawSound.soundIndex : index;
    const triggerMatch = context === 'cast-action' && soundIndex === 0
      ? castActionTriggerMatch(state, hint, rawSound)
      : { accepted: false, term: '' };
    const triggerSound = triggerMatch.accepted === true;
    const sound = { ...rawSound, soundIndex, triggerSound };
    addSoundTag(state, hint, sound, context);
    let matchedExactEvent = false;
    if (sound.event) {
      matchedExactEvent = addSoundEvent(state, wwise, sound, {
        kind: eventKind,
        path: hint.file || '',
        name: sound.event || '',
        id: hint.castAction?.animationId || '',
        soundIndex,
        triggerSound,
          triggerMatchTerm: triggerMatch.term || '',
      });
      if (!matchedExactEvent && includeCandidates) addFuzzyEventCandidates(state, wwise, hint, sound);
    }
    if (matchedExactEvent || !includeCandidates) continue;
    for (const candidate of sound.candidates || []) {
      addEvent(state, wwise, candidate, { kind: 'tani-candidate', path: hint.file || '', name: candidate, soundIndex }, { confidence: 'candidate' });
    }
    for (const wwiseCandidate of sound.wwise || []) {
      addEvent(state, wwise, wwiseCandidate.name || wwiseCandidate.id, {
        kind: 'anim-sound-index-wwise',
        path: hint.file || '',
        name: wwiseCandidate.name || '',
        id: String(wwiseCandidate.id || ''),
        soundIndex,
      }, { confidence: 'candidate' });
    }
  }
}

function animSoundSearchText(item) {
  const soundText = (item.sounds || []).map((sound) => [
    sound.system || '',
    sound.bank || '',
    sound.event || '',
    ...(sound.candidates || []).slice(0, 24),
    ...(sound.wwise || []).slice(0, 24).map((candidate) => candidate.name || candidate.id || ''),
  ].join(' '));
  return [item.file || '', item.refAni || '', ...(item.pss || []), ...soundText].join(' ');
}

function prepareAnimSoundSearchIndex(animIndex) {
  if (!Array.isArray(animIndex)) return [];
  return animIndex
    .filter((item) => (item.sounds || []).length)
    .map((item) => ({
      ...item,
      searchNorm: normalizeName(animSoundSearchText(item)),
    }));
}

function compactAnimSoundHint(item, reason, score) {
  return {
    reason,
    score,
    source: 'anim-sound-index',
    file: normalizeSlashes(item.file || ''),
    refAni: normalizeSlashes(item.refAni || ''),
    faction: item.faction || '',
    pss: (item.pss || []).map(normalizeSlashes),
    sounds: (item.sounds || []).map((sound, soundIndex) => ({
      soundIndex,
      system: sound.system || '',
      bank: sound.bank || '',
      event: sound.event || '',
      candidates: (sound.candidates || []).slice(0, 12),
      wwise: (sound.wwise || []).slice(0, 8).map((candidate) => ({
        id: candidate.id || '',
        name: candidate.name || '',
        score: candidate.score || 0,
        playable: candidate.playable === true,
      })),
    })),
  };
}

function buildAnimSoundLookup(animIndex) {
  const byTani = new Map();
  for (const item of animIndex || []) {
    for (const value of [item.file, item.refAni].filter(Boolean)) {
      const key = dataSourceKey(value);
      if (key) byTani.set(key, item);
    }
  }
  return { byTani };
}

function compactSkillRow(row) {
  return {
    SkillID: row.SkillID || row.__cells?.[1] || row.__cells?.[0] || '',
    SkillName: row.SkillName || row.__cells?.[0] || '',
    KindType: row.KindType || '',
    FunctionType: row.FunctionType || '',
    CastMode: row.CastMode || '',
    EffectPlayType: row.EffectPlayType || '',
    ScriptFile: row.ScriptFile || '',
    BelongKungfu: row.BelongKungfu || '',
    BelongSchool: row.BelongSchool || '',
  };
}

function getCoreSkillIndex() {
  const stamp = getFileStamp(join(SKILL_TABLE_ROOT, 'skills.tab'));
  if (CORE_SKILL_INDEX_CACHE?.stamp === stamp) return CORE_SKILL_INDEX_CACHE.value;
  const index = new Map();
  for (const row of skillRows()) {
    const skillId = String(row.SkillID || '').trim();
    const skillName = String(row.SkillName || '').trim();
    if (!skillId || !skillName || /^(?:\u4F2A\u4F20|\u7EDD\u5883|\u9053\u5177)[\s_\uFF3F\-\u00B7\u30FB\uFF0E.\u3002:\uFF1A]/u.test(skillName)) continue;
    for (const term of coreNameTerms(skillName, { allowSingleHan: true })) {
      if (!index.has(term.normalized)) index.set(term.normalized, []);
      index.get(term.normalized).push({ row, term });
    }
  }
  CORE_SKILL_INDEX_CACHE = { stamp, value: index };
  return index;
}

function findCoreSkillCandidates(ability, state) {
  const terms = state.coreTerms || [];
  if (!terms.length) return [];
  const currentId = String(ability?.skill?.SkillID || ability?.id || '');
  const sourceSkill = ability?.skill || {};
  const matches = [];
  const seen = new Set();
  const coreIndex = getCoreSkillIndex();
  for (const term of terms) {
    for (const indexed of coreIndex.get(term.normalized) || []) {
      const row = indexed.row;
    const skillId = String(row.SkillID || '').trim();
    if (!skillId || skillId === currentId) continue;
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      let score = 1000 + term.normalized.length;
    for (const field of ['KindType', 'FunctionType', 'CastMode', 'EffectPlayType']) {
      if (sourceSkill[field] && row[field] && sourceSkill[field] === row[field]) score += 80;
    }
    const scriptFile = String(row.ScriptFile || '').toLowerCase();
    if (scriptFile && !scriptFile.startsWith('npc\\') && !scriptFile.startsWith('npc/')) score += 120;
    if (scriptFile && !scriptFile.startsWith('item\\') && !scriptFile.startsWith('item/')) score += 30;
    if (Number(skillId) > 0 && Number(skillId) < 10000) score += 50;
      matches.push({ score, matchedTerm: term, skill: compactSkillRow(row) });
    }
  }
  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return Number(left.skill.SkillID || 0) - Number(right.skill.SkillID || 0);
  });
  return matches.slice(0, MAX_CORE_ACTION_SKILLS);
}

function getActionAnimationMap() {
  const stamp = `${getFileStamp(join(REPRESENT_ROOT, 'skill', 'skill_dash.txt'))}:${getFileStamp(join(REPRESENT_ROOT, 'skill', 'skill_tag.txt'))}`;
  if (ACTION_ANIMATION_MAP_CACHE?.stamp === stamp) return ACTION_ANIMATION_MAP_CACHE.value;
  const map = new Map();
  const pushMapping = (skillId, row, table, animationId) => {
    const id = String(skillId || '').trim();
    const value = String(animationId || '').trim();
    if (!id || !/^\d+$/.test(value)) return;
    if (!map.has(id)) map.set(id, []);
    pushUnique(map.get(id), {
      table,
      animationId: value,
      lineNo: row.__lineNo || '',
      raw: row.__rawLine || '',
    }, (item) => `${item.table}:${item.animationId}`, 16);
  };
  for (const row of representRows('skill/skill_dash.txt')) pushMapping(row.SkillID || row.__cells?.[0], row, 'skill/skill_dash.txt', row.AnimationID || row.__cells?.[1]);
  for (const row of representRows('skill/skill_tag.txt')) pushMapping(row.SkillID || row.__cells?.[0], row, 'skill/skill_tag.txt', row.AnimationID || row.__cells?.[1]);
  ACTION_ANIMATION_MAP_CACHE = { stamp, value: map };
  return map;
}

function actionAnimationMappingsForSkill(skillId) {
  const id = String(skillId || '').trim();
  return id ? (getActionAnimationMap().get(id) || []) : [];
}

function getPlayerAnimationById() {
  const stamp = PLAYER_ANIMATION_BODIES.map((body) => getFileStamp(join(PLAYER_ANIMATION_ROOT, `player_animation_${body}.txt`))).join(':');
  if (PLAYER_ANIMATION_BY_ID_CACHE?.stamp === stamp) return PLAYER_ANIMATION_BY_ID_CACHE.value;
  const map = new Map();
  for (const body of PLAYER_ANIMATION_BODIES) {
    for (const row of playerAnimationRows(body)) {
      const id = String(row.AnimationID || row.__cells?.[0] || '').trim();
      const animationFile = normalizeSlashes(row.AnimationFile || row.__cells?.[6] || '');
      if (!id || !animationFile) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({
        body,
        animationId: id,
        kindId: row.KindID || row.__cells?.[1] || '',
        sheathType: row.SheathType || row.__cells?.[2] || '',
        isLoop: row.IsLoop || row.__cells?.[5] || '',
        path: animationFile,
        lineNo: row.__lineNo || '',
      });
    }
  }
  PLAYER_ANIMATION_BY_ID_CACHE = { stamp, value: map };
  return map;
}

function playerAnimationFilesForId(animationId) {
  const id = String(animationId || '').trim();
  return id ? (getPlayerAnimationById().get(id) || []) : [];
}

function collectCastActionSoundRefs(state, ability, wwise, animLookup) {
  const candidates = [];
  if (ability?.skill?.SkillID || ability?.id) {
    candidates.push({
      score: 900,
      matchedTerm: { label: displayAbilityName(ability), normalized: normalizeName(displayAbilityName(ability)) },
      skill: compactSkillRow({ ...(ability.skill || {}), SkillID: ability.skill?.SkillID || ability.id, SkillName: ability.skill?.SkillName || displayAbilityName(ability) }),
      source: 'matched skill',
    });
  }
  for (const candidate of findCoreSkillCandidates(ability, state)) candidates.push({ ...candidate, source: 'core skill match' });

  for (const candidate of candidates) {
    const skillId = candidate.skill?.SkillID || '';
    const skillName = candidate.skill?.SkillName || '';
    for (const mapping of actionAnimationMappingsForSkill(skillId)) {
      for (const action of playerAnimationFilesForId(mapping.animationId)) {
        const item = animLookup.byTani.get(dataSourceKey(action.path));
        const ref = {
          source: candidate.source || '',
          matchedTerm: candidate.matchedTerm?.label || '',
          coreSkillId: String(skillId),
          coreSkillName: skillName,
          table: mapping.table,
          animationId: mapping.animationId,
          body: action.body,
          path: action.path,
          kindId: action.kindId,
          sheathType: action.sheathType,
          isLoop: action.isLoop,
          score: candidate.score || 0,
          soundIndexed: Boolean(item),
        };
        addCastActionRef(state, ref);
        if (!item?.sounds?.length) continue;
        const reason = `${candidate.source || 'action'} ${skillId} ${skillName} -> ${mapping.table} AnimationID ${mapping.animationId}`.trim();
        const hint = {
          ...compactAnimSoundHint(item, reason, 1800 + (candidate.score || 0)),
          castAction: ref,
        };
        collectSoundHint(state, wwise, hint, { context: 'cast-action' });
      }
    }
  }
}

function collectAnimSoundIndexMatches(state, wwise, animIndex, limit = 16) {
  if (!animIndex?.length) return;
  const matches = [];
  for (const item of animIndex) {
    const textNorm = item.searchNorm || normalizeName(animSoundSearchText(item));
    let score = 0;
    let reason = '';
    for (const term of state.matchTerms || []) {
      if (!term.normalized || term.normalized.length < 2) continue;
      if (textNorm.includes(term.normalized)) {
        const candidateScore = 600 + term.normalized.length;
        if (candidateScore > score) {
          score = candidateScore;
          reason = `name term ${term.label}`;
        }
      }
    }
    if (score) matches.push(compactAnimSoundHint(item, reason, score));
  }
  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.file.localeCompare(right.file, 'zh-Hans-CN');
  });
  for (const hint of matches.slice(0, limit)) collectSoundHint(state, wwise, hint);
}

function isBroadNameSoundHint(hint) {
  const reason = String(hint?.reason || '');
  return String(hint?.source || '') === 'anim-sound-index'
    && /\bname term\b/i.test(reason)
    && !/\bresource path\b/i.test(reason);
}

function isPropertyTraceFile(file) {
  const source = `${file?.source || ''} ${file?.note || ''}`;
  return /\bbuff\s+\d+\s+represent\s+\d+/i.test(source) || /\bbuff\s+\d+\s+table\b/i.test(source);
}

function collectTraceSoundRefs(state, ability, wwise) {
  walkTrace(ability, (node) => {
    for (const ref of node.playSfxRefs || []) addPlaySfxRef(state, ref, node);
    for (const file of node.files || []) {
      const extension = extname(file.path || '').toLowerCase();
      const source = { kind: 'trace-file', path: file.path || '', name: file.source || file.note || '' };
      if (isPropertyTraceFile(file)) {
        if (file.category === 'sound' || file.category === 'effect' || AUDIO_EXTENSIONS.has(extension) || EFFECT_EXTENSIONS.has(extension)) {
          addPropertyEffectRef(state, file, { ...source, kind: 'property-effect' });
        }
        continue;
      }
      if (file.category === 'sound' || AUDIO_EXTENSIONS.has(extension)) {
        addDirectAudioRef(state, file, source);
      } else if (file.category === 'effect' || EFFECT_EXTENSIONS.has(extension)) {
        addClientEffectRef(state, file, { ...source, kind: 'trace-effect' });
      }
    }
    for (const hint of node.soundHints || []) {
      if (isBroadNameSoundHint(hint)) continue;
      collectSoundHint(state, wwise, hint);
    }
  });
}

function makeWemPlayable(wem) {
  return {
    kind: 'wwise-wem',
    wemId: wem.id,
    wemName: wem.name,
    label: `${wem.name || `${wem.id}.wem`} (${wem.id})`,
    path: wem.file || `${wem.id}.wem`,
    localFiles: wem.localFiles || [],
    eventNames: wem.eventNames || [],
    playback: {
      route: 'url',
      url: `/api/ability-matcher/wwise-audio?wem=${encodeURIComponent(wem.id)}`,
    },
  };
}

function makeDirectAudioPlayable(audio) {
  if (!audio.localPath || !BROWSER_AUDIO_EXTENSIONS.has(audio.extension)) return null;
  return {
    kind: 'direct-audio',
    path: audio.path,
    label: audio.name || basename(audio.path),
    eventNames: [],
    playback: {
      route: 'url',
      url: `/api/ability-matcher/local-audio?path=${encodeURIComponent(audio.localPath)}`,
    },
  };
}

function attachPlayableRefs(states, wwise) {
  for (const state of states) {
    for (const wem of state.wemMap.values()) {
      wem.localFiles = localWemFiles(wwise, wem.id);
      wem.playable = hasLocalWemSource(wwise, wem.id) ? [makeWemPlayable(wem)] : [];
    }
    for (const directAudio of state.directAudioMap.values()) {
      const playable = makeDirectAudioPlayable(directAudio);
      directAudio.playable = playable ? [playable] : [];
    }
  }
}

function sourceStamp(prefixCache) {
  return [
    `schema:${CACHE_SCHEMA_VERSION}`,
    `prefix:${prefixCache?.sourceStamp || 'unknown'}`,
    `wwise:${getFileStamp(WWISE_INDEX_PATH)}`,
    `animSound:${getFileStamp(ANIM_SOUND_INDEX_PATH)}`,
    `taniCatalog:${taniCatalogStamp()}`,
    `audioCache:${getFileStamp(AUDIO_CACHE_DIR)}`,
  ].join('|');
}

function finalizeState(state) {
  const allEvents = [...state.eventMap.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const allWems = [...state.wemMap.values()].sort((left, right) => Number(left.id) - Number(right.id));
  const allDirectAudio = [...state.directAudioMap.values()].sort((left, right) => left.path.localeCompare(right.path));
  const allClientEffectRefs = [...state.clientEffectMap.values()].sort((left, right) => left.path.localeCompare(right.path));
  const allPropertyEffectRefs = [...state.propertyEffectMap.values()].sort((left, right) => left.path.localeCompare(right.path));
  const allUnresolvedEvents = [...state.unresolvedEventMap.values()].sort((left, right) => left.name.localeCompare(right.name));
  const confirmedEvents = allEvents.filter((event) => event.confidence !== 'candidate');
  const candidateEvents = allEvents.filter((event) => event.confidence === 'candidate');
  const isCastActionSource = (source) => source.kind === 'cast-action-tani-event';
  const isTriggerSource = (source) => isCastActionSource(source) && source.triggerSound === true;
  const eventHasSource = (event, predicate) => (event.sources || []).some(predicate);
  const triggerEvents = confirmedEvents.filter((event) => eventHasSource(event, isTriggerSource));
  const confirmedWemIds = new Set();
  for (const event of confirmedEvents) {
    for (const wemId of event.wems?.streamed || []) confirmedWemIds.add(String(wemId));
    for (const wemId of event.wems?.inMemory || []) confirmedWemIds.add(String(wemId));
  }
  const triggerWemIds = new Set();
  const triggerEventNames = new Set();
  for (const event of triggerEvents) {
    triggerEventNames.add(event.name);
    for (const wemId of event.wems?.streamed || []) triggerWemIds.add(String(wemId));
    for (const wemId of event.wems?.inMemory || []) triggerWemIds.add(String(wemId));
  }
  const confirmedWems = allWems.filter((wem) => confirmedWemIds.has(String(wem.id)));
  const triggerWems = allWems.filter((wem) => triggerWemIds.has(String(wem.id)));
  const relatedWems = confirmedWems.filter((wem) => !triggerWemIds.has(String(wem.id)));
  const candidateWems = allWems.filter((wem) => !confirmedWemIds.has(String(wem.id)));
  const hasCastActionSound = confirmedEvents.some((event) => eventHasSource(event, isCastActionSource));
  const allConfirmedPlayable = [
    ...confirmedWems.flatMap((wem) => wem.playable || []),
    ...allDirectAudio.flatMap((audio) => audio.playable || []),
  ];
  const triggerScopedWems = triggerWems.map((wem) => {
    const eventNames = (wem.eventNames || []).filter((eventName) => triggerEventNames.has(eventName));
    const sources = (wem.sources || []).filter((source) => triggerEventNames.has(source.eventName || '') && isTriggerSource(source));
    return {
      ...wem,
      eventNames,
      sources,
      playable: (wem.playable || []).map((playable) => ({ ...playable, eventNames })),
    };
  });
  const triggerPlayable = triggerScopedWems.flatMap((wem) => wem.playable || []).slice(0, MAX_PLAYABLE_PER_ABILITY);
  const relatedPlayable = relatedWems.flatMap((wem) => wem.playable || []).slice(0, MAX_PLAYABLE_PER_ABILITY);
  const playable = (triggerEvents.length ? triggerPlayable : allConfirmedPlayable).slice(0, MAX_PLAYABLE_PER_ABILITY);
  const compactEvent = (event) => ({
    ...event,
    banks: (event.banks || []).slice(0, MAX_BANKS_PER_EVENT),
    wems: {
      streamed: (event.wems?.streamed || []).slice(0, MAX_WEM_IDS_PER_EVENT),
      inMemory: (event.wems?.inMemory || []).slice(0, MAX_WEM_IDS_PER_EVENT),
    },
    sources: (event.sources || []).slice(0, 12),
  });
  const compactWem = (wem) => ({
    ...wem,
    eventNames: (wem.eventNames || []).slice(0, 12),
    sources: (wem.sources || []).slice(0, 12),
  });
  const events = confirmedEvents.slice(0, MAX_EVENTS_PER_ABILITY).map(compactEvent);
  const triggerEventRows = triggerEvents.slice(0, MAX_TRIGGER_EVENTS_PER_ABILITY).map(compactEvent);
  const wems = confirmedWems.slice(0, MAX_WEMS_PER_ABILITY).map(compactWem);
  const triggerWemRows = triggerScopedWems.slice(0, MAX_TRIGGER_WEMS_PER_ABILITY).map(compactWem);
  const directAudio = allDirectAudio.slice(0, MAX_DIRECT_AUDIO_REFS_PER_ABILITY);
  const clientEffectRefs = allClientEffectRefs.slice(0, MAX_EFFECT_REFS_PER_ABILITY);
  const propertyEffectRefs = allPropertyEffectRefs.slice(0, MAX_PROPERTY_REFS_PER_ABILITY);
  const unresolvedEvents = allUnresolvedEvents.slice(0, MAX_UNRESOLVED_EVENTS_PER_ABILITY);
  let status = 'no-reference';
  if (triggerPlayable.length) status = 'trigger-playable';
  else if (triggerEvents.length) status = 'trigger-event';
  else if (playable.length) status = hasCastActionSound ? 'cast-action-playable' : 'playable';
  else if (confirmedEvents.length) status = hasCastActionSound ? 'cast-action-event' : 'event-only';
  else if (allDirectAudio.length) status = 'file-ref-only';
  else if (allUnresolvedEvents.length || state.soundTags.length || state.taniRefs.length) status = 'sound-tag-only';
  else if (allClientEffectRefs.length || allPropertyEffectRefs.length) status = 'effect-ref-only';
  else if (state.playSfxRefs.length) status = 'play-sfx-only';
  else if (state.taniCatalogRefs.length) status = 'tani-ref-only';
  const statusText = status === 'no-reference'
    ? 'no confirmed client sound found'
    : status === 'trigger-playable'
      ? 'confirmed trigger sound found; local playback available'
      : status === 'trigger-event'
        ? 'confirmed trigger sound event found; local WEM not available'
    : status === 'cast-action-playable'
      ? 'related cast-action sound found; local playback available'
      : status === 'cast-action-event'
        ? 'related cast-action sound event found; no trigger sound event'
        : status === 'tani-ref-only'
      ? 'TANI animation clue only; no confirmed sound event'
      : status === 'play-sfx-only'
        ? 'PlaySfx clue only; no confirmed resolved sound'
        : status === 'effect-ref-only'
          ? 'effect reference only; not an ability sound answer'
          : status === 'sound-tag-only'
            ? 'sound clue only; no confirmed resolved event'
            : status === 'event-only'
              ? 'confirmed sound event found; local WEM not available'
              : status === 'file-ref-only'
                ? 'confirmed sound file reference found'
                : 'confirmed playable local Wwise sound found';
  return {
    id: state.id,
    prefix: state.prefix,
    kind: state.kind,
    name: state.name,
    status,
    statusText,
    terms: state.matchTerms,
    counts: {
      events: confirmedEvents.length,
      triggerEvents: triggerEvents.length,
      candidateEvents: candidateEvents.length,
      wems: confirmedWems.length,
      triggerWems: triggerWems.length,
      candidateWems: candidateWems.length,
      playable: playable.length,
      triggerPlayable: triggerPlayable.length,
      relatedPlayable: relatedPlayable.length,
      directAudio: allDirectAudio.length,
      clientEffectRefs: allClientEffectRefs.length,
      propertyEffectRefs: allPropertyEffectRefs.length,
      castActionRefs: state.castActionRefs.length,
      playSfxRefs: state.playSfxRefs.length,
      taniRefs: state.taniRefs.length,
      taniCatalogRefs: state.taniCatalogRefs.length,
      soundTags: state.soundTags.length,
      unresolvedEvents: allUnresolvedEvents.length,
    },
    triggerEvents: triggerEventRows,
    events,
    triggerWems: triggerWemRows,
    wems,
    triggerPlayable,
    relatedPlayable,
    playable,
    directAudio,
    clientEffectRefs,
    propertyEffectRefs,
    castActionRefs: state.castActionRefs,
    playSfxRefs: state.playSfxRefs,
    taniRefs: state.taniRefs,
    taniCatalogRefs: state.taniCatalogRefs,
    soundTags: state.soundTags,
    unresolvedEvents,
    notes: state.notes,
  };
}

function buildStats(entries) {
  const emptyGroupStats = () => ({
    total: 0,
    playable: 0,
    triggerPlayable: 0,
    eventOnly: 0,
    triggerEventOnly: 0,
    fileRefOnly: 0,
    soundTagOnly: 0,
    effectRefOnly: 0,
    playSfxOnly: 0,
    taniRefOnly: 0,
    noReference: 0,
    noSound: 0,
    withReferences: 0,
    withEvents: 0,
    withTriggerEvents: 0,
    withPlayable: 0,
    withTriggerPlayable: 0,
    withSoundTags: 0,
    withClientEffectRefs: 0,
    withPropertyEffectRefs: 0,
    withCastActionRefs: 0,
    withPlaySfxRefs: 0,
    withTaniCatalogRefs: 0,
  });
  const groups = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, emptyGroupStats()]));
  const total = emptyGroupStats();
  const confirmedSoundStatuses = new Set(['trigger-playable', 'trigger-event', 'playable', 'cast-action-playable', 'event-only', 'cast-action-event', 'file-ref-only']);
  for (const entry of entries) {
    const groupStats = groups[entry.prefix] || total;
    for (const stats of [total, groupStats]) {
      stats.total += 1;
      if (entry.status === 'trigger-playable') {
        stats.playable += 1;
        stats.triggerPlayable += 1;
      } else if (entry.status === 'playable' || entry.status === 'cast-action-playable') stats.playable += 1;
      else if (entry.status === 'trigger-event') {
        stats.eventOnly += 1;
        stats.triggerEventOnly += 1;
      } else if (entry.status === 'event-only' || entry.status === 'cast-action-event') stats.eventOnly += 1;
      else if (entry.status === 'file-ref-only') stats.fileRefOnly += 1;
      else if (entry.status === 'sound-tag-only') stats.soundTagOnly += 1;
      else if (entry.status === 'effect-ref-only') stats.effectRefOnly += 1;
      else if (entry.status === 'play-sfx-only') stats.playSfxOnly += 1;
      else if (entry.status === 'tani-ref-only') stats.taniRefOnly += 1;
      else stats.noReference += 1;
      if (!confirmedSoundStatuses.has(entry.status)) stats.noSound += 1;
      if (entry.status !== 'no-reference') stats.withReferences += 1;
      if (entry.counts.events > 0) stats.withEvents += 1;
      if (entry.counts.triggerEvents > 0) stats.withTriggerEvents += 1;
      if (entry.counts.playable > 0) stats.withPlayable += 1;
      if (entry.counts.triggerPlayable > 0) stats.withTriggerPlayable += 1;
      if (entry.counts.soundTags > 0) stats.withSoundTags += 1;
      if (entry.counts.clientEffectRefs > 0) stats.withClientEffectRefs += 1;
      if (entry.counts.propertyEffectRefs > 0) stats.withPropertyEffectRefs += 1;
      if (entry.counts.castActionRefs > 0) stats.withCastActionRefs += 1;
      if (entry.counts.playSfxRefs > 0) stats.withPlaySfxRefs += 1;
      if (entry.counts.taniCatalogRefs > 0) stats.withTaniCatalogRefs += 1;
    }
  }
  return { total, groups };
}

function flattenPrefixCache(prefixCache) {
  if (Array.isArray(prefixCache?.results)) return prefixCache.results;
  return PREFIXED_ABILITY_GROUPS.flatMap((group) => prefixCache?.groups?.[group] || []);
}

function cacheIsCurrent(cache, expectedSourceStamp = '') {
  if (!cache?.ok || cache.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  return !expectedSourceStamp || cache.sourceStamp === expectedSourceStamp;
}

export async function buildAbilitySoundCache(options = {}) {
  options.onProgress?.({ phase: 'prefix-cache' });
  const prefixCache = options.prefixCache || buildAbilityPrefixCache({ force: options.forcePrefix ? '1' : '' });
  const abilities = flattenPrefixCache(prefixCache);
  options.onProgress?.({ phase: 'load-wwise' });
  const wwise = loadWwiseIndex();
  const states = abilities.map(createState);
  options.onProgress?.({ phase: 'tani-catalog' });
  const taniCatalog = loadTaniCatalog();
  const taniExtractCandidates = attachTaniCatalogCandidates(states, taniCatalog);
  let taniExtraction = { requested: taniExtractCandidates.length, attempted: 0, extracted: 0 };
  if (options.extractTani !== false && taniExtractCandidates.length) {
    options.onProgress?.({ phase: 'extract-tani', candidates: taniExtractCandidates.length });
    taniExtraction = extractTaniPaths(taniExtractCandidates, options.maxTaniExtract || MAX_TANI_EXTRACT_TOTAL);
    if (taniExtraction.extracted > 0) {
      options.onProgress?.({ phase: 'rebuild-anim-sound-index', extracted: taniExtraction.extracted });
      const rebuilt = rebuildAnimSoundIndex();
      if (!rebuilt) states[0]?.notes.push('Failed to rebuild log/anim-sound-index.json after TANI extraction.');
    }
  }
  refreshTaniCatalogExtractionFlags(states);
  const animIndex = prepareAnimSoundSearchIndex(loadAnimSoundIndex());
  const animLookup = buildAnimSoundLookup(animIndex);
  options.onProgress?.({ phase: 'collect-traces', abilities: abilities.length });
  for (let abilityIndex = 0; abilityIndex < abilities.length; abilityIndex += 1) {
    collectTraceSoundRefs(states[abilityIndex], abilities[abilityIndex], wwise);
    collectCastActionSoundRefs(states[abilityIndex], abilities[abilityIndex], wwise, animLookup);
    if ((abilityIndex + 1) % 50 === 0 || abilityIndex + 1 === abilities.length) {
      options.onProgress?.({ phase: 'collect-traces', done: abilityIndex + 1, abilities: abilities.length });
    }
  }
  options.onProgress?.({ phase: 'attach-playable' });
  attachPlayableRefs(states, wwise);
  options.onProgress?.({ phase: 'finalize' });
  const entries = states.map(finalizeState);
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  const byKey = Object.fromEntries(entries.map((entry) => [`${entry.prefix}:${entry.id}`, entry]));
  const payload = {
    ok: true,
    schemaVersion: CACHE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceStamp: sourceStamp(prefixCache),
    cachePath: relative(REPO_ROOT, SOUND_CACHE_PATH).replace(/\\/g, '/'),
    prefixCachePath: prefixCache.cachePath || '',
    dataRoots: {
      wwiseIndex: relative(REPO_ROOT, WWISE_INDEX_PATH).replace(/\\/g, '/'),
      animSoundIndex: relative(REPO_ROOT, ANIM_SOUND_INDEX_PATH).replace(/\\/g, '/'),
      taniCatalog: repoRelativePath(taniCatalog.path || ''),
      taniExtractRoot: relative(REPO_ROOT, TANI_EXTRACT_ROOT).replace(/\\/g, '/'),
      audioCache: relative(REPO_ROOT, AUDIO_CACHE_DIR).replace(/\\/g, '/'),
    },
    taniExtraction,
    wwiseStats: wwise.stats,
    total: entries.length,
    stats: buildStats(entries),
    results: entries,
    byId,
    byKey,
  };
  ensureDir(ABILITY_MATCHER_ROOT);
  writeFileSync(SOUND_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function readAbilitySoundCache() {
  return readJsonFile(SOUND_CACHE_PATH, null);
}

export async function getAbilitySoundCache(options = {}) {
  const prefixCache = buildAbilityPrefixCache({ force: options.forcePrefix ? '1' : '' });
  const expectedSourceStamp = sourceStamp(prefixCache);
  const cache = readAbilitySoundCache();
  if (!options.force && cacheIsCurrent(cache, expectedSourceStamp)) return cache;
  if (options.force || options.buildIfMissing || !cacheIsCurrent(cache)) {
    return buildAbilitySoundCache({ ...options, prefixCache });
  }
  return { ok: false, error: `Ability sound cache missing: ${relative(REPO_ROOT, SOUND_CACHE_PATH).replace(/\\/g, '/')}` };
}

export function getAbilitySoundEntry(cache, abilityId, prefix = '') {
  const id = String(abilityId || '').trim();
  if (!cacheIsCurrent(cache) || !id) return null;
  if (prefix && cache.byKey?.[`${prefix}:${id}`]) return cache.byKey[`${prefix}:${id}`];
  return cache.byId?.[id] || null;
}

export function attachAbilitySoundCache(payload, options = {}) {
  const cache = options.cache || readAbilitySoundCache();
  if (!cacheIsCurrent(cache)) return payload;
  const attach = (ability, seen = new Set()) => {
    if (!ability || typeof ability !== 'object') return;
    const key = `${ability.prefix || ''}:${ability.id || ''}:${ability.kind || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = getAbilitySoundEntry(cache, ability.id, ability.prefix || '');
    if (entry) ability.soundResolution = entry;
    for (const child of ability.children || []) attach(child, seen);
    for (const relatedSkill of ability.relatedSkills || []) attach(relatedSkill, seen);
  };
  for (const ability of payload?.results || []) attach(ability);
  for (const group of Object.values(payload?.groups || {})) {
    for (const ability of group || []) attach(ability);
  }
  if (!payload.soundCache && cache) {
    payload.soundCache = {
      generatedAt: cache.generatedAt,
      cachePath: cache.cachePath,
      stats: cache.stats,
    };
  }
  return payload;
}

export { SOUND_CACHE_PATH };

