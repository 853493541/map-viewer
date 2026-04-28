/**
 * actor-animation-player.js  (v4 — Player Animation Browser + Built-in PSS Renderer)
 *
 * Left panel: body type selector, animation table, tani catalog, serial table
 * Right side: Three.js 3D viewport (top) + small info panel (bottom)
 * PSS effects rendered directly using Three.js (no iframe)
 */

import * as THREE from 'three';
import { DDSLoader } from '/vendor/three/examples/jsm/loaders/DDSLoader.js';
import { FBXLoader } from '/vendor/three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const bodyTypeBar = $('#body-type-bar');
const animSearchEl = $('#anim-search');
const animListEl = $('#anim-list');
const animPaginationEl = $('#anim-pagination');
const animTableBadge = $('#anim-table-badge');
const taniSearchEl = $('#tani-search');
const taniListEl = $('#tani-list');
const taniPaginationEl = $('#tani-pagination');
const taniCatalogBadge = $('#tani-catalog-badge');
const serialSearchEl = $('#serial-search');
const serialListEl = $('#serial-list');
const serialBadge = $('#serial-badge');
const infoTitle = $('#info-title');
const infoSubtitle = $('#info-subtitle');
const infoBody = $('#info-body');
const statusConnection = $('#status-connection');
const statusBodyType = $('#status-body-type');
const statusCount = $('#status-count');
const statusRenderer = $('#status-renderer');
const vpLabel = $('#vp-label');
const vpStats = $('#vp-stats');
const viewportPanel = $('#viewport-panel');
const viewportCanvas = $('#viewport-canvas');
const viewportOverlay = $('#viewport-overlay');
const pssSelector = $('#pss-selector');
const debugPanel = $('#debug-panel');
const debugBody = $('#debug-body');
const debugTabButtons = Array.from(document.querySelectorAll('.dbg-tab'));
const timelineBar = $('#timeline-bar');
const tlPlayPause = $('#tl-playpause');
const tlScrubber = $('#tl-scrubber');
const tlTime = $('#tl-time');
const tlMarkers = $('#tl-markers');
const tlLoop = $('#tl-loop');
const tlSpeed = $('#tl-speed');

// ─── State ───────────────────────────────────────────────────────────────────

let currentBodyType = 'f1';
let bodyTypeCounts = {};
let animPage = 0;
let animTotal = 0;
let taniPage = 0;
let taniTotal = 0;
let serialEntries = [];
let serialMap = new Map();
const PAGE_SIZE = 100;
let animSearchTimer = null;
let taniSearchTimer = null;
let serialSearchTimer = null;
let currentTaniData = null;
let currentSoundEntries = [];
let currentDebugTab = 'runtime';

// ─── Debug Log ────────────────────────────────────────────────────────────────

const pssDebugState = {
  sourcePath: '',
  loadedAt: null,
  apiData: null,
  // Per-PSS raw binary audit from /api/pss/debug-dump (authoritative vs uncertain
  // field list, per-block non-zero word dump, socket hint). One entry per PSS
  // loaded from the current TANI. The user explicitly asked for a PSS-focused
  // debug log that does not hide what is still guessed.
  debugDumps: [],
  // Per-PSS socket routing (what the renderer actually applied, and why).
  socketRouting: [],
  textureResults: [],
  meshResults: [],
  emitters: [],
  errors: [],
  // Every place where the renderer silently substitutes a default/guessed value
  // when authored data is missing records an entry here. Surfaced in the new
  // "Fallbacks" debug tab and in /api/debug/pss-render-log. Without this the
  // scene can render "successfully" while every emitter is on a guessed socket
  // with guessed blend mode and guessed lifetime — which is exactly the class
  // of silent drift the user asked us to stop ignoring.
  fallbacks: [],
};

function dbg(category, msg, data) {
  const entry = { t: Date.now(), category, msg, data };
  // attach to pssDebugState based on category
  if (category === 'texture') pssDebugState.textureResults.push({ msg, ...data });
  else if (category === 'mesh') pssDebugState.meshResults.push({ msg, ...data });
  else if (category === 'mesh-error') pssDebugState.meshResults.push({ msg, error: true, ...data });
  else if (category === 'error') pssDebugState.errors.push({ msg, ...data });
  else if (category === 'fallback') pssDebugState.fallbacks.push({ msg, ...data });
  // Fallbacks go to console.warn so F12 shows them yellow, not buried in debug
  // verbosity. Real errors use console.debug here (actual thrown exceptions are
  // routed through the window.error handler which uses console.error).
  if (category === 'fallback') console.warn(`[PSS Debug] [fallback]`, msg, data || '');
  else console.debug(`[PSS Debug] [${category}]`, msg, data || '');
}

// Per-PSS fallback aggregator: many fallback categories (max-particles,
// lifetime, size-curve, socket-default, pss-socket) fire once per emitter
// and produce dozens of identical lines per PSS. This collapses them to ONE
// summary per (category, sub-key) per PSS. Reset via resetFallbackAggregator
// at the start of each PSS load. The subKey is an optional discriminator
// (e.g., bone name) so distinct sub-categories still each emit one summary.
const fallbackAggregator = new Map(); // key -> { count, first }

function dbgFallbackAggregate(subCategory, subKey, msg, data) {
  const key = `${subCategory}|${subKey || ''}`;
  const existing = fallbackAggregator.get(key);
  if (existing) {
    existing.count++;
    if (existing.data) {
      const indices = existing.data._emitterIndices;
      if (Array.isArray(indices) && indices.length < 12 && Number.isFinite(data?.emitterIndex)) {
        indices.push(data.emitterIndex);
      }
    }
    return;
  }
  const clonedData = data ? { ...data } : {};
  if (Number.isFinite(clonedData.emitterIndex)) {
    clonedData._emitterIndices = [clonedData.emitterIndex];
    delete clonedData.emitterIndex;
  }
  fallbackAggregator.set(key, { count: 1, msg, data: clonedData });
}

function flushFallbackAggregator() {
  for (const [key, info] of fallbackAggregator) {
    const [category] = key.split('|');
    const payload = { category, ...info.data, occurrences: info.count };
    if (Array.isArray(payload._emitterIndices)) {
      payload.emitterIndices = payload._emitterIndices.join(',');
      delete payload._emitterIndices;
    }
    const suffix = info.count > 1 ? ` (×${info.count} emitters, first summary only)` : '';
    dbg('fallback', info.msg + suffix, payload);
  }
  fallbackAggregator.clear();
}

// Mirror any console.warn / console.error into pssDebugState.errors so they
// surface in /api/debug/pss-render-log (and the UI Issues tab) alongside real
// thrown exceptions. Without this, warnings like failed texture parses or
// unexpected GLB payloads stay silent in the debug log even though F12 shows
// them. The originals are still called so DevTools behaves normally.
(function installConsoleRelays() {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const format = (args) => args.map((a) => {
    if (a == null) return String(a);
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.error = (...args) => {
    try { pssDebugState.errors.push({ msg: `[console.error] ${format(args)}`, level: 'error' }); } catch { /* ignore */ }
    origError(...args);
  };
  console.warn = (...args) => {
    try { pssDebugState.errors.push({ msg: `[console.warn] ${format(args)}`, level: 'warn' }); } catch { /* ignore */ }
    origWarn(...args);
  };
})();

function resetDebugState() {
  pssDebugState.sourcePath = '';
  pssDebugState.loadedAt = null;
  pssDebugState.apiData = null;
  pssDebugState.debugDumps = [];
  pssDebugState.socketRouting = [];
  pssDebugState.textureResults = [];
  pssDebugState.meshResults = [];
  pssDebugState.emitters = [];
  pssDebugState.errors = [];
  pssDebugState.fallbacks = [];
  fallbackAggregator.clear();
  try { SOCKET_FALLBACK_LOGGED_BONES.clear(); } catch { /* defined later */ }
  try { SOCKET_FALLBACK_COUNT.clear(); } catch { /* defined later */ }
  try { TEXTURE_SHORT_BODY_LOGGED.clear(); } catch { /* defined later */ }
}

function setActiveDebugTab(tabId) {
  currentDebugTab = (tabId === 'pss' || tabId === 'warnings') ? tabId : 'runtime';
  debugTabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.debugTab === currentDebugTab);
  });
  if (debugPanel && !debugPanel.classList.contains('hidden')) renderDebugPanel();
}

function isMeaningfulDebugValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function formatDebugNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatDebugInlineValue(value) {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.map(formatDebugInlineValue).join(', ') : '—';
  if (typeof value === 'number') return formatDebugNumber(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nested]) => isMeaningfulDebugValue(nested))
      .map(([key, nested]) => `${key}:${formatDebugInlineValue(nested)}`);
    return entries.length ? entries.join(' | ') : '—';
  }
  return String(value);
}

