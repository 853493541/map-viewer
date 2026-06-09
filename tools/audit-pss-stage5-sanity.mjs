import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = process.env.PSS_STAGE5_BASE_URL || process.env.PSS_AUDIT_BASE_URL || 'http://127.0.0.1:3015';
const outputDir = 'log';
const catalogLimit = Number(process.env.PSS_STAGE5_LIMIT || process.env.PSS_AUDIT_LIMIT || 500);
const concurrency = Math.max(1, Math.min(8, Number(process.env.PSS_STAGE5_CONCURRENCY || process.env.PSS_AUDIT_CONCURRENCY || 2)));
const requestTimeoutMs = Math.max(10_000, Number(process.env.PSS_STAGE5_TIMEOUT_MS || process.env.PSS_AUDIT_TIMEOUT_MS || 300_000));

const stageChart = [
	{ stage: 'Stage 1', goal: 'Make PSS inspectable', gate: 'Header, TOC, strings, emitter lists visible in page/API', status: 'done' },
	{ stage: 'Stage 2', goal: 'Decode structural emitters', gate: 'Sprite, mesh, trail/track, camera-shake, materials, textures surfaced', status: 'done' },
	{ stage: 'Stage 3', goal: 'Close blocker parser audit', gate: 'unknown-blob/unparsed/renderer-scale issue classes are zero', status: 'done' },
	{ stage: 'Stage 4', goal: 'Discover accepted-but-strange structures', gate: 'Stage 4 candidate findings are zero', status: 'done' },
	{ stage: 'Stage 5', goal: 'Residual sanity sweep', gate: 'No live PSS output still exposes unknown/fallback/warning/unresolved markers', status: 'now' },
];

const markerPattern = /unknown|fallback|unparsed|undecoded|decode\s*warning|warning|failed|error|missing|unresolved/i;
const badStatusPattern = /unknown|fallback|unparsed|undecoded|warning|failed|error|missing|unresolved/i;

function basename(path) {
	return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path) {
	let lastError = null;
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
			if (!response.ok) throw new Error(`${response.status} ${path}`);
			return response.json();
		} catch (error) {
			lastError = error;
			if (attempt >= 5) break;
			await wait(750 * attempt);
		}
	}
	throw lastError;
}

function increment(map, key) {
	const safeKey = key == null || key === '' ? '(blank)' : String(key);
	map[safeKey] = (map[safeKey] || 0) + 1;
}

function countArray(value) {
	return Array.isArray(value) ? value.length : 0;
}

function compactText(value, max = 180) {
	return String(value || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, max);
}

function isEmptyValue(value) {
	if (value == null) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value).length === 0;
	return value === false;
}

function makeIssue(type, severity, sourcePath, details = {}) {
	return {
		type,
		severity,
		sourcePath,
		file: basename(sourcePath),
		...details,
	};
}

function pushIssue(issues, summary, issue) {
	issues.push(issue);
	increment(summary.issuesByType, issue.type);
	increment(summary.issuesBySeverity, issue.severity);
}

function safeIssueKey(issue) {
	return [issue.type, issue.sourcePath, issue.path || '', issue.block ?? '', issue.moduleKey || '', issue.occurrence ?? '', issue.value || issue.field || ''].join('|');
}

function pushUniqueIssue(issues, summary, seen, issue) {
	const key = safeIssueKey(issue);
	if (seen.has(key)) return;
	seen.add(key);
	pushIssue(issues, summary, issue);
}

function typedMarkerStringIssue(sourcePath, pathText, keyText, value) {
	if (/^\$\.analyze\.emitters\.\d+\.tailParams\.semantic$/i.test(pathText) && value === 'unknown') {
		const blockMatch = pathText.match(/^\$\.analyze\.emitters\.(\d+)\./i);
		return makeIssue('stage5-tail-params-unknown-semantic', 'medium', sourcePath, {
			block: blockMatch ? Number(blockMatch[1]) : '',
			path: pathText,
			field: keyText,
			value,
			proof: 'A sprite emitter still exposes decoded tail parameters with semantic=unknown.',
		});
	}

	if (/^\$\.analyze\.emitters\.\d+\.colorCurveSource$/i.test(pathText) && /\(undecoded\)/i.test(value)) {
		const blockMatch = pathText.match(/^\$\.analyze\.emitters\.(\d+)\./i);
		return makeIssue('stage5-color-curve-source-undecoded', 'medium', sourcePath, {
			block: blockMatch ? Number(blockMatch[1]) : '',
			path: pathText,
			field: keyText,
			value,
			proof: 'A declared color module is classified as no-animation but the source string still says undecoded.',
		});
	}

	return null;
}

