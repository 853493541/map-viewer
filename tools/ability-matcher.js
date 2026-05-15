import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '..');
const SKILL_TABLE_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'logic-skill-prefixed-out', 'settings', 'skill');
const REPRESENT_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'skill-tables-out', 'Represent');
const ABILITY_MATCHER_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'ability-matcher');
const EXTRACT_ROOT = join(ABILITY_MATCHER_ROOT, 'extracted');
const PATHLIST_ROOT = join(ABILITY_MATCHER_ROOT, 'pathlists');
const PREFIX_CACHE_PATH = join(ABILITY_MATCHER_ROOT, 'ability-prefix-cache.json');
const ANIM_SOUND_INDEX_PATH = join(REPO_ROOT, 'log', 'anim-sound-index.json');
const PAKV4_EXTRACT_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/bin64/PakV4SfxExtract.exe');
const PREFIX_CACHE_SCHEMA_VERSION = 3;

const TABLE_CACHE = new Map();
const SCRIPT_SCAN_CACHE = new Map();
let ANIM_SOUND_INDEX_CACHE = null;

const SKILL_DIRECT_TABLES = [
  'skill_user_data.krl.txt',
  'skill_tag.txt',
  'skill_dash.txt',
  'skill_chain.txt',
  'skill_reset_down_animation.txt',
  'skill_effect.txt',
  'skill_result.txt',
  'missile.txt',
  'skill_missile.txt',
  'hit_target_sound.txt',
  'behit_shake.txt',
  'skill_caster_effect.txt',
];

const PLAYER_TABLES = [
  'player/player_skill_move_animation.txt',
  'player/player_skill_move_bird_animation.txt',
  'player/player_cast_skill_reset_animation.txt',
];

const RESOURCE_EXT_RE = /\.(?:lua|lh|pss|sfx|tani|ani|mdl|mesh|wem|bnk|wav|dds|tga|png|jpg|jpeg|bmp|tab|txt|ini|xml)$/i;
const PREFIXED_ABILITY_GROUPS = ['绝境', '伪传'];
const RELATED_SKILL_FIELDS = [
  'SkillName', 'SkillID', 'Design_Effect', 'MaxLevel', 'KindType', 'FunctionType',
  'CastMode', 'WeaponRequest', 'EffectPlayType', 'ScriptFile', 'EffectType',
];

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readGb18030(filePath) {
  return iconv.decode(readFileSync(filePath), 'gb18030').replace(/^\uFEFF/, '');
}

function getFileStamp(filePath) {
  if (!existsSync(filePath)) return 'missing';
  const stats = statSync(filePath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function readTable(filePath) {
  const stamp = `${filePath}:${getFileStamp(filePath)}`;
  const cached = TABLE_CACHE.get(filePath);
  if (cached?.stamp === stamp) return cached.value;

  if (!existsSync(filePath)) {
    const empty = { headers: [], rows: [], byFirst: new Map(), bySkillId: new Map() };
    TABLE_CACHE.set(filePath, { stamp, value: empty });
    return empty;
  }

  const lines = readGb18030(filePath)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const headers = (lines[0] || '').split('\t').map((header, index) => header || `col${index}`);
  const rows = lines.slice(1).map((line, index) => {
    const cells = line.split('\t');
    const row = { __lineNo: index + 2, __rawLine: line, __cells: cells };
    headers.forEach((header, cellIndex) => {
      row[header] = cells[cellIndex] ?? '';
    });
    return row;
  });
  const byFirst = new Map();
  const bySkillId = new Map();
  for (const row of rows) {
    const first = String(row.__cells[0] || '').trim();
    if (first) {
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(row);
    }
    const skillId = String(row.SkillID || '').trim();
    if (skillId) bySkillId.set(skillId, row);
  }
  const value = { headers, rows, byFirst, bySkillId };
  TABLE_CACHE.set(filePath, { stamp, value });
  return value;
}

function skillTable(name) {
  return readTable(join(SKILL_TABLE_ROOT, name));
}

function representTable(relPath) {
  return readTable(join(REPRESENT_ROOT, relPath));
}

function normalizeSlashes(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_＿\-·・．.。:：,，、'"“”‘’()（）\[\]【】<>《》]/g, '');
}

function versionCoreName(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:伪传|绝境)[\s_＿\-·・．.。:：]+(.+)$/u);
  return match ? normalizeName(match[1]) : '';
}

function isStrictNameMatch(value, queryNorm) {
  if (!queryNorm) return false;
  const fullName = normalizeName(value);
  return fullName === queryNorm || versionCoreName(value) === queryNorm;
}

function prefixedAbilityGroup(value) {
  const text = String(value || '').trim();
  return text.match(/^(绝境|伪传)[\s_＿\-·・．.。:：]+/u)?.[1] || '';
}

function aliasCoreName(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:伪传|绝境)[\s_＿\-·・．.。:：]+(.+)$/u);
  return match ? match[1] : text;
}

function stripLeadingId(value) {
  return String(value || '').replace(/^\s*\d+\s*/, '');
}

function stripAbilityDecorations(value) {
  return stripLeadingId(value)
    .replace(/^(?:伪传|绝境)[\s_＿\-·・．.。:：]+/u, '')
    .replace(/^(?:道具|绝境)[\s_＿\-·・．.。:：]*/u, '')
    .trim();
}