function renderRuntimeDebugContent(d, data) {
  let html = '';

  html += `<div class="dbg-section">
    <div class="dbg-section-title">Overview</div>
    <div class="dbg-row"><span class="dbg-k">File</span><span class="dbg-v">${escapeHtml(extractFileName(data.sourcePath))}</span></div>
    <div class="dbg-row"><span class="dbg-k">Source</span><span class="dbg-v">${escapeHtml(data.source)}</span></div>
    <div class="dbg-row"><span class="dbg-k">Duration</span><span class="dbg-v">${data.globalPlayDuration}ms play / ${data.globalDuration}ms total</span></div>
    <div class="dbg-row"><span class="dbg-k">Loop</span><span class="dbg-v">${data.globalLoopEnd > 0 ? data.globalLoopEnd + 'ms' : 'no'}</span></div>
    <div class="dbg-row"><span class="dbg-k">Emitters</span><span class="dbg-v">${data.emitters?.length || 0} total</span></div>
    <div class="dbg-row"><span class="dbg-k">Textures</span><span class="dbg-v">${d.textureResults.length} processed</span></div>
    <div class="dbg-row"><span class="dbg-k">Meshes</span><span class="dbg-v">${d.meshResults.length} processed</span></div>
  </div>`;

  if (data.emitters?.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Emitters (${data.emitters.length})</div>`;
    for (const em of data.emitters) {
      const rp = em.runtimeParams;
      const lifetime = rp?.lifetimeSeconds ?? rp?.scalar ?? '?';
      const sizeCurve = rp?.sizeCurve ? rp.sizeCurve.map(v => v.toFixed(2)).join(',') : 'none';
      const texNames = (em.resolvedTextures || []).map((t) => extractFileName(t.texturePath)).join(', ') || '—';
      const meshNames = (em.meshes || []).map((p) => extractFileName(p)).join(', ') || '—';
      const clsName = em.type === 'sprite' ? 'sprite' : em.type === 'mesh' ? 'mesh' : 'track';
      html += `<div class="dbg-emitter ${clsName}">
        <div class="dbg-row"><span class="dbg-k">#${em.index} ${em.type}</span><span class="dbg-v">${em.category || ''} ${em.blendMode ? '| ' + em.blendMode : ''}</span></div>`;
      if (em.type === 'sprite') {
        html += `<div class="dbg-row"><span class="dbg-k">Lifetime</span><span class="dbg-v">${lifetime}s | sizeCurve:${sizeCurve}</span></div>
        <div class="dbg-row"><span class="dbg-k">colorCurve</span><span class="dbg-v">${em.colorCurve ? em.colorCurve.length + ' keys' : 'null'}</span></div>
        <div class="dbg-row"><span class="dbg-k">Textures</span><span class="dbg-v">${escapeHtml(texNames)}</span></div>`;
      } else if (em.type === 'mesh') {
        html += `<div class="dbg-row"><span class="dbg-k">Meshes</span><span class="dbg-v">${escapeHtml(meshNames)}</span></div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (d.textureResults.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Texture Load Results</div>`;
    for (const t of d.textureResults) {
      const cls = t.loaded ? 'dbg-ok' : 'dbg-err';
      html += `<div class="dbg-row"><span class="${cls}">${t.loaded ? '✓' : '✗'}</span><span class="dbg-v">${escapeHtml(t.name || extractFileName(t.texturePath) || '?')}</span></div>`;
    }
    html += `</div>`;
  }

  if (d.meshResults.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Mesh GLB Results</div>`;
    for (const m of d.meshResults) {
      const cls = m.error ? 'dbg-err' : 'dbg-ok';
      html += `<div class="dbg-row"><span class="${cls}">${m.error ? '✗' : '✓'}</span><span class="dbg-v">${escapeHtml(extractFileName(m.sourcePath) || '?')}</span></div>`;
    }
    html += `</div>`;
  }

  if (currentSoundEntries.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Sound Events (Wwise - not playable)</div>`;
    for (const s of currentSoundEntries) {
      html += `<div class="dbg-row"><span class="dbg-k">${escapeHtml(s.system || '—')}</span><span class="dbg-warn">${escapeHtml(s.event)}</span></div>`;
    }
    html += `</div>`;
  }

  if (d.errors.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Errors</div>`;
    for (const e of d.errors) {
      html += `<div class="dbg-row"><span class="dbg-err">✗</span><span class="dbg-v">${escapeHtml(e.msg)}</span></div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="dbg-section"><div class="dbg-row"><span class="dbg-ok">✓</span><span class="dbg-v">No runtime errors</span></div></div>`;
  }

  return html;
}

function renderPssBlockAudit(blk) {
  const parsed = blk.parsed || {};
  const clsName = blk.typeLabel === 'sprite' ? 'sprite' : blk.typeLabel === 'mesh' ? 'mesh' : blk.typeLabel === 'track' ? 'track' : '';
  let html = `<div class="dbg-emitter ${clsName}">`;
  html += `<div class="dbg-row"><span class="dbg-k">#${blk.index} ${blk.typeLabel}</span><span class="dbg-v">off ${blk.offset} | size ${blk.size}</span></div>`;

  if (blk.typeLabel === 'global') {
    html += `<div class="dbg-row"><span class="dbg-k">Timing</span><span class="dbg-v">delay:${formatDebugInlineValue(parsed.globalStartDelayMs)} | play:${formatDebugInlineValue(parsed.globalPlayDurationMs)} | total:${formatDebugInlineValue(parsed.globalDurationMs)} | loopEnd:${formatDebugInlineValue(parsed.globalLoopEndMs)}</span></div>`;
  } else if (blk.typeLabel === 'sprite') {
    const moduleNames = Array.isArray(parsed.modules) && parsed.modules.length ? parsed.modules.join(' | ') : 'none';
    const unknownNames = Array.isArray(parsed.unknownModules) && parsed.unknownModules.length ? parsed.unknownModules.join(' | ') : '';
    const derivedFlags = [
      parsed.hasVelocity ? 'velocity' : null,
      parsed.hasBrightness ? 'brightness' : null,
      parsed.hasColorCurve ? 'colorCurve' : null,
    ].filter(Boolean).join(', ') || 'none';
    const rawBlendSource = parsed.blendModeSource || '';
    // 'name-convention:<suffix>-suffix' is authoritative-by-engine-convention
    // for materials in 独立材质/ where the editor's material-creation flow
    // enforces the basename suffix as the BlendMode declaration. It is NOT
    // a heuristic fallback and must render with ok styling.
    const blendSourceAuthoritative = rawBlendSource === 'jsondef' || rawBlendSource.startsWith('name-convention:');
    const blendSource = rawBlendSource === 'jsondef'
      ? 'jsondef'
      : rawBlendSource.startsWith('name-convention:')
        ? rawBlendSource.replace(/^name-convention:/, 'convention:')
        : rawBlendSource.startsWith('name-fallback:')
          ? `fallback:${rawBlendSource.slice('name-fallback:'.length)}`
          : rawBlendSource === 'name-fallback'
            ? 'fallback'
            : (rawBlendSource || 'unknown');
    html += `<div class="dbg-row"><span class="dbg-k">Material</span><span class="dbg-v">${escapeHtml(parsed.materialName || parsed.material || '—')}</span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Blend</span><span class="dbg-v">${escapeHtml(parsed.blendMode || '—')} <span class="${blendSourceAuthoritative ? 'dbg-ok' : 'dbg-warn'}">(${escapeHtml(blendSource)})</span></span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Layout</span><span class="dbg-v">uv:${formatDebugInlineValue(parsed.uvRows)}×${formatDebugInlineValue(parsed.uvCols)} | layers:${formatDebugInlineValue(parsed.layerCount)} | maxParticles:${formatDebugInlineValue(parsed.maxParticles)}</span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Modules</span><span class="dbg-v">${escapeHtml(moduleNames)}</span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Derived</span><span class="dbg-v">${escapeHtml(derivedFlags)} | textures:${Array.isArray(parsed.textures) ? parsed.textures.length : 0} | colorCurveKeys:${formatDebugInlineValue(parsed.colorCurveKeyframes)}</span></div>`;
    if (unknownNames) {
      html += `<div class="dbg-row"><span class="dbg-k">Unknown</span><span class="dbg-warn">${escapeHtml(unknownNames)}</span></div>`;
    }
    if (isMeaningfulDebugValue(parsed.runtimeParams)) {
      html += `<div class="dbg-row"><span class="dbg-k">Runtime</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.runtimeParams))}</span></div>`;
    }
    if (isMeaningfulDebugValue(parsed.tailParams)) {
      html += `<div class="dbg-row"><span class="dbg-k">Tail</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.tailParams))}</span></div>`;
    }
  } else if (blk.typeLabel === 'mesh') {
    html += `<div class="dbg-row"><span class="dbg-k">Meshes</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.meshes))}</span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Animations</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.animations))}</span></div>`;
    const launcherClass = parsed.launcherClass || '—';
    const launcherKey = parsed.launcherClassKey || '—';
    const cf = parsed.classFlags || {};
    const flagNames = [
      cf.isRibbon && 'ribbon',
      cf.hasTrackCurve && 'track',
      cf.hasSiblingTrack && 'sibling-track',
      cf.isCloth && 'cloth',
      cf.isFlame && 'flame',
    ].filter(Boolean).join(', ') || 'none';
    const featureRaw = (cf && typeof cf.raw === 'number') ? `0x${cf.raw.toString(16).padStart(8, '0')}` : '—';
    html += `<div class="dbg-row"><span class="dbg-k">Class</span><span class="dbg-v">${escapeHtml(launcherClass)} <span class="dbg-warn">(key ${escapeHtml(launcherKey)})</span></span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Flags</span><span class="dbg-v">${escapeHtml(flagNames)} <span class="dbg-warn">(feature ${featureRaw})</span></span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Scale</span><span class="dbg-v">emitter:${formatDebugInlineValue(parsed.emitterScale)} | secondary:${formatDebugInlineValue(parsed.secondaryScale)} | poolIndex:${parsed.spawnPoolIndex == null ? 'ribbon' : parsed.spawnPoolIndex}</span></div>`;
  } else if (blk.typeLabel === 'track') {
    html += `<div class="dbg-row"><span class="dbg-k">Tracks</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.tracks))}</span></div>`;
    if (isMeaningfulDebugValue(parsed.trackParams)) {
      html += `<div class="dbg-row"><span class="dbg-k">Params</span><span class="dbg-v">${escapeHtml(formatDebugInlineValue(parsed.trackParams))}</span></div>`;
    }
  }

  if (Array.isArray(blk.uncertain) && blk.uncertain.length > 0) {
    for (const item of blk.uncertain) {
      html += `<div class="dbg-row"><span class="dbg-err">?</span><span class="dbg-v">${escapeHtml(item)}</span></div>`;
    }
  }

  html += `</div>`;
  return html;
}

function renderPssDebugContent(d, data) {
  let html = '';
  const dumps = Array.isArray(d.debugDumps) ? d.debugDumps : [];
  const selectedSourcePath = normalizeDebugPath(data.sourcePath);
  const selectedDump = dumps.find((dump) => normalizeDebugPath(dump.sourcePath) === selectedSourcePath)
    || dumps.find((dump) => normalizeDebugPath(extractFileName(dump.sourcePath)) === normalizeDebugPath(extractFileName(data.sourcePath)))
    || dumps[0]
    || null;

  const selectedSpriteBlocks = Array.isArray(selectedDump?.blocks)
    ? selectedDump.blocks.filter((blk) => blk.typeLabel === 'sprite')
    : [];
  const selectedVelocityBlockCount = selectedSpriteBlocks.filter((blk) => blk.parsed?.hasVelocity).length;
  // Treat 'jsondef' AND 'name-convention:*' as authoritative — only true
  // heuristic fallbacks (name-fallback:*, jsondef:missing) count as gaps.
  const isAuthoritativeBlend = (src) => src === 'jsondef' || (typeof src === 'string' && src.startsWith('name-convention:'));
  const selectedBlendFallbackCount = selectedSpriteBlocks.filter((blk) => blk.parsed?.blendModeSource && !isAuthoritativeBlend(blk.parsed.blendModeSource)).length;
  const selectedUnknownModuleBlockCount = selectedSpriteBlocks.filter((blk) => Array.isArray(blk.parsed?.unknownModules) && blk.parsed.unknownModules.length > 0).length;
  const selectedOpenGapCount = Array.isArray(selectedDump?.uncertain) ? selectedDump.uncertain.length : 0;

  const totalSpriteBlocks = dumps.reduce((sum, dump) => sum + (Array.isArray(dump.blocks) ? dump.blocks.filter((blk) => blk.typeLabel === 'sprite').length : 0), 0);
  const velocityBlockCount = dumps.reduce((sum, dump) => sum + (Array.isArray(dump.blocks) ? dump.blocks.filter((blk) => blk.typeLabel === 'sprite' && blk.parsed?.hasVelocity).length : 0), 0);
  const blendFallbackCount = dumps.reduce((sum, dump) => sum + (Array.isArray(dump.blocks) ? dump.blocks.filter((blk) => blk.typeLabel === 'sprite' && blk.parsed?.blendModeSource && !isAuthoritativeBlend(blk.parsed.blendModeSource)).length : 0), 0);
  const unknownModuleBlockCount = dumps.reduce((sum, dump) => sum + (Array.isArray(dump.blocks) ? dump.blocks.filter((blk) => blk.typeLabel === 'sprite' && Array.isArray(blk.parsed?.unknownModules) && blk.parsed.unknownModules.length > 0).length : 0), 0);
  const unresolvedItems = dumps.flatMap((dump) => Array.isArray(dump.uncertain) ? dump.uncertain : []);
  const unresolvedItemCount = unresolvedItems.length;
  const uniqueUnresolvedItemCount = new Set(unresolvedItems).size;
  const unresolvedSummary = unresolvedItemCount === uniqueUnresolvedItemCount
    ? `${unresolvedItemCount}`
    : `${uniqueUnresolvedItemCount} unique / ${unresolvedItemCount} total`;

  html += `<div class="dbg-section">
    <div class="dbg-section-title">PSS Audit Overview</div>
    <div class="dbg-row"><span class="dbg-k">Selection</span><span class="dbg-v">${escapeHtml(extractFileName(data.sourcePath))}</span></div>
    <div class="dbg-row"><span class="dbg-k">Selected PSS</span><span class="dbg-v">sprite blocks:${selectedSpriteBlocks.length} | velocity module:${selectedVelocityBlockCount} | blend fallback:${selectedBlendFallbackCount} | unknown-module blocks:${selectedUnknownModuleBlockCount} | top-level gaps:${selectedOpenGapCount}</span></div>
    <div class="dbg-row"><span class="dbg-k">Loaded PSS</span><span class="dbg-v">${dumps.length}</span></div>
    <div class="dbg-row"><span class="dbg-k">Loaded Set</span><span class="dbg-v">sprite blocks:${totalSpriteBlocks} audited | velocity module:${velocityBlockCount} | blend fallback:${blendFallbackCount}</span></div>
    <div class="dbg-row"><span class="dbg-k">Aggregate Flags</span><span class="dbg-v">unknown-module blocks:${unknownModuleBlockCount} | top-level gaps:${unresolvedSummary}</span></div>
  </div>`;

  if (dumps.length === 0) {
    html += `<div class="dbg-section"><div class="dbg-row"><span class="dbg-warn">!</span><span class="dbg-v">No /api/pss/debug-dump data available for this selection yet.</span></div></div>`;
    return html;
  }

  for (const dump of dumps) {
    const fileName = extractFileName(dump.sourcePath);
    const spriteBlocks = Array.isArray(dump.blocks) ? dump.blocks.filter((blk) => blk.typeLabel === 'sprite') : [];
    const socketReason = dump.socket?.reason || 'unknown';
    // Authored socket is only ok when the server returned a non-null name.
    const socketClass = dump.socket?.suggested ? 'dbg-ok' : 'dbg-warn';
    const velocityCount = spriteBlocks.filter((blk) => blk.parsed?.hasVelocity).length;
    // gravityCount removed: 重力 has zero occurrences in any cached PSS file.
    const brightnessCount = spriteBlocks.filter((blk) => blk.parsed?.hasBrightness).length;
    const jsondefBlendCount = spriteBlocks.filter((blk) => blk.parsed?.blendModeSource === 'jsondef').length;
    const conventionBlendCount = spriteBlocks.filter((blk) => typeof blk.parsed?.blendModeSource === 'string' && blk.parsed.blendModeSource.startsWith('name-convention:')).length;
    const missingBlendCount = spriteBlocks.filter((blk) => blk.parsed?.blendModeSource === 'jsondef:missing').length;

    // Collapsed-when-clean policy: a PSS audit is "clean" when there are no
    // open gaps AND no heuristic blend fallbacks AND no missing jsondefs.
    const openGapCount = Array.isArray(dump.uncertain) ? dump.uncertain.length : 0;
    const blendHeuristicCount = spriteBlocks.filter((blk) => typeof blk.parsed?.blendModeSource === 'string' && blk.parsed.blendModeSource.startsWith('name-fallback')).length;
    const isClean = openGapCount === 0 && blendHeuristicCount === 0 && missingBlendCount === 0;
    const sectionStatus = isClean ? 'ok' : 'warn';
    const sectionStatusLabel = isClean ? '✓ all clean' : `${openGapCount + blendHeuristicCount + missingBlendCount} issue(s)`;

    // Each PSS file gets a foldable section. Collapsed by default when clean
    // so problematic files immediately stand out.
    html += `<details class="dbg-section dbg-fold ${sectionStatus}"${isClean ? '' : ' open'}>`;
    html += `<summary><span class="dbg-fold-label">PSS Audit</span><span class="dbg-fold-meta">${escapeHtml(fileName)} <small>(${escapeHtml(sectionStatusLabel)})</small></span></summary>`;
    html += `<div class="dbg-row"><span class="dbg-k">Emitters</span><span class="dbg-v">${dump.emitterCount} total | global:${dump.counts?.global || 0} sprite:${dump.counts?.sprite || 0} mesh:${dump.counts?.mesh || 0} track:${dump.counts?.track || 0}</span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Socket</span><span class="dbg-v"><span class="${socketClass}">${escapeHtml(dump.socket?.suggested || '—')}</span> <small>(${escapeHtml(socketReason)})</small></span></div>`;
    html += `<div class="dbg-row"><span class="dbg-k">Sprite Audit</span><span class="dbg-v">velocity:${velocityCount} | brightness:${brightnessCount} | blend jsondef:${jsondefBlendCount} | blend convention:${conventionBlendCount} | blend jsondef:missing:${missingBlendCount}</span></div>`;

    // Resolved confirmations: collapsed by default — these are positive
    // confirmations the parser knows the format, not items needing attention.
    if (Array.isArray(dump.resolved) && dump.resolved.length > 0) {
      html += `<details class="dbg-fold ok"><summary><span class="dbg-fold-label">Resolved</span><span class="dbg-fold-meta">${dump.resolved.length} confirmed item(s)</span></summary>`;
      for (const note of dump.resolved) {
        html += `<div class="dbg-row"><span class="dbg-ok">✓</span><span class="dbg-v">${escapeHtml(note)}</span></div>`;
      }
      html += `</details>`;
    }

    // Open Gaps: ALWAYS expanded so genuine issues are immediately visible.
    if (Array.isArray(dump.uncertain) && dump.uncertain.length > 0) {
      html += `<div class="dbg-row"><span class="dbg-k">Open Gaps</span><span class="dbg-v">${dump.uncertain.length}</span></div>`;
      for (const item of dump.uncertain) {
        html += `<div class="dbg-row"><span class="dbg-err">?</span><span class="dbg-v">${escapeHtml(item)}</span></div>`;
      }
    }

    // Per-block records: collapsed by default — long and only useful when
    // diagnosing a specific emitter.
    if (Array.isArray(dump.blocks) && dump.blocks.length > 0) {
      html += `<details class="dbg-fold"><summary><span class="dbg-fold-label">Blocks</span><span class="dbg-fold-meta">${dump.blocks.length} detailed records</span></summary>`;
      for (const blk of dump.blocks) {
        html += renderPssBlockAudit(blk);
      }
      html += `</details>`;
    }

    html += `</details>`;
  }

  if (d.socketRouting && d.socketRouting.length > 0) {
    html += `<div class="dbg-section"><div class="dbg-section-title">Applied Socket Routing</div>`;
    for (const r of d.socketRouting) {
      const fn = extractFileName(r.sourcePath);
      const cls = r.applied === r.suggested && r.suggested ? 'dbg-ok' : 'dbg-warn';
      html += `<div class="dbg-row"><span class="${cls}">${escapeHtml(r.applied || '—')}</span><span class="dbg-v">${escapeHtml(fn)} <small>(suggested:${escapeHtml(r.suggested || '—')}; ${escapeHtml(r.reason || '')})</small></span></div>`;
    }
    html += `</div>`;
  }

  return html;
}

// ─── New Pss DEBUG LOGS — per-issue evidence panel ──────────────────────────
// Each entry in PSS_ISSUES carries:
//   - title, difficulty, status ('solved' | 'open')
//   - howFound: methodology used to discover the bug
//   - detect(dumps, fallbacks): returns array of evidence strings for the
//     CURRENTLY loaded PSS(es). Solved issues should always return [].
const PSS_ISSUES = [
  {
    id: 1,
    title: 'Multi-emitter sprite blocks return only first emitter\'s curve',
    difficulty: '2/5',
    status: 'solved',
    howFound: 'Audited tools/audit-all-pss.cjs across 80 cached PSS files; counted blocks where the binary scan finds 2+ Hanzi-tagged module markers but parser exposes only one curveInfo.velocity. Confirmed by probing t_天策尖刺02.pss block#15: 2 emitter markers in bytes, 1 curve in output.',
    detect: (dumps) => {
      const errs = [];
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          if (blk.type !== 1) continue;
          const ec = blk.parsed?.emitterCount || 0;
          const ci = blk.parsed?.curveInfo || {};
          for (const k of Object.keys(ci)) {
            const arr = ci[k];
            if (Array.isArray(arr) && ec > 1 && arr.length > 0 && arr.length < ec) {
              errs.push(`${fileName} blk#${blk.index} ${k}: ${arr.length} entries for ${ec} emitters`);
            }
          }
        }
      }
      return errs;
    },
  },
  {
    id: 2,
    title: 'Phantom module markers (重力 / 发射率) searched but never present',
    difficulty: '3/5',
    status: 'solved',
    howFound: 'Wrote tools/audit-parser-logic.cjs which uses the parser\'s own maximal-Hanzi-run extraction logic and counted occurrences across all 80 PSS files. Result: 重力=0, 发射率=0, 尺寸=0, 生命=0, 加速=0, 起始=0. They were therefore phantom whitelist entries that produced empty curveInfo.gravity / curveInfo.emissionRate fields on every PSS.',
    detect: (dumps) => {
      const errs = [];
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          const ci = blk.parsed?.curveInfo;
          if (ci && (Array.isArray(ci.gravity) || Array.isArray(ci.emissionRate) || 'gravity' in ci || 'emissionRate' in ci)) {
            errs.push(`${fileName} blk#${blk.index}: phantom curveInfo.gravity/emissionRate still present`);
          }
          if (blk.parsed && 'hasGravity' in blk.parsed) {
            errs.push(`${fileName} blk#${blk.index}: hasGravity field still present`);
          }
        }
      }
      return errs;
    },
  },
  {
    id: 3,
    title: 'Whitelist incomplete — 20 real module markers silently dropped',
    difficulty: '3/5',
    status: 'solved',
    howFound: 'tools/audit-parser-logic.cjs ranked all maximal-Hanzi-run substrings by file count. tools/audit-candidate-names.cjs verified each candidate with ≥5 distinct files. Found 20 names that appeared in many files but were not in CONFIRMED_PSS_MODULE_NAMES, so extractConfirmedSpriteModules dropped them. Live verification on jc02 after fix shows 扭曲强度 / 旋转 / 偏移 / 消散贴图速度 / 消散贴图偏移 now appearing in parsed.modules.',
    detect: (dumps) => {
      const errs = [];
      const knownNew = ['扭曲强度', '旋转', '开启深度', '关闭深度', '偏移', '颜色贴图缩放', '颜色贴图速度', '其他', '消散贴图速度', '消散贴图偏移', '扭曲速度', '扭曲贴图', '扭曲缩放', '通道贴图缩放', '通道贴图重复', '流光', '层雾', '极光', '边缘模糊', '无缝'];
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          const unk = blk.parsed?.unknownModules || [];
          for (const u of unk) {
            if (knownNew.includes(u)) {
              errs.push(`${fileName} blk#${blk.index}: ${u} is in newly-added whitelist but still appearing as unknown`);
            }
          }
        }
      }
      return errs;
    },
  },
  {
    id: 4,
    title: 'Parser must never produce nonsense Chinese (no whitelist fallback)',
    difficulty: '3/5',
    status: 'solved',
    howFound: 'Round 3 (2026-04-26): per user directive, any nonsense Chinese surfaced by the parser is a structural bug — the parser must not be reading non-name byte regions in the first place. The maximal-Hanzi-pair run scanner inside extractConfirmedSpriteModules was replaced with anchored byte-search: each whitelisted module name is encoded once at boot to its exact GB18030 byte sequence (server.js MODULE_NAME_BYTES), and only those exact byte sequences are matched inside the variable region of each sprite block. Random parameter bytes (floats / ints / struct fields) cannot coincide with a 4+ byte specific sequence, so byte-pair coincidence noise is eliminated structurally — no whitelist-tolerance, no prefix-peel salvage, no fallback. parsed.unknownModules is now [] by construction; detector treats any entry as an immediate error.',
    detect: (dumps) => {
      const errs = [];
      const seen = new Map();
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          const unk = blk.parsed?.unknownModules || [];
          for (const u of unk) {
            if (!u || typeof u !== 'string') continue;
            const key = u;
            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push(`${fileName} blk#${blk.index}`);
          }
        }
      }
      for (const [name, where] of seen.entries()) {
        errs.push(`parser read non-name bytes as "${name}" in ${where.length} block(s) — STRUCTURAL BUG: ${where.slice(0, 3).join(', ')}${where.length > 3 ? ' …' : ''}`);
      }
      return errs;
    },
  },
  {
    id: 5,
    title: 'pickFallbackRuntimeScalar / applyFallbackSpriteRuntimeDefaults still active',
    difficulty: '2/5',
    status: 'solved',
    howFound: 'Searched server.js for "pickFallback" and "applyFallback*RuntimeDefaults". Found two functions invoked when authoritative tailParams are absent — these silently substituted hardcoded defaults (smoke=0.4, debris=0.6, light=0.6, other=0.5) rather than surfacing the gap. Per user directive ("no fallback, anything goes wrong is a warning"), pickFallbackRuntimeScalar was deleted, applyFallbackSpriteRuntimeDefaults was replaced with flagSpritesMissingAuthoritativeRuntime which now emits parsed.fallbackSpriteRuntimeWarnings instead of fabricating values.',
    detect: (dumps, _fallbacks, apiData) => {
      const errs = [];
      // Live evidence: per-emitter runtimeParams source check from apiData.
      const ems = apiData?.emitters || [];
      for (let i = 0; i < ems.length; i++) {
        const src = ems[i]?.runtimeParams?.source;
        if (typeof src === 'string' && /inferred-fallback-default|unknownFallback/i.test(src)) {
          errs.push(`emitter#${i} still uses fabricated fallback (${src})`);
        }
        if (ems[i]?.runtimeWarning) {
          errs.push(`emitter#${i} ${ems[i].category || ''}: ${ems[i].runtimeWarning}`);
        }
      }
      const warns = apiData?.fallbackSpriteRuntimeWarnings;
      if (Array.isArray(warns) && warns.length > 0 && errs.length === 0) {
        for (const w of warns) errs.push(`emitter#${w.emitterIndex} category=${w.category} ${w.reason}`);
      }
      return errs;
    },
  },
  {
    id: 6,
    title: 'blendMode resolved by keyword/name heuristic instead of jsondef',
    difficulty: '2/5',
    status: 'solved',
    howFound: 'Round 1 (2026-04-26): per user directive ("anything goes wrong is a warning, never silent fallback"), the four `name-fallback:*-keyword` branches in server.js (alpha/add/glow/multiply suffix outside 独立材质, plus 消散/渐变/fade and 发光/加亮/shine/光亮/gloss Chinese-keyword guesses) were deleted. Only the `name-convention:*-suffix` path inside 独立材质/ remains — that one is authoritative because the editor writes the suffix into RenderState.BlendMode at material-creation time. For every other case where the .jsondef is unavailable, blendMode now stays null and a warning is surfaced via parsed.uncertain rather than a fabricated value.',
    detect: (dumps) => {
      const errs = [];
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          const src = blk.parsed?.blendModeSource;
          if (typeof src === 'string' && /name-fallback|keyword/i.test(src)) {
            errs.push(`${fileName} blk#${blk.index} material=${blk.parsed?.material || '?'} STRUCTURAL BUG: heuristic blendMode resolution still active (${src})`);
          }
        }
      }
      return errs;
    },
  },
  {
    id: 7,
    title: 'type-3 trackParams indices marked APPROXIMATE',
    difficulty: '3/5',
    status: 'solved',
    howFound: 'Round 1 (2026-04-26): per user directive ("anything goes wrong is a warning, never silent fallback / heuristic"), the unverified trackParams field-index extractor in server.js extractTrackRuntimeParams (alphaScale@floats[9], speedHint@floats[11], flowScale@floats[14], tailToken@uints[13] — all guesses labeled "APPROXIMATE indices" in the type3 audit string) was deleted. extractTrackRuntimeParams now returns null. Each type-3 emitter receives a structured trackParamsWarning explaining the absence, and the block\'s parsed.uncertain surfaces the warning so it shows in the Warnings tab. Client-side (sliceTrackNodesForEmitter, linkedTrack rendering) already gracefully handles trackParams=null with documented defaults (widthScale=1, speedHint=80, flowScale=1) — no functional regression. Detector flags any block that still carries non-null trackParams.',
    detect: (dumps) => {
      const errs = [];
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          if (blk.type !== 3) continue;
          const tp = blk.parsed?.trackParams;
          if (tp && typeof tp === 'object') {
            errs.push(`${fileName} blk#${blk.index}: STRUCTURAL BUG — trackParams still extracted via APPROXIMATE indices: ${JSON.stringify(tp)}`);
          }
          for (const u of (blk.uncertain || [])) {
            if (/approximate/i.test(String(u))) {
              errs.push(`${fileName} blk#${blk.index}: lingering APPROXIMATE annotation: ${u}`);
            }
          }
        }
      }
      return errs;
    },
  },
  {
    id: 8,
    title: 'GATA start-times use safe fallback',
    difficulty: '5/5',
    status: 'solved',
    howFound: 'Round 1 (2026-04-26): server.js parseTaniBinary used to push every PSS entry with a hardcoded `startTimeMs = 0` and a comment calling it the "safe fallback". When the source PSS was unresolvable, the post-loop also assigned `entry.effectiveStartTimeMs = entry.startTimeMs` (i.e. 0) with `timingSource = "tani-unresolved"`, so a fabricated zero looked authoritative. Per the no-silent-fallback policy, both substitutions were removed: GATA entries now carry `startTimeMs: null` plus a structured `gataTimingWarning`; when no source PSS is available, `effectiveStartTimeMs` stays null and `timingSource = "unresolved-no-source-pss"`. parseTaniBinary also now exposes a top-level `gataTimingStatus` summary. Client-side, getTimelineEntryStartTimeMs records a `kind:"tani-start-time-unresolved"` entry into pssDebugState.fallbacks before returning 0 for layout-only positioning, and loadAllPssFromTani feeds that resolved value into addPssEffect explicitly. Detector flags any regression that re-introduces a numeric startTimeMs, the old timingSource string, or a missing gataTimingWarning.',
    detect: (dumps, fallbacks, apiData) => {
      const errs = [];
      const tani = (typeof window !== 'undefined' && window.currentTaniData) || null;
      const entries = tani && Array.isArray(tani.pssEntries) ? tani.pssEntries : [];
      const taniName = tani?.path ? extractFileName(tani.path) : (tani?.aniPath ? extractFileName(tani.aniPath) : '(no tani loaded)');
      if (entries.length === 0) {
        // Nothing to detect against — not evidence of the bug.
        return errs;
      }
      const status = tani?.gataTimingStatus;
      if (!status || status.perEntryStartTime !== 'not-extracted') {
        errs.push(`${taniName}: gataTimingStatus is missing or no longer marks perEntryStartTime as not-extracted (regression)`);
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const tag = `${taniName} pssEntries[${i}] (${extractFileName(e?.path || '')})`;
        if (typeof e?.startTimeMs === 'number') {
          errs.push(`${tag}: startTimeMs is a number (${e.startTimeMs}) — silent fallback regression; must be null after issue #8`);
        }
        if (!e?.gataTimingWarning) {
          errs.push(`${tag}: gataTimingWarning is missing — GATA timing must always be flagged as not-extracted`);
        }
        if (e?.timingSource === 'tani-unresolved') {
          errs.push(`${tag}: timingSource still uses the legacy "tani-unresolved" label that fabricated effectiveStartTimeMs=0`);
        }
        if (e?.timingSource === 'unresolved-no-source-pss' && Number.isFinite(e?.effectiveStartTimeMs)) {
          errs.push(`${tag}: timingSource=unresolved-no-source-pss but effectiveStartTimeMs=${e.effectiveStartTimeMs} (must be null)`);
        }
      }
      // Sanity sweep over PSS dumps for any lingering "safe fallback" wording.
      for (const dump of (dumps || [])) {
        const fileName = extractFileName(dump.sourcePath);
        for (const u of (dump.uncertain || [])) {
          if (/safe fallback/i.test(String(u))) errs.push(`${fileName}: PSS dump still surfaces "safe fallback" text: ${u}`);
        }
      }
      return errs;
    },
  },
  {
    id: 9,
    title: 'Block #15 in jc02: binary scan finds 3 emitters, parser exposes 2',
    difficulty: '5/5',
    status: 'solved',
    howFound: 'Round 1 (2026-04-26): probed `t_天策尖刺02.pss` block #15 directly. moduleOffsets contained 速度 at offsets 2962/3498/4035 (3 occurrences) and 缩放 at 2694/3230/3767 (3 occurrences), yet `parsed.curveInfo.velocity[].length === 2` and `parsed.curveInfo.scale[].length === 2`. Root cause: server.js `buildCurveEntry` had `if (!decoded && occurrenceIdx > 0) return null;` which silently dropped any later emitter whose payload bytes did not match a known keyframe schema. Fixed structurally per the no-silent-fallback rule: `buildCurveEntry` now ALWAYS emits an entry when the module occurrence exists, even if no schema matched. Failed-decode entries carry `decoded:false`, `layoutKind:null`, plus a `decodeWarning` string and a `structuralProbe` with `payloadStart/payloadEnd/payloadLen/moduleOffsetIdx` so the audit can see exactly where the payload sits. A new helper `findOccurrencePayload` resolves the byte range without going through the keyframe schemas. Detector flags any sprite block where the count of a curve module name in `parsed.moduleOffsets` exceeds the length of the matching `parsed.curveInfo.<key>[]` array, OR a block where any per-emitter curveInfo entry both lacks `decoded:true` AND lacks `decodeWarning` (which would mean a silent drop snuck back in).',
    detect: (dumps) => {
      const errs = [];
      const KEY_TO_CN = {
        velocity: '速度',
        brightness: '亮度',
        color: '颜色',
        scale: '缩放',
        rotation: '旋转',
        distortStrength: '扭曲强度',
        offset: '偏移',
      };
      for (const dump of (dumps || [])) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          if (blk.type !== 1) continue;
          const offsets = Array.isArray(blk.parsed?.moduleOffsets) ? blk.parsed.moduleOffsets : [];
          const ci = blk.parsed?.curveInfo || {};
          for (const [key, cn] of Object.entries(KEY_TO_CN)) {
            const occurrences = offsets.reduce((n, m) => n + (m && m.name === cn ? 1 : 0), 0);
            const arr = Array.isArray(ci[key]) ? ci[key] : [];
            if (occurrences > arr.length) {
              errs.push(`${fileName} blk#${blk.index}: ${cn} has ${occurrences} byte-scan occurrence(s) but curveInfo.${key} only exposes ${arr.length} — silent emitter drop (issue #9 regression)`);
            }
            // Also flag any entry that lacks both decoded:true and a decodeWarning — a true silent failure shouldn't exist after the fix.
            for (let i = 0; i < arr.length; i++) {
              const e = arr[i];
              if (!e) {
                errs.push(`${fileName} blk#${blk.index}: curveInfo.${key}[${i}] is falsy — silent drop`);
                continue;
              }
              if (e.decoded !== true && e.layoutKind == null && !e.decodeWarning) {
                errs.push(`${fileName} blk#${blk.index}: curveInfo.${key}[${i}] (emitter#${e.emitterIndex}) has decoded=${e.decoded}, layoutKind=null, AND no decodeWarning — every undecoded entry must carry an explanation or a recognized layoutKind`);
              }
            }
          }
        }
      }
      return errs;
    },
  },
  {
    id: 10,
    title: 'validModules filter drops emitters before curve decode',
    difficulty: '3/5',
    status: 'solved',
    howFound: 'Round 1 (2026-04-26): the original detector compared parsed.moduleOffsets.length vs parsed.modules.length and treated any difference as "validator dropped emitters". That premise was wrong: modules is `[...new Set(moduleOffsets.map(m => m.name))]` — deduplicated by design — so the difference is always exactly the number of repeated names across multi-emitter blocks (e.g. block #15 of jc02 declares 通道/速度/缩放 once per emitter). After the issue #4 anchored byte-search rewrite (server.js extractConfirmedSpriteModules), there is also no "validator filter" anymore: anchored search either matches an exact whitelist GB18030 byte sequence (kept) or doesn\'t (no candidate to drop). The rewritten detector now flags actual structural drops: any moduleOffsets entry whose name is not in MODULE_NAME_WHITELIST, or any block with parsed.unknownModules entries (which would indicate a regression to candidate-scan + filter logic).',
    detect: (dumps) => {
      const errs = [];
      const KNOWN = new Set(['亮度','速度','颜色','加强','缩放','羽化','羽化颜色','通道','贴图','通道贴图','消散贴图','颜色贴图','颜色贴图旋转','颜色贴图单次','颜色贴图重复','颜色贴图自定义','特效','光效','烟雾','消散','消散密度','四方连续','火焰纹理','层图','纹理','轨迹','勾边','勾边宽度','勾边颜色','扭曲强度','旋转','开启深度','关闭深度','偏移','颜色贴图缩放','颜色贴图速度','其他','消散贴图速度','消散贴图偏移','扭曲速度','扭曲贴图','扭曲缩放','通道贴图缩放','通道贴图重复','流光','层雾','极光','边缘模糊','无缝','吞探','沙尘','波纹','渐入','通道贴图单次','刀光溶解','水纹','光球','颜色贴图偏移','光线','噪点贴图','纹理烟影','光点','星空纹理','流光颜色','强度控制','流光区域贴图','流光亮度','通道贴图偏移','烟火','通道贴图旋转','水波','流光区域','法线','柔光','光圈','消散贴图旋转','云烟雾','轮廓范围幂','轮廓光强度','条带','闪电','羽化强度','遮罩','方向消失程度']);
      for (const dump of dumps) {
        const fileName = extractFileName(dump.sourcePath);
        for (const blk of (dump.blocks || [])) {
          if (blk.type !== 1) continue;
          const mods = Array.isArray(blk.parsed?.modules) ? blk.parsed.modules : [];
          for (const name of mods) {
            if (typeof name === 'string' && !KNOWN.has(name)) {
              errs.push(`${fileName} blk#${blk.index}: parsed.modules contains "${name}" not in MODULE_NAME_WHITELIST — anchored byte-search regression`);
            }
          }
          const unk = blk.parsed?.unknownModules || [];
          if (Array.isArray(unk) && unk.length > 0) {
            errs.push(`${fileName} blk#${blk.index}: unknownModules has ${unk.length} entries — anchored byte-search regression (issue #4 was supposed to make this 0)`);
          }
        }
      }
      return errs;
    },
  },
];

let __selectedIssueId = 1;
function renderIssuesPanel() {
  const issuesBody = document.getElementById('issues-body');
  const issuesButtons = document.getElementById('issues-buttons');
  if (!issuesBody || !issuesButtons) return;
  const d = pssDebugState;
  const dumps = Array.isArray(d.debugDumps) ? d.debugDumps : [];
  const fallbacks = Array.isArray(d.fallbacks) ? d.fallbacks : [];

  // Render the 10 issue buttons (green = solved, red = open).
  issuesButtons.innerHTML = PSS_ISSUES.map((iss) => {
    const cls = ['issue-btn'];
    if (iss.status === 'solved') cls.push('solved');
    if (iss.id === __selectedIssueId) cls.push('active');
    return `<button type="button" class="${cls.join(' ')}" data-issue-id="${iss.id}" title="${escapeHtml(iss.title)}">#${iss.id}<br>${iss.status === 'solved' ? '\u2713 SOLVED' : '\u2717 OPEN'}</button>`;
  }).join('');
  Array.from(issuesButtons.querySelectorAll('.issue-btn')).forEach((btn) => {
    btn.addEventListener('click', () => {
      __selectedIssueId = parseInt(btn.dataset.issueId, 10) || 1;
      renderIssuesPanel();
    });
  });

  if (!d.apiData) {
    issuesBody.innerHTML = '<div style="color:var(--panel-muted);padding:12px;">No PSS loaded yet</div>';
    return;
  }

  const issue = PSS_ISSUES.find((i) => i.id === __selectedIssueId) || PSS_ISSUES[0];
  let errors = [];
  try { errors = issue.detect(dumps, fallbacks, d.apiData) || []; } catch (e) { errors = [`detector threw: ${e.message}`]; }

  const statusBadge = issue.status === 'solved'
    ? `<span style="color:#7fdc7f;font-weight:bold;">SOLVED</span>`
    : `<span style="color:#ff8a65;font-weight:bold;">OPEN</span>`;

  const dumpInfo = dumps.length === 0
    ? `<div style="color:#888;font-style:italic;padding:6px;">No PSS debug-dump loaded yet \u2014 load an animation to see live evidence.</div>`
    : `<div style="color:#888;font-size:11px;padding:4px 0;">scanned ${dumps.length} PSS file(s): ${dumps.map((dd) => escapeHtml(extractFileName(dd.sourcePath))).join(', ')}</div>`;

  let evidenceHtml;
  if (errors.length === 0) {
    evidenceHtml = issue.status === 'solved'
      ? `<div style="color:#7fdc7f;padding:6px;">\u2713 No evidence found \u2014 fix is verified live.</div>`
      : `<div style="color:#888;padding:6px;font-style:italic;">No evidence found in currently-loaded PSS files. Either the issue does not affect them, or the loaded set is too small to surface it.</div>`;
  } else {
    evidenceHtml = `<div style="padding:4px 0;color:#ff8a65;font-weight:bold;">${errors.length} evidence row(s):</div>`
      + errors.map((e) => `<div style="padding:3px 6px;border-left:2px solid #ff8a65;margin:2px 0;background:#2a1a1a;font-family:monospace;font-size:11px;color:#ddd;">${escapeHtml(e)}</div>`).join('');
  }

  const plainLines = errors.map((e) => `#${issue.id} ${issue.title} | ${e}`);
  window.__pssIssuesPlainText = plainLines.join('\n');

  issuesBody.innerHTML = `
<div class="dbg-section">
  <div style="padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:3px;">
    <div style="font-size:13px;font-weight:bold;margin-bottom:4px;">#${issue.id} \u2014 ${escapeHtml(issue.title)}</div>
    <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Status: ${statusBadge} \u00b7 Difficulty: ${escapeHtml(issue.difficulty)}</div>
    <div style="font-size:11px;color:#bbb;margin-bottom:8px;padding:6px;background:#0d0d0d;border-left:2px solid #4a8;border-radius:2px;">
      <b style="color:#4a8;">How this was found:</b><br>${escapeHtml(issue.howFound)}
    </div>
    ${dumpInfo}
    ${evidenceHtml}
  </div>
</div>`;
}