function isBenignMarkerStringPath(pathText, keyText) {
	if (/^\$\.resolved\.\d+$/i.test(pathText)) return true;
	if (/^\$\.socket\.source$/i.test(pathText)) return true;
	if (/^\$\.detail\.toc\./i.test(pathText)) return true;
	if (/^\$\.blocks\.\d+\.authoritative\./i.test(pathText)) return true;
	if (/^\$\.blocks\.\d+\.parsed\.tailParams\.semantic$/i.test(pathText)) return true;
	if (/\.note$|\.proof$|\.howFound$|\.layout$/i.test(pathText)) return true;
	if (/^note$|^proof$|^howFound$|^layout$/i.test(keyText)) return true;
	return false;
}

function scanMarkerFields(sourcePath, root, issues, summary, seen, options = {}) {
	const maxIssuesPerFile = options.maxIssuesPerFile ?? 80;
	let fileIssues = 0;
	const ancestors = new Set();

	function visit(value, path, key) {
		if (fileIssues >= maxIssuesPerFile) return;
		if (isEmptyValue(value)) return;

		const pathText = path.join('.');
		const keyText = String(key || '');

		if (/unknownModules$/i.test(keyText) && Array.isArray(value) && value.length > 0) {
			fileIssues++;
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unknown-module-list', 'high', sourcePath, {
				path: pathText,
				value: compactText(value.join(', '), 220),
				proof: 'PSS analyzer still exposes unknownModules with unresolved module names.',
			}));
			return;
		}

		if (/warning|error|failure|failed/i.test(keyText) && !isEmptyValue(value)) {
			fileIssues++;
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-warning-field', 'high', sourcePath, {
				path: pathText,
				field: keyText,
				value: compactText(typeof value === 'string' ? value : JSON.stringify(value), 260),
				proof: 'Live PSS output still contains a non-empty warning/error/failure field.',
			}));
		}

		if (/fallback|unknown|unresolved|missing|unparsed|undecoded/i.test(keyText) && !isEmptyValue(value)) {
			fileIssues++;
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-marker-field', 'medium', sourcePath, {
				path: pathText,
				field: keyText,
				value: compactText(typeof value === 'string' ? value : JSON.stringify(value), 260),
				proof: 'Live PSS output still has a suspicious marker in a field name with a non-empty value.',
			}));
		}

		if (typeof value === 'string' && markerPattern.test(value)) {
			const typedIssue = typedMarkerStringIssue(sourcePath, pathText, keyText, value);
			if (typedIssue) {
				fileIssues++;
				pushUniqueIssue(issues, summary, seen, typedIssue);
			} else if (!isBenignMarkerStringPath(pathText, keyText)) {
				fileIssues++;
				pushUniqueIssue(issues, summary, seen, makeIssue('stage5-marker-string', 'medium', sourcePath, {
					path: pathText,
					field: keyText,
					value: compactText(value, 260),
					proof: 'Live PSS output still contains a suspicious marker word in a string value.',
				}));
			}
		}

		if (!value || typeof value !== 'object') return;
		if (ancestors.has(value)) return;
		ancestors.add(value);

		if (Array.isArray(value)) {
			value.forEach((entry, index) => visit(entry, path.concat(index), index));
		} else {
			for (const [childKey, childValue] of Object.entries(value)) {
				visit(childValue, path.concat(childKey), childKey);
			}
		}
		ancestors.delete(value);
	}

	visit(root, ['$'], '$');
}

