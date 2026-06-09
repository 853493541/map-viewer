import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = process.env.PSS_STAGE4_BASE_URL || process.env.PSS_AUDIT_BASE_URL || 'http://127.0.0.1:3015';
const outputDir = 'log';
const catalogLimit = Number(process.env.PSS_STAGE4_LIMIT || process.env.PSS_AUDIT_LIMIT || 500);
const concurrency = Math.max(1, Math.min(12, Number(process.env.PSS_STAGE4_CONCURRENCY || process.env.PSS_AUDIT_CONCURRENCY || 1)));
const requestTimeoutMs = Math.max(5_000, Number(process.env.PSS_STAGE4_TIMEOUT_MS || process.env.PSS_AUDIT_TIMEOUT_MS || 180_000));

const stageChart = [
	{ stage: 'Stage 1', goal: 'Make PSS inspectable', gate: 'Header, TOC, strings, emitter lists visible in page/API', status: 'done' },
	{ stage: 'Stage 2', goal: 'Decode structural emitters', gate: 'Sprite, mesh, trail/track, camera-shake, materials, textures surfaced', status: 'done' },
	{ stage: 'Stage 3', goal: 'Close blocker audit rows', gate: 'unknown-blob/unparsed/renderer-scale issue classes are zero', status: 'done' },
	{ stage: 'Stage 4', goal: 'Discover accepted-but-strange payloads', gate: 'This report lists every remaining suspicious/defaulted structure', status: 'now' },
];

const curveLayoutIssues = new Map();

function basename(path) {
	return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

function increment(map, key) {
	const safeKey = key == null || key === '' ? '(blank)' : String(key);
	map[safeKey] = (map[safeKey] || 0) + 1;
}

function countArray(value) {
	return Array.isArray(value) ? value.length : 0;
}

function isFiniteNumber(value) {
	return Number.isFinite(Number(value));
}

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function compactText(value, max = 180) {
	return String(value || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, max);
}

function objectKeys(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
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
			await wait(500 * attempt);
		}
	}
	throw lastError;
}

function makeIssue(type, severity, sourcePath, block, details) {
	return {
		type,
		severity,
		sourcePath,
		file: basename(sourcePath),
		block,
		...details,
	};
}

function pushIssue(issues, summary, issue) {
	issues.push(issue);
	increment(summary.issuesByType, issue.type);
	increment(summary.issuesBySeverity, issue.severity);
}

function firstFiniteCurveValue(key) {
	if (!key || typeof key !== 'object') return null;
	for (const name of ['value', 'x', 'a', 'y', 'b', 'z', 'c', 'w', 'd']) {
		if (Number.isFinite(key[name])) return key[name];
	}
	return null;
}

function hasUsableCurve(entries) {
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) => {
		if (!entry || entry.decoded === false || !Array.isArray(entry.keys) || entry.keys.length === 0) return false;
		return entry.keys.some((key) => Number.isFinite(firstFiniteCurveValue(key)));
	});
}

function hasMeaningfulNumberArray(value) {
	return Array.isArray(value) && value.some((item) => Number.isFinite(Number(item)) && Math.abs(Number(item)) > 0.000001);
}

function hasMeaningfulSizeRuntime(runtimeParams) {
	if (!runtimeParams || typeof runtimeParams !== 'object') return false;
	if (hasMeaningfulNumberArray(runtimeParams.sizeCurve)) return true;
	if (hasMeaningfulNumberArray(runtimeParams.sizeCurveKeyframes)) return true;
	const scalar = finiteNumber(runtimeParams.spatialScalar ?? runtimeParams.scalar);
	return scalar != null && Math.abs(scalar) > 0.000001;
}

function hasMeaningfulColorRuntime(emitter) {
	const colorCurve = Array.isArray(emitter?.colorCurve) ? emitter.colorCurve : [];
	return colorCurve.some((row) => Array.isArray(row) && row.some((value) => Number.isFinite(Number(value)) && Math.abs(Number(value)) > 0.000001));
}