// Unified Warnings panel. Per the user's directive (2026-04-26):
//   - No more separate "Issues" tab, no more "Fallbacks" tab, no
//     informational "Notes" rendering.
//   - Anything that goes wrong is a single warning row.
//   - Engine-authoritative resolved items (e.g. legacy-fwrite-memory-leak
//     velocity payloads that the runtime engine rejects → effective zero)
//     are NOT surfaced — they are silent successes from the user's POV.
function renderWarningsContent(d) {
  const dumps = Array.isArray(d.debugDumps) ? d.debugDumps : [];
  const fallbacks = Array.isArray(d.fallbacks) ? d.fallbacks : [];
  const warnings = [];

  for (const dump of dumps) {
    const fileName = extractFileName(dump.sourcePath);
    if (Array.isArray(dump.uncertain)) {
      for (const item of dump.uncertain) {
        warnings.push({ where: `${fileName}`, detail: item });
      }
    }
    if (Array.isArray(dump.blocks)) {
      for (const blk of dump.blocks) {
        if (Array.isArray(blk.uncertain) && blk.uncertain.length > 0) {
          const where = `${fileName} · ${blk.typeLabel || 'blk'}#${blk.index}`
            + (blk.parsed?.materialName ? ` [${blk.parsed.materialName}]` : '');
          for (const item of blk.uncertain) warnings.push({ where, detail: item });
        }
      }
    }
  }

  // Renderer-side silent substitutions are also warnings.
  for (const fb of fallbacks) {
    const cat = String(fb.category || fb.msg || '').split(':')[0].trim() || 'fallback';
    const { msg, category: _c, ...rest } = fb;
    const detail = Object.keys(rest).length
      ? `${msg || cat} — ${formatDebugInlineValue(rest)}`
      : (msg || cat);
    warnings.push({ where: cat, detail });
  }

  const plainLines = warnings.map((w) => `${w.where} | ${w.detail}`);
  window.__pssIssuesPlainText = plainLines.join('\n');
  window.__pssFallbacksPlainText = plainLines.join('\n');

  if (warnings.length === 0) {
    return `<div class="dbg-section"><div class="dbg-row"><span class="dbg-ok">✓</span><span class="dbg-v">No warnings.</span></div></div>`;
  }

  let html = `<div class="dbg-section"><div class="dbg-section-title">Warnings (${warnings.length})</div>`;
  for (const w of warnings) {
    html += `<div class="dbg-row"><span class="dbg-warn">!</span><span class="dbg-v"><b>${escapeHtml(w.where)}</b> — ${escapeHtml(w.detail)}</span></div>`;
  }
  html += `</div>`;
  return html;
}

function renderDebugPanel() {
  // Issues panel is independent of the debug panel; refresh it if visible.
  try {
    const ip = document.getElementById('issues-panel');
    if (ip && !ip.classList.contains('hidden')) renderIssuesPanel();
  } catch { /* ignore */ }
  if (!debugBody) return;
  const d = pssDebugState;
  const data = d.apiData;
  if (!data) {
    debugBody.innerHTML = '<div style="color:var(--panel-muted);padding:12px;">No PSS loaded yet</div>';
    return;
  }

  debugBody.innerHTML = currentDebugTab === 'pss'
    ? renderPssDebugContent(d, data)
    : currentDebugTab === 'warnings'
      ? renderWarningsContent(d, data)
      : renderRuntimeDebugContent(d, data);
}

async function postDebugLogToServer() {
  // Flush any pending per-PSS aggregated fallback summaries first, so they
  // appear in the posted log instead of being held forever.
  try { flushFallbackAggregator(); } catch { /* not yet defined — rare */ }
  try {
    await fetch('/api/debug/pss-render-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePath: pssDebugState.sourcePath,
        loadedAt: pssDebugState.loadedAt,
        textureResults: pssDebugState.textureResults,
        meshResults: pssDebugState.meshResults,
        emitterCount: pssDebugState.apiData?.emitters?.length || 0,
        spriteCount: spriteEmitters.length,
        meshCount: meshObjects.length,
        trackCount: trackLines.length,
        errors: pssDebugState.errors,
        fallbacks: pssDebugState.fallbacks,
        soundEntries: currentSoundEntries,
        // PSS-focused audit: parsed vs uncertain fields per emitter + socket hint
        debugDumps: pssDebugState.debugDumps,
        socketRouting: pssDebugState.socketRouting,
      }),
    });
  } catch { /* non-fatal */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function extractFileName(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function normalizeDebugPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').trim().toLowerCase();
}

function dirnameFromUrl(url) {
  const normalized = String(url || '').replace(/[?#].*$/, '').replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.substring(0, idx) : '';
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.substring(0, i) : name;
}

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.substring(i).toLowerCase() : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── THREE.JS PSS RENDERER (Built from scratch) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Per-particle size shaders ──
const PSS_VERTEX_SHADER = `
attribute float pSize;
attribute vec4 pColor;
varying vec4 vCol;
void main() {
  vCol = pColor;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = pSize * (300.0 / -mvPos.z);
  gl_Position = projectionMatrix * mvPos;
}
`;
const PSS_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform int useMap;
varying vec4 vCol;
void main() {
  vec4 col = vCol;
  if (useMap == 1) {
    col *= texture2D(map, gl_PointCoord);
  } else {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    col.a *= smoothstep(0.5, 0.15, d);
  }
  if (col.a < 0.004) discard;
  gl_FragColor = col;
}
`;

const ddsLoader = new DDSLoader();
const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const pssMeshTextureCache = new Map();

// ── Scene setup ──
let renderer, scene, camera, clock, gridHelper;
let animationFrameId = null;
let isRendering = false;
let showGrid = true;

// ── Effect state ──
let spriteEmitters = [];   // active sprite particle systems
let meshObjects = [];       // loaded GLB mesh objects
let trackLines = [];        // active track ribbon emitters
let effectStartTime = 0;
let effectDuration = 5000;  // ms
let effectLooping = false;

// ── Timeline State ───────────────────────────────────────────────────────────
let timelineMs = 0;          // current playback position (ms)
let timelineTotalMs = 5000;  // animation duration from .ani (ms)
let timelinePlaying = false;
let timelineLooping = true;
let timelineSpeed = 1.0;
let timelineLastClockSec = null;
let timelinePssEntries = []; // [{path, startTimeMs}] for current tani
let soloPssSourcePath = null; // when set, hide emitters whose sourcePath differs

// Effect socket binding comes exclusively from TANI/PSS authored metadata.
// There is no default socket name and no keyword-based chooser: if the
// authored data does not name a socket, effects attach to the anchor rig
// root (currentEffectSocketName stays empty).
let playerAnchorRig = null;
let playerAnchorLoadVersion = 0;
let currentEffectSocketName = '';
let currentEffectSocketReason = 'no socket: authored metadata not yet loaded';
const spriteParentQuaternion = new THREE.Quaternion();
const spriteLocalQuaternion = new THREE.Quaternion();

function normalizeBoneKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeSocketKey(name) {
  return String(name || '').trim().toLowerCase();
}

function chooseEffectSocketSelection(_sourcePaths) {
  // No path-keyword chooser. The caller must provide authored socket
  // metadata; if absent, we return an empty selection and the effect
  // renders at the anchor rig origin.
  return {
    socketName: '',
    reason: 'no authored socket metadata in TANI/PSS',
  };
}

function findPrimarySkinnedMesh(root) {
  let bestMesh = null;
  let bestVertexCount = -1;

  root?.traverse((object) => {
    if (!object?.isSkinnedMesh || !object.geometry?.attributes?.position) return;
    const vertexCount = object.geometry.attributes.position.count || 0;
    if (vertexCount > bestVertexCount) {
      bestMesh = object;
      bestVertexCount = vertexCount;
    }
  });

  return bestMesh;
}

function hidePlayerRigRenderables(root) {
  root?.traverse((object) => {
    if (!object?.isMesh && !object?.isSkinnedMesh && !object?.isLine && !object?.isPoints) return;
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => {
        if (material) material.visible = false;
      });
    } else if (object.material) {
      object.material.visible = false;
    }
  });
}

function applyPlayerRigPresentation(root, placementRoot, orientationRoot) {
  orientationRoot.quaternion.identity();
  placementRoot.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  const primaryMesh = findPrimarySkinnedMesh(root);
  const bones = primaryMesh?.skeleton?.bones || [];
  const lowerNameMap = new Map(bones.map((bone) => [String(bone.name || '').toLowerCase(), bone]));
  const pelvisBone = lowerNameMap.get('bip01_pelvis') || lowerNameMap.get('pelvis') || null;
  const headBone = lowerNameMap.get('bip01_head') || lowerNameMap.get('head') || null;

  const pelvisPosition = new THREE.Vector3();
  const headPosition = new THREE.Vector3();
  const upVector = new THREE.Vector3();
  const uprightCorrection = new THREE.Quaternion();

  if (pelvisBone && headBone) {
    pelvisBone.getWorldPosition(pelvisPosition);
    headBone.getWorldPosition(headPosition);
    upVector.subVectors(headPosition, pelvisPosition);
    if (upVector.lengthSq() > 0.0001) {
      upVector.normalize();
      if (upVector.y < 0.6) {
        uprightCorrection.setFromUnitVectors(upVector, new THREE.Vector3(0, 1, 0));
      }
    }
  }

  orientationRoot.quaternion.copy(uprightCorrection);
  orientationRoot.updateMatrixWorld(true);

  const rawBox = new THREE.Box3().setFromObject(orientationRoot);
  if (!rawBox.isEmpty()) {
    const center = rawBox.getCenter(new THREE.Vector3());
    placementRoot.position.set(-center.x, -rawBox.min.y, -center.z);
  }
  placementRoot.updateMatrixWorld(true);
}

function buildPlayerRigSocketNodes(root, socketBindings) {
  const bonesByLower = new Map();
  const bonesByNormalized = new Map();
  root?.traverse((object) => {
    if (!object?.isBone) return;
    const lowerName = String(object.name || '').toLowerCase();
    const normalized = normalizeBoneKey(object.name);
    if (lowerName && !bonesByLower.has(lowerName)) bonesByLower.set(lowerName, object);
    if (normalized && !bonesByNormalized.has(normalized)) bonesByNormalized.set(normalized, object);
  });

  const findBone = (name) => {
    const lowerName = String(name || '').toLowerCase();
    const normalized = normalizeBoneKey(name);
    return bonesByLower.get(lowerName) || bonesByNormalized.get(normalized) || null;
  };

  const socketNodes = new Map();
  for (const binding of socketBindings || []) {
    if (!binding?.socketName || !binding?.parentBone) continue;
    const bone = findBone(binding.parentBone);
    if (!bone) continue;

    const socketNode = new THREE.Group();
    socketNode.name = `player_socket_${binding.socketName}`;
    socketNode.userData.parentBone = binding.parentBone;

    if (Array.isArray(binding.matrix) && binding.matrix.length === 16) {
      const matrix = new THREE.Matrix4();
      matrix.set(
        binding.matrix[0], binding.matrix[1], binding.matrix[2], binding.matrix[3],
        binding.matrix[4], binding.matrix[5], binding.matrix[6], binding.matrix[7],
        binding.matrix[8], binding.matrix[9], binding.matrix[10], binding.matrix[11],
        binding.matrix[12], binding.matrix[13], binding.matrix[14], binding.matrix[15],
      );
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      matrix.decompose(position, quaternion, scale);
      socketNode.position.copy(position);
      socketNode.quaternion.copy(quaternion);
      socketNode.userData.socketScale = scale.toArray();
    }

    bone.add(socketNode);
    socketNodes.set(normalizeSocketKey(binding.socketName), socketNode);
  }

  return {
    bonesByLower,
    bonesByNormalized,
    socketNodes,
  };
}

function clearPlayerAnchorRig(invalidatePending = true) {
  if (invalidatePending) {
    playerAnchorLoadVersion += 1;
  }
  if (playerAnchorRig?.placementRoot?.parent) {
    playerAnchorRig.placementRoot.parent.remove(playerAnchorRig.placementRoot);
  }
  playerAnchorRig = null;
}

function resolveAvailableEffectSocketName(preferredSocketName = currentEffectSocketName) {
  const socketNodes = playerAnchorRig?.socketNodes;
  if (!(socketNodes instanceof Map) || socketNodes.size === 0) {
    if (preferredSocketName) {
      dbg('fallback', 'socket: no rig loaded → returning empty (effect will attach to scene root)', {
        category: 'socket', preferred: preferredSocketName, rigLoaded: Boolean(playerAnchorRig),
      });
    }
    return '';
  }

  const key = normalizeSocketKey(preferredSocketName);
  if (key && socketNodes.has(key)) return key;

  // No keyword-fallback list: if the authored socket is not present,
  // caller must handle the empty result (render at rig root).
  if (preferredSocketName) {
    dbg('fallback', `socket: "${preferredSocketName}" not in rig → returning empty`, {
      category: 'socket', preferred: preferredSocketName,
      availableSockets: Array.from(socketNodes.keys()).slice(0, 24),
      totalSockets: socketNodes.size,
    });
  }
  return '';
}

// When authored PSS→socket metadata is missing (the common case for skills
// whose Socket.tab entry is absent), we still want the effect to be anchored
// to the character rather than floating at world origin. We walk an ordered
// list of "likely" bones and return the first one the rig actually has.
// Order: weapon bones → weapon socket → hand bones → spine/pelvis → root.
const DEFAULT_BONE_FALLBACK_CHAIN = [
  'r_weaponsocket', 'l_weaponsocket',
  'bip01_r_hand', 'bip01_l_hand',
  'bip01_r_forearm', 'bip01_l_forearm',
  'bip01_spine2', 'bip01_spine1', 'bip01_spine',
  'bip01_pelvis', 'bip01',
];

function findDefaultFallbackBone() {
  const byLower = playerAnchorRig?.bonesByLower;
  const byNorm = playerAnchorRig?.bonesByNormalized;
  if (!(byLower instanceof Map) && !(byNorm instanceof Map)) return null;
  for (const candidate of DEFAULT_BONE_FALLBACK_CHAIN) {
    const lower = candidate.toLowerCase();
    const bone = byLower?.get(lower) || byNorm?.get(normalizeBoneKey(candidate));
    if (bone) return { bone, name: candidate };
  }
  return null;
}

const SOCKET_FALLBACK_LOGGED_BONES = new Set();
const SOCKET_FALLBACK_COUNT = new Map(); // boneName -> count

function attachObjectToEffectSocket(object3D, preferredSocketName = currentEffectSocketName) {
  if (!object3D?.isObject3D) return '';

  const resolvedSocketName = resolveAvailableEffectSocketName(preferredSocketName);
  const socketNode = resolvedSocketName ? playerAnchorRig?.socketNodes?.get(resolvedSocketName) : null;

  if (socketNode) {
    socketNode.add(object3D);
    object3D.userData.effectSocketName = resolvedSocketName;
    return resolvedSocketName;
  }

  // No authored socket resolved. Attach to a sensible default bone so the
  // effect tracks the character instead of sitting at world origin. This is
  // still a fallback — record it — but distinguish "bone default used" from
  // "effect floating at scene root".
  const defaultBone = findDefaultFallbackBone();
  if (defaultBone) {
    defaultBone.bone.add(object3D);
    object3D.userData.effectSocketName = `bone:${defaultBone.name}`;
    // Attaching skill-PSS to the right-hand bone (bip01_r_hand) when no
    // Socket.tab is present is the engine-convention default for weapon
    // effects — NOT a parser gap. Silent. Non-default bones still dedup-
    // log since those indicate missing rig data worth surfacing.
    const isConventionalDefault = defaultBone.name === 'bip01_r_hand';
    const count = (SOCKET_FALLBACK_COUNT.get(defaultBone.name) || 0) + 1;
    SOCKET_FALLBACK_COUNT.set(defaultBone.name, count);
    if (!isConventionalDefault && !SOCKET_FALLBACK_LOGGED_BONES.has(defaultBone.name)) {
      SOCKET_FALLBACK_LOGGED_BONES.add(defaultBone.name);
      dbg('fallback', `socket: no authored socket → attached to default bone "${defaultBone.name}" (subsequent identical fallbacks suppressed)`, {
        category: 'socket', preferred: preferredSocketName, resolved: resolvedSocketName,
        appliedBone: defaultBone.name, rigLoaded: Boolean(playerAnchorRig),
        suppressedAfter: 1,
      });
    }
    return `bone:${defaultBone.name}`;
  }

  // No rig at all — last resort.
  dbg('fallback', 'socket: no socket node and no default bone → attached to scene root (effect will not follow character)', {
    category: 'socket', preferred: preferredSocketName, resolved: resolvedSocketName,
    rigLoaded: Boolean(playerAnchorRig),
  });
  if (object3D.parent !== scene) scene.add(object3D);
  return '';
}

// The anchor rig that gives effects a character to follow. Historically this
// loaded a bone-only skeleton FBX from /api/player-anim/anchor-support and
// then hid every renderable so only the invisible bones remained. That made
// effects float with nothing to see them against. Now we prefer loading an
// actor export (the "花萝" preset — an F1 body with no animation clip) so the
// character is actually rendered. Socket bindings still come from
// anchor-support because they are authored per-body-type and reference bone
// names present in every F1 skeleton.
//
// If fetching the actor export list fails or no matching preset is found, we
// fall back to the old skeleton-only path and record a fallback entry so the
// regression is visible in the Fallbacks tab.
const ACTOR_PRESET_BY_BODY_TYPE = {
  // 花萝无动作.fbx is an F1 body with the full wardrobe + textures and no
  // embedded animation clips. Perfect for use as a static anchor.
  f1: '花萝',
};

async function findActorPresetFbxUrl(normalizedBodyType) {
  const presetName = ACTOR_PRESET_BY_BODY_TYPE[normalizedBodyType];
  if (!presetName) return null;
  try {
    const list = await fetchJson('/api/actor-exports');
    if (!list?.available || !Array.isArray(list.exports)) return null;
    const match = list.exports.find((e) => e?.name === presetName);
    if (!match?.fbxUrl) {
      dbg('fallback', `actor-preset: preset "${presetName}" not in /api/actor-exports \u2192 using bone-only skeleton (character will be invisible)`, {
        category: 'actor-preset', preset: presetName, bodyType: normalizedBodyType,
      });
      return null;
    }
    // Build a lowercase→original-name Map so per-material texture lookup is
    // O(1) — exactly what actor-viewer does via findTextureFile().
    const textureFileLookup = new Map();
    for (const fileName of (match.textureFiles || [])) {
      if (typeof fileName === 'string' && fileName) {
        textureFileLookup.set(fileName.toLowerCase(), fileName);
      }
    }
    return {
      fbxUrl: match.fbxUrl,
      textureBaseUrl: match.textureBaseUrl || `${dirnameFromUrl(match.fbxUrl)}/tex`,
      name: match.name,
      textureFileLookup,
    };
  } catch (err) {
    dbg('fallback', `actor-preset: /api/actor-exports failed \u2192 using bone-only skeleton`, {
      category: 'actor-preset', bodyType: normalizedBodyType, error: err?.message || String(err),
    });
    return null;
  }
}

// Look up an original texture file name by {materialName}{suffix}{.png|.tga}.
// Returns the original cased filename, or null if nothing matches.
function findPresetTextureFile(textureFileLookup, materialName, suffix) {
  if (!(textureFileLookup instanceof Map) || !materialName) return null;
  const prefix = `${materialName}${suffix}`.toLowerCase();
  if (textureFileLookup.has(`${prefix}.png`)) return textureFileLookup.get(`${prefix}.png`);
  if (textureFileLookup.has(`${prefix}.tga`)) return textureFileLookup.get(`${prefix}.tga`);
  return null;
}

function loadPresetTexture(url, colorSpace) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (tex) => {
        if (colorSpace) tex.colorSpace = colorSpace;
        resolve(tex);
      },
      undefined,
      () => resolve(null),
    );
  });
}

// Walk every Mesh and prepare its material so textures render correctly.
// Mirrors actor-viewer.prepareMaterials() + applyFallbackMaterialTextures():
// for each material, look up {materialName}_Diffuse.{png,tga} in the actor's
// tex/ directory and override material.map so the character's textures match
// what actor-viewer shows. Without this pass the FBX ships with generic or
// missing maps and 花萝 renders with wrong albedo.
async function prepareAnchorRigMaterials(root, preset) {
  const textureFileLookup = preset?.textureFileLookup || null;
  const textureBaseUrl = preset?.textureBaseUrl || null;

  const overrideTasks = [];
  root?.traverse((object) => {
    if (!object?.isMesh && !object?.isSkinnedMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      // Zero the default emissive unless an emissiveMap is authored.
      if (material.emissive && !material.emissiveMap) {
        material.emissive.setRGB(0, 0, 0);
      }
      material.side = THREE.DoubleSide;
      if (material.transparent || material.alphaTest === 0) {
        material.alphaTest = Math.max(material.alphaTest || 0, 0.3);
      }
      // Per-material texture override: find {materialName}_Diffuse.* in
      // the actor's tex/ directory and swap it into material.map.
      const matName = String(material.name || '').trim();
      if (matName && textureFileLookup && textureBaseUrl) {
        const diffuseFile = findPresetTextureFile(textureFileLookup, matName, '_Diffuse');
        if (diffuseFile) {
          const url = `${textureBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(diffuseFile)}`;
          overrideTasks.push(loadPresetTexture(url, THREE.SRGBColorSpace).then((tex) => {
            if (tex) {
              material.map = tex;
              if (material.color) material.color.setHex(0xffffff);
              material.needsUpdate = true;
            } else {
              dbg('fallback', `actor-preset: texture "${diffuseFile}" failed to load → using FBX default map`, {
                category: 'actor-preset-texture', material: matName, url,
              });
            }
          }));
        }
        const normalFile = findPresetTextureFile(textureFileLookup, matName, '_TangentSpace_Normal');
        if (normalFile) {
          const url = `${textureBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(normalFile)}`;
          overrideTasks.push(loadPresetTexture(url, null).then((tex) => {
            if (tex) { material.normalMap = tex; material.needsUpdate = true; }
          }));
        }
        const specularFile = findPresetTextureFile(textureFileLookup, matName, '_SpecularColor');
        if (specularFile) {
          const url = `${textureBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(specularFile)}`;
          overrideTasks.push(loadPresetTexture(url, THREE.SRGBColorSpace).then((tex) => {
            if (tex && 'specularMap' in material) { material.specularMap = tex; material.needsUpdate = true; }
          }));
        }
      }
      // Enforce sRGB on any map still pointing at the FBX's embedded texture.
      if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
      if (material.emissiveMap) material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      material.needsUpdate = true;
    }
  });
  await Promise.all(overrideTasks);
}

async function ensurePlayerAnchorRig(bodyType) {
  const normalizedBodyType = String(bodyType || '').trim().toLowerCase();
  if (!normalizedBodyType) return null;
  if (playerAnchorRig?.bodyType === normalizedBodyType) return playerAnchorRig;

  const loadVersion = playerAnchorLoadVersion + 1;
  playerAnchorLoadVersion = loadVersion;

  // Always pull socket bindings from anchor-support — they are authored data
  // not embedded in any FBX. preferredSkeletonUrl is our fallback skeleton.
  const support = await fetchJson(`/api/player-anim/anchor-support?bodyType=${encodeURIComponent(normalizedBodyType)}`);
  const fallbackSkeletonUrl = support.preferredSkeletonUrl || support.standardSkeletonUrl || support.exportSkeletonUrl || support.importTestUrl;

  // Prefer the actor preset FBX (renders the character with textures) over
  // the bone-only skeleton.
  const preset = await findActorPresetFbxUrl(normalizedBodyType);
  const skeletonUrl = preset?.fbxUrl || fallbackSkeletonUrl;
  const resourcePath = preset?.textureBaseUrl || null;
  if (!skeletonUrl) {
    dbg('fallback', `anchor-rig: no skeleton URL for bodyType \"${normalizedBodyType}\" \u2192 effects will float in world space`, {
      category: 'anchor-rig', bodyType: normalizedBodyType,
    });
    return null;
  }

  const loader = new FBXLoader();
  // Texture resource base: for the actor preset we use its /tex/ directory;
  // otherwise we fall back to the directory containing the skeleton FBX.
  const resourceBase = resourcePath || dirnameFromUrl(skeletonUrl);
  if (resourceBase) {
    loader.setResourcePath(`${resourceBase.replace(/\/+$/, '')}/`);
  }

  const root = await new Promise((resolve, reject) => {
    loader.load(skeletonUrl, resolve, undefined, reject);
  });

  if (loadVersion !== playerAnchorLoadVersion) return playerAnchorRig;

  clearPlayerAnchorRig(false);

  const placementRoot = new THREE.Group();
  const orientationRoot = new THREE.Group();
  orientationRoot.add(root);
  placementRoot.add(orientationRoot);
  scene.add(placementRoot);

  applyPlayerRigPresentation(root, placementRoot, orientationRoot);
  const rigMaps = buildPlayerRigSocketNodes(root, support.socketBindings || []);

  if (preset?.fbxUrl) {
    // We DO want to see the character when we loaded the actor preset.
    // prepareAnchorRigMaterials is async: fire-and-forget so the rig is
    // returned immediately while textures swap in asynchronously.
    prepareAnchorRigMaterials(root, preset).catch((err) => {
      console.warn('prepareAnchorRigMaterials failed:', err);
    });
  } else {
    // Old bone-only skeleton path \u2014 hide everything, used only if the preset
    // lookup failed. Fallback was already recorded inside findActorPresetFbxUrl.
    hidePlayerRigRenderables(root);
  }

  playerAnchorRig = {
    bodyType: normalizedBodyType,
    support,
    root,
    placementRoot,
    orientationRoot,
    usingActorPreset: Boolean(preset?.fbxUrl),
    presetName: preset?.name || null,
    ...rigMaps,
  };
  return playerAnchorRig;
}