function compactRow(row, fields) {
  if (!row) return null;
  const out = { lineNo: row.__lineNo };
  for (const field of fields) out[field] = row[field] ?? '';
  return out;
}

function skillById(skillId) {
  return skillTable('skills.tab').bySkillId.get(String(skillId)) || null;
}

function buffById(buffId) {
  return skillTable('Buff.tab').byFirst.get(String(buffId))?.[0] || null;
}

function skillScriptLogicalPath(skillRow) {
  const script = String(skillRow?.ScriptFile || '').trim();
  if (!script) return '';
  return normalizeSlashes(`scripts/skill/${script}`);
}

function scoreRelatedSkill(row, core) {
  const coreNorm = normalizeName(core);
  if (!coreNorm) return null;

  const rawName = String(row?.SkillName || '');
  const strippedName = stripLeadingId(rawName);
  const nameNorm = normalizeName(rawName);
  const strippedNorm = normalizeName(strippedName);
  const scriptNorm = normalizeName(row?.ScriptFile || '');
  const exactItemNorm = normalizeName(`道具${core}`);
  const exactJuejingNorm = normalizeName(`绝境${core}`);
  const itemScript = scriptNorm.includes(exactItemNorm) || scriptNorm.includes(normalizeName(`沙漠风暴道具${core}`));

  if (strippedNorm === exactItemNorm) return { score: 1200, reason: 'exact item skill' };
  if (itemScript && (strippedNorm === coreNorm || strippedNorm.includes(coreNorm))) return { score: 1125, reason: 'item script' };
  if (strippedNorm === exactJuejingNorm) return { score: 1050, reason: '绝境 skill' };
  if (strippedNorm === coreNorm) return { score: 1000, reason: 'original skill' };
  if (strippedNorm.includes(exactItemNorm) || (strippedNorm.includes(normalizeName('道具')) && strippedNorm.includes(coreNorm))) {
    return { score: 875, reason: 'item-related skill' };
  }
  if (strippedNorm.endsWith(coreNorm)) return { score: 750, reason: 'same-core skill' };
  if (nameNorm.includes(coreNorm)) return { score: 500, reason: 'contains core name' };
  return null;
}

function relatedSkillMatchesForAlias(alias, limit = 12) {
  const core = aliasCoreName(alias?.Name || '');
  const matches = [];
  for (const row of skillTable('skills.tab').rows) {
    const scored = scoreRelatedSkill(row, core);
    if (!scored) continue;
    matches.push({
      id: String(row.SkillID || ''),
      core,
      reason: scored.reason,
      score: scored.score,
      skill: compactRow(row, RELATED_SKILL_FIELDS),
      row,
    });
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftScript = left.skill?.ScriptFile ? 1 : 0;
    const rightScript = right.skill?.ScriptFile ? 1 : 0;
    if (rightScript !== leftScript) return rightScript - leftScript;
    const leftName = String(left.skill?.SkillName || '');
    const rightName = String(right.skill?.SkillName || '');
    if (leftName.length !== rightName.length) return leftName.length - rightName.length;
    return Number(left.id || 0) - Number(right.id || 0);
  });

  return matches.slice(0, limit).map(({ row, ...match }, index) => ({ ...match, rank: index + 1 }));
}