function trailBindingIssueMeta(emitter, trackEmitters) {
	const bindingStatus = String(emitter?.trackBindingStatus || emitter?.trackBinding?.status || 'missing-linked-track');
	if (bindingStatus === 'baked-mesh-animation') return null;
	if (bindingStatus === 'external-runtime-trail') return null;
	if (bindingStatus === 'static-mesh-material') return null;
	if (bindingStatus === 'missing-track-emitter' || trackEmitters.length === 0) {
		return {
			type: 'trail-class-mesh-missing-motion-source',
			severity: 'high',
			proof: 'Trail/ribbon launcher has no sibling type-3 ParticleTrack block and no resolved mesh animation fallback, so no motion source is available.',
		};
	}
	if (bindingStatus === 'missing-motion-source') {
		return {
			type: 'trail-class-mesh-missing-motion-source',
			severity: 'high',
			proof: 'Trail/ribbon launcher has neither a sibling type-3 ParticleTrack block nor a resolved mesh animation fallback, so no motion source is available.',
		};
	}
	if (bindingStatus === 'track-path-missing') {
		return {
			type: 'trail-class-track-emitter-without-track-path',
			severity: 'high',
			proof: 'Trail/ribbon launcher has a sibling type-3 block, but that track block contains no track path.',
		};
	}
	if (bindingStatus === 'track-path-unresolved') {
		return {
			type: 'trail-class-track-reference-unresolved',
			severity: 'medium',
			proof: 'Trail/ribbon launcher has a sibling type-3 track path, but the referenced track asset was not resolved.',
		};
	}
	if (bindingStatus === 'track-undecoded') {
		return {
			type: 'trail-class-track-without-decodable-nodes',
			severity: 'medium',
			proof: 'Trail/ribbon launcher has a resolved sibling track asset, but no decoded node set with nodeCount > 0 is available for rendering.',
		};
	}
	return {
		type: 'trail-class-track-link-index-gap',
		severity: 'medium',
		proof: 'Trail/ribbon launcher has available decoded track data, but linkedTrack was not populated. Stage 4 should inspect ordinal pairing.',
	};
}

function compactProbe(entry) {
	const probe = entry?.structuralProbe || {};
	const out = {};
	for (const key of ['payloadLen', 'tagAt0', 'tagInValidRange', 'selectedKeyFrameType', 'declaredCountAtPlus4', 'declaredCountAtPlus4Hex', 'countFieldExceedsPayload', 'countFieldIsZero', 'trailingBytesAfterCount', 'trailingPrintableRatio', 'trailingAlphaRatio']) {
		if (probe[key] != null) out[key] = probe[key];
	}
	if (probe.firstBytesHex) out.firstBytesHex = compactText(probe.firstBytesHex, 96);
	if (probe.trailingPreviewAscii) out.trailingPreviewAscii = compactText(probe.trailingPreviewAscii, 120);
	if (Array.isArray(probe.bytes)) out.bytes = probe.bytes.slice(0, 32);
	return out;
}

function auditCurveInfo(sourcePath, dump, issues, summary) {
	const blocks = Array.isArray(dump?.blocks) ? dump.blocks : [];
	for (const block of blocks) {
		const curveInfo = block?.parsed?.curveInfo || null;
		if (!curveInfo || typeof curveInfo !== 'object') continue;
		for (const [moduleKey, entries] of Object.entries(curveInfo)) {
			if (!Array.isArray(entries)) continue;
			for (let occurrence = 0; occurrence < entries.length; occurrence++) {
				const entry = entries[occurrence];
				const layoutKind = entry?.layoutKind || '(none)';
				increment(summary.layoutKinds, `${moduleKey}:${layoutKind}`);

				const layoutMeta = curveLayoutIssues.get(layoutKind);
				if (layoutMeta) {
					pushIssue(issues, summary, makeIssue(layoutMeta.type, layoutMeta.severity, sourcePath, block.index, {
						section: 'PSS Debug Dump JSON / parsed.curveInfo',
						moduleKey,
						occurrence,
						layoutKind,
						payloadBytes: entry?.payloadBytes ?? entry?.structuralProbe?.payloadLen ?? null,
						effectiveValue: entry?.effectiveValue || null,
						probe: compactProbe(entry),
						proof: layoutMeta.stage4Why,
					}));
				}

				if (entry?.decodeWarning) {
					pushIssue(issues, summary, makeIssue('decode-warning-leftover', 'high', sourcePath, block.index, {
						section: 'PSS Debug Dump JSON / parsed.curveInfo',
						moduleKey,
						occurrence,
						layoutKind,
						decodeWarning: String(entry.decodeWarning),
						proof: 'Decoder still emitted a warning after Stage 3 cleanup.',
					}));
				}
			}
		}
	}
}