async function preparePlayerAnchorRigForEffect(sourcePaths) {
  const selection = chooseEffectSocketSelection(sourcePaths);
  currentEffectSocketName = selection.socketName;
  currentEffectSocketReason = selection.reason;

  try {
    const rig = await ensurePlayerAnchorRig(currentBodyType);
    const resolvedSocketName = resolveAvailableEffectSocketName(currentEffectSocketName);
    if (resolvedSocketName) {
      currentEffectSocketName = resolvedSocketName;
    }
    return rig;
  } catch (err) {
    console.warn('Failed to prepare player anchor rig:', err);
    currentEffectSocketReason = `anchor rig unavailable: ${err?.message || err}`;
    return null;
  }
}

function initThreeJs() {
  renderer = new THREE.WebGLRenderer({
    canvas: viewportCanvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x080c12, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.sortObjects = true;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  camera.position.set(0, 150, 400);
  camera.lookAt(0, 50, 0);

  clock = new THREE.Clock();

  // Grid
  gridHelper = new THREE.GridHelper(800, 40, 0x1a2a3a, 0x111a24);
  scene.add(gridHelper);

  // Scene lights. The actor FBX materials (MeshPhongMaterial) render black
  // without at least one light; a hemisphere + directional pair gives a clean
  // soft fill plus a key light so the character reads as a 3D object rather
  // than a silhouette. Effect sprites/tracks use MeshBasicMaterial and are
  // unaffected.
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x404050, 1.0);
  hemiLight.position.set(0, 200, 0);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(150, 300, 200);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xcfe0ff, 0.3);
  fillLight.position.set(-150, 100, -100);
  scene.add(fillLight);

  // Orbit-style mouse controls (manual, lightweight)
  initOrbitControls();

  // Resize
  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(viewportPanel);
  resizeRenderer();
}

function resizeRenderer() {
  const rect = viewportPanel.getBoundingClientRect();
  const w = rect.width || 800;
  const h = rect.height || 600;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Simple orbit controls ──
let orbitState = { dragging: false, button: -1, lastX: 0, lastY: 0, theta: 0, phi: Math.PI / 6, dist: 400, targetX: 0, targetY: 50, targetZ: 0 };

function initOrbitControls() {
  viewportCanvas.addEventListener('pointerdown', (e) => {
    orbitState.dragging = true;
    orbitState.button = e.button;
    orbitState.lastX = e.clientX;
    orbitState.lastY = e.clientY;
    viewportCanvas.setPointerCapture(e.pointerId);
  });
  viewportCanvas.addEventListener('pointermove', (e) => {
    if (!orbitState.dragging) return;
    const dx = e.clientX - orbitState.lastX;
    const dy = e.clientY - orbitState.lastY;
    orbitState.lastX = e.clientX;
    orbitState.lastY = e.clientY;
    if (orbitState.button === 0) {
      // Rotate
      orbitState.theta -= dx * 0.005;
      orbitState.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, orbitState.phi - dy * 0.005));
    } else if (orbitState.button === 2) {
      // Pan (vertical)
      orbitState.targetY += dy * 0.5;
    }
    updateCameraFromOrbit();
  });
  viewportCanvas.addEventListener('pointerup', () => { orbitState.dragging = false; });
  viewportCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbitState.dist = Math.max(20, Math.min(3000, orbitState.dist + e.deltaY * 0.5));
    updateCameraFromOrbit();
  }, { passive: false });
  viewportCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  updateCameraFromOrbit();
}

function updateCameraFromOrbit() {
  const { theta, phi, dist, targetX, targetY, targetZ } = orbitState;
  camera.position.set(
    targetX + dist * Math.sin(phi) * Math.sin(theta),
    targetY + dist * Math.cos(phi),
    targetZ + dist * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(targetX, targetY, targetZ);
}

function resetCamera() {
  orbitState = { ...orbitState, theta: 0, phi: Math.PI / 6, dist: 400, targetX: 0, targetY: 50, targetZ: 0 };
  updateCameraFromOrbit();
}

function autoFitCameraToEffect() {
  const box = new THREE.Box3();

  for (const mo of meshObjects) {
    if (mo && mo.group) {
      const b = new THREE.Box3().setFromObject(mo.group);
      if (!b.isEmpty()) box.union(b);
    }
  }
  for (const line of trackLines) {
    const trackObject = line?.group || line;
    if (trackObject) {
      const b = new THREE.Box3().setFromObject(trackObject);
      if (!b.isEmpty()) box.union(b);
    }
  }
  for (const em of spriteEmitters) {
    const r = em.spawnRadius || 50;
    const yBase = em.spawnYBase || 80;
    const yHalf = (em.spawnYSpread || 50) / 2;
    const minPoint = new THREE.Vector3(-r, yBase - yHalf, -r);
    const maxPoint = new THREE.Vector3(r, yBase + yHalf, r);
    if (em.points?.parent) {
      box.expandByPoint(em.points.localToWorld(minPoint));
      box.expandByPoint(em.points.localToWorld(maxPoint));
    } else {
      box.expandByPoint(minPoint);
      box.expandByPoint(maxPoint);
    }
  }

  if (box.isEmpty()) return;

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z, 50);
  const fovRad = (camera.fov * Math.PI) / 180;
  const fitDist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.5;

  orbitState.dist = Math.max(200, Math.min(3000, fitDist));
  orbitState.targetX = center.x;
  orbitState.targetY = center.y;
  orbitState.targetZ = center.z;
  orbitState.theta = 0;
  orbitState.phi = Math.PI / 6;
  updateCameraFromOrbit();
}

// ── Render loop ──
function startRenderLoop() {
  if (isRendering) return;
  isRendering = true;
  clock.start();
  effectStartTime = clock.getElapsedTime();
  renderFrame();
}