function slugForPath(value) {
  return normalizeSlashes(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'path';
}

function findFileRecursive(dir, filename) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
        return full;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractedPathFor(logicalPath) {
  return join(EXTRACT_ROOT, normalizeSlashes(logicalPath).replace(/\//g, '\\'));
}

function ensurePakv4File(logicalPath) {
  const normalized = normalizeSlashes(logicalPath);
  if (!normalized || normalized.split('/').includes('..')) return null;

  const expected = extractedPathFor(normalized);
  if (existsSync(expected)) return expected;
  if (!existsSync(PAKV4_EXTRACT_EXE)) return null;

  ensureDir(EXTRACT_ROOT);
  ensureDir(PATHLIST_ROOT);
  const pathlist = join(PATHLIST_ROOT, `${slugForPath(normalized)}.txt`);
  writeFileSync(pathlist, iconv.encode(normalized.replace(/\//g, '\\') + '\r\n', 'gb18030'));

  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlist, EXTRACT_ROOT], {
      cwd: dirname(PAKV4_EXTRACT_EXE),
      timeout: 20000,
      windowsHide: true,
    });
  } catch {
    // PakV4SfxExtract can still extract partial results before returning non-zero.
  }

  if (existsSync(expected)) return expected;
  return findFileRecursive(EXTRACT_ROOT, basename(normalized)) || null;
}

function ensurePakv4Files(logicalPaths) {
  const normalizedPaths = [...new Set((logicalPaths || []).map(normalizeSlashes))]
    .filter((value) => value && !value.split('/').includes('..'))
    .filter((value) => !existsSync(extractedPathFor(value)));
  if (!normalizedPaths.length || !existsSync(PAKV4_EXTRACT_EXE)) return;

  ensureDir(EXTRACT_ROOT);
  ensureDir(PATHLIST_ROOT);
  const pathlist = join(PATHLIST_ROOT, `_bulk_${Date.now()}.txt`);
  writeFileSync(pathlist, iconv.encode(normalizedPaths.map((value) => value.replace(/\//g, '\\')).join('\r\n') + '\r\n', 'gb18030'));

  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlist, EXTRACT_ROOT], {
      cwd: dirname(PAKV4_EXTRACT_EXE),
      timeout: Math.max(20000, normalizedPaths.length * 1200),
      windowsHide: true,
    });
  } catch {
    // PakV4SfxExtract can still extract partial results before returning non-zero.
  }
}

function logicalVariants(pathValue) {
  const normalized = normalizeSlashes(pathValue);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  if (normalized.startsWith('skill/')) variants.add(`scripts/${normalized}`);
  if (normalized.startsWith('scripts/skill/')) variants.add(normalized.replace(/^scripts\//, ''));
  return [...variants];
}

function extractQuotedStrings(text) {
  const values = [];
  const re = /"([^"]+)"/g;
  let match;
  while ((match = re.exec(text))) values.push(match[1]);
  return values;
}

function printableStrings(text) {
  return text.match(/[\x20-\x7e\u4e00-\u9fff·，。、：；（）【】《》“”‘’_\\/.-]{3,}/g) || [];
}

function getNumericArgs(callText) {
  return [...String(callText || '').matchAll(/\b\d{2,6}\b/g)].map((match) => match[0]);
}

function collectCallNumbers(text, names) {
  const values = new Set();
  const nameRe = names.join('|');
  const re = new RegExp(`(?:${nameRe})\\s*\\(([^)]*)\\)`, 'g');
  let match;
  while ((match = re.exec(text))) {
    for (const value of getNumericArgs(match[1])) values.add(value);
  }
  return values;
}

function readJsonFileCached(filePath, cache) {
  const stamp = getFileStamp(filePath);
  if (cache?.stamp === stamp) return cache;
  if (!existsSync(filePath)) return { stamp, value: null };
  try {
    return { stamp, value: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch {
    return { stamp, value: null };
  }
}

function getAnimSoundIndex() {
  ANIM_SOUND_INDEX_CACHE = readJsonFileCached(ANIM_SOUND_INDEX_PATH, ANIM_SOUND_INDEX_CACHE);
  return ANIM_SOUND_INDEX_CACHE.value?.items || [];
}

function normalizeLookup(value) {
  return normalizeSlashes(value).toLowerCase();
}

function soundSearchText(item) {
  return JSON.stringify({
    file: item.file || '',
    refAni: item.refAni || '',
    pss: item.pss || [],
    sounds: (item.sounds || []).map((sound) => ({
      system: sound.system || '',
      bank: sound.bank || '',
      event: sound.event || '',
      candidates: sound.candidates || [],
      wwise: (sound.wwise || []).map((candidate) => candidate.name || ''),
    })),
  });
}

function soundTermsForTrace({ skill, matchAlias, relatedSkills = [] }) {
  const raw = [
    matchAlias?.Name,
    skill?.SkillName,
    ...relatedSkills.map((item) => item?.skill?.SkillName),
  ];
  const terms = new Map();
  for (const value of raw) {
    const text = String(value || '').trim();
    if (!text) continue;
    for (const term of [text, aliasCoreName(text), stripAbilityDecorations(text), text.split(/[\s_＿\-·・．.。:：/\\]+/u).pop()]) {
      const cleaned = stripAbilityDecorations(term || '');
      const normalized = normalizeName(cleaned);
      if (normalized.length >= 2 && !/^\d+$/.test(normalized)) terms.set(normalized, cleaned);
    }
  }
  return [...terms.entries()].map(([normalized, label]) => ({ normalized, label }));
}

function compactSoundHint(item, reason, score) {
  return {
    reason,
    score,
    source: 'anim-sound-index',
    file: normalizeSlashes(item.file || ''),
    refAni: normalizeSlashes(item.refAni || ''),
    faction: item.faction || '',
    pss: (item.pss || []).map(normalizeSlashes),
    sounds: (item.sounds || []).map((sound) => ({
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

function findSoundHints({ skill, matchAlias, relatedSkills = [], files = [] }, limit = 16) {
  const index = getAnimSoundIndex();
  if (!index.length) return [];
  const resourcePaths = new Set((files || [])
    .map((file) => normalizeLookup(file.path))
    .filter(Boolean));
  const terms = soundTermsForTrace({ skill, matchAlias, relatedSkills });
  const matches = [];

  for (const item of index) {
    const reasons = [];
    let score = 0;
    const itemPaths = [item.file, item.refAni, ...(item.pss || [])].map(normalizeLookup).filter(Boolean);
    const exact = itemPaths.find((value) => resourcePaths.has(value));
    if (exact) {
      score = Math.max(score, 1200);
      reasons.push(`resource path ${exact}`);
    }

    const textNorm = normalizeName(soundSearchText(item));
    for (const term of terms) {
      if (textNorm.includes(term.normalized)) {
        score = Math.max(score, 600 + term.normalized.length);
        reasons.push(`name term ${term.label}`);
      }
    }

    if (!score || !(item.sounds || []).length) continue;
    matches.push(compactSoundHint(item, [...new Set(reasons)].join(', '), score));
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.file.localeCompare(right.file, 'zh-Hans-CN');
  });
  const seen = new Set();
  return matches.filter((hint) => {
    const key = `${hint.file}|${hint.refAni}|${hint.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function playSfxRefsForScript(script) {
  return [...new Set(script?.playSfxIds || [])].map((id) => ({
    id,
    skill: compactRow(skillById(id), RELATED_SKILL_FIELDS),
  }));
}

function classifyResourcePath(logicalPath) {
  const ext = (logicalPath.match(/\.[^.\/]+$/)?.[0] || '').toLowerCase();
  if (ext === '.lua' || ext === '.lh') return 'script';
  if (ext === '.pss' || ext === '.sfx') return 'effect';
  if (ext === '.tani' || ext === '.ani') return 'animation';
  if (ext === '.wem' || ext === '.bnk' || ext === '.wav') return 'sound';
  if (ext === '.dds' || ext === '.tga' || ext === '.png' || ext === '.jpg' || ext === '.jpeg') return 'texture';
  if (ext === '.mdl' || ext === '.mesh') return 'model';
  if (ext === '.tab' || ext === '.txt' || ext === '.ini' || ext === '.xml') return 'table';
  return 'file';
}

function makeFileEntry(logicalPath, source, note = '') {
  const normalized = normalizeSlashes(logicalPath);
  if (!normalized) return null;
  const localPath = existsSync(extractedPathFor(normalized)) ? extractedPathFor(normalized) : null;
  return {
    path: normalized,
    category: classifyResourcePath(normalized),
    source,
    note,
    localPath: localPath ? relative(REPO_ROOT, localPath).replace(/\\/g, '/') : '',
    extracted: Boolean(localPath),
  };
}

function scanScript(logicalPath, options = {}) {
  const extractAssets = options.extractAssets !== false;
  const normalized = normalizeSlashes(logicalPath);
  if (!normalized) return null;
  const localPath = ensurePakv4File(normalized);
  if (!localPath || !existsSync(localPath)) {
    return { logicalPath: normalized, localPath: '', extracted: false, includes: [], files: [], buffIds: [], subSkillIds: [], cooldownIds: [], playSfxIds: [] };
  }

  const stamp = `${localPath}:${getFileStamp(localPath)}`;
  const cached = SCRIPT_SCAN_CACHE.get(normalized);
  if (cached?.stamp === stamp) return cached.value;

  const text = readGb18030(localPath);
  const quoted = extractQuotedStrings(text);
  const printable = printableStrings(text);
  const scanText = `${text}\n${printable.join('\n')}`;
  const includes = [...new Set([...scanText.matchAll(/Include\s*\(\s*"([^"]+)"\s*\)/g)].map((match) => normalizeSlashes(match[1])))]
    .filter(Boolean);

  const files = new Map();
  const addFile = (value, source, note = '') => {
    for (const variant of logicalVariants(value)) {
      if (!RESOURCE_EXT_RE.test(variant)) continue;
      const entry = makeFileEntry(variant, source, note);
      if (entry && !files.has(entry.path)) files.set(entry.path, entry);
    }
  };

  addFile(normalized, 'skill script');
  includes.forEach((includePath) => addFile(includePath, 'script include'));
  [...quoted, ...printable].forEach((value) => {
    const trimmed = normalizeSlashes(value);
    if (trimmed.includes('/') && RESOURCE_EXT_RE.test(trimmed)) addFile(trimmed, 'script string');
  });

  const buffIds = new Set();
  const buffCallIds = collectCallNumbers(scanText, ['AddBuff', 'GetBuff', 'DelBuff', 'BindBuff', 'AddSlowCheckSelfBuff', 'AddSlowCheckDestBuff', 'AddSlowCheckSelfOwnBuff', 'AddSlowCheckDestOwnBuff']);
  for (const id of buffCallIds) {
    if (buffById(id)) buffIds.add(id);
  }

  const subSkillIds = new Set();
  const childPatterns = [
    /CAST_SKILL_TARGET_DST[\s\S]{0,160}?\b(\d{3,6})\b/g,
    /\b(?:dwSkillID\w*|nSkillID\w*|dwSubSkillID\w*)\s*=\s*(\d{3,6})/g,
  ];
  for (const pattern of childPatterns) {
    let match;
    while ((match = pattern.exec(scanText))) {
      if (skillById(match[1])) subSkillIds.add(match[1]);
    }
  }
  const castIds = collectCallNumbers(scanText, ['CastSkill', 'CastSkillLvBySituation', 'SetSubsectionSkill']);
  for (const id of castIds) {
    if (skillById(id)) subSkillIds.add(id);
  }

  const cooldownIds = [...collectCallNumbers(scanText, ['SetNormalCoolDown', 'SetCheckCoolDown', 'SetPublicCoolDown'])];
  const playSfxIds = [...collectCallNumbers(scanText, ['PlaySfx'])];

  if (extractAssets) {
    for (const includePath of includes) {
      ensurePakv4File(includePath);
    }
    for (const entry of files.values()) {
      if (entry.category !== 'table') ensurePakv4File(entry.path);
    }
  }

  const value = {
    logicalPath: normalized,
    localPath: relative(REPO_ROOT, localPath).replace(/\\/g, '/'),
    extracted: true,
    includes,
    files: [...files.values()],
    buffIds: [...buffIds],
    subSkillIds: [...subSkillIds],
    cooldownIds,
    playSfxIds,
  };
  SCRIPT_SCAN_CACHE.set(normalized, { stamp, value });
  return value;
}

function addUniqueFile(files, entry) {
  if (!entry?.path) return;
  const previous = files.get(entry.path);
  if (!previous) {
    files.set(entry.path, entry);
    return;
  }
  if (!previous.extracted && entry.extracted) previous.extracted = true;
  if (!previous.localPath && entry.localPath) previous.localPath = entry.localPath;
  if (!previous.source.includes(entry.source)) previous.source = `${previous.source}, ${entry.source}`;
}

function skillBuffRowsForRepresentId(representId) {
  const id = String(representId || '').trim();
  if (!id || id === '0') return [];
  return representTable('skill/skill_buff.txt').rows
    .filter((row) => String(row.SkillBuffID || '').trim() === id)
    .map((row) => ({
      lineNo: row.__lineNo,
      Part: row.Part || '',
      SkillBuffID: row.SkillBuffID || '',
      PartName: row.PartName || '',
      BoneNameLeft: row.BoneNameLeft || '',
      BoneNameRight: row.BoneNameRight || '',
      SFXFilePathLeft: row.SFXFilePathLeft || '',
      SFXFilePathRight: row.SFXFilePathRight || '',
    }));
}

function traceBuff(buffId, files, source, options = {}) {
  const extractAssets = options.extractAssets !== false;
  const row = buffById(buffId);
  if (!row) return null;
  addUniqueFile(files, makeFileEntry('settings/skill/Buff.tab', `buff ${buffId} table`));
  const compact = compactRow(row, ['ID', 'Name', 'FunctionType', 'RepresentPos', 'RepresentID', 'ScriptFile', 'RLActions']);
  const skillBuffRows = skillBuffRowsForRepresentId(row.RepresentID);
  if (skillBuffRows.length) {
    addUniqueFile(files, makeFileEntry('Represent/skill/skill_buff.txt', `buff ${buffId} represent ${row.RepresentID}`));
  }
  for (const skillBuffRow of skillBuffRows) {
    for (const field of ['SFXFilePathLeft', 'SFXFilePathRight']) {
      const value = normalizeSlashes(skillBuffRow[field]);
      if (!value || !RESOURCE_EXT_RE.test(value)) continue;
      const extracted = extractAssets ? ensurePakv4File(value) : null;
      const entry = makeFileEntry(value, `buff ${buffId} represent ${row.RepresentID}`, field);
      if (entry && extracted) {
        entry.extracted = true;
        entry.localPath = relative(REPO_ROOT, extracted).replace(/\\/g, '/');
      }
      addUniqueFile(files, entry);
    }
  }
  if (row.ScriptFile) {
    const scriptPath = normalizeSlashes(`scripts/buff/${row.ScriptFile}`);
    addUniqueFile(files, makeFileEntry(scriptPath, `buff ${buffId} script`));
  }
  return { buffId: String(buffId), source, row: compact, skillBuffRows };
}

function directTableHits(skillId, files) {
  const out = [];
  for (const rel of SKILL_DIRECT_TABLES) {
    const fullRel = `skill/${rel}`;
    const fullPath = join(REPRESENT_ROOT, fullRel);
    if (!existsSync(fullPath)) continue;
    if (rel.endsWith('.krl.txt')) {
      const text = readGb18030(fullPath);
      const match = text.match(new RegExp(`(?:^|\\n)${skillId}\\s*=([\\s\\S]*?)(?=\\n\\d+\\s*=|$)`));
      if (match) out.push({ table: fullRel, block: match[0].trim() });
      continue;
    }
    const table = readTable(fullPath);
    const rows = table.rows.filter((row) => row.__cells[0] === String(skillId) || row.__cells.includes(String(skillId)));
    if (!rows.length) continue;
    out.push({
      table: fullRel,
      rows: rows.slice(0, 20).map((row) => ({ lineNo: row.__lineNo, raw: row.__rawLine })),
    });
    for (const row of rows) {
      for (const cell of row.__cells) {
        const value = normalizeSlashes(cell);
        if (value.includes('/') && RESOURCE_EXT_RE.test(value)) addUniqueFile(files, makeFileEntry(value, `table ${fullRel}`));
      }
    }
  }

  for (const rel of ['camera/skill_move_camera.txt', ...PLAYER_TABLES]) {
    const table = representTable(rel);
    const rows = table.rows.filter((row) => row.__cells[0] === String(skillId));
    if (rows.length) {
      out.push({ table: rel, rows: rows.map((row) => ({ lineNo: row.__lineNo, raw: row.__rawLine })) });
    }
  }
  return out;
}

function traceSkill(skillId, options = {}) {
  const { depth = 0, maxDepth = 3, seen = new Set() } = options;
  const matchAlias = options.matchAlias || null;
  const extractAssets = options.extractAssets !== false;
  const id = String(skillId);
  if (seen.has(id) || depth > maxDepth) return null;
  seen.add(id);

  const row = skillById(id);
  if (!row) return null;
  const files = new Map();
  addUniqueFile(files, makeFileEntry('settings/skill/skills.tab', 'skill table'));

  const compactSkill = compactRow(row, [
    'SkillName', 'SkillID', 'Design_Effect', 'MaxLevel', 'KindType', 'FunctionType',
    'CastMode', 'WeaponRequest', 'EffectPlayType', 'ScriptFile', 'EffectType',
    'SkillEventMask1', 'SkillEventMask2', 'SkillEventMask3', 'HitStiffSkillMoveID',
  ]);

  const scriptPath = skillScriptLogicalPath(row);
  const script = scriptPath ? scanScript(scriptPath, { extractAssets }) : null;
  if (script) {
    for (const entry of script.files) addUniqueFile(files, entry);
  }

  const directBuff = traceBuff(id, files, 'same numeric ID', { extractAssets });
  const scriptBuffs = [];
  for (const buffId of script?.buffIds || []) {
    const traced = traceBuff(buffId, files, 'script reference', { extractAssets });
    if (traced) scriptBuffs.push(traced);
  }

  const tableHits = directTableHits(id, files);
  const childIds = [...new Set(script?.subSkillIds || [])].filter((childId) => childId !== id && skillById(childId));
  const children = childIds
    .map((childId) => traceSkill(childId, { depth: depth + 1, maxDepth, seen, extractAssets }))
    .filter(Boolean);
  for (const child of children) {
    for (const entry of child.files || []) addUniqueFile(files, { ...entry, source: `child ${child.id}: ${entry.source}` });
  }

  const sortedFiles = [...files.values()].sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
  const playSfxRefs = playSfxRefsForScript(script);
  const soundHints = findSoundHints({ skill: compactSkill, matchAlias, files: sortedFiles });

  return {
    id,
    matchAlias,
    skill: compactSkill,
    script,
    directBuff,
    scriptBuffs,
    cooldownIds: script?.cooldownIds || [],
    playSfxIds: script?.playSfxIds || [],
    playSfxRefs,
    childIds,
    children,
    tableHits,
    soundHints,
    files: sortedFiles,
  };
}

function scoreSkill(row, queryNorm, queryRaw) {
  const name = String(row.SkillName || '');
  const nameNorm = normalizeName(name);
  const id = String(row.SkillID || '');
  if (id === queryRaw) return -1200;
  if (versionCoreName(name) === queryNorm) return -1125 + nameNorm.length;
  if (nameNorm === queryNorm) return -1100;
  if (nameNorm.endsWith(queryNorm)) return -850 + nameNorm.length;
  if (nameNorm.includes(queryNorm)) return -650 + nameNorm.indexOf(queryNorm) + nameNorm.length;
  return 0;
}

function scoreMatchedItem(item, queryNorm, queryRaw) {
  if (item.matchAlias?.Name) {
    const aliasNorm = normalizeName(item.matchAlias.Name);
    const id = String(item.matchAlias.ID || '');
    if (id === queryRaw) return -1050;
    if (versionCoreName(item.matchAlias.Name) === queryNorm) return -925 + aliasNorm.length;
    if (aliasNorm === queryNorm) return -900;
    if (aliasNorm.endsWith(queryNorm)) return -700 + aliasNorm.length;
    if (aliasNorm.includes(queryNorm)) return -520 + aliasNorm.indexOf(queryNorm) + aliasNorm.length;
  }
  return item.row ? scoreSkill(item.row, queryNorm, queryRaw) : 0;
}

function traceBuffOnly(alias, options = {}) {
  const id = String(alias.ID || '');
  const relatedTraceLimit = Math.max(0, Math.min(Number(options.relatedTraceLimit ?? 1) || 0, 5));
  const files = new Map();
  const directBuff = traceBuff(id, files, 'buff name match', options);
  const relatedSkillMatches = options.relatedSkillMatches || relatedSkillMatchesForAlias(alias, 12);
  const relatedSkills = relatedSkillMatches
    .slice(0, relatedTraceLimit)
    .map((match) => traceSkill(match.id, {
      maxDepth: options.maxDepth ?? 3,
      extractAssets: options.extractAssets,
    }))
    .filter(Boolean);
  for (const relatedSkill of relatedSkills) {
    for (const entry of relatedSkill.files || []) {
      addUniqueFile(files, { ...entry, source: `resolved skill ${relatedSkill.id}: ${entry.source}` });
    }
  }
  const sortedFiles = [...files.values()].sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
  const playSfxRefs = relatedSkills.flatMap((relatedSkill) => (relatedSkill.playSfxRefs || []).map((ref) => ({
    ...ref,
    source: `resolved skill ${relatedSkill.id}`,
  })));
  const soundHints = findSoundHints({ matchAlias: alias, relatedSkills, files: sortedFiles });
  return {
    id,
    kind: 'buff',
    matchAlias: alias,
    skill: null,
    script: null,
    directBuff,
    scriptBuffs: [],
    cooldownIds: [],
    playSfxIds: [...new Set(playSfxRefs.map((ref) => ref.id))],
    playSfxRefs,
    childIds: [],
    children: [],
    tableHits: [],
    relatedSkillMatches,
    relatedSkills,
    primaryRelatedSkill: relatedSkills[0] || null,
    soundHints,
    files: sortedFiles,
  };
}

function dataRootsPayload() {
  return {
    skillTables: relative(REPO_ROOT, SKILL_TABLE_ROOT).replace(/\\/g, '/'),
    representTables: relative(REPO_ROOT, REPRESENT_ROOT).replace(/\\/g, '/'),
    extracted: relative(REPO_ROOT, EXTRACT_ROOT).replace(/\\/g, '/'),
  };
}

function prefixCacheSourceStamp() {
  return [
    `schema:${PREFIX_CACHE_SCHEMA_VERSION}`,
    `skills:${getFileStamp(join(SKILL_TABLE_ROOT, 'skills.tab'))}`,
    `buffs:${getFileStamp(join(SKILL_TABLE_ROOT, 'Buff.tab'))}`,
    `skillBuff:${getFileStamp(join(REPRESENT_ROOT, 'skill', 'skill_buff.txt'))}`,
    `animSound:${getFileStamp(ANIM_SOUND_INDEX_PATH)}`,
  ].join('|');
}

function enrichPrefixTrace(trace, prefix, row) {
  const scriptFile = String(row?.ScriptFile || trace?.skill?.ScriptFile || '').trim();
  const resolvedSkill = trace?.primaryRelatedSkill?.skill || trace?.relatedSkills?.[0]?.skill || null;
  const resolvedScriptFile = String(resolvedSkill?.ScriptFile || '').trim();
  return {
    ...trace,
    prefix,
    hasScript: Boolean(scriptFile || resolvedScriptFile),
    hasLua: /\.lua\s*$/i.test(scriptFile || resolvedScriptFile),
    scriptFile,
    resolvedSkill: resolvedSkill ? compactRow(resolvedSkill, RELATED_SKILL_FIELDS) || resolvedSkill : null,
    resolvedSkillId: resolvedSkill?.SkillID || '',
    resolvedSkillName: resolvedSkill?.SkillName || '',
    resolvedScriptFile,
  };
}

function emptyPrefixGroups() {
  return Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, []]));
}

function sortAbilityRows(left, right) {
  const nameDelta = String(left.SkillName || left.Name || '').localeCompare(String(right.SkillName || right.Name || ''), 'zh-Hans-CN');
  if (nameDelta !== 0) return nameDelta;
  return Number(left.SkillID || left.ID || 0) - Number(right.SkillID || right.ID || 0);
}

function readPrefixCache(sourceStamp) {
  if (!existsSync(PREFIX_CACHE_PATH)) return null;
  try {
    const cached = JSON.parse(readFileSync(PREFIX_CACHE_PATH, 'utf8'));
    if (cached?.sourceStamp !== sourceStamp || !cached?.groups) return null;
    return { ...cached, ok: true, cached: true };
  } catch {
    return null;
  }
}

export function buildAbilityPrefixCache(params = {}) {
  const force = params.force === true || params.force === '1' || params.force === 'true';
  const sourceStamp = prefixCacheSourceStamp();
  const cached = force ? null : readPrefixCache(sourceStamp);
  if (cached) return cached;

  const rowGroups = emptyPrefixGroups();
  for (const row of skillTable('skills.tab').rows) {
    const group = prefixedAbilityGroup(row.SkillName);
    if (rowGroups[group]) rowGroups[group].push(row);
  }
  for (const group of PREFIXED_ABILITY_GROUPS) rowGroups[group].sort(sortAbilityRows);

  const buffGroups = emptyPrefixGroups();
  for (const row of skillTable('Buff.tab').rows) {
    const group = prefixedAbilityGroup(row.Name);
    if (buffGroups[group]) buffGroups[group].push(row);
  }
  for (const group of PREFIXED_ABILITY_GROUPS) buffGroups[group].sort(sortAbilityRows);

  const buffRelatedMatches = new Map();
  const relatedScriptPaths = [];
  for (const group of PREFIXED_ABILITY_GROUPS) {
    for (const row of buffGroups[group]) {
      const alias = compactRow(row, ['ID', 'Name', 'FunctionType', 'RepresentPos', 'RepresentID', 'ScriptFile', 'RLActions']);
      const matches = relatedSkillMatchesForAlias(alias, 12);
      buffRelatedMatches.set(String(row.ID || ''), matches);
      for (const match of matches.slice(0, 1)) {
        const relatedRow = skillById(match.id);
        if (relatedRow) relatedScriptPaths.push(skillScriptLogicalPath(relatedRow));
      }
    }
  }

  ensurePakv4Files([
    ...PREFIXED_ABILITY_GROUPS.flatMap((group) => rowGroups[group].map(skillScriptLogicalPath)),
    ...relatedScriptPaths,
  ].filter(Boolean));

  const groups = emptyPrefixGroups();
  const errors = [];
  for (const group of PREFIXED_ABILITY_GROUPS) {
    for (const row of rowGroups[group]) {
      try {
        const trace = traceSkill(row.SkillID, { maxDepth: 3, extractAssets: false });
        if (trace) groups[group].push(enrichPrefixTrace(trace, group, row));
      } catch (err) {
        errors.push({
          prefix: group,
          id: String(row.SkillID || ''),
          name: String(row.SkillName || ''),
          error: err?.message || String(err),
        });
      }
    }

    for (const row of buffGroups[group]) {
      try {
        const alias = compactRow(row, ['ID', 'Name', 'FunctionType', 'RepresentPos', 'RepresentID', 'ScriptFile', 'RLActions']);
        const trace = traceBuffOnly(alias, {
          extractAssets: false,
          relatedSkillMatches: buffRelatedMatches.get(String(row.ID || '')) || [],
        });
        if (trace) groups[group].push(enrichPrefixTrace(trace, group, row));
      } catch (err) {
        errors.push({
          prefix: group,
          id: String(row.ID || ''),
          name: String(row.Name || ''),
          error: err?.message || String(err),
        });
      }
    }
  }

  const results = PREFIXED_ABILITY_GROUPS.flatMap((group) => groups[group]);
  const counts = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, groups[group].length]));
  const skills = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, groups[group].filter((item) => item.kind !== 'buff').length]));
  const buffs = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, groups[group].filter((item) => item.kind === 'buff').length]));
  const scripted = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, groups[group].filter((item) => item.hasScript).length]));
  const lua = Object.fromEntries(PREFIXED_ABILITY_GROUPS.map((group) => [group, groups[group].filter((item) => item.hasLua).length]));
  const payload = {
    ok: true,
    cached: false,
    generatedAt: new Date().toISOString(),
    sourceStamp,
    cachePath: relative(REPO_ROOT, PREFIX_CACHE_PATH).replace(/\\/g, '/'),
    prefixes: PREFIXED_ABILITY_GROUPS,
    counts,
    skills,
    buffs,
    scripted,
    lua,
    total: results.length,
    returned: results.length,
    results,
    groups,
    errors,
    dataRoots: dataRootsPayload(),
  };

  ensureDir(ABILITY_MATCHER_ROOT);
  writeFileSync(PREFIX_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function buildAbilityMatcherSearch(params = {}) {
  const rawQuery = String(params.query || '').trim();
  const limit = Math.max(1, Math.min(Number(params.limit) || 24, 80));
  const queryAfterEquals = rawQuery.includes('=') ? rawQuery.split('=').slice(1).join('=').trim() : rawQuery;
  const numericQuery = rawQuery.match(/\b\d{2,6}\b/)?.[0] || '';
  const queryNorm = normalizeName(queryAfterEquals || rawQuery);

  if (!rawQuery) {
    return { ok: true, query: rawQuery, count: 0, results: [] };
  }

  const skillRows = skillTable('skills.tab').rows;
  const candidates = [];
  const seen = new Set();
  for (const row of skillRows) {
    const id = String(row.SkillID || '').trim();
    const nameNorm = normalizeName(row.SkillName || '');
    const scriptNorm = normalizeName(row.ScriptFile || '');
    const byId = numericQuery && id === numericQuery;
    const byName = queryNorm && nameNorm.includes(queryNorm);
    const byScript = queryNorm && scriptNorm.includes(queryNorm);
    if (!byId && !byName && !byScript) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ row, matchAlias: null, strictName: isStrictNameMatch(row.SkillName, queryNorm) });
  }

  const allBuffMatches = skillTable('Buff.tab').rows
    .filter((row) => {
      const id = String(row.ID || '').trim();
      const nameNorm = normalizeName(row.Name || '');
      return (numericQuery && id === numericQuery) || (queryNorm && nameNorm.includes(queryNorm));
    })
    .slice(0, 80)
    .map((row) => compactRow(row, ['ID', 'Name', 'FunctionType', 'RepresentPos', 'RepresentID', 'ScriptFile', 'RLActions']));

  for (const alias of allBuffMatches) {
    if (seen.has(alias.ID)) continue;
    seen.add(alias.ID);
    candidates.push({ row: null, matchAlias: alias, kind: 'buff', strictName: isStrictNameMatch(alias.Name, queryNorm) });
  }

  const useStrictNames = !numericQuery && queryNorm && candidates.some((item) => item.strictName);
  const hasStrictSkill = useStrictNames && candidates.some((item) => item.row && item.strictName);
  const matched = useStrictNames
    ? candidates.filter((item) => item.strictName && (!hasStrictSkill || item.row))
    : candidates;
  const buffMatches = useStrictNames
    ? allBuffMatches.filter((row) => isStrictNameMatch(row.Name, queryNorm))
    : allBuffMatches;

  matched.sort((left, right) => {
    const scoreDelta = scoreMatchedItem(left, queryNorm, numericQuery || rawQuery) - scoreMatchedItem(right, queryNorm, numericQuery || rawQuery);
    if (scoreDelta !== 0) return scoreDelta;
    return Number(left.row?.SkillID || left.matchAlias?.ID || 0) - Number(right.row?.SkillID || right.matchAlias?.ID || 0);
  });

  const results = matched
    .slice(0, limit)
    .map((item) => (item.row ? traceSkill(item.row.SkillID, { matchAlias: item.matchAlias }) : traceBuffOnly(item.matchAlias)))
    .filter(Boolean);

  return {
    ok: true,
    query: rawQuery,
    normalizedQuery: queryNorm,
    count: matched.length,
    returned: results.length,
    results,
    buffMatches,
    dataRoots: dataRootsPayload(),
  };
}
