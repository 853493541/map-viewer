import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = process.env.PSS_STAGE6_BASE_URL || process.env.PSS_AUDIT_BASE_URL || 'http://127.0.0.1:3015';
const outputDir = 'log';
const catalogLimit = Number(process.env.PSS_STAGE6_LIMIT || process.env.PSS_AUDIT_LIMIT || 500);
const concurrency = Math.max(1, Math.min(8, Number(process.env.PSS_STAGE6_CONCURRENCY || process.env.PSS_AUDIT_CONCURRENCY || 4)));
const requestTimeoutMs = Math.max(10_000, Number(process.env.PSS_STAGE6_TIMEOUT_MS || process.env.PSS_AUDIT_TIMEOUT_MS || 300_000));

const stageChart = [
  { stage: 'Stage 1', goal: 'Make PSS inspectable', gate: 'Header, TOC, strings, emitter lists visible in page/API', status: 'done' },
  { stage: 'Stage 2', goal: 'Decode structural emitters', gate: 'Sprite, mesh, trail/track, camera-shake, materials, textures surfaced', status: 'done' },
  { stage: 'Stage 3', goal: 'Close blocker parser audit', gate: 'unknown-blob/unparsed/renderer-scale issue classes are zero', status: 'done' },
  { stage: 'Stage 4', goal: 'Discover accepted-but-strange structures', gate: 'Stage 4 candidate findings are zero', status: 'done' },
  { stage: 'Stage 5', goal: 'Residual sanity sweep', gate: 'Stage 5 marker findings are zero', status: 'done' },
  { stage: 'Stage 6', goal: 'Bit-level semantic proof scan', gate: 'Every exposed uncertain byte/field has a final semantic label or is listed with proof', status: 'now' },
];

function basename(path) {
  return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

function compactText(value, max = 260) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, max);
}

function increment(map, key) {
  const safeKey = key == null || key === '' ? '(blank)' : String(key);
  map[safeKey] = (map[safeKey] || 0) + 1;
}

function hex(buffer) {
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(path, as = 'json') {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) throw new Error(`${response.status} ${path}`);
      if (as === 'arrayBuffer') return Buffer.from(await response.arrayBuffer());
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= 5) break;
      await wait(750 * attempt);
    }
  }
  throw lastError;
}

function issueForUncertainBlock(sourcePath, block, rawBytes) {
  const uncertain = Array.isArray(block?.uncertain) ? block.uncertain : [];
  if (!uncertain.length) return null;
  const cameraShake = block?.parsed?.cameraShake || null;
  const parameters = cameraShake?.parameters || null;
  const isCameraShakeField04 = block?.typeLabel === 'camera-shake'
    && parameters
    && Object.prototype.hasOwnProperty.call(parameters, 'field04Float')
    && Array.isArray(parameters.field04CandidateNames)
    && parameters.field04CandidateNames.length > 0;

  if (isCameraShakeField04) {
    return {
      type: 'stage6-camera-shake-field04-ambiguous',
      severity: 'medium',
      sourcePath,
      file: basename(sourcePath),
      block: block.index,
      section: 'PSS type-4 camera-shake block / KG3D_ParticleCameraShake header',
      offset: block.offset,
      size: block.size,
      rawFirst128Hex: hex(rawBytes.subarray(block.offset, Math.min(block.offset + 128, rawBytes.length))),
      headHex32: block.headHex32,
      field04Float: parameters.field04Float,
      field04CandidateNames: parameters.field04CandidateNames,
      parsedParameters: parameters,
      derived: cameraShake?.derived || null,
      samplesPreview: Array.isArray(cameraShake?.samples) ? cameraShake.samples.slice(0, 6) : [],
      uncertainty: uncertain,
      whatBlobLooksLike: `header fDuration@+0=${parameters.fDuration}, field04@+4=${parameters.field04Float}, sampleRate@+8=${parameters.sampleRateFps}, nType@+40=${parameters.nType}, sampleCount@+52=${parameters.sampleCount}, samples start @+${parameters.sampleDataOffset}`,
      whyWrong: 'The parser decodes the block structure and samples, but the +4 float is still exported as field04Float with candidate names instead of a final engine semantic. That means this byte range is read but not fully named.',
      whyNeedFix: 'Camera shake playback/editor UI cannot faithfully expose or edit the authored shake parameter until +4 is proven as the correct KG3D_ParticleCameraShake member, likely fFrequency or fAmplitude.',
    };
  }

  return {
    type: 'stage6-debug-uncertain-leftover',
    severity: 'medium',
    sourcePath,
    file: basename(sourcePath),
    block: block?.index ?? null,
    section: `${block?.typeLabel || 'unknown'} block`,
    offset: block?.offset ?? null,
    size: block?.size ?? null,
    rawFirst128Hex: block?.offset != null ? hex(rawBytes.subarray(block.offset, Math.min(block.offset + 128, rawBytes.length))) : '',
    headHex32: block?.headHex32 || '',
    uncertainty: uncertain,
    whatBlobLooksLike: 'debug-dump block still carries an uncertainty list',
    whyWrong: 'Stage 6 requires every exposed uncertain parser field to be either fully named or listed as a remaining semantic gap.',
    whyNeedFix: 'Leaving generic uncertainty in the debug API means downstream render/editor logic cannot know whether the field is safe to use semantically.',
  };
}