function stopRenderLoop() {
  isRendering = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function renderFrame() {
  if (!isRendering) return;
  animationFrameId = requestAnimationFrame(renderFrame);

  const elapsed = clock.getElapsedTime();
  const clockDelta = clock.getDelta();

  // ── Timeline advance ──
  // Track pre-advance value so we can feed a timeline-scoped delta to
  // emitter animation mixers (mesh ANI clips must follow timeline play /
  // pause / seek / loop, not wall-clock time).
  const timelineMsBefore = timelineMs;
  let timelineLoopedThisFrame = false;
  if (timelinePlaying && timelineTotalMs > 0) {
    if (timelineLastClockSec !== null) {
      const delta = (elapsed - timelineLastClockSec) * 1000 * timelineSpeed;
      timelineMs += delta;
      if (timelineMs >= timelineTotalMs) {
        if (timelineLooping) {
          timelineMs = timelineMs % timelineTotalMs;
          timelineLoopedThisFrame = true;
          for (const em of spriteEmitters) {
            resetSpriteEmitter(em);
          }
          for (const mesh of meshObjects) {
            if (typeof mesh.reset === 'function') mesh.reset();
          }
          for (const track of trackLines) {
            if (typeof track.reset === 'function') track.reset();
          }
        } else {
          timelineMs = timelineTotalMs;
          timelinePlaying = false;
        }
      }
    }
    timelineLastClockSec = elapsed;
    updateTimelineUI();
  }
  // Timeline-scoped delta in seconds. After a loop reset we already called
  // mo.reset() above, so feed 0 for the current frame to avoid a negative or
  // huge jump. When paused / seeking, delta is 0 and mixers freeze naturally.
  const timelineDeltaSec = timelineLoopedThisFrame
    ? 0
    : Math.max(0, (timelineMs - timelineMsBefore) / 1000);

  // ── Update sprite emitters (timeline-aware) ──
  for (const emitter of spriteEmitters) {
    const emStart = emitter.startTimeMs || 0;
    const solo = soloPssSourcePath;
    const soloHidden = solo && emitter.sourcePath !== solo;
    const visible = !soloHidden && timelineMs >= emStart;
    emitter.points.visible = visible;
    if (visible) {
      updateSpriteEmitter(emitter, timelineMs - emStart);
    }
  }

  // ── Update mesh animations ──
  for (const mo of meshObjects) {
    const solo = soloPssSourcePath;
    const soloHidden = solo && mo.sourcePath !== solo;
    mo.group.visible = !soloHidden && timelineMs >= (mo.startTimeMs || 0);
    if (mo.group.visible) {
      if (typeof mo.update === 'function') {
        mo.update(timelineDeltaSec);
      } else if (mo.mixer) {
        mo.mixer.update(timelineDeltaSec);
      }
    }
  }

  // ── Track line visibility ──
  for (const tl of trackLines) {
    const startTimeMs = tl.startTimeMs || tl.userData?.startTimeMs || 0;
    const solo = soloPssSourcePath;
    const soloHidden = solo && tl.sourcePath !== solo;
    const visible = !soloHidden && timelineMs >= startTimeMs;
    const trackObject = tl.group || tl;
    if (trackObject) trackObject.visible = visible;
    if (visible && typeof tl.update === 'function') {
      tl.update(timelineMs - startTimeMs);
    }
  }

  renderer.render(scene, camera);

  const sprites = spriteEmitters.length;
  const meshes = meshObjects.length;
  const tracks = trackLines.length;
  vpStats.textContent = `S:${sprites} M:${meshes} T:${tracks} | ${(timelineMs / 1000).toFixed(2)}s`;
}

// ── Clear scene ──
function clearEffect() {
  stopRenderLoop();
  for (const em of spriteEmitters) {
    if (typeof em.dispose === 'function') {
      em.dispose();
    } else {
      scene.remove(em.points);
      em.points.geometry.dispose();
      em.points.material.dispose();
    }
  }
  spriteEmitters = [];
  for (const mo of meshObjects) {
    if (typeof mo.dispose === 'function') {
      mo.dispose();
    } else {
      scene.remove(mo.group);
    }
  }
  meshObjects = [];
  for (const tl of trackLines) {
    if (typeof tl.dispose === 'function') {
      tl.dispose();
    } else {
      scene.remove(tl);
      tl.geometry?.dispose?.();
      tl.material?.dispose?.();
    }
  }
  trackLines = [];
  pssSelector.innerHTML = '';
  vpLabel.textContent = 'No effect loaded';
  vpStats.textContent = '';
  viewportOverlay.classList.remove('hidden');
  statusRenderer.textContent = 'Renderer: idle';
  timelineBar.classList.add('hidden');
  timelinePlaying = false;
  timelineMs = 0;
  timelineLastClockSec = null;
  timelinePssEntries = [];
  soloPssSourcePath = null;
}

// ── Timeline UI helpers ──────────────────────────────────────────────────────
function updateTimelineUI() {
  if (!tlPlayPause) return;
  tlPlayPause.textContent = timelinePlaying ? '⏸' : '▶';
  tlScrubber.value = timelineTotalMs > 0 ? Math.round((timelineMs / timelineTotalMs) * 10000) : 0;
  tlTime.textContent = `${(timelineMs / 1000).toFixed(2)} / ${(timelineTotalMs / 1000).toFixed(2)}s`;
  tlLoop.classList.toggle('active', timelineLooping);
}

function getTimelineEntryStartTimeMs(entry) {
  if (Number.isFinite(entry?.effectiveStartTimeMs)) return entry.effectiveStartTimeMs;
  if (Number.isFinite(entry?.startTimeMs)) return entry.startTimeMs;
  // Issue #8: GATA per-PSS start times are not engine-verified. When the source
  // PSS could not be resolved either, surface the unresolved state once per
  // (entry-path) so the Warnings panel shows it instead of silently rendering
  // at t=0 as if it were authoritative.
  if (entry && !entry.__timingWarningRecorded) {
    entry.__timingWarningRecorded = true;
    const list = (pssDebugState.fallbacks ||= []);
    list.push({
      kind: 'tani-start-time-unresolved',
      path: entry.path || '(unknown path)',
      timingSource: entry.timingSource || 'unresolved',
      gataTimingWarning: entry.gataTimingWarning || 'GATA per-PSS start time is not engine-verified; source PSS globalStartDelay also unresolved.',
      message: `${extractFileName(entry.path || '')}: timing unresolved — rendered at t=0 for layout only, not as an authoritative authored value.`,
    });
  }
  return 0;
}

function getPssEffectTiming(data) {
  // Strict authored-only timing. Any field that the server couldn't parse
  // out of the global block stays null, and the caller must handle the
  // absence explicitly (no numeric fallback).
  const rawStartDelay = Number(data?.globalStartDelay);
  const rawPlay = Number(data?.globalPlayDuration);
  const rawTotal = Number(data?.globalDuration);
  const startDelayMs = Number.isFinite(rawStartDelay) && rawStartDelay >= 0 ? rawStartDelay : null;
  const playDurationMs = Number.isFinite(rawPlay) && rawPlay > 0 ? rawPlay : null;
  const totalDurationMs = Number.isFinite(rawTotal) && rawTotal > 0
    ? rawTotal
    : (playDurationMs != null && startDelayMs != null ? startDelayMs + playDurationMs : (playDurationMs ?? null));
  const activeDurationMs = (totalDurationMs != null && startDelayMs != null)
    ? Math.max(0, totalDurationMs - startDelayMs)
    : (playDurationMs ?? null);
  return {
    startDelayMs,
    totalDurationMs,
    activeDurationMs,
  };
}

function updateTimelineMarkers() {
  if (!tlMarkers) return;
  tlMarkers.innerHTML = '';
  for (const entry of timelinePssEntries) {
    const startTimeMs = getTimelineEntryStartTimeMs(entry);
    if (startTimeMs <= 0 || timelineTotalMs <= 0) continue;
    const pct = startTimeMs / timelineTotalMs;
    if (pct <= 0 || pct >= 1) continue;
    const marker = document.createElement('div');
    marker.className = 'tl-marker';
    marker.style.left = `${pct * 100}%`;
    marker.title = `${extractFileName(entry.path)} @ ${startTimeMs.toFixed(0)}ms`;
    tlMarkers.appendChild(marker);
  }
}

// ── Additive PSS effect load (used by loadAllPssFromTani) ───────────────────
async function addPssEffect(sourcePath, startTimeMs = 0) {
  try {
    // Fetch the analyzer (full parsed data used by the renderer) AND the
    // focused binary audit in parallel. The audit drives the PSS-focused debug
    // panel and the per-PSS socket routing — without it, every PSS in a TANI
    // stacks on the same fallback socket.
    const [data, debugDump] = await Promise.all([
      fetchJson(`/api/pss/analyze?sourcePath=${encodeURIComponent(sourcePath)}`),
      fetchJson(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`).catch(() => null),
    ]);
    if (!data.ok) throw new Error('API error');

    // Store first successfully loaded PSS data for debug panel
    if (!pssDebugState.apiData) pssDebugState.apiData = data;
    if (debugDump && debugDump.ok) {
      debugDump._sourcePath = sourcePath;
      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {
        pssDebugState.debugDumps.push(debugDump);
      }
    }

    // Per-PSS socket selection: honor the server-provided hint if it resolves
    // to a real socket on the currently-loaded rig; fall back to whatever
    // `currentEffectSocketName` was set to by the actor loader.
    const requestedSocket = debugDump?.socket?.suggested || null;
    const resolvedSocket = requestedSocket
      ? resolveAvailableEffectSocketName(requestedSocket)
      : resolveAvailableEffectSocketName(currentEffectSocketName);
    const socketForThisPss = resolvedSocket || currentEffectSocketName;
    pssDebugState.socketRouting.push({
      sourcePath,
      suggested: requestedSocket,
      resolved: resolvedSocket,
      applied: socketForThisPss,
      reason: debugDump?.socket?.reason || 'fallback (no debug-dump)',
    });
    if (requestedSocket && !resolvedSocket) {
      // Server told us to use socket X, the rig doesn't have it, we picked
      // whatever currentEffectSocketName holds. That downstream value itself
      // may also not exist — which attachObjectToEffectSocket will record
      // separately when it falls through to scene root.
      dbg('fallback', `pss-socket: server suggested "${requestedSocket}" but rig has no such socket → using "${socketForThisPss}" instead`, {
        category: 'pss-socket', sourcePath, suggested: requestedSocket, applied: socketForThisPss,
      });
    }
    // else: when `requestedSocket` is null the server had no PSS→socket
    // binding to report. For skill PSS (e.g. T_天策龙牙.pss) that is the
    // normal case — effects inherit the caller's socket. Silent; not a gap.

    const texPromises = (data.textures || []).map(t => loadTexture(t));
    const loadedTextures = await Promise.all(texPromises);
    const texMap = new Map();
    for (let ti = 0; ti < (data.textures || []).length; ti++) {
      const t = data.textures[ti];
      const loaded = !!loadedTextures[ti];
      const name = t.texturePath?.split('/').pop() || '?';
      // Mirror the single-PSS flow so the runtime debug panel shows texture
      // load results for every PSS in a TANI chain, not only the first one.
      dbg('texture', name, { texturePath: t.texturePath, name, loaded, sourcePath });
      if (loaded) {
        texMap.set(t.texturePath, loadedTextures[ti]);
        texMap.set(t.originalPath || t.texturePath, loadedTextures[ti]);
      }
    }
    // data.fireIntent was a keyword guess on server side — REMOVED. Always false.
    const trackTexturePool = buildTrackTexturePool(data.textures || [], texMap, false);
    const effectTiming = getPssEffectTiming(data);
    const effectStartTimeMs = Math.max(0, startTimeMs + (effectTiming.startDelayMs ?? 0));
    const localEffectDurationMs = effectTiming.activeDurationMs;
    const createdSpriteEmitters = [];
    const createdTrackEmitters = [];

    const spriteEmitterDefs = (data.emitters || []).filter((em) => em.type === 'sprite');
    for (let spriteIndex = 0; spriteIndex < spriteEmitterDefs.length; spriteIndex++) {
      const em = spriteEmitterDefs[spriteIndex];
      // Collect ALL resolved texture layers (not just the first one).
      // PSS sprite emitters can be 单层/双层/三层 (1-3 layers); discard none.
      const textures = [];
      for (const rt of (em.resolvedTextures || [])) {
        const t = texMap.get(rt.texturePath);
        if (t) textures.push(t);
      }
      const emObj = createSpriteEmitter(em, textures, spriteIndex, spriteEmitterDefs.length);
      emObj.startTimeMs = effectStartTimeMs;
      emObj.effectDurationMs = localEffectDurationMs;
      emObj.sourcePath = sourcePath;
      emObj.points.visible = (effectStartTimeMs === 0);
      attachObjectToEffectSocket(emObj.points, socketForThisPss);
      spriteEmitters.push(emObj);
      createdSpriteEmitters.push(emObj);
    }

    const meshEmitterDefs = (data.emitters || []).filter((em) => em.type === 'mesh');
    for (let meshIdx = 0; meshIdx < meshEmitterDefs.length; meshIdx++) {
      const em = meshEmitterDefs[meshIdx];
      const mo = await loadMeshEmitter(em, meshIdx, meshEmitterDefs.length);
      const meshName = (em.resolvedMeshes || [])
        .map((asset) => asset?.sourcePath)
        .filter(Boolean)
        .map((p) => p.split('/').pop())
        .join(', ');
      if (mo) {
        mo.startTimeMs = effectStartTimeMs;
        mo.sourcePath = sourcePath;
        mo.group.visible = (effectStartTimeMs === 0);
        const attachedMeshSocket = attachObjectToEffectSocket(mo.group, socketForThisPss);
        // Spread mesh emitters in XZ so multiple emitters don't stack at the same point.
        // Skip spread for track-driven ribbons — their update() writes group.position
        // every frame and the spread offset would be invisible anyway.
        if (!mo.trackPath) {
          const meshSpreadR = attachedMeshSocket ? 3 : 25;
          const meshAngle = (meshIdx / Math.max(meshEmitterDefs.length, 1)) * Math.PI * 2;
          mo.group.position.x += Math.cos(meshAngle) * meshSpreadR;
          mo.group.position.z += Math.sin(meshAngle) * meshSpreadR;
        }
        meshObjects.push(mo);
        dbg('mesh', `Loaded mesh emitter: ${meshName || `#${em.index}`}`, {
          emitterIndex: em.index,
          sourcePath,
          sourcePaths: (em.resolvedMeshes || []).map((asset) => asset?.sourcePath).filter(Boolean),
          animationPaths: (em.resolvedAnimations || []).map((asset) => asset?.sourcePath).filter(Boolean),
        });
      } else {
        // Only record as a real failure if the server DID resolve a mesh path
        // for this emitter but the GLB loader rejected it. Emitters with no
        // resolved meshes are a server-side cache miss, not a renderer bug,
        // and spamming "Failed mesh emitter" for each one makes the debug
        // panel misleading.
        const resolved = (em.resolvedMeshes || []).map((a) => a?.sourcePath).filter(Boolean);
        if (resolved.length > 0) {
          dbg('mesh-error', `Failed mesh emitter: ${meshName || `#${em.index}`}`, {
            emitterIndex: em.index,
            sourcePath,
            sourcePaths: resolved,
          });
          dbgFallbackAggregate('mesh-load', sourcePath,
            `mesh-load: GLB loader rejected resolved mesh(es) → emitter skipped`,
            { emitterIndex: em.index, sourcePath, sourcePaths: resolved });
        } else {
          // Two sub-cases. The server-side type-2 parser classifies EVERY
          // type=2 block as `type:'mesh'` even when the block's subType is
          // actually particle/flame/cloth/billboard/trail — those launchers
          // never embed a .mesh path, so `em.meshes` is empty by design,
          // not by cache miss. Logging those as "mesh-cache miss" is wrong
          // and was producing dozens of misleading entries.
          const requestedMeshes = (em.meshes || em.meshPaths || []);
          if (requestedMeshes.length > 0) {
            // Real cache miss: mesh path requested but not found in extract.
            dbgFallbackAggregate('mesh-cache', sourcePath,
              `mesh-cache: server returned 0 resolved meshes → emitter silently skipped`,
              {
                emitterIndex: em.index,
                sourcePath,
                requestedMeshes: requestedMeshes.slice(0, 8),
              });
          } else {
            // No mesh path authored — non-mesh type-2 launcher
            // (Sprite/Particle/Flame/Cloth/Trail billboard). These are
            // legitimately unsupported by the web renderer; silently skip
            // rather than filling the debug panel with expected-missing entries.
          }
        }
      }
    }

    const trackEmitterDefs = (data.emitters || []).filter((em) => em.type === 'track');
    for (let trackIndex = 0; trackIndex < trackEmitterDefs.length; trackIndex++) {
      const em = trackEmitterDefs[trackIndex];
      const trackEmitter = createTrackEmitter(em, trackTexturePool, trackIndex, trackEmitterDefs.length);
      if (trackEmitter) {
        trackEmitter.startTimeMs = effectStartTimeMs;
        trackEmitter.effectDurationMs = localEffectDurationMs;
        trackEmitter.group.visible = (effectStartTimeMs === 0);
        attachObjectToEffectSocket(trackEmitter.group, socketForThisPss);
        trackLines.push(trackEmitter);
        createdTrackEmitters.push(trackEmitter);
      }
    }

    assignSpriteCadenceFromTracks(createdSpriteEmitters, createdTrackEmitters);
    return {
      startTimeMs: effectStartTimeMs,
      endTimeMs: effectStartTimeMs + localEffectDurationMs,
      totalDurationMs: effectTiming.totalDurationMs,
    };
  } catch (err) {
    console.warn('addPssEffect failed:', sourcePath, err.message);
    dbg('error', `addPssEffect(${sourcePath.split('/').pop()}): ${err.message}`, {});
    return null;
  }
}

// ── Load all PSS effects from tani with timeline ─────────────────────────────
async function loadAllPssFromTani(pssEntries, durationMs) {
  clearEffect();
  resetDebugState();
  viewportOverlay.classList.add('hidden');

  timelineTotalMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  timelineMs = 0;
  timelinePlaying = false;
  timelineLastClockSec = null;
  timelinePssEntries = (pssEntries || []).map((entry) => {
    if (typeof entry === 'string') return { path: entry, startTimeMs: 0 };
    return { ...entry };
  });

  await preparePlayerAnchorRigForEffect([
    currentTaniData?.aniPath,
    ...pssEntries.map((entry) => entry?.path),
  ]);

  for (let i = 0; i < timelinePssEntries.length; i++) {
    const entry = timelinePssEntries[i];
    pssDebugState.sourcePath = entry.path;
    pssDebugState.loadedAt = new Date().toISOString();
    // Issue #8: never coerce a null start time to 0 silently. Use the explicit
    // effectiveStartTimeMs from the server when available; otherwise call
    // getTimelineEntryStartTimeMs which records an unresolved-timing warning
    // before returning the layout-only 0.
    const layoutStart = getTimelineEntryStartTimeMs(entry);
    const window = await addPssEffect(entry.path, layoutStart);
    if (window) {
      entry.effectiveStartTimeMs = window.startTimeMs;
      timelineTotalMs = Math.max(timelineTotalMs, window.endTimeMs);
    }
  }

  if (spriteEmitters.length === 0 && meshObjects.length === 0 && trackLines.length === 0) {
    viewportOverlay.classList.remove('hidden');
    viewportOverlay.querySelector('.empty-msg').textContent = 'Effect loaded, but no renderable emitters found';
    statusRenderer.textContent = 'Renderer: no renderable emitters';
    return;
  }

  vpLabel.textContent = timelinePssEntries.length === 1 ? extractFileName(timelinePssEntries[0].path) : `${timelinePssEntries.length} PSS effects`;
  statusRenderer.textContent = `Renderer: ${spriteEmitters.length}S ${meshObjects.length}M ${trackLines.length}T | ${(timelineTotalMs / 1000).toFixed(2)}s | ${currentEffectSocketName}`;

  timelineBar.classList.remove('hidden');
  buildPssSelector(timelinePssEntries);
  updateTimelineMarkers();
  updateTimelineUI();

  timelinePlaying = true;
  timelineLastClockSec = null;
  startRenderLoop();

  // Auto-fit camera to show the full effect (meshes + tracks may extend far from origin)
  autoFitCameraToEffect();

  // Update debug panel now that all PSS effects have loaded
  // Flush per-PSS aggregated fallback summaries (max-particles / lifetime /
  // size-curve collapse dozens of per-emitter logs to one summary each).
  flushFallbackAggregator();
  if (!debugPanel.classList.contains('hidden') || (document.getElementById('issues-panel') && !document.getElementById('issues-panel').classList.contains('hidden'))) renderDebugPanel();
  postDebugLogToServer();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPRITE EMITTER ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampValue(value, min, max) {
  const safe = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, safe));
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wrapUnit(value) {
  const wrapped = (Number.isFinite(value) ? value : 0) % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function sampleTriCurve(startValue, midValue, endValue, t) {
  const time = clamp01(t);
  if (time <= 0.5) {
    return startValue + (midValue - startValue) * (time / 0.5);
  }
  return midValue + (endValue - midValue) * ((time - 0.5) / 0.5);
}

// Linear interpolation across an ordered array of N keyframe values. Used
// when the PSS author supplied a full KG3D_ParticleSizeLifeTime keyframe
// array (detected server-side as N×16B stride records; see extractTailParams
// sizeCurveKeyframes). Falls back to sampleTriCurve when fewer than 2 keys.
function sampleKeyframeCurve(keyframes, t) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return 1;
  if (keyframes.length === 1) return keyframes[0];
  const time = clamp01(t);
  const scaled = time * (keyframes.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(keyframes.length - 1, left + 1);
  const frac = scaled - left;
  return keyframes[left] + (keyframes[right] - keyframes[left]) * frac;
}

function sampleColorCurve(colorCurve, t) {
  if (!Array.isArray(colorCurve) || colorCurve.length === 0) {
    return [1, 1, 1, 1];
  }
  if (colorCurve.length === 1) {
    const only = colorCurve[0] || [1, 1, 1, 1];
    return [only[0] ?? 1, only[1] ?? 1, only[2] ?? 1, only[3] ?? 1];
  }

  const scaled = clamp01(t) * (colorCurve.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(colorCurve.length - 1, leftIndex + 1);
  const mix = scaled - leftIndex;
  const left = colorCurve[leftIndex] || colorCurve[0] || [1, 1, 1, 1];
  const right = colorCurve[rightIndex] || left;

  return [0, 1, 2, 3].map((channel) => {
    const start = Number(left[channel]);
    const end = Number(right[channel]);
    const safeStart = Number.isFinite(start) ? start : 1;
    const safeEnd = Number.isFinite(end) ? end : safeStart;
    return safeStart + (safeEnd - safeStart) * mix;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPRITE EMITTER (no-fallback rewrite) ─────────────────────────────────────
// Every value used to spawn / update / render a sprite particle MUST come from
// authored PSS data. The previous implementation synthesised role, timeline
// window, spawn radius, velocity, particle count, base size, fade curves,
// opacity and rotation from material-name keywords and category heuristics.
// That entire heuristic stack has been deleted per user mandate.
//
// Authored fields consumed:
//   emitterData.colorCurve               KG3D_ParticleColor / ColorLifeTime
//   emitterData.runtimeParams.lifetimeSeconds   KG3D_ParticleLifeTime.fLifeTime
//   emitterData.runtimeParams.sizeCurve         KG3D_ParticleSizeLifeTime triplet
//   emitterData.runtimeParams.alphaCurve        KG3D_ParticleAlphaLifeTime triplet
//   emitterData.runtimeParams.maxParticles      per-emitter pool (fixed trailer)
//   emitterData.uvRows / uvCols          atlas dims from +320 / +324
//   emitterData.blendMode                .jsondef RenderState.BlendMode
//   emitterData.layerCount / layerFlags  +360 block
//
// Fields we do NOT substitute when absent:
//   velocity, spawn radius, Y-spread, rotation, fade curves, timeline
//   sub-window, pulse cadence, activity gate — all resolve to zero / identity.
// ═══════════════════════════════════════════════════════════════════════════════

// Deterministic RNG (mulberry32). Used only in seed-dependent helpers that
// need per-particle jitter derived from a stable integer seed. Never for
// rendering position / color / velocity.
function makeSprng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getEffectGlobalGate(effectTimeMs, effectDurationMs) {
  const dur = Math.max(1, Number.isFinite(effectDurationMs) ? effectDurationMs : (timelineTotalMs || effectDuration || 5000));
  const playNorm = clamp01(effectTimeMs / dur);
  // Binary on/off: within authored duration = 1 else 0. No synthesised fade.
  return { durationMs: dur, playNorm, globalGate: (playNorm >= 0 && playNorm <= 1) ? 1 : 0 };
}

// Retained as a no-op stub so both call sites continue to compile. Cadence
// linking required synthesised role classification and per-emitter phase
// seeds — deleted by the no-fallback rewrite.
function assignSpriteCadenceFromTracks(/* spriteEmitterList, trackEmitterList */) { return 0; }

function spawnSpriteParticle(em, particle) {
  // Lifetime — authored PSS lifetimeSeconds. Absent → full effect duration.
  particle.lifetime = Math.max(0.05, Number.isFinite(em.authoredLifetime) ? em.authoredLifetime : em.effectSeconds);

  // Size — authored size curve multipliers. Absent → constant 1.0 world unit.
  if (em.authoredSizeKeyframes && em.authoredSizeKeyframes.length >= 3) {
    // Full keyframe array (KG3D_ParticleSizeLifeTime records). Stored as an
    // ordered list of size-value samples across particle lifetime.
    particle.sizeKeyframes = em.authoredSizeKeyframes;
    particle.size = em.authoredSizeKeyframes[0];
    particle.sizeMid = em.authoredSizeKeyframes[Math.floor(em.authoredSizeKeyframes.length / 2)];
    particle.sizeEnd = em.authoredSizeKeyframes[em.authoredSizeKeyframes.length - 1];
    particle.useRuntimeSizeCurve = true;
  } else if (em.authoredSizeCurve) {
    particle.sizeKeyframes = null;
    particle.size = em.authoredSizeCurve[0];
    particle.sizeMid = em.authoredSizeCurve[1];
    particle.sizeEnd = em.authoredSizeCurve[2];
    particle.useRuntimeSizeCurve = true;
  } else {
    particle.sizeKeyframes = null;
    particle.size = 1; particle.sizeMid = 1; particle.sizeEnd = 1;
    particle.useRuntimeSizeCurve = false;
  }

  // Spawn at emitter origin. PSS type-1 block parser does not expose per-
  // particle velocity / spawn offset / gravity, so: zero velocity, zero rot.
  particle.spawnPos.set(0, 0, 0);
  particle.velocity.set(0, 0, 0);
  particle.rotSpeed = 0;
  particle.maxOpacity = 1;
  particle.age = 0;
  particle.alive = true;

  for (const layer of particle.layers) {
    layer.mesh.visible = true;
    layer.mesh.position.copy(particle.spawnPos);
    layer.mesh.scale.setScalar(particle.size * layer.scaleMul);
    layer.mesh.rotation.z = layer.rotationOffset;
    layer.mat.opacity = 0;
  }
}

function resetSpriteEmitter(em) {
  if (!em || !Array.isArray(em.particles)) return;
  em.lastEffectTimeMs = null;
  em.elapsed = 0;
  for (const particle of em.particles) {
    particle.alive = false;
    particle.age = 0;
    for (const layer of particle.layers) {
      layer.mesh.visible = false;
      layer.mat.opacity = 0;
    }
  }
  // Fixed deterministic pool: spawn every particle at t=0. They cycle over
  // the authored lifetime.
  for (const particle of em.particles) spawnSpriteParticle(em, particle);
}

function disposeSpriteEmitter(em) {
  if (!em) return;
  em.points?.parent?.remove(em.points);
  // Shared per-layer resources: dispose once, not per-particle.
  if (Array.isArray(em.layerResources)) {
    for (const res of em.layerResources) {
      res.mat?.dispose?.();
      if (res.atlasTex && typeof res.atlasTex.dispose === 'function') {
        res.atlasTex.dispose();
      }
    }
  }
  em.sharedGeometry?.dispose?.();
}

function createSpriteEmitter(emitterData, textures, emIndex = 0, totalEmitters = 1) {
  const colorCurve = Array.isArray(emitterData.colorCurve) && emitterData.colorCurve.length > 0
    ? emitterData.colorCurve : null;
  const runtime = emitterData.runtimeParams || null;
  const authoredLifetime = runtime && Number.isFinite(runtime.lifetimeSeconds) && runtime.lifetimeSeconds > 0
    ? runtime.lifetimeSeconds : null;
  const authoredSizeCurve = runtime && Array.isArray(runtime.sizeCurve) && runtime.sizeCurve.length === 3
    ? runtime.sizeCurve.map(Number) : null;
  const authoredSizeKeyframes = runtime && Array.isArray(runtime.sizeCurveKeyframes) && runtime.sizeCurveKeyframes.length >= 3
    ? runtime.sizeCurveKeyframes.map(Number) : null;
  const authoredAlphaCurve = runtime && Array.isArray(runtime.alphaCurve) && runtime.alphaCurve.length === 3
    ? runtime.alphaCurve.map(Number) : null;
  const authoredMaxParticles = runtime && Number.isFinite(runtime.maxParticles) && runtime.maxParticles > 0
    ? runtime.maxParticles : null;

  // blendMode always comes from .jsondef RenderState.BlendMode on the server
  // (readJsondefBlendMode). Engine default is 'normal' when absent.
  const isAdditive = emitterData.blendMode === 'additive';
  // If the analyzer had to guess blend mode from material/texture name, it
  // marks blendModeSource with 'name-fallback' or 'name-fallback:<reason>'.
  // Count every occurrence so we can see how many emitters in a TANI are
  // rendering with a guessed blend.
  const bmSource = emitterData.blendModeSource || '';
  if (bmSource.startsWith('name-fallback') && emitterData.blendMode !== 'normal') {
    // Only log guessed blend mode when the inferred result is non-default
    // (additive/multiply). When inference gives 'normal' the result is
    // identical to the engine default — no meaningful info to surface.
    dbgFallbackAggregate('blend-mode-guessed', pssDebugState.sourcePath,
      `blend-mode: .jsondef missing → guessed "${emitterData.blendMode || 'normal'}" from material name`,
      {
        emitterIndex: emitterData.index,
        sourcePath: pssDebugState.sourcePath,
        applied: emitterData.blendMode || 'normal',
        blendModeSource: bmSource,
        material: emitterData.materialName || emitterData.material || null,
      });
  } else if (bmSource === 'jsondef:missing') {
    dbgFallbackAggregate('blend-mode', pssDebugState.sourcePath,
      `blend-mode: .jsondef file not found → using engine default 'normal'`,
      {
        emitterIndex: emitterData.index,
        sourcePath: pssDebugState.sourcePath,
        applied: emitterData.blendMode || 'normal',
      });
  }

  const authoredLayerCount = Number.isFinite(emitterData.layerCount) && emitterData.layerCount > 0
    ? Math.min(4, emitterData.layerCount) : null;
  const rawTextures = (Array.isArray(textures) ? textures : [textures]).filter(Boolean);
  const textureLayers = authoredLayerCount
    ? rawTextures.slice(0, authoredLayerCount)
    : rawTextures.slice(0, 4);
  if (textureLayers.length === 0) textureLayers.push(null);

  // Initial material tint = midpoint of authored colorCurve. Absent → white
  // (texture shown as-is, honest "no authored color").
  let baseTint;
  if (colorCurve) {
    const mid = sampleColorCurve(colorCurve, 0.5);
    baseTint = new THREE.Color(mid[0], mid[1], mid[2]);
  } else {
    baseTint = new THREE.Color(1, 1, 1);
    // Only log as a fallback if the PSS block actually declared a
    // KG3D_ParticleColor (颜色) module but the server failed to decode
    // its payload. When status is 'no-module' the block is texture-only
    // (颜色贴图 without 颜色) — default white is the engine-correct result
    // and is NOT a parser gap.
    if (emitterData.colorCurveStatus === 'unparsed') {
      dbg('fallback', 'color-tint: 颜色 module declared but payload unparsed → tint defaulted to white (1,1,1)', {
        category: 'color-tint',
        emitterIndex: emitterData.index,
        sourcePath: pssDebugState.sourcePath,
        colorCurveStatus: emitterData.colorCurveStatus,
      });
    }
  }

  const sharedGeometry = new THREE.PlaneGeometry(1, 1);
  const points = new THREE.Group();
  scene.add(points);

  const uvRows = Math.max(1, Math.min(16, Number(emitterData.uvRows) || 1));
  const uvCols = Math.max(1, Math.min(16, Number(emitterData.uvCols) || 1));
  const atlasCellCount = uvRows * uvCols;
  const isAtlas = atlasCellCount > 1;

  const effectSeconds = Math.max(0.2, (timelineTotalMs || effectDuration || 5000) / 1000);
  // Particle count: authored maxParticles, else 1. No role-based scaling.
  const particleCount = authoredMaxParticles || 1;
  // Only log as a fallback when the block has the standard tail marker AND
  // we actually saw the marker bytes — strict equality with `true` so that
  // peer-inferred runtimes (where tailMarkerPresent is undefined because
  // the block has no marker of its own) do NOT trigger the message.
  // Authored time modules (生命 / 尺寸) are the ONLY ones that serialize a
  // per-particle lifetime float; other modules (速度/重力/旋转/亮度/颜色…)
  // sample over [0..lifetime] but do not author it. When neither is
  // present, engine inheritance of the global play duration is the
  // engine-correct outcome, not a parser gap.
  const tailMarkerPresent = runtime ? runtime.tailMarkerPresent === true : false;
  const sprMods = Array.isArray(emitterData.modules) ? emitterData.modules : [];
  const hasLifetimeAuthoringModule = sprMods.includes('\u751F\u547D') || sprMods.includes('\u5C3A\u5BF8');
  if (!authoredMaxParticles && tailMarkerPresent) {
    dbgFallbackAggregate('max-particles', pssDebugState.sourcePath,
      'max-particles: tail marker present but maxParticles unparsed → defaulted to 1 particle',
      {
        emitterIndex: emitterData.index,
        sourcePath: pssDebugState.sourcePath,
        applied: particleCount,
      });
  }
  if (!authoredLifetime && tailMarkerPresent && hasLifetimeAuthoringModule) {
    dbgFallbackAggregate('lifetime', pssDebugState.sourcePath,
      'lifetime: tail marker present but lifetimeSeconds unparsed → reusing full effect duration',
      {
        emitterIndex: emitterData.index,
        sourcePath: pssDebugState.sourcePath,
        fallbackSeconds: effectSeconds,
      });
  }
  if (!authoredSizeCurve && tailMarkerPresent) {
    // Server already classifies size-curve state authoritatively (see
    // server.js sizeCurveStatus). Only the 'unparsed' case represents a
    // real parser gap. 'no-module' (engine-default size 1.0 IS the
    // authored outcome) and 'no-animation' (缩放 declared but payload is
    // metadata-only zeros) are silent.
    if (emitterData.sizeCurveStatus === 'unparsed') {
      dbgFallbackAggregate('size-curve', pssDebugState.sourcePath,
        'size-curve: 缩放 module has dense payload but no decodable keyframe array',
        {
          emitterIndex: emitterData.index,
          sourcePath: pssDebugState.sourcePath,
          sizeCurveStatus: emitterData.sizeCurveStatus,
        });
    }
  }

  // ── Shared per-layer resources ──
  // Every particle in this sprite emitter is spawned at t=0 in
  // resetSpriteEmitter() and advances its age uniformly, so ALL particles
  // share the same color, opacity, atlas frame, and size every frame. That
  // means the Material and Texture (atlas clone) only need to exist ONCE
  // per layer instead of once per (particle × layer). Previous revisions
  // cloned the texture and instantiated MeshBasicMaterial per particle,
  // producing up to maxParticles × layerCount (e.g. 120 × 2 = 240) redundant
  // GPU resources per sprite emitter, which is the dominant cause of the
  // PSS-load-time viewport stall the user reported.
  const layerResources = textureLayers.map((texture, layerIndex) => {
    const layerFlag = Array.isArray(emitterData.layerFlags) ? Number(emitterData.layerFlags[layerIndex] || 0) : 0;
    let atlasTex = texture;
    if (isAtlas && texture?.clone) {
      atlasTex = texture.clone();
      atlasTex.needsUpdate = false;
      atlasTex.wrapS = THREE.ClampToEdgeWrapping;
      atlasTex.wrapT = THREE.ClampToEdgeWrapping;
      atlasTex.repeat.set(1 / uvCols, 1 / uvRows);
      atlasTex.offset.set(0, (uvRows - 1) / uvRows);
    }

    const mat = new THREE.MeshBasicMaterial({
      map: atlasTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: isAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
      opacity: 0,
      color: baseTint.clone(),
    });

    return {
      mat,
      atlasTex: isAtlas ? atlasTex : null,
      texture,
      layerFlag,
      scaleMul: 1,
      opacityMul: 1,
      spinMul: 0,
      rotationOffset: 0,
    };
  });

  const particles = [];
  for (let particleIndex = 0; particleIndex < particleCount; particleIndex++) {
    // Each particle still owns its own Mesh instances (one per layer) so the
    // scene graph honors the authored maxParticles concurrency. Mesh objects
    // are cheap compared with Materials/Textures; the Material+Map is shared
    // across every particle in the emitter at the same layer index.
    const layers = layerResources.map((res) => {
      const mesh = new THREE.Mesh(sharedGeometry, res.mat);
      mesh.visible = false;
      points.add(mesh);
      return {
        mesh,
        mat: res.mat,
        atlasTex: res.atlasTex,
        scaleMul: res.scaleMul,
        opacityMul: res.opacityMul,
        spinMul: res.spinMul,
        rotationOffset: res.rotationOffset,
        layerFlag: res.layerFlag,
      };
    });

    particles.push({
      id: particleIndex,
      layers,
      alive: false,
      age: 0,
      lifetime: 1,
      size: 1,
      sizeMid: 1,
      sizeEnd: 1,
      useRuntimeSizeCurve: false,
      spawnPos: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      rotSpeed: 0,
      maxOpacity: 1,
    });
  }

  const emitter = {
    runtimeType: 'sprite',
    points,
    sharedGeometry,
    layerResources,   // Material+Texture owned ONCE per layer, shared by all particles
    particles,
    emDef: emitterData,
    particleCount: particles.length,
    uvRows,
    uvCols,
    atlasCellCount,
    isAtlas,
    colorCurve,
    authoredLifetime,
    authoredSizeCurve,
    authoredSizeKeyframes,
    authoredAlphaCurve,
    authoredMaxParticles,
    sizeCurveAuthored: Boolean(authoredSizeCurve),
    isAdditive,
    baseTint: baseTint.clone(),
    currentColor: baseTint.clone(),
    effectSeconds,
    effectDurationMs: Math.max(1, timelineTotalMs || effectDuration || 5000),
    lastEffectTimeMs: null,
    elapsed: 0,
    emitterIndex: emitterData.index,
    dispose() { disposeSpriteEmitter(this); },
  };

  resetSpriteEmitter(emitter);
  return emitter;
}

function updateSpriteEmitter(em, effectTimeMs) {
  const previous = em.lastEffectTimeMs;
  let dt = 0.016;
  if (Number.isFinite(previous)) {
    const rawDelta = (effectTimeMs - previous) / 1000;
    if (rawDelta < 0) { resetSpriteEmitter(em); }
    else { dt = Math.max(0.001, Math.min(0.05, rawDelta)); }
  }
  em.lastEffectTimeMs = effectTimeMs;
  em.elapsed += dt;

  const { globalGate } = getEffectGlobalGate(effectTimeMs, em.effectDurationMs);

  // All particles share age/lifetime (resetSpriteEmitter spawns them all at
  // t=0 together and they cycle uniformly). So color, alpha, size and atlas
  // frame are IDENTICAL across the whole pool every frame. Compute them
  // once using particle[0] as the representative, then advance the rest to
  // keep state in sync. This drops the per-frame cost from O(particles ×
  // layers) curve samples + material writes to O(layers).
  const rep = em.particles[0];
  if (!rep) return;
  if (!rep.alive) spawnSpriteParticle(em, rep);
  rep.age += dt;
  if (rep.age >= rep.lifetime) rep.age = 0;
  const t = clamp01(rep.age / rep.lifetime);

  // Shared color + alpha (one write per layer material).
  let opacity = globalGate;
  if (em.colorCurve) {
    const color = sampleColorCurve(em.colorCurve, t);
    const authoredAlpha = em.authoredAlphaCurve
      ? sampleTriCurve(em.authoredAlphaCurve[0], em.authoredAlphaCurve[1], em.authoredAlphaCurve[2], t)
      : (Number.isFinite(color[3]) ? color[3] : 1);
    opacity = Math.max(0, Math.min(1, authoredAlpha)) * globalGate;
    em.currentColor.setRGB(color[0], color[1], color[2]);
    for (const res of em.layerResources) {
      res.mat.color.setRGB(color[0], color[1], color[2]);
      res.mat.opacity = opacity;
    }
  } else {
    em.currentColor.setRGB(1, 1, 1);
    for (const res of em.layerResources) {
      res.mat.color.setRGB(1, 1, 1);
      res.mat.opacity = opacity;
    }
  }

  // Shared atlas offset (one write per layer texture).
  if (em.isAtlas) {
    const cellIndex = Math.min(em.atlasCellCount - 1, Math.floor(t * em.atlasCellCount));
    const col = cellIndex % em.uvCols;
    const row = Math.floor(cellIndex / em.uvCols);
    const flippedRow = (em.uvRows - 1) - row;
    const offX = col / em.uvCols;
    const offY = flippedRow / em.uvRows;
    for (const res of em.layerResources) {
      if (res.atlasTex) res.atlasTex.offset.set(offX, offY);
    }
  }

  const currentSize = rep.useRuntimeSizeCurve
    ? (rep.sizeKeyframes
        ? sampleKeyframeCurve(rep.sizeKeyframes, t)
        : sampleTriCurve(rep.size, rep.sizeMid, rep.sizeEnd, t))
    : 1;

  // Shared billboard quaternion (parent group is the same for all layers).
  const parentGroup = em.points;
  if (parentGroup) {
    parentGroup.getWorldQuaternion(spriteParentQuaternion);
    spriteLocalQuaternion.copy(spriteParentQuaternion).invert().multiply(camera.quaternion);
  } else {
    spriteLocalQuaternion.copy(camera.quaternion);
  }

  // Per-particle work: sync age, then apply scale + quaternion to meshes.
  // Position is static (spawn = origin, no authored velocity) so we do NOT
  // re-copy it every frame — that was 4560+ redundant Vector3.copy calls
  // per frame on a fully loaded PSS.
  for (const particle of em.particles) {
    if (!particle.alive) spawnSpriteParticle(em, particle);
    particle.age = rep.age;
    for (const layer of particle.layers) {
      layer.mesh.visible = true;
      layer.mesh.scale.setScalar(currentSize * layer.scaleMul);
      layer.mesh.quaternion.copy(spriteLocalQuaternion);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MESH EMITTER ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function loadMeshEmitter(meshAsset, emIndex = 0, totalMeshEmitters = 1) {
  const resolvedMeshAssets = (meshAsset?.resolvedMeshes || []).filter((asset) => asset?.sourcePath);
  if (resolvedMeshAssets.length === 0) return null;

  // NO per-emitter tint keyword guess (previous `resolvePssEmitterTint` was a
  // guess — user rule: never guess. If a launcher authors a tint color it is
  // stored in the PSS type-2 block (see `KG3D_ParticleColor` / `KG3D_Particle
  // ColorLifeTime` / `KE3D_ParticleMeshQuoteLauncher::SetMeshQuoteColor` per
  // /memories/repo/pss-format-authoritative.md) and must be parsed server-
  // side into `meshAsset.color = [r,g,b,a]`. Until that parse is implemented
  // we do NOT tint — the authored texture alone is shown. White will appear
  // for white-mask textures; that is the honest rendering.
  const pssEmitterTint = (Array.isArray(meshAsset?.color) && meshAsset.color.length >= 3)
    ? new THREE.Color(meshAsset.color[0], meshAsset.color[1], meshAsset.color[2])
    : null;

  // PSS particle meshes: normalize to 100 units max, matching the track emitter
  // normalisation (scale = 100 / maxDim) so all effect layers share the same
  // coordinate scale. Then apply the per-emitter emitterScale from meshFields.
  const pssEffectNormalizeSize = 100;
  const emitterScaleFactor = Number.isFinite(meshAsset?.meshFields?.emitterScale)
    ? Math.max(0.1, Math.min(4, meshAsset.meshFields.emitterScale)) : 1;
  const actorMultiMeshRadialOffset = 8;

  const animationPaths = (meshAsset?.resolvedAnimations || [])
    .map((asset) => asset?.sourcePath)
    .filter(Boolean);

  const cloneMeshMaterial = (material) => {
    if (!material || typeof material.clone !== 'function') return material;
    const mat = material.clone();
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    if (!Number.isFinite(mat.opacity)) mat.opacity = 1;
    mat.transparent = Boolean(mat.transparent || mat.opacity < 1);
    if ('toneMapped' in mat) mat.toneMapped = false;
    return mat;
  };

  const buildPssMeshTextureCandidates = (texturePath) => {
    const normalized = String(texturePath || '').trim().replace(/\\/g, '/');
    if (!normalized) return [];

    const candidates = [];
    if (/\.tga$/i.test(normalized)) {
      candidates.push(normalized.replace(/\.tga$/i, '.dds'));
    }
    candidates.push(normalized);
    return [...new Set(candidates)];
  };

  const loadPssMeshTextureByPath = async (texturePath, usage = 'color') => {
    const candidates = buildPssMeshTextureCandidates(texturePath);
    for (const candidate of candidates) {
      const cacheKey = `${usage}:${candidate.toLowerCase()}`;
      let pending = pssMeshTextureCache.get(cacheKey);
      if (!pending) {
        pending = loadTexture({
          texturePath: candidate,
          rawUrl: `/api/pss/texture?path=${encodeURIComponent(candidate)}`,
        }).then((texture) => {
          if (texture && usage !== 'color') {
            texture.colorSpace = THREE.NoColorSpace;
          }
          return texture;
        });
        pssMeshTextureCache.set(cacheKey, pending);
      }

      const texture = await pending;
      if (texture) return texture;
    }

    return null;
  };

  const applyPssMeshMaterial = async (mesh) => {
    if (!mesh?.isMesh) return;

    const slots = Array.isArray(mesh.material)
      ? mesh.material.map((mat, i) => ({ mat, i }))
      : [{ mat: mesh.material, i: null }];

    for (const { mat: material, i: slotIndex } of slots) {
      if (!material) continue;

      const meshMaterialMeta = material.userData?.pssMaterial;
      if (!meshMaterialMeta || typeof meshMaterialMeta !== 'object') continue;

      const textures = meshMaterialMeta.textures || {};
      const colors = meshMaterialMeta.colors || {};
      const floats = meshMaterialMeta.floats || {};
      // PSS JsonInspack texture slots use Chinese key names (e.g. 颜色贴图=color,
      // 消散贴图=dissolve/alpha, 通道贴图=channel). Try English keys first (for
      // actor meshes converted by build_map_data.py), then Chinese fallbacks.
      const baseColorPath = textures.BaseColorMap || textures.DiffuseTexture || textures.ColorMap
        || textures['颜色贴图'] || textures['消散贴图'] || textures['通道贴图'] || null;
      const normalPath = textures.NormalTexture || textures.NormalMap || textures['法线贴图'] || null;
      const blendMode = Number(meshMaterialMeta.blendMode || 0);
      const alphaRef = THREE.MathUtils.clamp((Number(meshMaterialMeta.alphaRef) || 128) / 255, 0, 1);

      // Authentic material Params (direct from JsonInspack Param array).
      // BaseColor: RGBA multiplier. Rim "轮廓光强度&颜色" RGBA stores rim
      // color in RGB and intensity in A (can exceed 1.0 for HDR glow).
      // These are authored values — not guesses — so we prefer them over
      // any client-side tint when the texture is unavailable.
      const paramBaseColor = Array.isArray(colors.BaseColor) && colors.BaseColor.length >= 3
        ? colors.BaseColor : null;
      const paramRim = Array.isArray(colors['轮廓光强度&颜色']) && colors['轮廓光强度&颜色'].length >= 4
        ? colors['轮廓光强度&颜色'] : null;

      const [baseColorTexture, normalTexture] = await Promise.all([
        baseColorPath ? loadPssMeshTextureByPath(baseColorPath, 'color') : Promise.resolve(null),
        normalPath ? loadPssMeshTextureByPath(normalPath, 'normal') : Promise.resolve(null),
      ]);

      // Choose the tint color strictly from authored data, in priority:
      //   1. BaseColor Param from JsonInspack (authored RGBA)
      //   2. pssEmitterTint (authored sprite colorCurve) if present
      //   3. Rim color's RGB (authored) when nothing else available
      //   4. White (texture provides all color)
      let authoredTint = null;
      if (paramBaseColor) {
        authoredTint = new THREE.Color(paramBaseColor[0], paramBaseColor[1], paramBaseColor[2]);
      } else if (pssEmitterTint) {
        authoredTint = pssEmitterTint.clone();
      } else if (!baseColorTexture && paramRim) {
        authoredTint = new THREE.Color(paramRim[0], paramRim[1], paramRim[2]);
      }

      if (blendMode === 2) {
        // Additive blend: replace MeshStandardMaterial with MeshBasicMaterial.
        // Without scene lights MeshStandardMaterial produces no diffuse output;
        // MeshBasicMaterial outputs map.rgb × color directly, which is correct
        // for additive glow / particle-mesh effects.
        const tintHex = authoredTint ? authoredTint.getHex() : 0xffffff;
        const newMat = new THREE.MeshBasicMaterial({
          map: baseColorTexture || null,
          color: tintHex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        newMat.userData = material.userData;
        if (slotIndex !== null) {
          mesh.material[slotIndex] = newMat;
        } else {
          mesh.material = newMat;
        }
        material.dispose();
      } else {
        if (baseColorTexture) {
          material.map = baseColorTexture;
          if (authoredTint && material.color?.copy) {
            material.color.copy(authoredTint);
          } else {
            material.color?.setHex?.(0xffffff);
          }
        } else if (authoredTint && material.color?.copy) {
          material.color.copy(authoredTint);
        }
        // Rim/fresnel glow from 轮廓光强度&颜色 (authentic).
        // Only apply as emissive when the shader supports it (e.g. MeshStandardMaterial).
        if (paramRim && 'emissive' in material && material.emissive?.setRGB) {
          const intensity = Math.max(0, Math.min(4, paramRim[3] || 0));
          material.emissive.setRGB(
            paramRim[0] * intensity,
            paramRim[1] * intensity,
            paramRim[2] * intensity
          );
          if ('emissiveIntensity' in material) material.emissiveIntensity = 1;
        }
        if (normalTexture && 'normalMap' in material) {
          material.normalMap = normalTexture;
          material.normalScale = new THREE.Vector2(1, -1);
        }
        if (blendMode === 1) {
          material.transparent = true;
          material.alphaTest = Math.max(0.02, alphaRef);
        }
        material.needsUpdate = true;
      }
    }
  };

  const applyPssMeshMaterialTextures = async (root) => {
    const jobs = [];
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      jobs.push(applyPssMeshMaterial(obj));
    });
    await Promise.all(jobs);
  };

  const prepareMeshInstance = (root) => {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.geometry?.clone) {
        obj.geometry = obj.geometry.clone();
      }
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map(cloneMeshMaterial);
      } else {
        obj.material = cloneMeshMaterial(obj.material);
      }
    });
    return root;
  };

  const centerAndScaleMeshGroup = (root) => {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return false;
    const boxCenter = new THREE.Vector3();
    const boxSize = new THREE.Vector3();
    box.getCenter(boxCenter);
    box.getSize(boxSize);
    const maxDim = Math.max(boxSize.x, boxSize.y, boxSize.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0.0001) return false;
    const normScale = (pssEffectNormalizeSize / maxDim) * emitterScaleFactor;
    root.scale.setScalar(normScale);
    root.position.copy(boxCenter).multiplyScalar(-normScale);
    return true;
  };

  const disposeObject3D = (root) => {
    root.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) {
        for (const material of obj.material) {
          material?.dispose?.();
        }
      } else {
        obj.material?.dispose?.();
      }
    });
  };

  const group = new THREE.Group();
  const mixers = [];
  const clipActions = [];

  for (let meshIndex = 0; meshIndex < resolvedMeshAssets.length; meshIndex++) {
    const asset = resolvedMeshAssets[meshIndex];
    const params = new URLSearchParams({ path: asset.sourcePath });
    if (animationPaths.length > 0) {
      params.set('ani', animationPaths.join(','));
    }
    const glbUrl = `/api/pss/mesh-glb?${params.toString()}`;

    try {
      const gltf = await new Promise((resolve, reject) => {
        gltfLoader.load(glbUrl, resolve, undefined, reject);
      });
      const root = gltf.scene || gltf.scenes?.[0];
      if (!root) continue;

      const instance = prepareMeshInstance(root);
      await applyPssMeshMaterialTextures(instance);
      if (!centerAndScaleMeshGroup(instance)) continue;

      if (resolvedMeshAssets.length > 1) {
        const angle = (meshIndex / Math.max(resolvedMeshAssets.length, 1)) * Math.PI * 2;
        const radial = actorMultiMeshRadialOffset;
        instance.position.x += Math.cos(angle) * radial;
        instance.position.z += Math.sin(angle) * radial;
      }

      group.add(instance);

      const clips = Array.isArray(gltf.animations) ? gltf.animations : [];
      if (clips.length > 0) {
        const mixer = new THREE.AnimationMixer(instance);
        mixers.push(mixer);
        for (const clip of clips) {
          const action = mixer.clipAction(clip);
          action.reset();
          action.play();
          clipActions.push(action);
        }
        mixer.update(0);
      }
    } catch (err) {
      console.warn('Failed to load mesh GLB:', asset.sourcePath, err);
    }
  }

  if (group.children.length === 0) return null;

  scene.add(group);

  // ── Motion source resolution ──
  // Three cases, decided by authoritative PSS fields (never by name):
  //   1. `linkedTrack` present (server paired this ribbon launcher with a
  //      sibling type-3 track emitter via `classFlags.hasSiblingTrack`):
  //      translate the whole group along the decoded path each frame.
  //   2. `linkedTrack` absent BUT `classFlags.hasTrackCurve === true`
  //      (a.k.a. MeshQuoteEmbedded, e.g. 气流_模型粒子 / 月上升_模型粒子):
  //      the motion curve is baked into the referenced .Mesh/.Ani asset and
  //      was converted to glTF animation channels by
  //      `tools/convert_pss_mesh_to_glb.py`. The mixer+clipActions built in
  //      the loop above already plays every GLB clip, so no extra work is
  //      needed here — just log the branch so it is visible in DevTools.
  //   3. Neither: static mesh at emitter origin.
  const classFlags = meshAsset?.meshFields?.classFlags || {};
  const hasTrackCurveBakedIn = classFlags.hasTrackCurve === true && classFlags.hasSiblingTrack === false;
  let trackPath = null;
  let trackElapsed = 0;
  if (meshAsset?.linkedTrack?.decodedTrack?.nodes) {
    const normalized = normalizeDecodedTrackNodes(meshAsset.linkedTrack.decodedTrack.nodes);
    if (normalized && Array.isArray(normalized.nodes) && normalized.nodes.length >= 2) {
      const params = meshAsset.linkedTrack.trackParams || {};
      const speedHint = Number.isFinite(params.speedHint) ? Math.max(5, Math.min(2000, params.speedHint)) : 80;
      const flowScale = Number.isFinite(params.flowScale) ? Math.max(0.2, Math.min(4, params.flowScale)) : 1;
      // 80 speed ≈ 2.2s cycle, 25 speed ≈ 7s (big fire banner, slow sweep)
      const cycleSeconds = Math.max(0.6, Math.min(8, 176 / speedHint * (1 / Math.max(0.4, flowScale))));
      trackPath = {
        nodes: normalized.nodes,
        cycleSeconds,
        phase: (emIndex / Math.max(totalMeshEmitters, 1)) + (meshAsset.index % 7) * 0.13,
      };
    }
  } else if (hasTrackCurveBakedIn && clipActions.length > 0) {
    console.debug('[pss-mesh] baked-curve motion: launcherClass=%s clips=%d anims=%o',
      meshAsset?.meshFields?.launcherClass, clipActions.length, animationPaths);
  } else if (hasTrackCurveBakedIn) {
    console.warn('[pss-mesh] launcher %s has hasTrackCurve=true but GLB exposed 0 animation clips — ' +
      'convert_pss_mesh_to_glb.py did not emit a curve. Mesh will render static.',
      meshAsset?.meshFields?.launcherClass);
  }

  return {
    group,
    mixers,
    trackPath,
    update(dt) {
      for (const mixer of mixers) {
        mixer.update(dt);
      }
      if (trackPath && trackPath.nodes.length >= 2) {
        trackElapsed += dt;
        const cycle = trackPath.cycleSeconds;
        const t = (((trackElapsed / cycle) + trackPath.phase) % 1 + 1) % 1;
        const nodes = trackPath.nodes;
        let segEnd = 1;
        for (; segEnd < nodes.length; segEnd++) {
          if (nodes[segEnd].along >= t) break;
        }
        if (segEnd >= nodes.length) segEnd = nodes.length - 1;
        const a = nodes[Math.max(0, segEnd - 1)];
        const b = nodes[segEnd];
        const span = Math.max(0.000001, b.along - a.along);
        const local = Math.max(0, Math.min(1, (t - a.along) / span));
        group.position.set(
          a.position.x + (b.position.x - a.position.x) * local,
          a.position.y + (b.position.y - a.position.y) * local,
          a.position.z + (b.position.z - a.position.z) * local,
        );
        const tx = b.position.x - a.position.x;
        const tz = b.position.z - a.position.z;
        if (tx * tx + tz * tz > 0.000001) {
          group.rotation.y = Math.atan2(tx, tz);
        }
      }
    },
    reset() {
      trackElapsed = 0;
      for (const action of clipActions) {
        action.reset();
        action.play();
      }
      for (const mixer of mixers) {
        mixer.setTime(0);
        mixer.update(0);
      }
    },
    dispose() {
      group.parent?.remove(group);
      disposeObject3D(group);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TRACK EMITTER ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeTrackVector(rawVector, fallback) {
  if (!Array.isArray(rawVector) || rawVector.length < 3) return fallback.clone();
  const x = Number(rawVector[0]);
  const y = Number(rawVector[1]);
  const z = Number(rawVector[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback.clone();
  const out = new THREE.Vector3(x, y, -z);
  if (out.lengthSq() < 0.000001) return fallback.clone();
  out.normalize();
  return out;
}

function normalizeDecodedTrackNodes(trackNodes) {
  const baseNodes = [];
  for (const node of trackNodes || []) {
    const pos = node?.position;
    if (!Array.isArray(pos) || pos.length < 3) continue;

    const x = Number(pos[0]);
    const y = Number(pos[1]);
    const z = Number(pos[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    baseNodes.push({
      position: new THREE.Vector3(x, y, -z),
      right: normalizeTrackVector(node?.right, new THREE.Vector3(1, 0, 0)),
      up: normalizeTrackVector(node?.up, new THREE.Vector3(0, 1, 0)),
      forward: normalizeTrackVector(node?.forward, new THREE.Vector3(0, 0, 1)),
      widthHint: Number.isFinite(Number(node?.w)) ? clampValue(Math.abs(Number(node.w)), 0.25, 2.5) : 1,
    });
  }
  if (baseNodes.length < 2) return null;

  const compact = [baseNodes[0]];
  for (let i = 1; i < baseNodes.length; i++) {
    if (compact[compact.length - 1].position.distanceToSquared(baseNodes[i].position) > 0.000001) {
      compact.push(baseNodes[i]);
    }
  }
  if (compact.length < 2) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const node of compact) {
    const point = node.position;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  }

  const center = new THREE.Vector3(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5,
  );
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.0001);
  const scale = 100 / maxDim;

  let totalLength = 0;
  const cumulativeLengths = [0];
  for (let i = 1; i < compact.length; i++) {
    totalLength += compact[i].position.distanceTo(compact[i - 1].position);
    cumulativeLengths.push(totalLength);
  }
  const invTotal = totalLength > 0.000001 ? 1 / totalLength : 0;

  const nodes = compact.map((node, index) => {
    const along = invTotal > 0
      ? cumulativeLengths[index] * invTotal
      : index / Math.max(compact.length - 1, 1);

    const position = node.position.clone().sub(center).multiplyScalar(scale);
    position.y += 80;

    const prev = compact[Math.max(0, index - 1)].position.clone().sub(center).multiplyScalar(scale);
    prev.y += 80;
    const next = compact[Math.min(compact.length - 1, index + 1)].position.clone().sub(center).multiplyScalar(scale);
    next.y += 80;

    const tangent = next.clone().sub(prev);
    if (tangent.lengthSq() < 0.000001) tangent.copy(node.forward);
    if (tangent.lengthSq() < 0.000001) tangent.set(0, 0, 1);
    tangent.normalize();

    const side = node.right.clone();
    side.addScaledVector(tangent, -side.dot(tangent));
    if (side.lengthSq() < 0.000001) side.copy(new THREE.Vector3().crossVectors(tangent, node.up));
    if (side.lengthSq() < 0.000001) {
      const refAxis = Math.abs(tangent.y) < 0.92 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      side.copy(new THREE.Vector3().crossVectors(tangent, refAxis));
    }
    side.normalize();

    const up = node.up.clone();
    up.addScaledVector(tangent, -up.dot(tangent));
    up.addScaledVector(side, -up.dot(side));
    if (up.lengthSq() < 0.000001) up.copy(new THREE.Vector3().crossVectors(side, tangent));
    if (up.lengthSq() < 0.000001) up.set(0, 1, 0);
    up.normalize();

    const thickness = (0.58 + 0.42 * Math.sin(along * Math.PI)) * node.widthHint;
    return { position, along, thickness, tangent, side, up };
  });

  return { nodes, pathLength: totalLength * scale };
}

function sliceTrackNodesForEmitter(nodes, emIndex, totalTrackEmitters, trackParams, seedRoot) {
  if (!Array.isArray(nodes) || nodes.length < 4) {
    return {
      nodes: nodes || [],
      segmentStart: 0,
      segmentEnd: 1,
      segmentSpan: 1,
      segmentCenter: 0.5,
      usedFallback: true,
    };
  }

  const total = Math.max(totalTrackEmitters, 1);
  const widthScale = Number.isFinite(trackParams?.widthScale) ? clampValue(trackParams.widthScale, 0.25, 2.5) : 1;
  const flowScale = Number.isFinite(trackParams?.flowScale) ? clampValue(trackParams.flowScale, 0.2, 4) : 1;
  const speedHint = Number.isFinite(trackParams?.speedHint) ? clampValue(trackParams.speedHint, 5, 2000) : 80;

  const baseCenter = (emIndex + 0.5) / total;
  const jitter = ((((seedRoot >>> 9) & 1023) / 1023) - 0.5) * 0.08;
  const flowOffset = (flowScale - 1) * 0.045;
  const segmentCenter = wrapUnit(baseCenter + jitter + flowOffset);

  const speedBoost = speedHint < 40 ? 0.14 : speedHint < 80 ? 0.08 : 0.04;
  const spanUpperBound = clampValue(0.98 / total + 0.4, 0.36, 0.9);
  const segmentSpan = clampValue(0.22 + widthScale * 0.15 + speedBoost, 0.2, spanUpperBound);

  const start = segmentCenter - segmentSpan * 0.5;
  const end = segmentCenter + segmentSpan * 0.5;
  const selected = [];

  for (const node of nodes) {
    let wrappedAlong = node.along;
    if (wrappedAlong - segmentCenter > 0.5) wrappedAlong -= 1;
    else if (segmentCenter - wrappedAlong > 0.5) wrappedAlong += 1;

    if (wrappedAlong >= start && wrappedAlong <= end) {
      const segmentAlong = clampValue((wrappedAlong - start) / Math.max(segmentSpan, 0.0001), 0, 1);
      selected.push({ ...node, segmentAlong });
    }
  }

  if (selected.length < 4) {
    return {
      nodes: nodes.map((node) => ({ ...node, segmentAlong: node.along })),
      segmentStart: 0,
      segmentEnd: 1,
      segmentSpan: 1,
      segmentCenter,
      usedFallback: true,
    };
  }

  selected.sort((left, right) => left.segmentAlong - right.segmentAlong);
  return {
    nodes: selected,
    segmentStart: wrapUnit(start),
    segmentEnd: wrapUnit(end),
    segmentSpan,
    segmentCenter,
    usedFallback: false,
  };
}

function classifyTrackTextureSemantic(path, categoryHint = '') {
  const value = String(path || '').toLowerCase();
  const category = String(categoryHint || '').toLowerCase();
  return {
    isTrack: /轨迹|track|trail|line|streak/.test(value),
    isMask: /alpha|mask|通道/.test(value),
    isGlow: /光|flare|glow|beam|ring/.test(value),
    isSmoke: category === 'smoke' || /烟|smoke|cloud|雾|fog/.test(value),
    isDebris: category === 'debris' || /碎|leaf|debris|枫叶|血|肉/.test(value),
    isFire: /火|fire|flame/.test(value),
  };
}

function scoreTrackTextureCandidate(path, categoryHint = '', fireIntent = false) {
  const semantic = classifyTrackTextureSemantic(path, categoryHint);
  let score = 0;
  if (semantic.isTrack) score += 10;
  if (semantic.isMask) score += 4;
  if (semantic.isGlow) score += 2;
  if (semantic.isSmoke) score -= 3;
  if (semantic.isDebris) score -= 5;
  // Fire is noise on normal track ribbons, but when the PSS has fire intent
  // (火|fire|flame in any subTypeName) warm textures are the whole point.
  if (semantic.isFire) score += fireIntent ? 8 : -2;
  if (fireIntent && /红|_red|w_水_红|火焰|flame|fire|ember|lava|橙|yellow|黄/i.test(String(path || ''))) score += 3;
  if (String(categoryHint || '').toLowerCase() === 'light') score += 1;
  return score;
}

function buildTrackTexturePool(textureDefs, texMap, fireIntent = false) {
  const pool = [];
  const seen = new Set();
  for (const texDef of textureDefs || []) {
    const originalPath = texDef.originalPath || texDef.texturePath;
    const texture = texMap.get(originalPath) || texMap.get(texDef.texturePath);
    if (!texture || seen.has(texture)) continue;

    seen.add(texture);
    const label = texDef.texturePath || originalPath || '';
    const category = String(texDef.category || 'other').toLowerCase();
    pool.push({
      texture,
      label,
      category,
      score: scoreTrackTextureCandidate(label, category, fireIntent),
      ...classifyTrackTextureSemantic(label, category),
    });
  }

  pool.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return String(left.label).localeCompare(String(right.label), undefined, { sensitivity: 'base' });
  });
  return pool;
}

function chooseTrackTextureForEmitter(texturePool, trackParams, emIndex, totalTrackEmitters, seedRoot) {
  if (!Array.isArray(texturePool) || texturePool.length === 0) {
    return { selected: null, bucket: 'none' };
  }

  const nonNegative = texturePool.filter((candidate) => candidate.score >= 0);
  const usable = nonNegative.length ? nonNegative : texturePool.slice(0, Math.min(4, texturePool.length));
  const trackCandidates = usable.filter((candidate) => candidate.isTrack);
  const strictMaskCandidates = usable.filter((candidate) => candidate.isMask);
  const broadMaskCandidates = usable.filter((candidate) => candidate.isMask || candidate.score >= 4);
  const lightCandidates = usable.filter((candidate) => candidate.category === 'light' || candidate.isGlow);

  const speedHint = Number.isFinite(trackParams?.speedHint) ? trackParams.speedHint : 80;
  const flowScale = Number.isFinite(trackParams?.flowScale) ? trackParams.flowScale : 1;
  const widthScale = Number.isFinite(trackParams?.widthScale) ? trackParams.widthScale : 1;

  let bucket = 'usable';
  let candidates = usable;
  if ((widthScale < 0.85 || flowScale < 0.9) && broadMaskCandidates.length) {
    if (strictMaskCandidates.length) {
      candidates = strictMaskCandidates;
      bucket = 'mask';
    } else {
      candidates = broadMaskCandidates;
      bucket = 'mask-broad';
    }
  } else if (trackCandidates.length) {
    candidates = trackCandidates;
    bucket = 'track';
  } else if (speedHint >= 60 && lightCandidates.length) {
    candidates = lightCandidates;
    bucket = 'light';
  } else if (strictMaskCandidates.length) {
    candidates = strictMaskCandidates;
    bucket = 'mask-fallback';
  } else if (broadMaskCandidates.length) {
    candidates = broadMaskCandidates;
    bucket = 'mask-broad-fallback';
  } else if (lightCandidates.length) {
    candidates = lightCandidates;
    bucket = 'light-fallback';
  }

  const safeTotal = Math.max(totalTrackEmitters, 1);
  const lane = Math.max(0, Math.min(safeTotal - 1, emIndex));
  const mix = (seedRoot ^ Math.imul(lane + 1, 0x9E3779B1)) >>> 0;
  const selected = candidates[mix % candidates.length] || candidates[0] || null;
  return { selected, bucket };
}

function buildTrackRibbonGeometry(trackNodes, widthScale) {
  if (!Array.isArray(trackNodes) || trackNodes.length < 2) return null;

  const nodeCount = trackNodes.length;
  const vertexCount = nodeCount * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = vertexCount > 65535
    ? new Uint32Array((nodeCount - 1) * 6)
    : new Uint16Array((nodeCount - 1) * 6);

  for (let i = 0; i < nodeCount; i++) {
    const node = trackNodes[i];
    const side = (node.side || new THREE.Vector3(1, 0, 0)).clone();
    if (side.lengthSq() < 0.000001) side.set(1, 0, 0);
    side.normalize();

    const profile = 0.88 + 0.12 * Math.sin((node.segmentAlong ?? node.along) * Math.PI);
    const halfWidth = (0.06 + node.thickness * 0.13) * widthScale * profile;
    const left = node.position.clone().addScaledVector(side, -halfWidth);
    const right = node.position.clone().addScaledVector(side, halfWidth);

    const vertexIndex = i * 2;
    const positionIndex = vertexIndex * 3;
    const uvIndex = vertexIndex * 2;

    positions[positionIndex + 0] = left.x;
    positions[positionIndex + 1] = left.y;
    positions[positionIndex + 2] = left.z;
    positions[positionIndex + 3] = right.x;
    positions[positionIndex + 4] = right.y;
    positions[positionIndex + 5] = right.z;

    const along = clampValue(Number.isFinite(node.segmentAlong) ? node.segmentAlong : node.along, 0, 1);
    uvs[uvIndex + 0] = along;
    uvs[uvIndex + 1] = 0;
    uvs[uvIndex + 2] = along;
    uvs[uvIndex + 3] = 1;

    if (i < nodeCount - 1) {
      const indexOffset = i * 6;
      indices[indexOffset + 0] = vertexIndex;
      indices[indexOffset + 1] = vertexIndex + 1;
      indices[indexOffset + 2] = vertexIndex + 2;
      indices[indexOffset + 3] = vertexIndex + 1;
      indices[indexOffset + 4] = vertexIndex + 3;
      indices[indexOffset + 5] = vertexIndex + 2;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return { geometry, nodeCount };
}

function createTrackRibbonMaterial(selectedTexture, trackConfig, seedRoot) {
  const hasTexture = Boolean(selectedTexture);
  const widthScale = trackConfig.widthScale;
  const alphaScale = trackConfig.alphaScale;
  const speedHint = trackConfig.speedHint;
  const flowScale = trackConfig.flowScale;

  const flowSpeed = clampValue(0.14 + flowScale * 0.2 + speedHint / 520, 0.08, 2.6);
  const flowTiling = clampValue(1.1 + flowScale * 1.45 + widthScale * 0.35, 1, 8);
  const trailWidth = clampValue(0.2 - (widthScale - 1) * 0.05 + (flowScale < 1 ? 0.03 : 0), 0.08, 0.42);
  const phase = ((seedRoot >>> 4) % 1000) / 1000;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uMap: { value: selectedTexture || null },
      uUseMap: { value: hasTexture ? 1 : 0 },
      // Tint: never hardcode. If the track emitter was seeded with a sampled
      // colorCurve midpoint from a sibling sprite block, use it; otherwise
      // leave white so the authored texture supplies the color.
      uColor: {
        value: (Array.isArray(trackConfig.tintRGB) && trackConfig.tintRGB.length >= 3)
          ? new THREE.Color(trackConfig.tintRGB[0], trackConfig.tintRGB[1], trackConfig.tintRGB[2])
          : new THREE.Color(1, 1, 1),
      },
      uOpacity: { value: Math.min(1, 0.95 * alphaScale) },
      uTime: { value: 0 },
      uFlowSpeed: { value: flowSpeed },
      uFlowScale: { value: flowTiling },
      uHead: { value: 0 },
      uTrailWidth: { value: trailWidth },
      uPhase: { value: phase },
    },
    vertexShader: `
      varying vec2 vUv;
      varying float vAlong;

      void main() {
        vUv = uv;
        vAlong = uv.x;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uUseMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uFlowSpeed;
      uniform float uFlowScale;
      uniform float uHead;
      uniform float uTrailWidth;
      uniform float uPhase;

      varying vec2 vUv;
      varying float vAlong;

      float wrappedDistance(float a, float b) {
        float d = abs(a - b);
        return min(d, 1.0 - d);
      }

      void main() {
        vec4 texMixed = vec4(1.0);
        if (uUseMap > 0.5) {
          vec2 flowUv = vec2(fract(vUv.x * uFlowScale - uTime * uFlowSpeed + uPhase), vUv.y);
          vec4 texA = texture2D(uMap, flowUv);
          vec4 texB = texture2D(uMap, vec2(fract(flowUv.x + 0.23), flowUv.y));
          texMixed = mix(texA, texB, 0.35);
        }

        float dist = wrappedDistance(vAlong, uHead);
        float trail = smoothstep(uTrailWidth, 0.0, dist);
        float core = smoothstep(uTrailWidth * 0.45, 0.0, dist);
        float pulse = 0.65 + 0.35 * sin((vAlong * 14.0 - uTime * 4.0) + uPhase * 6.2831853);

        float alpha = uOpacity * texMixed.a * max(0.0, trail * 0.75 + core * pulse);
        if (alpha < 0.002) discard;

        vec3 color = uColor * mix(vec3(1.0), texMixed.rgb, uUseMap);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  return { material };
}

function resetTrackEmitter(em) {
  if (!em) return;
  em.elapsed = 0;
  em.lastEffectTimeMs = null;
  if (em.ribbonUniforms) {
    em.ribbonUniforms.uTime.value = 0;
    em.ribbonUniforms.uHead.value = 0;
    em.ribbonUniforms.uOpacity.value = em.baseOpacity;
  }
}

function disposeTrackEmitter(em) {
  if (!em) return;
  em.group?.parent?.remove(em.group);
  if (em.ribbonMesh?.geometry) em.ribbonMesh.geometry.dispose();
  if (em.ribbonMesh?.material) em.ribbonMesh.material.dispose();
}

function createTrackEmitter(emitterData, texturePool, emIndex = 0, totalTrackEmitters = 1) {
  const resolvedTracks = Array.isArray(emitterData?.resolvedTracks) ? emitterData.resolvedTracks : [];
  let pickedTrack = null;
  for (const asset of resolvedTracks) {
    if (!asset?.decodedTrack || !Array.isArray(asset.decodedTrack.nodes) || asset.decodedTrack.nodes.length < 2) continue;
    if (!pickedTrack || asset.decodedTrack.nodes.length > pickedTrack.decodedTrack.nodes.length) {
      pickedTrack = asset;
    }
  }
  if (!pickedTrack) return null;

  const trackParams = emitterData.trackParams || {};
  const widthScale = Number.isFinite(trackParams.widthScale) ? clampValue(trackParams.widthScale, 0.25, 2.5) : 1;
  const alphaScale = Number.isFinite(trackParams.alphaScale) ? clampValue(trackParams.alphaScale, 0.1, 2.5) : 1;
  const speedHint = Number.isFinite(trackParams.speedHint) ? clampValue(trackParams.speedHint, 5, 2000) : 80;
  const flowScale = Number.isFinite(trackParams.flowScale) ? clampValue(trackParams.flowScale, 0.2, 4) : 1;

  const seedRoot = hashString(`${emitterData.index}|${(emitterData.tracks || []).join('|')}`);
  const selection = chooseTrackTextureForEmitter(texturePool, trackParams, emIndex, totalTrackEmitters, seedRoot);
  const normalizedTrack = normalizeDecodedTrackNodes(pickedTrack.decodedTrack.nodes);
  if (!normalizedTrack || !Array.isArray(normalizedTrack.nodes) || normalizedTrack.nodes.length < 2) return null;

  const slice = sliceTrackNodesForEmitter(normalizedTrack.nodes, emIndex, totalTrackEmitters, trackParams, seedRoot);
  const ribbonData = buildTrackRibbonGeometry(slice.nodes, widthScale);
  if (!ribbonData) return null;

  const ribbonMaterialInfo = createTrackRibbonMaterial(selection.selected?.texture || null, {
    widthScale,
    alphaScale,
    speedHint,
    flowScale,
    tintRGB: Array.isArray(emitterData?.colorCurve) && emitterData.colorCurve.length > 0
      ? sampleColorCurve(emitterData.colorCurve, 0.5)
      : null,
  }, seedRoot);

  const group = new THREE.Group();
  const ribbonMesh = new THREE.Mesh(ribbonData.geometry, ribbonMaterialInfo.material);
  group.add(ribbonMesh);
  scene.add(group);

  const effectSeconds = Math.max(0.2, (timelineTotalMs || effectDuration || 5000) / 1000);
  const trailSpeed = 0.06 + clampValue(speedHint / 80, 0.3, 3.2) * 0.12 * Math.max(0.35, flowScale);
  const phaseSeed = wrapUnit((seedRoot % 1000) / 997 + slice.segmentCenter * 0.37);

  const emitter = {
    emDef: emitterData,
    emitterIndex: emitterData.index,
    group,
    ribbonMesh,
    ribbonUniforms: ribbonMaterialInfo.material.uniforms,
    baseOpacity: clampValue(0.42 * alphaScale, 0.12, 0.95),
    trailSpeed,
    flowScale,
    phaseSeed,
    segmentStart: slice.segmentStart,
    segmentEnd: slice.segmentEnd,
    segmentSpan: slice.segmentSpan,
    segmentCenter: slice.segmentCenter,
    timelineOffset: (slice.segmentCenter * effectSeconds) + (emIndex / Math.max(1, totalTrackEmitters)) * 0.18,
    lastEffectTimeMs: null,
    elapsed: 0,
    startTimeMs: 0,
    effectDurationMs: Math.max(1, timelineTotalMs || effectDuration || 5000),
    update(effectTimeMs) {
      updateTrackEmitter(this, effectTimeMs);
    },
    reset() {
      resetTrackEmitter(this);
    },
    dispose() {
      disposeTrackEmitter(this);
    },
  };

  resetTrackEmitter(emitter);
  return emitter;
}

function updateTrackEmitter(em, effectTimeMs) {
  const previous = em.lastEffectTimeMs;
  let dt = 0.016;
  if (Number.isFinite(previous)) {
    const rawDelta = (effectTimeMs - previous) / 1000;
    if (rawDelta < 0) {
      resetTrackEmitter(em);
    } else {
      dt = clampValue(rawDelta, 0.001, 0.05);
    }
  }
  em.lastEffectTimeMs = effectTimeMs;
  em.elapsed += dt;

  const effectDurationMs = Math.max(1, em.effectDurationMs || timelineTotalMs || effectDuration || 5000);
  const progress = clamp01(effectTimeMs / effectDurationMs);
  const localTime = em.elapsed + em.timelineOffset;
  const head = wrapUnit(localTime * em.trailSpeed + em.phaseSeed * 0.17);
  const edgeGate = Math.min(clamp01(progress / 0.08), clamp01((1 - progress) / 0.12));
  const envelope = clampValue(edgeGate, 0.12, 1);

  if (em.ribbonUniforms) {
    em.ribbonUniforms.uTime.value = localTime;
    em.ribbonUniforms.uHead.value = head;
    em.ribbonUniforms.uOpacity.value = em.baseOpacity * envelope;
  }

  if (em.ribbonMesh) {
    em.ribbonMesh.visible = envelope > 0.01;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TEXTURE LOADING ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Dedupe repeated loadTexture fallback logs — the same missing texture URL is
// requested by many emitters, producing N identical lines per PSS.
const TEXTURE_SHORT_BODY_LOGGED = new Set();

async function loadTexture(texInfo) {
  if (!texInfo || !texInfo.rawUrl) {
    dbg('fallback', 'texture: rawUrl missing → returning null (map stays white)', {
      category: 'texture', texturePath: texInfo?.texturePath || null, sourcePath: pssDebugState.sourcePath,
    });
    return null;
  }
  const url = texInfo.rawUrl;

  // Do NOT guess the format from the URL extension \u2014 the server silently
  // serves DDS bytes under a .tga URL when the TGA wasn't in cache but a DDS
  // variant exists. Guessing from the extension made Three.js pick the PNG
  // TextureLoader for DDS bytes, it failed, map became null, and additive
  // materials rendered pure white. Instead: fetch raw bytes, look at the
  // magic header, then dispatch to the right parser.
  try {
    const res = await fetch(url);
    if (!res.ok) {
      dbg('fallback', `texture: HTTP ${res.status} → returning null`, {
        category: 'texture', url, status: res.status, sourcePath: pssDebugState.sourcePath,
      });
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 8) {
      // Empty body — engine renders white plane (the correct fallback for
      // a missing texture asset). Cases:
      //   1. `?missing=1` placeholder URL — already a server-side advisory.
      //   2. HTTP 204 No Content — server confirmed asset absent from all
      //      caches (zscache, ResourcePack, PakV4 extract). The PSS itself
      //      is intact; only the referenced .dds/.tga is gone. Silent.
      //   3. HTTP 200 with 0 bytes — unexpected, aggregate per-PSS for
      //      visibility but collapse all asset variants to one entry.
      const isExplicitMissing = /[?&]missing=1\b/.test(url);
      const isExplicit204 = res.status === 204;
      if (!isExplicitMissing && !isExplicit204) {
        let stem = url;
        try {
          const u = new URL(url, location.origin);
          const p = u.searchParams.get('path') || '';
          stem = p.replace(/\.[^./\\]+$/, '').split(/[/\\]/).pop() || p;
        } catch { /* keep raw url */ }
        dbgFallbackAggregate('texture-empty', pssDebugState.sourcePath,
          'texture: HTTP 200 returned empty body (unexpected — investigate)',
          { assetStem: stem, url, status: res.status, sourcePath: pssDebugState.sourcePath });
      }
      return null;
    }
    const magic = new Uint8Array(buf, 0, 8);

    // DDS: "DDS " = 0x44 0x44 0x53 0x20
    const isDds = magic[0] === 0x44 && magic[1] === 0x44 && magic[2] === 0x53 && magic[3] === 0x20;
    if (isDds) {
      const parsed = ddsLoader.parse(buf, true);
      if (!parsed || !parsed.mipmaps || parsed.mipmaps.length === 0) {
        dbg('fallback', 'texture: DDS parse produced 0 mipmaps → returning null', {
          category: 'texture', url,
        });
        return null;
      }
      const tex = new THREE.CompressedTexture(
        parsed.mipmaps, parsed.width, parsed.height, parsed.format
      );
      tex.minFilter = parsed.mipmapCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    // PNG: 89 50 4E 47  | JPEG: FF D8 FF
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47;
    const isJpg = magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF;
    if (isPng || isJpg) {
      const blob = new Blob([buf], { type: isPng ? 'image/png' : 'image/jpeg' });
      const bitmap = await createImageBitmap(blob).catch(() => null);
      if (!bitmap) {
        dbg('fallback', 'texture: PNG/JPG bitmap decode failed → returning null', {
          category: 'texture', url, format: isPng ? 'png' : 'jpg',
        });
        return null;
      }
      const tex = new THREE.Texture(bitmap);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      return tex;
    }

    // Unknown format \u2014 honest failure, no silent guessing.
    const magicHex = Array.from(magic).map(b => b.toString(16).padStart(2,'0')).join(' ');
    dbg('fallback', `texture: unknown magic bytes ${magicHex} → returning null`, {
      category: 'texture', url, magic: magicHex,
    });
    console.warn('loadTexture: unknown magic bytes for', url, magicHex);
    return null;
  } catch (err) {
    dbg('fallback', `texture: fetch/parse exception → returning null`, {
      category: 'texture', url, error: err?.message || String(err),
    });
    console.warn('loadTexture: fetch/parse error for', url, err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LOAD PSS EFFECT ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function loadPssEffect(sourcePath) {
  clearEffect();
  resetDebugState();
  pssDebugState.sourcePath = sourcePath;
  pssDebugState.loadedAt = new Date().toISOString();
  viewportOverlay.classList.add('hidden');
  vpLabel.textContent = extractFileName(sourcePath);
  statusRenderer.textContent = 'Renderer: loading...';

  await preparePlayerAnchorRigForEffect([sourcePath]);

  try {
    const [data, debugDump] = await Promise.all([
      fetchJson(`/api/pss/analyze?sourcePath=${encodeURIComponent(sourcePath)}`),
      fetchJson(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`).catch(() => null),
    ]);
    if (!data.ok) throw new Error('API error');

    pssDebugState.apiData = data;
    if (debugDump && debugDump.ok) {
      debugDump._sourcePath = sourcePath;
      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {
        pssDebugState.debugDumps.push(debugDump);
      }
    }

    const requestedSocket = debugDump?.socket?.suggested || null;
    const resolvedSocket = requestedSocket
      ? resolveAvailableEffectSocketName(requestedSocket)
      : resolveAvailableEffectSocketName(currentEffectSocketName);
    const socketForThisPss = resolvedSocket || currentEffectSocketName;
    pssDebugState.socketRouting.push({
      sourcePath,
      suggested: requestedSocket,
      resolved: resolvedSocket,
      applied: socketForThisPss,
      reason: debugDump?.socket?.reason || 'no debug-dump socket reason',
    });

    const effectTiming = getPssEffectTiming(data);
    const effectStartTimeMs = effectTiming.startDelayMs ?? 0;
    effectDuration = effectTiming.totalDurationMs ?? effectTiming.activeDurationMs ?? 0;
    effectLooping = (data.globalLoopEnd || 0) > 0;
    timelineTotalMs = effectDuration;
    timelineMs = 0;
    timelineLooping = effectLooping;
    timelinePlaying = false;
    timelineLastClockSec = null;
    timelinePssEntries = [{ path: sourcePath, startTimeMs: 0, effectiveStartTimeMs: effectStartTimeMs }];

    // Load textures for sprite emitters
    const texPromises = (data.textures || []).map(t => loadTexture(t));
    const loadedTextures = await Promise.all(texPromises);
    const texMap = new Map();
    for (let i = 0; i < (data.textures || []).length; i++) {
      const t = data.textures[i];
      const loaded = !!loadedTextures[i];
      const name = t.texturePath?.split('/').pop() || '?';
      dbg('texture', name, { texturePath: t.texturePath, name, loaded });
      if (loaded) {
        texMap.set(t.texturePath, loadedTextures[i]);
        texMap.set(t.originalPath || t.texturePath, loadedTextures[i]);
      }
    }
    // data.fireIntent was a keyword guess on server side — REMOVED. Always false.
    const trackTexturePool = buildTrackTexturePool(data.textures || [], texMap, false);
    const localEffectDurationMs = effectTiming.activeDurationMs;
    const createdSpriteEmitters = [];
    const createdTrackEmitters = [];

    // Create sprite emitters
    const spriteEmitterDefs = (data.emitters || []).filter((em) => em.type === 'sprite');
    for (let spriteIndex = 0; spriteIndex < spriteEmitterDefs.length; spriteIndex++) {
      const em = spriteEmitterDefs[spriteIndex];
      const textures = [];
      for (const rt of (em.resolvedTextures || [])) {
        const t = texMap.get(rt.texturePath);
        if (t) textures.push(t);
      }
      const spriteEmitter = createSpriteEmitter(em, textures, spriteIndex, spriteEmitterDefs.length);
      spriteEmitter.startTimeMs = effectStartTimeMs;
      spriteEmitter.effectDurationMs = localEffectDurationMs;
      spriteEmitter.points.visible = (effectStartTimeMs === 0);
      attachObjectToEffectSocket(spriteEmitter.points, socketForThisPss);
      spriteEmitters.push(spriteEmitter);
      createdSpriteEmitters.push(spriteEmitter);
    }

    // Load mesh emitters
    const meshEmitterDefs = (data.emitters || []).filter((em) => em.type === 'mesh');
    for (let meshIdx = 0; meshIdx < meshEmitterDefs.length; meshIdx++) {
      const em = meshEmitterDefs[meshIdx];
      const mo = await loadMeshEmitter(em, meshIdx, meshEmitterDefs.length);
      const meshName = (em.resolvedMeshes || [])
        .map((asset) => asset?.sourcePath)
        .filter(Boolean)
        .map((sourcePath) => sourcePath.split('/').pop())
        .join(', ');
      if (mo) {
        mo.startTimeMs = effectStartTimeMs;
        mo.sourcePath = sourcePath;
        mo.group.visible = (effectStartTimeMs === 0);
        const attachedMeshSocket = attachObjectToEffectSocket(mo.group, socketForThisPss);
        // Spread mesh emitters in XZ so multiple emitters don't stack at the same point.
        // Skip spread for track-driven ribbons — their update() owns position.
        if (!mo.trackPath) {
          const meshSpreadR = attachedMeshSocket ? 3 : 25;
          const meshAngle = (meshIdx / Math.max(meshEmitterDefs.length, 1)) * Math.PI * 2;
          mo.group.position.x += Math.cos(meshAngle) * meshSpreadR;
          mo.group.position.z += Math.sin(meshAngle) * meshSpreadR;
        }
        meshObjects.push(mo);
        dbg('mesh', `Loaded mesh emitter: ${meshName || `#${em.index}`}`, {
          emitterIndex: em.index,
          sourcePaths: (em.resolvedMeshes || []).map((asset) => asset?.sourcePath).filter(Boolean),
          animationPaths: (em.resolvedAnimations || []).map((asset) => asset?.sourcePath).filter(Boolean),
        });
      } else {
        dbg('mesh-error', `Failed mesh emitter: ${meshName || `#${em.index}`}`, {
          emitterIndex: em.index,
          sourcePaths: (em.resolvedMeshes || []).map((asset) => asset?.sourcePath).filter(Boolean),
        });
      }
    }

    // Create track emitters
    const trackEmitterDefs = (data.emitters || []).filter((em) => em.type === 'track');
    for (let trackIndex = 0; trackIndex < trackEmitterDefs.length; trackIndex++) {
      const em = trackEmitterDefs[trackIndex];
      const trackEmitter = createTrackEmitter(em, trackTexturePool, trackIndex, trackEmitterDefs.length);
      if (trackEmitter) {
        trackEmitter.startTimeMs = effectStartTimeMs;
        trackEmitter.effectDurationMs = localEffectDurationMs;
        trackEmitter.sourcePath = sourcePath;
        trackEmitter.group.visible = (effectStartTimeMs === 0);
        attachObjectToEffectSocket(trackEmitter.group, socketForThisPss);
        trackLines.push(trackEmitter);
        createdTrackEmitters.push(trackEmitter);
      }
    }

    assignSpriteCadenceFromTracks(createdSpriteEmitters, createdTrackEmitters);

    if (spriteEmitters.length === 0 && meshObjects.length === 0 && trackLines.length === 0) {
      viewportOverlay.classList.remove('hidden');
      viewportOverlay.querySelector('.empty-msg').textContent = 'Effect loaded, but no renderable emitters found';
    }

    statusRenderer.textContent = `Renderer: ${spriteEmitters.length}S ${meshObjects.length}M ${trackLines.length}T | ${(effectDuration / 1000).toFixed(1)}s | ${currentEffectSocketName}`;
    timelineBar.classList.remove('hidden');
    timelinePlaying = true;
    timelineLastClockSec = null;
    updateTimelineMarkers();
    updateTimelineUI();
    startRenderLoop();

    // Update debug panel
    if (!debugPanel.classList.contains('hidden') || (document.getElementById('issues-panel') && !document.getElementById('issues-panel').classList.contains('hidden'))) renderDebugPanel();
    postDebugLogToServer();

  } catch (err) {
    console.error('Failed to load PSS effect:', err);
    dbg('error', err.message, {});
    statusRenderer.textContent = `Renderer: error - ${err.message}`;
    viewportOverlay.classList.remove('hidden');
    viewportOverlay.querySelector('.empty-msg').textContent = `Failed to load: ${err.message}`;
    if (!debugPanel.classList.contains('hidden') || (document.getElementById('issues-panel') && !document.getElementById('issues-panel').classList.contains('hidden'))) renderDebugPanel();
    postDebugLogToServer();
  }
}

