import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { buildAbilityMatcherSearch } from './ability-matcher.js';
import { resolveFmodToWwise } from './fmod-to-wwise.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '..');
const ABILITY_MATCHER_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'ability-matcher');
const EXTRACT_ROOT = join(ABILITY_MATCHER_ROOT, 'extracted');
const PATHLIST_ROOT = join(ABILITY_MATCHER_ROOT, 'pathlists');
const SKILL_TABLE_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'logic-skill-prefixed-out', 'settings', 'skill');
const REPRESENT_ROOT = join(REPO_ROOT, 'cache-extraction', 'pakv4-probe', 'skill-tables-out', 'Represent');
const WWISE_EXTRACT_ROOT = join(REPO_ROOT, 'cache-extraction', 'wwise-pak-extract', 'Windows', 'base');
const WWISE_INDEX_PATH = join(REPO_ROOT, 'log', 'wwise-soundbank-index.json');
const REPORT_JSON = join(REPO_ROOT, 'log', 'ability-reference-extraction-report.json');
const REPORT_MD = join(REPO_ROOT, 'log', 'ability-reference-extraction-report.md');
const PAKV4_EXTRACT_EXE = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/bin64/PakV4SfxExtract.exe');
const CLIENT_WWISE_ROOT = resolve('C:/SeasunGame/Game/JX3/bin/zhcn_hd/jx3ac/jx3ac_Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows');

const RESOURCE_EXT_RE = /\.(?:lua|lh|pss|sfx|tani|ani|mdl|mesh|wem|bnk|wav|ogg|dds|tga|png|jpg|jpeg|bmp|tab|txt|ini|xml|jsoninspack)$/i;
const EXTRACTABLE_EXT_RE = /\.(?:lua|lh|pss|sfx|tani|ani|mdl|mesh|wem|bnk|wav|ogg|dds|tga|png|jpg|jpeg|bmp|ini|xml|jsoninspack)$/i;
const MAX_SCAN_BYTES = 12 * 1024 * 1024;

const args = process.argv.slice(2);
const options = {
  maxDepth: 4,
  limit: 12,
  queries: [],
};

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--max-depth') {
    options.maxDepth = Number(args[++index] || options.maxDepth);
  } else if (arg === '--limit') {
    options.limit = Number(args[++index] || options.limit);
  } else {
    options.queries.push(arg);
  }
}