function auditEmitters(sourcePath, detail, dump, issues, summary) {
	const emitters = Array.isArray(detail?.analyze?.emitters) ? detail.analyze.emitters : [];
	const blocksByIndex = new Map((Array.isArray(dump?.blocks) ? dump.blocks : []).map((block) => [block.index, block]));
	const trackEmitters = emitters.filter((emitter) => emitter?.type === 'track');
	summary.emitters += emitters.length;
	for (const emitter of emitters) {
		increment(summary.emitterTypes, emitter?.type || '(none)');
		const block = blocksByIndex.get(emitter?.index);
		const curveInfo = block?.parsed?.curveInfo || {};

		if (emitter?.type === 'sprite') {
			const textureCount = Math.max(countArray(emitter.texturePaths), countArray(emitter.textures));
			const resolvedTextureCount = countArray(emitter.resolvedTextures);
			const layerCount = finiteNumber(emitter.layerCount ?? emitter.declaredLayerCount ?? emitter.detectedLayerCount);
			if (textureCount === 0) {
				pushIssue(issues, summary, makeIssue('sprite-without-texture-reference', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / sprite assets',
					proof: 'Sprite emitter has no texture/material texture reference, so it cannot render as a normal sprite unless another hidden source supplies image data.',
				}));
			} else if (resolvedTextureCount < textureCount) {
				pushIssue(issues, summary, makeIssue('sprite-texture-unresolved', 'medium', sourcePath, emitter.index, {
					section: 'Parsed Emitters / sprite assets',
					textureCount,
					resolvedTextureCount,
					proof: 'Sprite references more textures than the resolver could materialize. Stage 4 should decide whether this is a missing asset path or a parser mapping issue.',
				}));
			}

			if (layerCount != null && textureCount > 0 && textureCount < layerCount) {
				pushIssue(issues, summary, makeIssue('sprite-layer-texture-count-mismatch', 'medium', sourcePath, emitter.index, {
					section: 'Parsed Emitters / sprite assets',
					layerCount,
					textureCount,
					proof: 'Declared/detected layer count exceeds texture count. Multi-layer sprite composition may be incomplete.',
				}));
			}

			if (emitter.sizeCurveStatus === 'authored' && !hasUsableCurve(curveInfo.scale) && !hasMeaningfulSizeRuntime(emitter.runtimeParams)) {
				pushIssue(issues, summary, makeIssue('sprite-authored-size-has-no-sampler-source', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / runtime size',
					modules: emitter.modules || [],
					proof: 'Emitter reports authored size/scale data, but no decoded scale keys or meaningful runtime size values are available for rendering.',
				}));
			}

			if (emitter.colorCurveStatus === 'authored' && !hasUsableCurve(curveInfo.color) && !hasMeaningfulColorRuntime(emitter)) {
				pushIssue(issues, summary, makeIssue('sprite-authored-color-has-no-sampler-source', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / runtime color',
					modules: emitter.modules || [],
					proof: 'Emitter reports authored color data, but no decoded color keys or meaningful colorCurve values are available for rendering.',
				}));
			}

			for (const moduleName of emitter.unknownModules || []) {
				pushIssue(issues, summary, makeIssue('sprite-unknown-module-name', 'medium', sourcePath, emitter.index, {
					section: 'Parsed Emitters / modules',
					moduleName,
					proof: 'Parser surfaced module text that is not in the known module set.',
				}));
			}
		}

		if (emitter?.type === 'mesh') {
			const meshes = countArray(emitter.meshes);
			const resolvedMeshes = countArray(emitter.resolvedMeshes);
			const animations = countArray(emitter.animations);
			const resolvedAnimations = countArray(emitter.resolvedAnimations);
			const launcherClass = String(emitter.meshFields?.launcherClass || '');
			const isTrailClass = /trail|ribbon|cloth/i.test(launcherClass);
			const isNonRenderReference = /SoundReference/i.test(launcherClass) || /声音引用/u.test(String(emitter.subTypeName || ''));
			const hasResolvedEmbeddedMeshMaterial = resolvedMeshes > 0 && countArray(emitter.texturePaths) === 0;
			const requiresSiblingTrack = isTrailClass && emitter.meshFields?.classFlags?.hasSiblingTrack === true;
			const materialIndex = emitter.meshFields?.materialIndex;
			if (meshes > resolvedMeshes) {
				pushIssue(issues, summary, makeIssue('mesh-reference-unresolved', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / mesh assets',
					meshes,
					resolvedMeshes,
					proof: 'Mesh launcher references more meshes than the resolver materialized.',
				}));
			}
			if (animations > resolvedAnimations) {
				pushIssue(issues, summary, makeIssue('mesh-animation-unresolved', 'medium', sourcePath, emitter.index, {
					section: 'Parsed Emitters / mesh assets',
					animations,
					resolvedAnimations,
					proof: 'Mesh launcher references more animation files than the resolver materialized.',
				}));
			}
			if (requiresSiblingTrack && !emitter.linkedTrack) {
				const issueMeta = trailBindingIssueMeta(emitter, trackEmitters);
				if (!issueMeta) continue;
				pushIssue(issues, summary, makeIssue(issueMeta.type, issueMeta.severity, sourcePath, emitter.index, {
					section: 'Parsed Emitters / trail binding',
					launcherClass,
					trackBindingStatus: emitter.trackBindingStatus || null,
					trackBinding: emitter.trackBinding || null,
					proof: issueMeta.proof,
				}));
			}
			if (!isTrailClass && !isNonRenderReference && !hasResolvedEmbeddedMeshMaterial && (materialIndex == null || Number(materialIndex) < 0)) {
				pushIssue(issues, summary, makeIssue('material-class-mesh-without-material-index', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / mesh material binding',
					launcherClass,
					materialIndex,
					proof: 'Material-class launcher does not expose a usable material index. This should not be treated like expected Trail nMaterialIndex=0xFFFFFFFF.',
				}));
			}
		}

		if (emitter?.type === 'track') {
			if (emitter.trackParamsWarning) {
				pushIssue(issues, summary, makeIssue('track-params-warning', 'high', sourcePath, emitter.index, {
					section: 'Parsed Emitters / track params',
					trackParamsWarning: emitter.trackParamsWarning,
					proof: 'Track block exists but still has a parser warning.',
				}));
			}
			if (countArray(emitter.tracks) > countArray(emitter.resolvedTracks)) {
				pushIssue(issues, summary, makeIssue('track-reference-unresolved', 'medium', sourcePath, emitter.index, {
					section: 'Parsed Emitters / track assets',
					tracks: countArray(emitter.tracks),
					resolvedTracks: countArray(emitter.resolvedTracks),
					proof: 'Track emitter references more track files than the resolver materialized.',
				}));
			}
		}

		if (emitter?.type === 'camera-shake' && emitter.cameraShakeWarning) {
			pushIssue(issues, summary, makeIssue('camera-shake-warning', 'high', sourcePath, emitter.index, {
				section: 'Parsed Emitters / camera-shake',
				cameraShakeWarning: emitter.cameraShakeWarning,
				proof: 'Camera-shake block exists but still has a parser warning.',
			}));
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
		emitters: 0,
		emitterTypes: {},
		layoutKinds: {},
		issuesByType: {},
		issuesBySeverity: {},
	};
	auditCurveInfo(sourcePath, dump, issues, summary);
	auditEmitters(sourcePath, detail, dump, issues, summary);
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
			if (index % 10 === 0 || index === items.length - 1) console.log(`[stage4] ${index + 1}/${items.length} ${items[index]?.sourcePath || ''}`);
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				results[index] = {
					sourcePath: items[index]?.sourcePath || '',
					summary: null,
					issues: [makeIssue('stage4-fetch-error', 'high', items[index]?.sourcePath || '', null, {
						section: 'API fetch',
						proof: error?.message || String(error),
					})],
				};
			}
			completed++;
			if (completed % 25 === 0 || completed === items.length) console.log(`[stage4] completed ${completed}/${items.length}`);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
	return results;
}