async function resolvePssPathsForAnimEntry(a) {
  const ext = fileExt(extractFileName(a.animFile));

  // Direct tani entry
  if (ext === '.tani') {
    const tani = await fetchJson(`/api/player-anim/tani-parse?path=${encodeURIComponent(a.animFile)}`);
    return { tani, resolvedFrom: 'direct-tani' };
  }

  // ANI fallback: find related tani by name in catalog
  if (ext === '.ani') {
    const stem = stripExt(extractFileName(a.animFile)).toLowerCase();
    const catalog = await fetchJson(`/api/player-anim/tani-catalog?bodyType=${encodeURIComponent(currentBodyType)}&search=${encodeURIComponent(stem)}&page=0&limit=30`);
    const entries = catalog.entries || [];
    const best = entries.find(e => e.name.toLowerCase().includes(stem)) || entries[0];
    if (!best) {
      throw new Error('No related .tani found for this .ani');
    }
    const tani = await fetchJson(`/api/player-anim/tani-parse?path=${encodeURIComponent(best.sourcePath)}`);
    return { tani, resolvedFrom: 'ani-fallback', matchedTani: best };
  }

  throw new Error('Selected file is not .tani or .ani');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TOOLBAR BUTTONS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

$('#btn-reset-camera').addEventListener('click', resetCamera);
$('#btn-restart').addEventListener('click', () => {
  timelineMs = 0;
  timelinePlaying = true;
  timelineLastClockSec = null;
  for (const em of spriteEmitters) {
    resetSpriteEmitter(em);
  }
  for (const mesh of meshObjects) {
    if (typeof mesh.reset === 'function') mesh.reset();
  }
  for (const track of trackLines) {
    if (typeof track.reset === 'function') track.reset();
  }
  if (!isRendering) startRenderLoop();
  updateTimelineUI();
});
$('#btn-grid').addEventListener('click', () => {
  showGrid = !showGrid;
  gridHelper.visible = showGrid;
  $('#btn-grid').classList.toggle('active', showGrid);
});
$('#btn-hide-bones').addEventListener('click', () => {
  // Bones button is disabled in HTML since there is no player skeleton in scene.
  // This listener is a no-op safety catch.
});
$('#btn-debug').addEventListener('click', () => {
  debugPanel.classList.toggle('hidden');
  $('#btn-debug').classList.toggle('active', !debugPanel.classList.contains('hidden'));
  if (!debugPanel.classList.contains('hidden') || (document.getElementById('issues-panel') && !document.getElementById('issues-panel').classList.contains('hidden'))) renderDebugPanel();
});
const issuesPanel = $('#issues-panel');
$('#btn-issues').addEventListener('click', () => {
  issuesPanel.classList.toggle('hidden');
  $('#btn-issues').classList.toggle('active', !issuesPanel.classList.contains('hidden'));
  if (!issuesPanel.classList.contains('hidden')) renderIssuesPanel();
});
$('#btn-issues-close').addEventListener('click', () => {
  issuesPanel.classList.add('hidden');
  $('#btn-issues').classList.remove('active');
});
$('#btn-issues-copy').addEventListener('click', async () => {
  const btn = $('#btn-issues-copy');
  try {
    const payload = window.__pssIssuesPlainText || '(no evidence)';
    await navigator.clipboard.writeText(payload);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
  } catch {
    btn.textContent = 'Error';
  }
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
});
debugTabButtons.forEach((btn) => {
  btn.addEventListener('click', () => setActiveDebugTab(btn.dataset.debugTab));
});
setActiveDebugTab(currentDebugTab);
$('#btn-debug-close').addEventListener('click', () => {
  debugPanel.classList.add('hidden');
  $('#btn-debug').classList.remove('active');
});
$('#btn-debug-copy').addEventListener('click', async () => {
  const btn = $('#btn-debug-copy');
  try {
    let payload;
    if (currentDebugTab === 'warnings') {
      payload = window.__pssIssuesPlainText || '(no warnings)';
    } else {
      payload = JSON.stringify({ ...pssDebugState, soundEntries: currentSoundEntries }, null, 2);
    }
    await navigator.clipboard.writeText(payload);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
  } catch {
    btn.textContent = 'Error';
  }
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
});

// ─── Timeline Controls ───────────────────────────────────────────────────────
tlPlayPause.addEventListener('click', () => {
  timelinePlaying = !timelinePlaying;
  if (timelinePlaying) { timelineLastClockSec = null; if (!isRendering) startRenderLoop(); }
  updateTimelineUI();
});
document.getElementById('tl-restart').addEventListener('click', () => {
  timelineMs = 0;
  timelinePlaying = true;
  timelineLastClockSec = null;
  for (const em of spriteEmitters) resetSpriteEmitter(em);
  if (!isRendering) startRenderLoop();
  updateTimelineUI();
});
tlLoop.addEventListener('click', () => {
  timelineLooping = !timelineLooping;
  tlLoop.classList.toggle('active', timelineLooping);
});
tlScrubber.addEventListener('input', e => {
  timelineMs = (parseInt(e.target.value) / 10000) * timelineTotalMs;
  timelinePlaying = false;
  updateTimelineUI();
});
tlSpeed.addEventListener('change', e => { timelineSpeed = parseFloat(e.target.value); });
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    timelinePlaying = !timelinePlaying;
    if (timelinePlaying) { timelineLastClockSec = null; if (!isRendering) startRenderLoop(); }
    updateTimelineUI();
  }
});