function scanEmitterSanity(sourcePath, detail, issues, summary, seen) {
	const emitters = Array.isArray(detail?.analyze?.emitters) ? detail.analyze.emitters : [];
	for (const emitter of emitters) {
		const block = emitter.index;
		for (const key of ['sizeCurveStatus', 'colorCurveStatus', 'alphaCurveStatus', 'textureStatus', 'materialStatus', 'trackBindingStatus']) {
			const value = emitter[key];
			if (typeof value === 'string' && badStatusPattern.test(value)) {
				pushUniqueIssue(issues, summary, seen, makeIssue('stage5-bad-emitter-status', 'high', sourcePath, {
					block,
					field: key,
					value,
					proof: 'Emitter status still reports a bad/unknown/fallback/unresolved state.',
				}));
			}
		}

		if (Array.isArray(emitter.unknownModules) && emitter.unknownModules.length > 0) {
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unknown-module-list', 'high', sourcePath, {
				block,
				value: emitter.unknownModules.join(', '),
				proof: 'Emitter still carries unknownModules.',
			}));
		}

		const textureCount = Math.max(countArray(emitter.texturePaths), countArray(emitter.textures));
		if (textureCount > countArray(emitter.resolvedTextures)) {
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unresolved-texture-reference', 'high', sourcePath, {
				block,
				textureCount,
				resolvedTextureCount: countArray(emitter.resolvedTextures),
				proof: 'Emitter still has texture references that do not resolve.',
			}));
		}

		if (countArray(emitter.meshes) > countArray(emitter.resolvedMeshes)) {
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unresolved-mesh-reference', 'high', sourcePath, {
				block,
				meshCount: countArray(emitter.meshes),
				resolvedMeshCount: countArray(emitter.resolvedMeshes),
				proof: 'Emitter still has mesh references that do not resolve.',
			}));
		}

		if (countArray(emitter.animations) > countArray(emitter.resolvedAnimations)) {
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unresolved-animation-reference', 'medium', sourcePath, {
				block,
				animationCount: countArray(emitter.animations),
				resolvedAnimationCount: countArray(emitter.resolvedAnimations),
				proof: 'Emitter still has animation references that do not resolve.',
			}));
		}

		if (countArray(emitter.tracks) > countArray(emitter.resolvedTracks)) {
			pushUniqueIssue(issues, summary, seen, makeIssue('stage5-unresolved-track-reference', 'medium', sourcePath, {
				block,
				trackCount: countArray(emitter.tracks),
				resolvedTrackCount: countArray(emitter.resolvedTracks),
				proof: 'Emitter still has track references that do not resolve.',
			}));
		}
	}
}

function scanCurveSanity(sourcePath, dump, issues, summary, seen) {
	for (const block of dump?.blocks || []) {
		const curveInfo = block?.parsed?.curveInfo || null;
		if (!curveInfo || typeof curveInfo !== 'object') continue;
		for (const [moduleKey, entries] of Object.entries(curveInfo)) {
			if (!Array.isArray(entries)) continue;
			for (let occurrence = 0; occurrence < entries.length; occurrence++) {
				const entry = entries[occurrence];
				if (!entry || typeof entry !== 'object') continue;
				if (entry.decoded === false) {
					pushUniqueIssue(issues, summary, seen, makeIssue('stage5-curve-decoded-false', 'high', sourcePath, {
						block: block.index,
						moduleKey,
						occurrence,
						layoutKind: entry.layoutKind || '',
						proof: 'Curve entry still reports decoded:false.',
					}));
				}
				if (entry.decodeWarning) {
					pushUniqueIssue(issues, summary, seen, makeIssue('stage5-curve-decode-warning', 'high', sourcePath, {
						block: block.index,
						moduleKey,
						occurrence,
						layoutKind: entry.layoutKind || '',
						decodeWarning: compactText(entry.decodeWarning, 280),
						proof: 'Curve entry still carries decodeWarning.',
					}));
				}
				if (typeof entry.layoutKind === 'string' && /unknown|fallback|unparsed|undecoded/i.test(entry.layoutKind)) {
					pushUniqueIssue(issues, summary, seen, makeIssue('stage5-bad-curve-layout-kind', 'high', sourcePath, {
						block: block.index,
						moduleKey,
						occurrence,
						layoutKind: entry.layoutKind,
						proof: 'Curve layout kind still contains unknown/fallback/unparsed marker.',
					}));
				}
			}
		}
	}
}

function summarizeResult(sourcePath, detail, dump) {
	const emitterTypes = {};
	const layoutKinds = {};
	for (const emitter of detail?.analyze?.emitters || []) increment(emitterTypes, emitter.type || '(missing)');
	for (const block of dump?.blocks || []) {
		const curveInfo = block?.parsed?.curveInfo || null;
		if (!curveInfo || typeof curveInfo !== 'object') continue;
		for (const [moduleKey, entries] of Object.entries(curveInfo)) {
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) increment(layoutKinds, `${moduleKey}:${entry?.layoutKind || '(missing)'}`);
		}
	}
	return {
		sourcePath,
		file: basename(sourcePath),
		emitters: countArray(detail?.analyze?.emitters),
		emitterTypes,
		layoutKinds,
	};
}

