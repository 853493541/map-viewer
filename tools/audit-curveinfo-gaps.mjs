import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = process.env.PSS_AUDIT_BASE_URL || 'http://127.0.0.1:3015';
const outputDir = 'log';
const catalogLimit = Number(process.env.PSS_AUDIT_LIMIT || 500);
const concurrency = Math.max(1, Math.min(12, Number(process.env.PSS_AUDIT_CONCURRENCY || 1)));
const requestTimeoutMs = Math.max(5_000, Number(process.env.PSS_AUDIT_TIMEOUT_MS || 60_000));

const curveStatusKeys = ['colorCurveStatus', 'sizeCurveStatus'];
const suspiciousTextPattern = /[\uFFFD\u758A\u5445\u5A9A\u5419\u571A]|^-?\d+\.\d{5,}$/u;

function basename(path) {
	return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

function increment(map, key) {
	const safeKey = key == null || key === '' ? '(blank)' : String(key);
	map[safeKey] = (map[safeKey] || 0) + 1;
}

async function fetchJson(path) {
	const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
	if (!response.ok) throw new Error(`${response.status} ${path}`);
	return response.json();
}

function firstKeyShape(entry) {
	const key = Array.isArray(entry?.keys) && entry.keys.length > 0 ? entry.keys[0] : null;
	if (!key || typeof key !== 'object') return [];
	return Object.keys(key).filter((name) => name !== 'index').sort();
}

function hasSamplerValue(entry) {
	const key = Array.isArray(entry?.keys) && entry.keys.length > 0 ? entry.keys[0] : null;
	if (!key || typeof key !== 'object') return false;
	return ['value', 'x', 'a', 'y', 'b', 'z', 'c', 'w', 'd'].some((name) => Number.isFinite(key[name]));
}

function hasUsableKeys(entry) {
	return entry && entry.decoded !== false && Array.isArray(entry.keys) && entry.keys.length > 0;
}

function makeIssue(type, severity, sourcePath, block, occurrence, details) {
	return {
		type,
		severity,
		sourcePath,
		file: basename(sourcePath),
		block,
		occurrence,
		...details,
	};
}

function auditStrings(sourcePath, detail, issues, summary) {
	const strings = Array.isArray(detail?.detail?.strings) ? detail.detail.strings : [];
	for (const row of strings) {
		const text = String(row?.text || '');
		if (!text || !suspiciousTextPattern.test(text)) continue;
		if (text.includes('Microsoft (R) HLSL Shader Compiler')) continue;
		increment(summary.suspiciousStringCategories, row?.category || '(none)');
		issues.push(makeIssue('suspicious-detail-string', 'medium', sourcePath, row?.block ?? null, null, {
			section: 'PSS detail strings',
			category: row?.category || null,
			text: text.slice(0, 180),
			proof: 'Detail string contains replacement/mojibake characters or a raw long float token, so it needs human review before being shown as meaningful text.',
		}));
	}
}

function auditEmitterStatuses(sourcePath, detail, issues, summary) {
	const emitters = Array.isArray(detail?.analyze?.emitters) ? detail.analyze.emitters : [];
	summary.emitters += emitters.length;
	for (const emitter of emitters) {
		increment(summary.emitterTypes, emitter?.type || '(none)');
		if (emitter?.type !== 'sprite') continue;
		summary.spriteEmitters++;
		for (const key of curveStatusKeys) {
			const status = emitter?.[key] || '(missing)';
			increment(summary.curveStatuses[key], status);
			if (status === 'unparsed') {
				issues.push(makeIssue('sprite-curve-status-unparsed', 'high', sourcePath, emitter.index, null, {
					section: 'Parsed Emitters / Field Coverage Notes',
					field: key,
					status,
					modules: emitter.modules || [],
					proof: `${key} is still unparsed on a sprite emitter; the detail modal should mark this red and the payload needs a decoder or a proven default classification.`,
				}));
			}
		}
		if (Array.isArray(emitter.unknownModules) && emitter.unknownModules.length > 0) {
			for (const moduleName of emitter.unknownModules) increment(summary.unknownModules, moduleName);
			issues.push(makeIssue('unknown-module-name', 'medium', sourcePath, emitter.index, null, {
				section: 'Parsed Emitters / Modules',
				unknownModules: emitter.unknownModules,
				proof: 'The parser surfaced module text but did not promote it into the known module set; this may hide authored curve data until triaged.',
			}));
		}
	}
}

function auditCurveInfo(sourcePath, dump, detail, issues, summary) {
	const blocks = Array.isArray(dump?.blocks) ? dump.blocks : [];
	summary.blocks += blocks.length;
	for (const block of blocks) {
		const curveInfo = block?.parsed?.curveInfo || null;
		if (!curveInfo || typeof curveInfo !== 'object') continue;
		for (const [moduleKey, entries] of Object.entries(curveInfo)) {
			if (!Array.isArray(entries)) continue;
			for (let occurrence = 0; occurrence < entries.length; occurrence++) {
				const entry = entries[occurrence];
				const layoutKind = entry?.layoutKind || '(none)';
				increment(summary.layoutKinds, `${moduleKey}:${layoutKind}`);
				if (entry?.decoded === false || layoutKind === 'unknown-blob' || entry?.decodeWarning) {
					issues.push(makeIssue('curve-entry-undecoded', 'high', sourcePath, block.index, occurrence, {
						section: 'PSS Debug Dump JSON / parsed.curveInfo',
						moduleKey,
						layoutKind,
						decoded: entry?.decoded ?? null,
						payloadBytes: entry?.payloadBytes ?? null,
						decodeWarning: entry?.decodeWarning || null,
						proof: 'curveInfo entry is visible but not decoded; this is a parser gap unless the payload can be reclassified as a proven engine default.',
					}));
				}
				if (moduleKey === 'scale' && hasUsableKeys(entry) && !hasSamplerValue(entry)) {
					issues.push(makeIssue('renderer-scale-key-shape-not-sampled', 'high', sourcePath, block.index, occurrence, {
						section: 'Renderer structured curve sampler',
						moduleKey,
						layoutKind,
						keyCount: entry.keys.length,
						firstKeyShape: firstKeyShape(entry),
						firstKey: entry.keys[0] || null,
						proof: 'Renderer sampleEmitterCurve1D could not read a scalar from this decoded scale key shape, so the parsed curve cannot affect rendered scale as-is.',
					}));
				}
			}
			if (moduleKey === 'scale' && entries.length > 1) {
				const first = entries[0];
				const laterUsableIndex = entries.findIndex((entry, index) => index > 0 && hasUsableKeys(entry) && hasSamplerValue(entry));
				const sampledEntry = hasUsableKeys(first) ? first : entries.find((entry) => hasUsableKeys(entry));
				if (laterUsableIndex > 0 && (!sampledEntry || !hasSamplerValue(sampledEntry))) {
					const later = entries[laterUsableIndex];
					issues.push(makeIssue('renderer-scale-occurrence-not-sampled', 'high', sourcePath, block.index, laterUsableIndex, {
						section: 'Renderer structured curve sampler',
						firstOccurrenceLayout: first?.layoutKind || null,
						firstOccurrenceKeyCount: Array.isArray(first?.keys) ? first.keys.length : null,
						sampledOccurrence: 0,
						usableOccurrence: laterUsableIndex,
						usableLayoutKind: later?.layoutKind || null,
						usableKeyCount: later?.keys?.length ?? null,
						proof: 'Renderer calls sampleEmitterCurve1D(em, "scale") without an occurrence index; this verifies pickCurveEntry can fall back when occurrence 0 has no usable keys.',
					}));
				}
			}
		}
	}
}

async function auditOne(item) {
	const sourcePath = item.sourcePath;
	const encoded = encodeURIComponent(sourcePath);
	const detail = await fetchJson(`/api/pss/detail?sourcePath=${encoded}`);
	const dump = await fetchJson(`/api/pss/debug-dump?sourcePath=${encoded}`);
	const issues = [];
	const summary = {
		sourcePath,
		file: basename(sourcePath),
		ok: detail?.ok !== false,
		emitters: 0,
		spriteEmitters: 0,
		blocks: 0,
		emitterTypes: {},
		curveStatuses: { colorCurveStatus: {}, sizeCurveStatus: {} },
		layoutKinds: {},
		unknownModules: {},
		suspiciousStringCategories: {},
	};
	auditEmitterStatuses(sourcePath, detail, issues, summary);
	auditCurveInfo(sourcePath, dump, detail, issues, summary);
	auditStrings(sourcePath, detail, issues, summary);
	return { sourcePath, summary, issues };
}

async function runPool(items, worker) {
	const results = new Array(items.length);
	let nextIndex = 0;
	let completed = 0;
	async function runWorker() {
		for (;;) {
			const index = nextIndex++;
			if (index >= items.length) return;
			if (index % 10 === 0 || index === items.length - 1) {
				console.log(`[audit] ${index + 1}/${items.length} ${items[index]?.sourcePath || ''}`);
			}
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				results[index] = {
					sourcePath: items[index]?.sourcePath || '',
					summary: null,
					issues: [makeIssue('audit-fetch-error', 'high', items[index]?.sourcePath || '', null, null, {
						section: 'API fetch',
						proof: error?.message || String(error),
					})],
				};
			}
			completed++;
			if (completed % 25 === 0 || completed === items.length) {
				console.log(`[audit] completed ${completed}/${items.length}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
	return results;
}

function mergeSummary(results) {
	const merged = {
		files: results.length,
		emitters: 0,
		spriteEmitters: 0,
		blocks: 0,
		emitterTypes: {},
		curveStatuses: { colorCurveStatus: {}, sizeCurveStatus: {} },
		layoutKinds: {},
		unknownModules: {},
		suspiciousStringCategories: {},
		issuesByType: {},
		issuesBySeverity: {},
	};
	for (const result of results) {
		const summary = result.summary;
		if (summary) {
			merged.emitters += summary.emitters;
			merged.spriteEmitters += summary.spriteEmitters;
			merged.blocks += summary.blocks;
			for (const [key, value] of Object.entries(summary.emitterTypes)) merged.emitterTypes[key] = (merged.emitterTypes[key] || 0) + value;
			for (const statusKey of curveStatusKeys) {
				for (const [key, value] of Object.entries(summary.curveStatuses[statusKey])) {
					merged.curveStatuses[statusKey][key] = (merged.curveStatuses[statusKey][key] || 0) + value;
				}
			}
			for (const [key, value] of Object.entries(summary.layoutKinds)) merged.layoutKinds[key] = (merged.layoutKinds[key] || 0) + value;
			for (const [key, value] of Object.entries(summary.unknownModules)) merged.unknownModules[key] = (merged.unknownModules[key] || 0) + value;
			for (const [key, value] of Object.entries(summary.suspiciousStringCategories)) merged.suspiciousStringCategories[key] = (merged.suspiciousStringCategories[key] || 0) + value;
		}
		for (const issue of result.issues) {
			increment(merged.issuesByType, issue.type);
			increment(merged.issuesBySeverity, issue.severity);
		}
	}
	return merged;
}

function topEntries(map, limit = 20) {
	return Object.entries(map || {})
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([key, count]) => ({ key, count }));
}

function markdownReport(report) {
	const lines = [];
	lines.push('# PSS Stage 3 Parser/Renderer Audit');
	lines.push('');
	lines.push(`- Base URL: ${baseUrl}`);
	lines.push(`- Files audited: ${report.summary.files}`);
	lines.push(`- Sprite emitters: ${report.summary.spriteEmitters}`);
	lines.push(`- Issues: ${report.issues.length}`);
	lines.push('');
	lines.push('## Issue Counts');
	lines.push('| Type | Count |');
	lines.push('|---|---:|');
	for (const row of topEntries(report.summary.issuesByType, 30)) lines.push(`| ${row.key} | ${row.count} |`);
	lines.push('');
	lines.push('## Curve Status Counts');
	lines.push('| Field | Status | Count |');
	lines.push('|---|---|---:|');
	for (const field of curveStatusKeys) {
		for (const row of topEntries(report.summary.curveStatuses[field], 20)) lines.push(`| ${field} | ${row.key} | ${row.count} |`);
	}
	lines.push('');
	lines.push('## High-Severity Samples');
	lines.push('| Type | File | Block | Occ | Proof |');
	lines.push('|---|---|---:|---:|---|');
	for (const issue of report.issues.filter((item) => item.severity === 'high').slice(0, 60)) {
		const proof = String(issue.proof || issue.decodeWarning || '').replace(/\|/g, '/').slice(0, 220);
		lines.push(`| ${issue.type} | ${issue.file} | ${issue.block ?? ''} | ${issue.occurrence ?? ''} | ${proof} |`);
	}
	lines.push('');
	return lines.join('\n');
}

mkdirSync(outputDir, { recursive: true });
const catalog = await fetchJson(`/api/pss/find?limit=${encodeURIComponent(String(catalogLimit))}`);
const items = Array.isArray(catalog.items) ? catalog.items : [];
if (items.length === 0) throw new Error('No PSS files returned from /api/pss/find');

console.log(`[audit] catalog files: ${items.length}; concurrency: ${concurrency}; timeoutMs: ${requestTimeoutMs}`);
const results = await runPool(items, auditOne);
const issues = results.flatMap((result) => result.issues || []);
const report = {
	generatedAt: new Date().toISOString(),
	baseUrl,
	catalogCount: catalog.count,
	auditedCount: items.length,
	summary: mergeSummary(results),
	results,
	issues,
};

const jsonPath = join(outputDir, 'pss-stage3-audit.json');
const mdPath = join(outputDir, 'pss-stage3-audit.md');
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
writeFileSync(mdPath, markdownReport(report), 'utf8');

console.log(`[audit] wrote ${jsonPath}`);
console.log(`[audit] wrote ${mdPath}`);
console.log(`[audit] issues: ${issues.length}`);
console.log(`[audit] issue types: ${JSON.stringify(report.summary.issuesByType)}`);