// ─── Tab System ──────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll('.sidebar-tab');
const tabContentMap = {
  'tab-anim-table':  $('#tab-anim-table'),
  'tab-tani-catalog': $('#tab-tani-catalog'),
  'tab-serial':      $('#tab-serial'),
};

function switchTab(tabId) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  Object.entries(tabContentMap).forEach(([id, el]) => { el.hidden = id !== tabId; });
}
tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ─── Body Type Selector ─────────────────────────────────────────────────────

const BODY_TYPE_LABELS = {
  F1: '小女孩 (F1)',
  F2: '大女孩 (F2)',
  M1: '小男孩 (M1)',
  M2: '大男孩 (M2)',
};

function renderBodyTypeBar(types) {
  bodyTypeBar.innerHTML = '';
  for (const t of types) {
    const btn = document.createElement('button');
    btn.className = 'bt-btn' + (t.bodyType.toLowerCase() === currentBodyType ? ' active' : '');
    btn.innerHTML = `${BODY_TYPE_LABELS[t.bodyType] || t.bodyType}<span class="bt-count">${t.entryCount.toLocaleString()}</span>`;
    btn.addEventListener('click', () => selectBodyType(t.bodyType.toLowerCase()));
    bodyTypeBar.appendChild(btn);
    bodyTypeCounts[t.bodyType.toLowerCase()] = t.entryCount;
  }
}