async function main() {
	mkdirSync(outputDir, { recursive: true });
	const catalog = await fetchJson(`/api/pss/find?limit=${catalogLimit}`);
	const items = Array.isArray(catalog.items) ? catalog.items : [];
	const issues = [];
	const seen = new Set();
	const summary = {
		files: 0,
		emitters: 0,
		emitterTypes: {},
		layoutKinds: {},
		issuesByType: {},
		issuesBySeverity: {},
	};
	const results = [];
	let cursor = 0;

	async function worker() {
		while (cursor < items.length) {
			const item = items[cursor++];
			const sourcePath = item.sourcePath;
			try {
				const encoded = encodeURIComponent(sourcePath);
				const [detail, dump] = await Promise.all([
					fetchJson(`/api/pss/detail?sourcePath=${encoded}`),
					fetchJson(`/api/pss/debug-dump?sourcePath=${encoded}`),
				]);
				const result = summarizeResult(sourcePath, detail, dump);
				results.push(result);
				summary.files++;
				summary.emitters += result.emitters;
				for (const [key, count] of Object.entries(result.emitterTypes)) summary.emitterTypes[key] = (summary.emitterTypes[key] || 0) + count;
				for (const [key, count] of Object.entries(result.layoutKinds)) summary.layoutKinds[key] = (summary.layoutKinds[key] || 0) + count;
				scanEmitterSanity(sourcePath, detail, issues, summary, seen);
				scanCurveSanity(sourcePath, dump, issues, summary, seen);
				scanMarkerFields(sourcePath, detail, issues, summary, seen, { maxIssuesPerFile: 40 });
				scanMarkerFields(sourcePath, dump, issues, summary, seen, { maxIssuesPerFile: 40 });
			} catch (error) {
				pushUniqueIssue(issues, summary, seen, makeIssue('stage5-fetch-error', 'high', sourcePath, {
					proof: compactText(error?.message || error, 260),
				}));
			}
			if (summary.files % 25 === 0) console.log(`[stage5] audited ${summary.files}/${items.length}: ${sourcePath}`);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));

	issues.sort((a, b) => (a.severity || '').localeCompare(b.severity || '') || (a.type || '').localeCompare(b.type || '') || (a.sourcePath || '').localeCompare(b.sourcePath || ''));
	results.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

	const report = {
		generatedAt: new Date().toISOString(),
		baseUrl,
		catalogCount: items.length,
		auditedCount: summary.files,
		stageChart,
		summary,
		issues,
		results,
	};

	writeFileSync(join(outputDir, 'pss-stage5-sanity.json'), JSON.stringify(report, null, 2));

	const lines = [];
	lines.push('# PSS Stage 5 Sanity Report');
	lines.push('');
	lines.push(`- Generated: ${report.generatedAt}`);
	lines.push(`- Base URL: ${baseUrl}`);
	lines.push(`- Files audited: ${summary.files}`);
	lines.push(`- Stage 5 findings: ${issues.length}`);
	lines.push('');
	lines.push('## Stage Chart');
	lines.push('| Stage | Goal | Gate | Status |');
	lines.push('|---|---|---|---|');
	for (const row of stageChart) lines.push(`| ${row.stage} | ${row.goal} | ${row.gate} | ${row.status} |`);
	lines.push('');
	lines.push('## Issue Counts');
	lines.push('| Type | Count |');
	lines.push('|---|---:|');
	for (const [type, count] of Object.entries(summary.issuesByType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		lines.push(`| ${type} | ${count} |`);
	}
	lines.push('');
	lines.push('## Severity Counts');
	lines.push('| Severity | Count |');
	lines.push('|---|---:|');
	for (const [severity, count] of Object.entries(summary.issuesBySeverity).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		lines.push(`| ${severity} | ${count} |`);
	}
	lines.push('');
	lines.push('## All Findings');
	lines.push('| Severity | Type | File | Block | Module | Occ | Field/Path | Value | Proof |');
	lines.push('|---|---|---|---:|---|---:|---|---|---|');
	for (const issue of issues) {
		lines.push(`| ${issue.severity || ''} | ${issue.type || ''} | ${issue.file || ''} | ${issue.block ?? ''} | ${issue.moduleKey || ''} | ${issue.occurrence ?? ''} | ${compactText(issue.path || issue.field || '', 120)} | ${compactText(issue.value || issue.layoutKind || issue.decodeWarning || '', 160)} | ${compactText(issue.proof || '', 220)} |`);
	}
	writeFileSync(join(outputDir, 'pss-stage5-sanity.md'), `${lines.join('\n')}\n`);

	console.log(`[stage5] wrote log/pss-stage5-sanity.json and log/pss-stage5-sanity.md with ${issues.length} finding(s)`);
}

main().catch((error) => {
	console.error(error?.stack || error);
	process.exit(1);
});