async function auditOne(item) {
  const sourcePath = item.sourcePath;
  const encoded = encodeURIComponent(sourcePath);
  const [dump, rawBytes] = await Promise.all([
    fetchWithRetry(`/api/pss/debug-dump?sourcePath=${encoded}`),
    fetchWithRetry(`/api/pss/raw-bytes?sourcePath=${encoded}`, 'arrayBuffer'),
  ]);
  const issues = [];
  if (Array.isArray(dump?.uncertain) && dump.uncertain.length) {
    issues.push({
      type: 'stage6-top-level-uncertain-leftover',
      severity: 'medium',
      sourcePath,
      file: basename(sourcePath),
      block: null,
      section: 'PSS debug-dump top-level uncertainty',
      uncertainty: dump.uncertain,
      whatBlobLooksLike: 'file-level debug dump still carries uncertain parser notes',
      whyWrong: 'Stage 6 requires no file-level uncertainty without concrete proof.',
      whyNeedFix: 'File-level uncertainty can hide whole-class parser or renderer gaps.',
    });
  }
  for (const block of dump?.blocks || []) {
    const issue = issueForUncertainBlock(sourcePath, block, rawBytes);
    if (issue) issues.push(issue);
  }
  return {
    sourcePath,
    file: basename(sourcePath),
    blockCount: Array.isArray(dump?.blocks) ? dump.blocks.length : 0,
    uncertainBlockCount: issues.length,
    issues,
  };
}