if (!options.queries.length) {
  options.queries = ['绝境·龙牙', '伪传·踏星行', '绝境·笑醉狂'];
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeSlashes(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function relPath(filePath) {
  return relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function extractedPathFor(logicalPath) {
  return join(EXTRACT_ROOT, normalizeSlashes(logicalPath).replace(/\//g, '\\'));
}

function localTablePath(logicalPath) {
  const normalized = normalizeSlashes(logicalPath);
  if (normalized.startsWith('settings/skill/')) {
    return join(SKILL_TABLE_ROOT, normalized.slice('settings/skill/'.length).replace(/\//g, '\\'));
  }
  if (normalized.startsWith('Represent/')) {
    return join(REPRESENT_ROOT, normalized.slice('Represent/'.length).replace(/\//g, '\\'));
  }
  return null;
}

function resolveLocalPath(logicalPath) {
  const normalized = normalizeSlashes(logicalPath);
  const tablePath = localTablePath(normalized);
  if (tablePath && existsSync(tablePath)) return tablePath;
  const expected = extractedPathFor(normalized);
  if (existsSync(expected)) return expected;
  return null;
}

function slugForPath(value) {
  return normalizeSlashes(value).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-160) || 'paths';
}

function extractPakv4Files(logicalPaths) {
  const targets = [...new Set(logicalPaths.map(normalizeSlashes))]
    .filter((value) => value && !value.split('/').includes('..'))
    .filter((value) => EXTRACTABLE_EXT_RE.test(value))
    .filter((value) => !resolveLocalPath(value));
  if (!targets.length) return { requested: 0, attempted: 0 };
  if (!existsSync(PAKV4_EXTRACT_EXE)) return { requested: targets.length, attempted: 0, error: 'PakV4SfxExtract.exe not found' };

  ensureDir(EXTRACT_ROOT);
  ensureDir(PATHLIST_ROOT);
  const pathlist = join(PATHLIST_ROOT, `_ability_refs_${Date.now()}_${slugForPath(targets[0])}.txt`);
  writeFileSync(pathlist, iconv.encode(targets.map((value) => value.replace(/\//g, '\\')).join('\r\n') + '\r\n', 'gb18030'));
  console.error(`[extract] ${targets.length} path(s) -> ${relPath(pathlist)}`);
  try {
    execFileSync(PAKV4_EXTRACT_EXE, [pathlist, EXTRACT_ROOT], {
      cwd: dirname(PAKV4_EXTRACT_EXE),
      timeout: Math.max(20000, targets.length * 1500),
      windowsHide: true,
    });
  } catch {
    // The extractor often writes partial results even when it returns non-zero.
  }
  return { requested: targets.length, attempted: targets.length, pathlist: relPath(pathlist) };
}

function classifyPath(logicalPath) {
  const ext = (logicalPath.match(/\.[^.\/]+$/)?.[0] || '').toLowerCase();
  if (ext === '.lua' || ext === '.lh') return 'script';
  if (ext === '.pss' || ext === '.sfx') return 'effect';
  if (ext === '.tani' || ext === '.ani') return 'animation';
  if (ext === '.wem' || ext === '.bnk' || ext === '.wav' || ext === '.ogg') return 'sound-file';
  if (ext === '.dds' || ext === '.tga' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.bmp') return 'texture';
  if (ext === '.mdl' || ext === '.mesh' || ext === '.jsoninspack') return 'model';
  if (ext === '.tab' || ext === '.txt' || ext === '.ini' || ext === '.xml') return 'table';
  return 'file';
}

function isStrByte(byte) {
  return (byte >= 0x20 && byte < 0x7f) || (byte >= 0x81 && byte <= 0xfe);
}

function findStrings(buffer, minLen = 4) {
  const out = [];
  let index = 0;
  while (index < buffer.length) {
    if (!isStrByte(buffer[index])) {
      index++;
      continue;
    }
    let end = index;
    while (end < buffer.length && isStrByte(buffer[end])) end++;
    if (end - index >= minLen) {
      out.push({ off: index, str: iconv.decode(buffer.slice(index, end), 'gbk') });
    }
    index = end + 1;
  }
  return out;
}

function extractResourcePathsFromString(value) {
  const paths = [];
  const text = String(value || '').replace(/\\/g, '/');
  const re = /(?:data|scripts|skill|settings|Represent|represent)[^\x00\r\n\t"'<>|*?]{0,260}?\.(?:lua|lh|pss|sfx|tani|ani|mdl|mesh|wem|bnk|wav|ogg|dds|tga|png|jpg|jpeg|bmp|tab|txt|ini|xml|jsoninspack)/gi;
  let match;
  while ((match = re.exec(text))) {
    let pathValue = match[0]
      .replace(/^[^A-Za-z0-9_\u4e00-\u9fff]*(?=(?:data|scripts|skill|settings|Represent|represent)\/)/i, '')
      .replace(/\s+$/g, '');
    const dataIndex = pathValue.search(/(?:data|scripts|skill|settings|Represent|represent)\//i);
    if (dataIndex > 0) pathValue = pathValue.slice(dataIndex);
    pathValue = normalizeSlashes(pathValue);
    if (RESOURCE_EXT_RE.test(pathValue)) paths.push(pathValue);
  }
  return paths;
}

function loadWwiseIndex() {
  if (!existsSync(WWISE_INDEX_PATH)) return { byHash: {}, events: {}, playableIds: new Set() };
  try {
    const payload = JSON.parse(readFileSync(WWISE_INDEX_PATH, 'utf8'));
    const playableIds = new Set();
    const playableNames = new Set();
    for (const [name, event] of Object.entries(payload.events || {})) {
      const ids = [...(event.wems?.streamed || []), ...(event.wems?.inMemory || [])];
      if (ids.length) {
        playableNames.add(name);
        playableIds.add(Number(event.taniHash || 0));
      }
    }
    for (const [hash, eventName] of Object.entries(payload.byHash || {})) {
      if (playableNames.has(eventName)) playableIds.add(Number(hash));
    }
    return { byHash: payload.byHash || {}, events: payload.events || {}, banks: payload.banks || {}, wems: payload.wems || {}, playableIds };
  } catch {
    return { byHash: {}, events: {}, playableIds: new Set() };
  }
}

function soundFilesForEvent(eventName, wwiseIndex) {
  const event = wwiseIndex.events?.[eventName];
  if (!event) return [];
  const out = [];
  for (const bank of event.banks || []) {
    const candidates = [
      join(WWISE_EXTRACT_ROOT, `${bank}.bnk`),
      join(CLIENT_WWISE_ROOT, `${bank}.bnk`),
      join(CLIENT_WWISE_ROOT, 'base', `${bank}.bnk`),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    out.push({ kind: 'bank', id: bank, localPath: found ? relPath(found) : '' });
  }
  for (const id of event.wems?.streamed || []) {
    const candidates = [
      join(WWISE_EXTRACT_ROOT, `${id}.wem`),
      join(CLIENT_WWISE_ROOT, `${id}.wem`),
      join(CLIENT_WWISE_ROOT, 'base', `${id}.wem`),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    out.push({ kind: 'streamed-wem', id: String(id), localPath: found ? relPath(found) : '' });
  }
  for (const id of event.wems?.inMemory || []) {
    const candidates = [
      join(WWISE_EXTRACT_ROOT, `${id}.wem`),
      join(TOOL_DIR, 'audio-cache', `${id}.ogg`),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    out.push({ kind: 'in-memory-wem', id: String(id), localPath: found ? relPath(found) : 'embedded in bank or anonymous pak bank' });
  }
  return out;
}

function scanFileForReferences(node, wwiseIndex) {
  const localPath = resolveLocalPath(node.path);
  if (!localPath || !existsSync(localPath)) return { refs: [], sounds: [], errors: [`missing local file for ${node.path}`] };
  const buffer = readFileSync(localPath);
  const strings = findStrings(buffer, 4);
  const refs = new Set();
  const sounds = [];

  for (const item of strings) {
    for (const ref of extractResourcePathsFromString(item.str)) refs.add(ref);
  }

  for (let index = 0; index < strings.length; index++) {
    const marker = strings[index].str;
    if (marker !== 'FMOD' && marker !== 'Wwise') continue;
    let event = null;
    let bank = null;
    const candidates = [];
    for (let lookahead = index + 1; lookahead < strings.length && lookahead < index + 14; lookahead++) {
      const value = strings[lookahead].str;
      if (value.length < 3) continue;
      if (!/^[A-Za-z0-9_\/\-]{3,}$/.test(value)) continue;
      if (!event && value.includes('/')) {
        event = value;
        continue;
      }
      if (!bank && /^[A-Za-z][A-Za-z0-9_]+$/.test(value) && value.length <= 32) {
        bank = value;
        continue;
      }
      candidates.push(value);
    }
    const resolved = event
      ? resolveFmodToWwise(event, wwiseIndex.byHash, candidates, 10, wwiseIndex.playableIds)
      : [];
    sounds.push({
      sourceFile: node.path,
      system: marker,
      bank,
      event,
      candidates: candidates.slice(0, 10),
      wwise: resolved.map((item) => ({
        ...item,
        files: soundFilesForEvent(item.name, wwiseIndex),
      })),
    });
  }

  return { refs: [...refs], sounds, errors: [] };
}

function walkTraceFiles(trace, sink, query, owner) {
  for (const file of trace.files || []) {
    addNode(sink, file.path, {
      category: file.category || classifyPath(file.path),
      source: file.source || owner,
      note: file.note || '',
      query,
      depth: 0,
      discoveredBy: owner,
    });
  }
  for (const ref of trace.playSfxRefs || []) {
    const scriptFile = ref.skill?.ScriptFile || ref.ScriptFile || '';
    if (scriptFile && scriptFile !== 'Default.lua') {
      addNode(sink, `scripts/skill/${scriptFile}`, {
        category: 'script',
        source: `PlaySfx ${ref.id || ref.skill?.ID || ''}`.trim(),
        note: ref.skill?.SkillName || '',
        query,
        depth: 0,
        discoveredBy: owner,
      });
      addNode(sink, `skill/${scriptFile}`, {
        category: 'script',
        source: `PlaySfx ${ref.id || ref.skill?.ID || ''}`.trim(),
        note: ref.skill?.SkillName || '',
        query,
        depth: 0,
        discoveredBy: owner,
      });
    }
  }
}

function addNode(map, logicalPath, meta) {
  const pathValue = normalizeSlashes(logicalPath);
  if (!pathValue || !RESOURCE_EXT_RE.test(pathValue)) return null;
  const existing = map.get(pathValue);
  if (existing) {
    existing.queries.add(meta.query || '');
    existing.sources.add(meta.source || meta.discoveredBy || 'unknown');
    existing.depth = Math.min(existing.depth, meta.depth ?? existing.depth);
    return existing;
  }
  const localPath = resolveLocalPath(pathValue);
  const node = {
    path: pathValue,
    category: meta.category || classifyPath(pathValue),
    depth: meta.depth ?? 0,
    note: meta.note || '',
    discoveredBy: meta.discoveredBy || '',
    queries: new Set([meta.query || '']),
    sources: new Set([meta.source || meta.discoveredBy || 'unknown']),
    localPath: localPath ? relPath(localPath) : '',
    extracted: Boolean(localPath),
    scanned: false,
  };
  map.set(pathValue, node);
  return node;
}

function serializeNode(node) {
  const localPath = resolveLocalPath(node.path);
  return {
    path: node.path,
    category: node.category,
    depth: node.depth,
    queries: [...node.queries].filter(Boolean),
    sources: [...node.sources].filter(Boolean),
    discoveredBy: node.discoveredBy,
    note: node.note,
    localPath: localPath ? relPath(localPath) : '',
    extracted: Boolean(localPath),
    scanned: node.scanned,
  };
}

function statusCounts(nodes) {
  const byCategory = {};
  let extracted = 0;
  let missing = 0;
  for (const node of nodes.values()) {
    const category = node.category;
    byCategory[category] = (byCategory[category] || 0) + 1;
    if (resolveLocalPath(node.path)) extracted++;
    else missing++;
  }
  return { total: nodes.size, extracted, missing, byCategory };
}

function markdownReport(report) {
  const lines = [];
  lines.push('# Ability Reference Extraction Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Queries: ${report.queries.join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Trace results: ${report.traceResults.length}`);
  lines.push(`- Files found: ${report.counts.total}`);
  lines.push(`- Extracted/local: ${report.counts.extracted}`);
  lines.push(`- Missing after extraction: ${report.counts.missing}`);
  lines.push(`- Sound markers found while scanning extracted files: ${report.sounds.length}`);
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  for (const [category, count] of Object.entries(report.counts.byCategory).sort()) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push('');
  lines.push('## Sound Markers');
  lines.push('');
  if (!report.sounds.length) {
    lines.push('- No FMOD/Wwise markers were discovered in the extracted referenced files.');
  } else {
    for (const sound of report.sounds.slice(0, 80)) {
      lines.push(`- ${sound.sourceFile}: ${sound.system} ${sound.event || '(no event path)'} ${sound.bank ? `(bank ${sound.bank})` : ''}`);
      for (const candidate of sound.wwise.slice(0, 5)) {
        lines.push(`  - Wwise ${candidate.id} ${candidate.name} playable=${candidate.playable}`);
        for (const file of candidate.files.slice(0, 6)) lines.push(`    - ${file.kind} ${file.id}: ${file.localPath || 'missing'}`);
      }
    }
  }
  lines.push('');
  lines.push('## Missing Files');
  lines.push('');
  const missing = report.files.filter((file) => !file.extracted);
  if (!missing.length) {
    lines.push('- None.');
  } else {
    for (const file of missing.slice(0, 120)) lines.push(`- ${file.category}: ${file.path}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  ensureDir(join(REPO_ROOT, 'log'));
  console.error(`[trace] queries: ${options.queries.join(', ')}`);
  const nodes = new Map();
  const traceResults = [];
  const traceSounds = [];
  for (const query of options.queries) {
    console.error(`[trace] searching ${query}`);
    const result = buildAbilityMatcherSearch({ query, limit: options.limit });
    for (const trace of result.results || []) {
      traceResults.push({ query, id: trace.id, kind: trace.kind || 'skill', skill: trace.skill, alias: trace.matchAlias, countFiles: (trace.files || []).length });
      walkTraceFiles(trace, nodes, query, `${query}:${trace.id}`);
      for (const hint of trace.soundHints || []) {
        traceSounds.push({ query, id: trace.id, ...hint });
      }
    }
  }

  const extractionPasses = [];
  const scanErrors = [];
  const discoveredSounds = [];
  const wwiseIndex = loadWwiseIndex();
  console.error(`[trace] initial referenced files: ${nodes.size}`);

  for (let depth = 0; depth <= options.maxDepth; depth++) {
    const pendingExtract = [...nodes.values()]
      .filter((node) => node.depth <= depth)
      .filter((node) => !resolveLocalPath(node.path))
      .map((node) => node.path);
    const extraction = extractPakv4Files(pendingExtract);
    extractionPasses.push({ depth, ...extraction });

    let scannedThisDepth = 0;
    for (const node of [...nodes.values()].filter((item) => item.depth <= depth && !item.scanned)) {
      const localPath = resolveLocalPath(node.path);
      if (!localPath || !existsSync(localPath)) continue;
      const stats = statSync(localPath);
      if (stats.size > MAX_SCAN_BYTES) continue;
      node.scanned = true;
      scannedThisDepth++;
      const scanned = scanFileForReferences(node, wwiseIndex);
      scanErrors.push(...scanned.errors);
      for (const sound of scanned.sounds) discoveredSounds.push(sound);
      for (const ref of scanned.refs) {
        if (nodes.size > 5000) break;
        addNode(nodes, ref, {
          category: classifyPath(ref),
          source: `discovered in ${node.path}`,
          query: [...node.queries][0] || '',
          depth: depth + 1,
          discoveredBy: node.path,
        });
      }
    }
    extractionPasses[extractionPasses.length - 1].scanned = scannedThisDepth;
    console.error(`[scan] depth=${depth} pending=${pendingExtract.length} scanned=${scannedThisDepth} total=${nodes.size} sounds=${discoveredSounds.length}`);
    if (!pendingExtract.length && scannedThisDepth === 0) break;
  }

  const files = [...nodes.values()].map(serializeNode).sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
  const report = {
    generatedAt: new Date().toISOString(),
    queries: options.queries,
    maxDepth: options.maxDepth,
    traceResults,
    traceSoundHints: traceSounds,
    extractionPasses,
    counts: statusCounts(nodes),
    sounds: discoveredSounds,
    scanErrors,
    files,
  };

  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(REPORT_MD, markdownReport(report), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    reportJson: relPath(REPORT_JSON),
    reportMarkdown: relPath(REPORT_MD),
    queries: report.queries,
    counts: report.counts,
    traceResults: report.traceResults,
    traceSoundHints: report.traceSoundHints.length,
    discoveredSoundMarkers: report.sounds.length,
    extractionPasses: report.extractionPasses,
    missing: report.files.filter((file) => !file.extracted).slice(0, 20),
  }, null, 2));
}

main();