async function selectBodyType(bt) {
  if (playerAnchorRig?.bodyType && playerAnchorRig.bodyType !== bt) {
    clearPlayerAnchorRig();
  }
  currentBodyType = bt;
  animPage = 0;
  taniPage = 0;
  bodyTypeBar.querySelectorAll('.bt-btn').forEach((btn, i) => {
    const btValue = ['f1', 'f2', 'm1', 'm2'][i];
    btn.classList.toggle('active', btValue === bt);
  });
  statusBodyType.textContent = `Body: ${bt.toUpperCase()}`;
  infoBody.innerHTML = '<div class="empty-state">No animation selected</div>';
  infoTitle.textContent = 'Select an animation';
  infoSubtitle.textContent = `Browsing ${bt.toUpperCase()} animations`;
  clearEffect();
  await Promise.all([loadAnimTable(), loadTaniCatalog()]);
}

// ─── Animation Table ─────────────────────────────────────────────────────────

async function loadAnimTable() {
  const search = animSearchEl.value.trim();
  animListEl.innerHTML = '<li class="empty-state">Loading...</li>';
  try {
    const params = new URLSearchParams({ bodyType: currentBodyType, page: animPage, limit: PAGE_SIZE });
    if (search) params.set('search', search);
    const data = await fetchJson(`/api/player-anim/animations?${params}`);
    animTotal = data.total;
    animTableBadge.textContent = animTotal.toLocaleString();
    statusCount.textContent = `${animTotal.toLocaleString()} animations`;
    renderAnimList(data.animations);
    renderPagination(animPaginationEl, animPage, animTotal, PAGE_SIZE, (p) => { animPage = p; loadAnimTable(); });
  } catch (err) {
    animListEl.innerHTML = `<li class="empty-state">Error: ${escapeHtml(err.message)}</li>`;
  }
}

function renderAnimList(animations) {
  animListEl.innerHTML = '';
  if (animations.length === 0) {
    animListEl.innerHTML = '<li class="empty-state">No animations found</li>';
    return;
  }
  for (const a of animations) {
    const li = document.createElement('li');
    const fname = extractFileName(a.animFile);
    const ext = fileExt(fname);
    li.className = ext === '.tani' ? 'is-tani' : ext === '.ani' ? 'is-ani' : 'is-placeholder';
    const loopIcon = a.isLoop ? '🔁' : '';
    li.innerHTML = `<span class="ani-id">${a.id}</span><span class="ani-name" title="${escapeHtml(a.animFile)}">${escapeHtml(fname)}</span><span class="ani-meta">${ext.replace('.', '').toUpperCase()} ${loopIcon}</span>`;
    li.addEventListener('click', () => showAnimDetail(a));
    animListEl.appendChild(li);
  }
}

// ─── Tani Catalog ────────────────────────────────────────────────────────────

async function loadTaniCatalog() {
  const search = taniSearchEl.value.trim();
  taniListEl.innerHTML = '<li class="empty-state">Loading...</li>';
  try {
    const params = new URLSearchParams({ bodyType: currentBodyType, page: taniPage, limit: PAGE_SIZE });
    if (search) params.set('search', search);
    const data = await fetchJson(`/api/player-anim/tani-catalog?${params}`);
    taniTotal = data.total;
    taniCatalogBadge.textContent = taniTotal.toLocaleString();
    renderTaniList(data.entries);
    renderPagination(taniPaginationEl, taniPage, taniTotal, PAGE_SIZE, (p) => { taniPage = p; loadTaniCatalog(); });
  } catch (err) {
    taniListEl.innerHTML = `<li class="empty-state">Error: ${escapeHtml(err.message)}</li>`;
  }
}

function renderTaniList(entries) {
  taniListEl.innerHTML = '';
  if (entries.length === 0) {
    taniListEl.innerHTML = '<li class="empty-state">No tani entries found</li>';
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'is-tani';
    li.innerHTML = `<span class="ani-id">${e.id}</span><span class="ani-name" title="${escapeHtml(e.sourcePath)}">${escapeHtml(e.name)}</span>`;
    li.addEventListener('click', () => showTaniDetail(e));
    taniListEl.appendChild(li);
  }
}

// ─── Serial Table ────────────────────────────────────────────────────────────

async function loadSerialTable() {
  try {
    const data = await fetchJson('/api/player-anim/serial-table');
    serialEntries = data.entries;
    serialBadge.textContent = serialEntries.length.toLocaleString();
    serialMap.clear();
    for (const s of serialEntries) {
      for (const aid of [s.phaseA, s.phaseB, s.phaseC]) {
        if (aid > 0) {
          if (!serialMap.has(aid)) serialMap.set(aid, []);
          serialMap.get(aid).push(s);
        }
      }
    }
    renderSerialList(serialEntries);
  } catch (err) {
    serialListEl.innerHTML = `<li class="empty-state">Error: ${escapeHtml(err.message)}</li>`;
  }
}

function renderSerialList(entries) {
  const search = serialSearchEl.value.trim().toLowerCase();
  const filtered = search ? entries.filter(e =>
    e.desc.toLowerCase().includes(search) || String(e.serialId).includes(search)
  ) : entries;
  serialListEl.innerHTML = '';
  if (filtered.length === 0) {
    serialListEl.innerHTML = '<li class="empty-state">No serial entries found</li>';
    return;
  }
  const shown = filtered.slice(0, 200);
  for (const s of shown) {
    const li = document.createElement('li');
    const phases = [s.phaseA, s.phaseB, s.phaseC].filter(v => v > 0);
    li.innerHTML = `<span class="ani-id">${s.serialId}</span><span class="ani-name">${escapeHtml(s.desc || '(unnamed)')}</span><span class="ani-meta">→ ${phases.join(',') || '—'}</span>`;
    li.addEventListener('click', () => showSerialDetail(s));
    serialListEl.appendChild(li);
  }
  if (filtered.length > 200) {
    const more = document.createElement('li');
    more.className = 'empty-state';
    more.textContent = `...and ${filtered.length - 200} more`;
    serialListEl.appendChild(more);
  }
}

// ─── Pagination ──────────────────────────────────────────────────────────────

function renderPagination(el, currentPage, total, pageSize, onNavigate) {
  el.innerHTML = '';
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return;
  const prev = document.createElement('button');
  prev.textContent = '← Prev';
  prev.disabled = currentPage === 0;
  prev.addEventListener('click', () => onNavigate(currentPage - 1));
  el.appendChild(prev);
  const info = document.createElement('span');
  info.textContent = `Page ${currentPage + 1} / ${totalPages} (${total.toLocaleString()})`;
  el.appendChild(info);
  const next = document.createElement('button');
  next.textContent = 'Next →';
  next.disabled = currentPage >= totalPages - 1;
  next.addEventListener('click', () => onNavigate(currentPage + 1));
  el.appendChild(next);
}

// ─── Detail: show animation info + load PSS into viewport ───────────────────

async function showAnimDetail(a) {
  const fname = extractFileName(a.animFile);
  const ext = fileExt(fname);
  infoTitle.textContent = fname;
  infoSubtitle.textContent = `ID: ${a.id} | ${currentBodyType.toUpperCase()} | ${ext.replace('.', '').toUpperCase()}`;

  // Highlight
  animListEl.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  const targetLi = Array.from(animListEl.querySelectorAll('li')).find(li => {
    const idEl = li.querySelector('.ani-id');
    return idEl && idEl.textContent === String(a.id);
  });
  if (targetLi) targetLi.classList.add('active');

  const serials = serialMap.get(a.id) || [];

  let html = `<div class="detail-section"><h3>Properties</h3><div class="detail-grid">
    <span class="label">Anim ID</span><span class="value">${a.id}</span>
    <span class="label">Kind / Sheath</span><span class="value">${a.kindId} / ${a.sheathType}</span>
    <span class="label">Loop</span><span class="value ${a.isLoop ? 'accent' : ''}">${a.isLoop ? 'Yes' : 'No'}</span>
    <span class="label">Speed / Ratio</span><span class="value">${a.animSpeed || '—'} / ${a.animRatio || '—'}</span>
  </div></div>`;

  if (serials.length > 0) {
    html += `<div class="detail-section"><h3>Skills (${serials.length})</h3><div class="serial-matches">
      ${serials.map(s => `<span class="serial-chip">${escapeHtml(s.desc || s.serialId)}</span>`).join('')}
    </div></div>`;
  }

  // For .tani/.ani files -> resolve tani, then render PSS
  if ((ext === '.tani' || ext === '.ani') && a.animFile) {
    html += `<div id="tani-loading" class="loading-detail">Resolving effect data...</div>`;
    html += `<div id="tani-info"></div>`;
    infoBody.innerHTML = html;
    statusRenderer.textContent = 'Renderer: preparing selection...';

    try {
      const resolved = await resolvePssPathsForAnimEntry(a);
      const tani = resolved.tani;
      currentTaniData = tani;
      currentSoundEntries = tani.soundEntries || [];
      document.getElementById('tani-loading')?.remove();

      let taniHtml = '';
      if (resolved.resolvedFrom === 'ani-fallback' && resolved.matchedTani) {
        taniHtml += `<div class="detail-section"><h3>Resolved From ANI</h3><div class="detail-grid">
          <span class="label">Matched TANI</span><span class="value file-path">${escapeHtml(resolved.matchedTani.name)}</span>
        </div></div>`;
      }
      const pssEntries = tani.pssEntries || (tani.pssPaths || []).map(p => ({ path: p, startTimeMs: 0 }));
      if (pssEntries.length > 0) {
        taniHtml += `<div class="detail-section"><h3>PSS Effects (${pssEntries.length})</h3><div class="detail-grid">
          ${pssEntries.map((e, i) => `<span class="label">PSS ${i + 1} @ ${getTimelineEntryStartTimeMs(e).toFixed(0)}ms</span><span class="value file-path">${escapeHtml(extractFileName(e.path))}</span>`).join('')}
        </div></div>`;
      }
      if (tani.soundEntries?.length > 0) {
        taniHtml += `<div class="detail-section"><h3>Sounds <span style="font-size:9px;color:var(--panel-warn);font-weight:400;">(Wwise — audio not available)</span></h3><div class="detail-grid">
          ${tani.soundEntries.map(s => `<span class="label">${escapeHtml(s.system)}</span><span class="value accent">${escapeHtml(s.event)}</span>`).join('')}
        </div></div>`;
      }
      taniHtml += `<div class="detail-section"><h3>Base Anim</h3><div class="detail-grid">
        <span class="label">Ani Path</span><span class="value file-path">${escapeHtml(extractFileName(tani.aniPath))}</span>
        <span class="label">Size</span><span class="value">${tani.fileSize.toLocaleString()}B</span>
      </div></div>`;

      const taniEl = document.getElementById('tani-info');
      if (taniEl) taniEl.innerHTML = taniHtml;

      // Fetch ani-header for timeline duration (awaited so we have duration before loading PSS)
      // Ani duration comes strictly from the decoded .ani header. If the
      // header fetch fails or returns a non-positive duration, we leave
      // aniDurationMs null and downstream logic surfaces "unknown".
      let aniDurationMs = null;
      if (tani.aniPath) {
        try {
          const h = await fetchJson(`/api/player-anim/ani-header?path=${encodeURIComponent(tani.aniPath)}`);
          aniDurationMs = Number.isFinite(h?.duration) && h.duration > 0 ? h.duration * 1000 : null;
          const el = document.getElementById('tani-info');
          if (el) {
            el.innerHTML += `<div class="detail-section"><h3>Animation</h3><div class="detail-grid">
              <span class="label">Bones</span><span class="value accent">${h.boneCount}</span>
              <span class="label">Frames</span><span class="value">${h.frameCount} @ ${h.fps?.toFixed(0)}fps</span>
              <span class="label">Duration</span><span class="value accent">${h.duration.toFixed(2)}s</span>
            </div></div>`;
          }
        } catch { /* non-fatal */ }
      }

      // Build PSS selector chips + load all with timeline (pssEntries already declared above)
      if (pssEntries.length > 0) {
        buildPssSelector(pssEntries);
        await loadAllPssFromTani(pssEntries, aniDurationMs);
      } else {
        clearEffect();
        viewportOverlay.classList.remove('hidden');
        viewportOverlay.querySelector('.empty-msg').textContent = 'No PSS paths found in this TANI';
        statusRenderer.textContent = 'Renderer: no PSS paths in tani';
      }
    } catch (err) {
      const el = document.getElementById('tani-loading');
      if (el) el.textContent = `Failed: ${err.message}`;
      clearEffect();
      viewportOverlay.classList.remove('hidden');
      viewportOverlay.querySelector('.empty-msg').textContent = `Could not play selection: ${err.message}`;
      statusRenderer.textContent = `Renderer: selection error - ${err.message}`;
    }
  } else {
    html += `<div class="detail-section"><h3>File</h3><div class="detail-grid">
      <span class="label">Path</span><span class="value file-path">${escapeHtml(a.animFile)}</span>
    </div></div>`;
    infoBody.innerHTML = html;
    clearEffect();
  }
}

async function showTaniDetail(e) {
  infoTitle.textContent = e.name;
  infoSubtitle.textContent = `Tani Catalog #${e.id}`;

  taniListEl.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  const targetLi = Array.from(taniListEl.querySelectorAll('li')).find(li => {
    const idEl = li.querySelector('.ani-id');
    return idEl && idEl.textContent === String(e.id);
  });
  if (targetLi) targetLi.classList.add('active');

  let html = `<div class="detail-section"><h3>Catalog Entry</h3><div class="detail-grid">
    <span class="label">ID</span><span class="value">${e.id}</span>
    <span class="label">Name</span><span class="value accent">${escapeHtml(e.name)}</span>
    <span class="label">Source</span><span class="value file-path">${escapeHtml(extractFileName(e.sourcePath))}</span>
  </div></div>`;
  html += `<div id="tani-loading" class="loading-detail">Loading .tani...</div>`;
  html += `<div id="tani-info"></div>`;
  infoBody.innerHTML = html;

  try {
    const tani = await fetchJson(`/api/player-anim/tani-parse?path=${encodeURIComponent(e.sourcePath)}`);
    currentTaniData = tani;
    currentSoundEntries = tani.soundEntries || [];
    document.getElementById('tani-loading')?.remove();

    let taniHtml = '';
    const pssEntries = tani.pssEntries || (tani.pssPaths || []).map(p => ({ path: p, startTimeMs: 0 }));
    if (pssEntries.length > 0) {
      taniHtml += `<div class="detail-section"><h3>PSS (${pssEntries.length})</h3><div class="detail-grid">
        ${pssEntries.map((e, i) => `<span class="label">${i + 1} @ ${getTimelineEntryStartTimeMs(e).toFixed(0)}ms</span><span class="value file-path">${escapeHtml(extractFileName(e.path))}</span>`).join('')}
      </div></div>`;
    }
    if (tani.soundEntries?.length > 0) {
      taniHtml += `<div class="detail-section"><h3>Sounds <span style="font-size:9px;color:var(--panel-warn);font-weight:400;">(Wwise — audio not available)</span></h3><div class="detail-grid">
        ${tani.soundEntries.map(s => `<span class="label">${escapeHtml(s.system || '—')}</span><span class="value accent">${escapeHtml(s.event)}</span>`).join('')}
      </div></div>`;
    }
    taniHtml += `<div class="detail-section"><h3>Base</h3><div class="detail-grid">
      <span class="label">Ani</span><span class="value file-path">${escapeHtml(extractFileName(tani.aniPath))}</span>
      <span class="label">Size</span><span class="value">${tani.fileSize.toLocaleString()}B</span>
    </div></div>`;

    const taniEl = document.getElementById('tani-info');
    if (taniEl) taniEl.innerHTML = taniHtml;

    // Fetch ani-header for timeline duration
    let aniDurationMs = null;
    if (tani.aniPath) {
      try {
        const h = await fetchJson(`/api/player-anim/ani-header?path=${encodeURIComponent(tani.aniPath)}`);
        aniDurationMs = Number.isFinite(h?.duration) && h.duration > 0 ? h.duration * 1000 : null;
        const el = document.getElementById('tani-info');
        if (el) {
          el.innerHTML += `<div class="detail-section"><h3>Anim Header</h3><div class="detail-grid">
            <span class="label">Bones</span><span class="value accent">${h.boneCount}</span>
            <span class="label">Frames</span><span class="value">${h.frameCount} @ ${h.fps?.toFixed(0)}fps</span>
            <span class="label">Duration</span><span class="value accent">${h.duration.toFixed(2)}s</span>
          </div></div>`;
        }
      } catch { /* non-fatal */ }
    }

    if (pssEntries.length > 0) {
      buildPssSelector(pssEntries);
      await loadAllPssFromTani(pssEntries, aniDurationMs);
    } else {
      clearEffect();
      viewportOverlay.classList.remove('hidden');
      viewportOverlay.querySelector('.empty-msg').textContent = 'No PSS paths found in this TANI';
      statusRenderer.textContent = 'Renderer: no PSS paths in tani';
    }
  } catch (err) {
    const el = document.getElementById('tani-loading');
    if (el) el.textContent = `Failed: ${err.message}`;
    clearEffect();
    viewportOverlay.classList.remove('hidden');
    viewportOverlay.querySelector('.empty-msg').textContent = `Could not play selection: ${err.message}`;
    statusRenderer.textContent = `Renderer: selection error - ${err.message}`;
  }
}

function showSerialDetail(s) {
  infoTitle.textContent = s.desc || `Serial #${s.serialId}`;
  infoSubtitle.textContent = `Serial ID: ${s.serialId}`;

  const phases = [
    { label: 'Phase A', id: s.phaseA },
    { label: 'Phase B', id: s.phaseB },
    { label: 'Phase C', id: s.phaseC },
  ].filter(p => p.id > 0);

  let html = `<div class="detail-section"><h3>Serial</h3><div class="detail-grid">
    <span class="label">ID</span><span class="value">${s.serialId}</span>
    <span class="label">Desc</span><span class="value accent">${escapeHtml(s.desc || '—')}</span>
    <span class="label">Haste</span><span class="value">${s.haste}</span>
    ${phases.map(p => `<span class="label">${p.label}</span><span class="value accent">${p.id}</span>`).join('')}
  </div></div>`;
  infoBody.innerHTML = html;
  serialListEl.querySelectorAll('li').forEach(li => li.classList.remove('active'));
}

// ─── PSS Selector (chips = seek buttons on timeline) ────────────────────────

function buildPssSelector(pssEntries) {
  pssSelector.innerHTML = '';
  if (!pssEntries || pssEntries.length <= 1) return;
  for (let i = 0; i < pssEntries.length; i++) {
    const entry = typeof pssEntries[i] === 'string' ? { path: pssEntries[i], startTimeMs: 0 } : pssEntries[i];
    const startTimeMs = getTimelineEntryStartTimeMs(entry);
    const chip = document.createElement('div');
    chip.className = 'pss-chip';
    const timeLabel = startTimeMs > 0 ? ` @${startTimeMs.toFixed(0)}ms` : '';
    chip.textContent = extractFileName(entry.path) + timeLabel;
    chip.title = `Click: solo this PSS (green = visible only). Click again to clear solo.`;
    chip.dataset.sourcePath = entry.path || '';
    chip.addEventListener('click', () => {
      const already = soloPssSourcePath === entry.path;
      soloPssSourcePath = already ? null : entry.path;
      pssSelector.querySelectorAll('.pss-chip').forEach(c => c.classList.remove('active'));
      if (!already) chip.classList.add('active');
      applyPssSoloFilter();
      if (!already) {
        timelineMs = startTimeMs;
        updateTimelineUI();
      }
    });
    pssSelector.appendChild(chip);
  }
}

function applyPssSoloFilter() {
  const solo = soloPssSourcePath;
  const matchOrHide = (obj, node) => {
    if (!node) return;
    if (!solo) { node.userData._pssSoloHidden = false; return; }
    node.userData._pssSoloHidden = (obj.sourcePath !== solo);
  };
  for (const em of spriteEmitters) matchOrHide(em, em.points);
  for (const mo of meshObjects) matchOrHide(mo, mo.group);
  for (const tr of trackLines) matchOrHide(tr, tr.group);
}

// ─── Search Debounce ─────────────────────────────────────────────────────────

animSearchEl.addEventListener('input', () => {
  clearTimeout(animSearchTimer);
  animSearchTimer = setTimeout(() => { animPage = 0; loadAnimTable(); }, 300);
});
taniSearchEl.addEventListener('input', () => {
  clearTimeout(taniSearchTimer);
  taniSearchTimer = setTimeout(() => { taniPage = 0; loadTaniCatalog(); }, 300);
});
serialSearchEl.addEventListener('input', () => {
  clearTimeout(serialSearchTimer);
  serialSearchTimer = setTimeout(() => renderSerialList(serialEntries), 200);
});

// ─── Init ────────────────────────────────────────────────────────────────────

// Capture runtime errors into pssDebugState so postDebugLogToServer surfaces
// them to the server-side /api/debug/pss-render-log store. This is the only
// way to see client-side JS failures (including async rejections) without
// the user needing to open DevTools manually.
function setAnimationPlayerStatus(status, extra) {
  try {
    document.body.dataset.animationPlayerStatus = status;
    if (extra) document.body.dataset.animationPlayerDetail = String(extra).slice(0, 240);
  } catch { /* non-fatal */ }
}
window.addEventListener('error', (ev) => {
  const msg = ev?.message || String(ev?.error || 'error');
  pssDebugState.errors.push({ msg: `[window.error] ${msg}`, source: ev?.filename, line: ev?.lineno, col: ev?.colno });
  setAnimationPlayerStatus('error', msg);
  postDebugLogToServer();
});
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev?.reason;
  const msg = reason?.message || reason?.toString?.() || 'unhandledrejection';
  pssDebugState.errors.push({ msg: `[unhandledrejection] ${msg}` });
  setAnimationPlayerStatus('error', msg);
  postDebugLogToServer();
});

async function init() {
  statusConnection.textContent = 'Loading...';
  statusConnection.className = 'status-item';
  setAnimationPlayerStatus('loading');

  // Init Three.js
  initThreeJs();
  // Do a single render so the viewport isn't blank
  renderer.render(scene, camera);

  try {
    const btData = await fetchJson('/api/player-anim/body-types');
    renderBodyTypeBar(btData.bodyTypes);
    statusConnection.textContent = 'Connected';
    statusConnection.className = 'status-item status-ok';
    await loadSerialTable();
    await selectBodyType(currentBodyType);
    // Default to tani tab with 龙牙 pre-searched
    switchTab('tab-tani-catalog');
    taniSearchEl.value = '龙牙';
    taniPage = 0;
    await loadTaniCatalog();
    // Auto-select default tani (F1s04tc技能13_龙牙8尺HD.tani) so the user
    // doesn't have to click it on every page load.
    try {
      const DEFAULT_TANI_NAME = 'F1s04tc技能13_龙牙8尺HD';
      const data = await fetchJson(`/api/player-anim/tani-catalog?bodyType=${encodeURIComponent(currentBodyType)}&search=${encodeURIComponent(DEFAULT_TANI_NAME)}&page=0&limit=1`);
      const entry = (data.entries || [])[0];
      if (entry) {
        await showTaniDetail(entry);
      }
    } catch (e) {
      pssDebugState.errors.push({ msg: `[default-tani] ${e.message}`, level: 'warn' });
    }
    setAnimationPlayerStatus('ready');
  } catch (err) {
    statusConnection.textContent = `Error: ${err.message}`;
    statusConnection.className = 'status-item status-err';
    pssDebugState.errors.push({ msg: `[init] ${err.message}` });
    setAnimationPlayerStatus('error', err.message);
    postDebugLogToServer();
    return;
  }

  // Automation / URL-param driven auto-select for headless debugging. Supports:
  //   ?auto=1&autoTani=<sourcePath>  — parse+load a specific tani after init.
  //   ?auto=1                         — load the first tani in the (龙牙-pre-searched) catalog.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('auto') === '1') {
      setAnimationPlayerStatus('auto-loading');
      const target = params.get('autoTani');
      let entry = null;
      if (target) {
        entry = { id: -1, name: extractFileName(target), sourcePath: target };
      } else {
        const data = await fetchJson(`/api/player-anim/tani-catalog?bodyType=${encodeURIComponent(currentBodyType)}&search=${encodeURIComponent('龙牙')}&page=0&limit=1`);
        entry = (data.entries || [])[0] || null;
      }
      if (entry) {
        await showTaniDetail(entry);
        // Treat real (non-warn) errors as 'auto-errors'; benign console.warn
        // entries (e.g. FBXLoader negative-material-index notice) should not
        // poison the page status. They still appear in the Issues / Fallbacks
        // tabs and in the posted debug log for inspection.
        const realErrors = pssDebugState.errors.filter((e) => e && e.level !== 'warn');
        const detail = realErrors[0]?.msg || '';
        setAnimationPlayerStatus(realErrors.length ? 'auto-errors' : 'auto-done', detail);
        // Force a final post so the server log reflects the final state.
        // Await so the headless dump-dom run cannot exit before the POST lands.
        await postDebugLogToServer();
      } else {
        setAnimationPlayerStatus('auto-no-entry');
        await postDebugLogToServer();
      }
    }
  } catch (err) {
    pssDebugState.errors.push({ msg: `[auto] ${err.message}` });
    setAnimationPlayerStatus('auto-error', err.message);
    await postDebugLogToServer();
  }
}

init();