function mergeSummary(results) {
	const merged = {
		files: results.length,
		emitters: 0,
		emitterTypes: {},
		layoutKinds: {},
		issuesByType: {},
		issuesBySeverity: {},
	};
	for (const result of results) {
		const summary = result.summary;
		if (summary) {
			merged.emitters += summary.emitters;
			for (const [key, value] of Object.entries(summary.emitterTypes)) merged.emitterTypes[key] = (merged.emitterTypes[key] || 0) + value;
			for (const [key, value] of Object.entries(summary.layoutKinds)) merged.layoutKinds[key] = (merged.layoutKinds[key] || 0) + value;
			for (const [key, value] of Object.entries(summary.issuesByType)) merged.issuesByType[key] = (merged.issuesByType[key] || 0) + value;
			for (const [key, value] of Object.entries(summary.issuesBySeverity)) merged.issuesBySeverity[key] = (merged.issuesBySeverity[key] || 0) + value;
		} else {
			for (const issue of result.issues || []) {
				increment(merged.issuesByType, issue.type);
				increment(merged.issuesBySeverity, issue.severity);
			}
		}
	}
	return merged;
}

function topEntries(map, limit = 40) {
	return Object.entries(map || {})
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([key, count]) => ({ key, count }));
}

function issueSortKey(issue) {
	const severityRank = { high: 0, medium: 1, low: 2 };
	return [severityRank[issue.severity] ?? 9, issue.type, issue.file, issue.block ?? -1, issue.moduleKey || '', issue.occurrence ?? -1];
}