async function runPool(items) {
  const results = [];
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        results.push(await auditOne(item));
      } catch (error) {
        results.push({
          sourcePath: item?.sourcePath || '',
          file: basename(item?.sourcePath || ''),
          blockCount: 0,
          uncertainBlockCount: 1,
          issues: [{
            type: 'stage6-fetch-error',
            severity: 'high',
            sourcePath: item?.sourcePath || '',
            file: basename(item?.sourcePath || ''),
            block: null,
            section: 'API fetch',
            proof: error?.message || String(error),
            whatBlobLooksLike: 'not fetched',
            whyWrong: 'A full scan cannot prove bit-level status for a file that failed to fetch.',
            whyNeedFix: 'Fetch errors must be resolved before declaring full PSS coverage.',
          }],
        });
      }
      completed++;
      if (completed % 25 === 0 || completed === items.length) console.log(`[stage6] audited ${completed}/${items.length}: ${item?.sourcePath || ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function markdownReport(report) {
  const lines = [];
  lines.push('# PSS Stage 6 Full Scan Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Base URL: ${report.baseUrl}`);
  lines.push(`- Question: Do all PSS bytes now have final semantics?`);
  lines.push(`- Answer: ${report.issues.length === 0 ? 'Yes for scanned debug output.' : 'No. Remaining semantic gaps are listed below with proof.'}`);
  lines.push('');
  lines.push('## Stage Chart');
  lines.push('| Stage | Goal | Gate | Status |');
  lines.push('|---|---|---|---|');
  for (const row of stageChart) lines.push(`| ${row.stage} | ${row.goal} | ${row.gate} | ${row.status} |`);
  lines.push('');
  lines.push('## Problems Found');
  if (!report.issues.length) {
    lines.push('No Stage 6 semantic gaps found.');
  } else {
    for (let index = 0; index < report.issues.length; index++) {
      const issue = report.issues[index];
      lines.push(`### ${index + 1}. ${issue.file} block ${issue.block} — ${issue.type}`);
      lines.push('');
      lines.push(`- Section: ${issue.section}`);
      lines.push(`- Offset/size: ${issue.offset ?? ''} / ${issue.size ?? ''}`);
      lines.push(`- What blob looks like: ${compactText(issue.whatBlobLooksLike, 400)}`);
      lines.push(`- Raw first bytes: ${compactText(issue.rawFirst128Hex, 520)}`);
      if (issue.field04CandidateNames) lines.push(`- Ambiguous field: field04Float=${issue.field04Float}; candidates=${issue.field04CandidateNames.join(', ')}`);
      if (issue.derived) lines.push(`- Structural proof: expectedBlockSize=${issue.derived.expectedBlockSize}; expectedSampleBytes=${issue.derived.expectedSampleBytes}; durationFromSamples=${issue.derived.durationFromSamples}; durationMatchesSamples=${issue.derived.durationMatchesSamples}`);
      if (Array.isArray(issue.samplesPreview) && issue.samplesPreview.length) lines.push(`- Sample preview: ${compactText(JSON.stringify(issue.samplesPreview), 700)}`);
      lines.push(`- Why this is wrong/unknown: ${issue.whyWrong}`);
      lines.push(`- Why this needs fixing: ${issue.whyNeedFix}`);
      lines.push(`- Parser uncertainty: ${compactText((issue.uncertainty || []).join(' / '), 700)}`);
      lines.push('');
    }
  }
  lines.push('## Stats');
  lines.push('');
  lines.push(`- Files audited: ${report.auditedCount}`);
  lines.push(`- Blocks audited: ${report.summary.blocksAudited}`);
  lines.push(`- Stage 6 findings: ${report.issues.length}`);
  lines.push(`- Issue classes: ${Object.entries(report.summary.issuesByType).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  lines.push(`- Severity counts: ${Object.entries(report.summary.issuesBySeverity).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

mkdirSync(outputDir, { recursive: true });
const catalog = await fetchWithRetry(`/api/pss/find?limit=${encodeURIComponent(String(catalogLimit))}`);
const items = Array.isArray(catalog.items) ? catalog.items : [];
if (!items.length) throw new Error('No PSS files returned from /api/pss/find');

console.log(`[stage6] catalog files: ${items.length}; concurrency: ${concurrency}; timeoutMs: ${requestTimeoutMs}`);
const results = await runPool(items);
const issues = results.flatMap((result) => result.issues || []);
const summary = {
  filesAudited: results.length,
  blocksAudited: results.reduce((sum, result) => sum + (result.blockCount || 0), 0),
  issuesByType: {},
  issuesBySeverity: {},
};
for (const issue of issues) {
  increment(summary.issuesByType, issue.type);
  increment(summary.issuesBySeverity, issue.severity);
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  auditedCount: results.length,
  stageChart,
  summary,
  issues,
  results,
};

writeFileSync(join(outputDir, 'pss-stage6-full-scan.json'), JSON.stringify(report, null, 2), 'utf8');
writeFileSync(join(outputDir, 'pss-stage6-full-scan.md'), markdownReport(report), 'utf8');

console.log('[stage6] wrote log/pss-stage6-full-scan.json and log/pss-stage6-full-scan.md');
console.log(`[stage6] findings: ${issues.length}`);
console.log(`[stage6] issue types: ${JSON.stringify(summary.issuesByType)}`);