function markdownReport(report) {
	const lines = [];
	lines.push('# PSS Stage 4 Discovery Report');
	lines.push('');
	lines.push(`- Generated: ${report.generatedAt}`);
	lines.push(`- Base URL: ${report.baseUrl}`);
	lines.push(`- Files audited: ${report.auditedCount}`);
	lines.push(`- Candidate findings: ${report.issues.length}`);
	lines.push('');
	lines.push('## Stage Chart');
	lines.push('| Stage | Goal | Gate | Status |');
	lines.push('|---|---|---|---|');
	for (const row of stageChart) lines.push(`| ${row.stage} | ${row.goal} | ${row.gate} | ${row.status} |`);
	lines.push('');
	lines.push('## Issue Counts');
	lines.push('| Type | Count |');
	lines.push('|---|---:|');
	for (const row of topEntries(report.summary.issuesByType, 80)) lines.push(`| ${row.key} | ${row.count} |`);
	lines.push('');
	lines.push('## Severity Counts');
	lines.push('| Severity | Count |');
	lines.push('|---|---:|');
	for (const row of topEntries(report.summary.issuesBySeverity, 10)) lines.push(`| ${row.key} | ${row.count} |`);
	lines.push('');
	lines.push('## All Findings');
	lines.push('| Severity | Type | File | Block | Module | Occ | Layout | Proof |');
	lines.push('|---|---|---|---:|---|---:|---|---|');
	const sorted = [...report.issues].sort((a, b) => {
		const ak = issueSortKey(a);
		const bk = issueSortKey(b);
		return ak.join('\u0000').localeCompare(bk.join('\u0000'));
	});
	for (const issue of sorted) {
		lines.push(`| ${issue.severity || ''} | ${issue.type || ''} | ${issue.file || ''} | ${issue.block ?? ''} | ${issue.moduleKey || ''} | ${issue.occurrence ?? ''} | ${issue.layoutKind || ''} | ${compactText(issue.proof || issue.decodeWarning || issue.trackParamsWarning || issue.cameraShakeWarning || '', 220)} |`);
	}
	lines.push('');
	return lines.join('\n');
}

mkdirSync(outputDir, { recursive: true });
const catalog = await fetchJson(`/api/pss/find?limit=${encodeURIComponent(String(catalogLimit))}`);
const items = Array.isArray(catalog.items) ? catalog.items : [];
if (items.length === 0) throw new Error('No PSS files returned from /api/pss/find');

console.log(`[stage4] catalog files: ${items.length}; concurrency: ${concurrency}; timeoutMs: ${requestTimeoutMs}`);
const results = await runPool(items, auditOne);
const issues = results.flatMap((result) => result.issues || []);
const report = {
	generatedAt: new Date().toISOString(),
	baseUrl,
	catalogCount: catalog.count,
	auditedCount: items.length,
	stageChart,
	summary: mergeSummary(results),
	results,
	issues,
};

const jsonPath = join(outputDir, 'pss-stage4-discovery.json');
const mdPath = join(outputDir, 'pss-stage4-discovery.md');
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
writeFileSync(mdPath, markdownReport(report), 'utf8');

console.log(`[stage4] wrote ${jsonPath}`);
console.log(`[stage4] wrote ${mdPath}`);
console.log(`[stage4] findings: ${issues.length}`);
console.log(`[stage4] issue types: ${JSON.stringify(report.summary.issuesByType)}`);