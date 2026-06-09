/**
 * PSS Effect Renderer v2 — Emitter-based particle system.
 *
 * Uses structured emitter data from /api/pss/analyze:
 *   - Per-emitter: type, material, blendMode, layerCount, textures, category
 *   - Global: duration
 *   - Flat texture list with resolved URLs
 *
 * Each type-1 (sprite) emitter spawns billboard particles using its assigned
 * texture(s). Blend mode, opacity and motion derive from material name + category.
 */
import {
  AdditiveBlending,
  Clock,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from '/lib/three-addons/controls/OrbitControls.js';
import { DDSLoader } from '/vendor/three/examples/jsm/loaders/DDSLoader.js';

/* ── DOM refs ──────────────────────────────────────── */
const dom = {
  search: document.getElementById('pss-search'),
  searchBtn: document.getElementById('pss-search-btn'),
  meta: document.getElementById('sidebar-meta'),
  list: document.getElementById('pss-list'),
  toolbar: document.getElementById('main-toolbar'),
  toolbarTitle: document.getElementById('toolbar-title'),
  canvas: document.getElementById('render-canvas'),
  viewportWrap: document.getElementById('viewport-wrap'),
  spinner: document.getElementById('loading-spinner'),
  infoOverlay: document.getElementById('info-overlay'),
};

/* ── State ─────────────────────────────────────────── */
const state = {
  catalog: [],
  selectedPss: null,
  pssData: null,
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  clock: new Clock(),
  effectGroup: null,
  emitters: [],
  animHandle: 0,
  loadToken: 0,
  debugLog: [],
  debugTextures: [],
  meshBindingAudit: null,
  globalDuration: 5,
};

const ddsLoader = new DDSLoader();
const textureLoader = new TextureLoader();

/* ── Debug System ──────────────────────────────────── */
function dbg(msg, level = 'info') {
  const ts = new Date().toISOString().slice(11, 23);
  state.debugLog.push({ ts, msg, level });
  if (state.debugLog.length > 50) state.debugLog.shift();
  console.log(`[PSS ${level}] ${msg}`);
  updateDebugOverlay();
}

function buildCopyableLog() {
  const lines = [];
  const data = state.pssData;
  const texDbg = state.debugTextures;

  lines.push('=== PSS Debug Panel ===');
  if (data) {
    lines.push(`Source: ${data.source || '?'} — ${data.sourcePath || ''}`);
    lines.push(`Format: v${data.version || '?'}, ${data.fileSize || 0} bytes`);
    const sC = (data.emitters || []).filter(e => e.type === 'sprite').length;
    const mC = (data.emitters || []).filter(e => e.type === 'mesh').length;
    lines.push(`Emitters: ${sC} sprite, ${mC} mesh, ${(data.emitters||[]).length} total`);
    lines.push(`Textures: ${data.totalTextures || 0} total, ${data.cachedTextures || 0} in cache`);
    lines.push(`Duration: ${((data.globalDuration || 5000) / 1000).toFixed(1)}s`);
  }

  if (texDbg.length) {
    lines.push('');
    lines.push('--- Texture Load Results ---');
    for (const t of texDbg) {
      const icon = t.status === 'loaded' ? 'OK' : t.status === 'error' ? 'ERR' : t.status === 'skipped' ? 'SKIP' : 'PEND';
      const sz = t.texW ? ` ${t.texW}x${t.texH}` : '';
      lines.push(`  [${icon}] [${t.category}] ${t.source} ${t.name}${sz}${t.error ? ' ERR:'+t.error : ''}`);
    }
  }

  if (data?.emitters?.length) {
    lines.push('');
    lines.push('--- Emitter Details ---');
    for (const em of data.emitters) {
      if (em.type === 'sprite')
        lines.push(`  [${em.index}] sprite ${em.blendMode} "${em.materialName}" tex=[${em.textures.join(', ')}]`);
      else if (em.type === 'mesh')
        lines.push(`  [${em.index}] mesh`);
      else if (em.type === 'track')
        lines.push(`  [${em.index}] track`);
    }
  }

  const audit = state.meshBindingAudit;
  if (audit && audit.total) {
    lines.push('');
    lines.push(`--- Mesh Material Binding (${audit.ok}/${audit.total} matched, ${audit.miss} missing) ---`);
    for (const it of audit.items) {
      const ok = it.texCount > 0 && it.resolvedOk === it.texCount;
      const idxStr = it.materialIndex == null ? 'n/a' : `#${it.materialIndex}`;
      const ref = it.refPath ? it.refPath.split(/[\\/]/).pop() : '-';
      lines.push(`  [${ok?'OK':'MISS'}] [${it.index}] ${it.mesh} <- mat${idxStr} ${ref} (${it.resolvedOk}/${it.texCount}) ${it.textureSource} :: ${it.textures.join(', ') || '(no .tga)'}`);
    }
  }

  lines.push('');
  lines.push('--- Log ---');
  for (const e of state.debugLog) lines.push(`[${e.ts}] ${e.msg}`);

  const lC = texDbg.filter(t => t.status === 'loaded').length;
  const pC = texDbg.filter(t => t.status === 'loaded' && (t.source === 'pakv4-compressed' || t.source === 'missing')).length;
  const eC = texDbg.filter(t => t.status === 'error').length;
  lines.push('');
  lines.push(`Active: ${state.emitters.length} emitters | Tex: ${lC} (${lC-pC} real, ${pC} placeholder) | Err: ${eC}`);
  return lines.join('\n');
}

function updateDebugOverlay() {
  const overlay = dom.infoOverlay;
  if (!overlay) return;
  overlay.style.display = 'block';
  overlay.style.pointerEvents = 'auto';
  overlay.style.overflowY = 'auto';
  overlay.style.maxHeight = '60vh';

  const data = state.pssData;
  const texDbg = state.debugTextures;

  let html = '<div class="info-title">PSS Debug Panel</div>';

  if (data) {
    const sC = (data.emitters || []).filter(e => e.type === 'sprite').length;
    const mC = (data.emitters || []).filter(e => e.type === 'mesh').length;
    html += `<div class="info-row"><span class="info-label">Source</span><span class="info-val">${esc(data.source||'?')} — ${esc(data.sourcePath||'')}</span></div>`;
    html += `<div class="info-row"><span class="info-label">Format</span><span class="info-val">v${data.version||'?'}, ${data.fileSize||0} bytes</span></div>`;
    html += `<div class="info-row"><span class="info-label">Emitters</span><span class="info-val">${sC} sprite, ${mC} mesh, ${(data.emitters||[]).length} total</span></div>`;
    html += `<div class="info-row"><span class="info-label">Textures</span><span class="info-val">${data.totalTextures||0} total, ${data.cachedTextures||0} in cache</span></div>`;
    html += `<div class="info-row"><span class="info-label">Duration</span><span class="info-val">${((data.globalDuration||5000)/1000).toFixed(1)}s (looping)</span></div>`;
  }

  if (texDbg.length) {
    html += '<div style="margin-top:8px;font-weight:700;font-size:12px;">Texture Load Results:</div>';
    html += '<div style="font-size:10px;line-height:1.7;max-height:200px;overflow-y:auto">';
    for (const t of texDbg) {
      const icon = t.status==='loaded'?'\u2705':t.status==='error'?'\u274C':t.status==='skipped'?'\u23ED':'\u23F3';
      const catClr = {light:'#ffe066',smoke:'#aaa',debris:'#c97',other:'#8af'}[t.category]||'#ccc';
      const srcClr = t.source==='cache'?'#8fc':t.source==='pakv4'?'#fd8':t.source==='pakv4-compressed'?'#f8a':t.source==='missing'?'#f66':'#aaa';
      const sz = t.texW ? ` ${t.texW}x${t.texH}` : '';
      html += `<div>${icon} <span style="color:${catClr}">[${t.category}]</span> <span style="color:${srcClr}">${t.source}</span> ${esc(t.name)}${sz}`;
      if (t.error) html += ` <span style="color:#f66">${esc(t.error)}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }

  // Sprite emitter details
  const sprEm = (data?.emitters || []).filter(e => e.type === 'sprite');
  if (sprEm.length) {
    html += '<div style="margin-top:8px;font-weight:700;font-size:12px;">Sprite Emitters:</div>';
    html += '<div style="font-size:10px;line-height:1.5;max-height:120px;overflow-y:auto;color:#8ea2ba">';
    for (const em of sprEm) {
      const b = em.blendMode==='additive'?'\u2726':'\u25FC';
      html += `<div>${b} [${em.index}] ${esc(em.materialName)} \u2192 ${em.textures.map(t=>esc(t)).join(' + ')}</div>`;
    }
    html += '</div>';
  }

  // Mesh emitter material-binding audit
  const audit = state.meshBindingAudit;
  if (audit && audit.total) {
    const headColor = audit.miss === 0 ? '#7f7' : '#fd8';
    html += `<div style="margin-top:8px;font-weight:700;font-size:12px;color:${headColor}">Mesh Material Binding: ${audit.ok}/${audit.total} matched${audit.miss?` (${audit.miss} missing)`:''}</div>`;
    html += '<div style="font-size:10px;line-height:1.5;max-height:140px;overflow-y:auto;color:#8ea2ba">';
    for (const it of audit.items) {
      const ok = it.texCount > 0 && it.resolvedOk === it.texCount;
      const icon = ok ? '\u2705' : '\u26A0\uFE0F';
      const idxStr = it.materialIndex == null ? 'n/a' : `#${it.materialIndex}`;
      const ref = it.refPath ? it.refPath.split(/[\\/]/).pop() : '—';
      const texs = it.textures.length ? it.textures.map(esc).join(', ') : '<span style="color:#f66">no .tga</span>';
      html += `<div>${icon} [${it.index}] ${esc(it.mesh)} \u2190 mat${idxStr} <span style="color:#aaf">${esc(ref)}</span> (${it.resolvedOk}/${it.texCount}) <span style="color:#789">${esc(it.textureSource)}</span><div style="padding-left:14px;color:#9ab">${texs}</div></div>`;
    }
    html += '</div>';
  }

  // Log
  html += '<div style="margin-top:8px;font-weight:700;font-size:12px;">Log:</div>';
  html += '<div style="font-size:10px;line-height:1.5;max-height:120px;overflow-y:auto;color:#8ea2ba">';
  for (const e of state.debugLog.slice(-15)) {
    const c = e.level==='error'?'#f66':e.level==='warn'?'#fd8':'#8ea2ba';
    html += `<div style="color:${c}">[${e.ts}] ${esc(e.msg)}</div>`;
  }
  html += '</div>';

  const lC = texDbg.filter(t=>t.status==='loaded').length;
  const pC = texDbg.filter(t=>t.status==='loaded'&&(t.source==='pakv4-compressed'||t.source==='missing')).length;
  const eC = texDbg.filter(t=>t.status==='error').length;
  html += `<div style="margin-top:8px;font-size:11px;color:#667">Active: ${state.emitters.length} emitters | Tex: ${lC} (${lC-pC} real, ${pC} placeholder) | Err: ${eC}</div>`;

  html += '<div style="margin-top:6px"><button id="copy-pss-log" style="background:#223;color:#aab;border:1px solid #445;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px">\uD83D\uDCCB Copy Full Log</button></div>';

  overlay.innerHTML = html;

  const copyBtn = document.getElementById('copy-pss-log');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const text = buildCopyableLog();
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '\u2705 Copied!';
        setTimeout(() => { copyBtn.textContent = '\uD83D\uDCCB Copy Full Log'; }, 2000);
      });
    };
  }
}

/* ── Catalog ───────────────────────────────────────── */
async function searchCatalog(query) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', '120');
  const res = await fetch(`/api/pss/catalog?${params}`);
  return res.json();
}

async function loadCatalog(query) {
  dom.meta.textContent = 'Searching\u2026';
  try {
    const data = await searchCatalog(query);
    state.catalog = data.results || [];
    dom.meta.textContent = `${data.returned} of ${data.total} PSS effects`;
    renderCatalogList();
  } catch (err) {
    dom.meta.textContent = `Error: ${err.message}`;
  }
}

function renderCatalogList() {
  dom.list.innerHTML = '';
  for (const pss of state.catalog) {
    const el = document.createElement('div');
    el.className = 'pss-item';
    if (state.selectedPss?.sourcePath === pss.sourcePath) el.classList.add('selected');
    el.innerHTML = `<div class="pss-name">${esc(pss.name)}</div><div class="pss-path">${esc(pss.sourcePath)}</div>`;
    el.addEventListener('click', () => selectPss(pss));
    dom.list.appendChild(el);
  }
}

/* ── PSS Selection + Analysis ──────────────────────── */
async function selectPss(pss) {
  state.selectedPss = pss;
  state.loadToken++;
  const token = state.loadToken;
  state.debugLog = [];
  state.debugTextures = [];
  state.meshBindingAudit = null;
  renderCatalogList();

  dom.toolbarTitle.textContent = pss.name;
  dom.spinner.classList.add('visible');
  dom.spinner.textContent = 'Analyzing PSS\u2026';

  dbg(`Selected: ${pss.name}`);
  dbg(`Path: ${pss.sourcePath}`);

  try {
    const t0 = performance.now();
    const res = await fetch(`/api/pss/analyze?sourcePath=${encodeURIComponent(pss.sourcePath)}`);
    const data = await res.json();
    const elapsed = (performance.now() - t0).toFixed(0);
    if (token !== state.loadToken) return;

    state.pssData = data;

    if (!data.ok) {
      dbg(`Analysis FAILED: ${data.error}`, 'error');
      dom.spinner.classList.remove('visible');
      return;
    }

    const sprC = (data.emitters || []).filter(e => e.type === 'sprite').length;
    state.globalDuration = Math.max(1, (data.globalDuration || 5000) / 1000);

    dbg(`Analyzed in ${elapsed}ms — ${sprC} sprite + ${(data.emitters||[]).length - sprC} other emitters, ${data.totalTextures} tex`);
    dbg(`Source: ${data.source}, duration: ${state.globalDuration.toFixed(1)}s`);

    // ── Mesh emitter texture-binding audit ────────────────
    // Verify every mesh emitter that has a .Mesh actually got matched textures
    // (via launcher.nMaterialIndex → PSS embedded KE3D_MT_PARTICLE_MATERIAL).
    const meshEms = (data.emitters || []).filter(e => e.type === 'mesh' && Array.isArray(e.meshes) && e.meshes.length > 0);
    if (meshEms.length) {
      let okCount = 0, missCount = 0;
      for (const em of meshEms) {
        const meshName = em.meshes[0].split(/[\\/]/).pop();
        const texCount = (em.texturePaths || []).length;
        const resolvedOk = (em.resolvedTextures || []).filter(t => t && t.existsInCache).length;
        const idxStr = (em.materialIndex == null) ? 'n/a' : `#${em.materialIndex}`;
        const src = em.textureSource || 'unbound';
        const refTail = em.materialRefPath ? em.materialRefPath.split(/[\\/]/).pop() : '';
        if (texCount > 0 && resolvedOk === texCount) {
          okCount++;
          dbg(`✅ mesh[${em.index}] ${meshName} ← mat${idxStr} ${refTail} (${resolvedOk}/${texCount} tex, ${src})`);
        } else {
          missCount++;
          dbg(`⚠️ mesh[${em.index}] ${meshName} ← mat${idxStr} (${resolvedOk}/${texCount} tex, ${src})`, 'warn');
        }
      }
      const lvl = missCount === 0 ? 'info' : 'warn';
      dbg(`Mesh-emitter binding coverage: ${okCount}/${meshEms.length} fully matched`, lvl);
      state.meshBindingAudit = { ok: okCount, total: meshEms.length, miss: missCount, items: meshEms.map(em => ({
        index: em.index, mesh: em.meshes[0].split(/[\\/]/).pop(),
        materialIndex: em.materialIndex ?? null, refPath: em.materialRefPath || null,
        textureSource: em.textureSource || 'unbound',
        texCount: (em.texturePaths || []).length,
        resolvedOk: (em.resolvedTextures || []).filter(t => t && t.existsInCache).length,
        textures: (em.texturePaths || []).map(p => p.split(/[\\/]/).pop()),
      })) };
    } else {
      state.meshBindingAudit = { ok: 0, total: 0, miss: 0, items: [] };
    }

    for (const t of data.textures || []) {
      const name = t.texturePath.split('/').pop();
      state.debugTextures.push({
        name, fullPath: t.texturePath, category: t.category,
        source: t.source || 'missing', rawUrl: t.rawUrl,
        status: t.rawUrl ? 'pending' : 'skipped',
        error: t.rawUrl ? null : 'no URL',
      });
    }
    updateDebugOverlay();

    dom.toolbar.innerHTML = `
      <h3 id="toolbar-title">${esc(pss.name)}</h3>
      <span class="badge">${sprC} sprite emitters</span>
      <span class="badge ok">${data.cachedTextures}/${data.totalTextures} tex</span>
    `;

    await buildEffectScene(data, token);
  } catch (err) {
    if (token !== state.loadToken) return;
    dbg(`Error: ${err.message}`, 'error');
    dom.spinner.classList.remove('visible');
  }
}

/* ── Three.js Scene ────────────────────────────────── */
function initRenderer() {
  if (state.renderer) return;

  state.scene = new Scene();
  state.camera = new PerspectiveCamera(55, 1, 0.1, 500);
  state.camera.position.set(0, 2, 8);

  state.renderer = new WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setClearColor(0x060910, 1);

  state.controls = new OrbitControls(state.camera, dom.canvas);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.08;
  state.controls.target.set(0, 1, 0);
  state.controls.update();

  onResize();
  window.addEventListener('resize', onResize);
  animate();
}

function onResize() {
  const rect = dom.canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 800;
  const h = rect.height || 600;
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h);
}

/* ── Texture Loading ───────────────────────────────── */
function loadEffectTexture(rawUrl) {
  return new Promise((resolve, reject) => {
    const isDds = rawUrl.includes('.dds');
    const loader = isDds ? ddsLoader : textureLoader;
    loader.load(
      rawUrl,
      (tex) => { tex.colorSpace = SRGBColorSpace; resolve(tex); },
      undefined,
      (err) => reject(new Error(`Load failed: ${err?.message || 'unknown'}`)),
    );
  });
}

/* ── Build Effect Scene ────────────────────────────── */
async function buildEffectScene(data, token) {
  // Clear previous
  if (state.effectGroup) {
    state.scene.remove(state.effectGroup);
    state.effectGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }
  state.emitters = [];
  state.effectGroup = new Group();
  state.scene.add(state.effectGroup);

  // 1. Load all textures into a map: originalPath -> Three.Texture
  const texMap = new Map();
  const allTex = (data.textures || []).filter(t => t.rawUrl);
  dbg(`Loading ${allTex.length} textures\u2026`);
  dom.spinner.textContent = `Loading ${allTex.length} textures\u2026`;

  for (let i = 0; i < allTex.length; i++) {
    const t = allTex[i];
    const dbgIdx = (data.textures || []).indexOf(t);
    const dbgEntry = state.debugTextures[dbgIdx];
    try {
      const tex = await loadEffectTexture(t.rawUrl);
      if (token !== state.loadToken) return;
      texMap.set(t.originalPath || t.texturePath, tex);
      // Also map by just the texture path in case keys differ
      texMap.set(t.texturePath, tex);
      if (dbgEntry) {
        dbgEntry.status = 'loaded';
        dbgEntry.texW = tex.image?.width || tex.mipmaps?.[0]?.width || '?';
        dbgEntry.texH = tex.image?.height || tex.mipmaps?.[0]?.height || '?';
      }
      dbg(`Loaded [${i+1}/${allTex.length}] ${t.texturePath.split('/').pop()} (${dbgEntry?.texW}x${dbgEntry?.texH})`);
    } catch (err) {
      if (token !== state.loadToken) return;
      if (dbgEntry) { dbgEntry.status = 'error'; dbgEntry.error = err.message; }
      dbg(`FAIL [${i+1}] ${t.texturePath.split('/').pop()} — ${err.message}`, 'error');
    }
    updateDebugOverlay();
  }

  dom.spinner.classList.remove('visible');
  dbg(`Textures ready: ${texMap.size}/${allTex.length}`);

  // 2. Build emitters from structured emitter list
  const spriteEmitters = (data.emitters || []).filter(e => e.type === 'sprite');
  if (!spriteEmitters.length) {
    dbg('No sprite emitters found', 'warn');
    return;
  }

  for (let i = 0; i < spriteEmitters.length; i++) {
    const emDef = spriteEmitters[i];
    // Find primary texture for this emitter
    const texPaths = emDef.texturePaths || [];
    const primaryTex = texPaths.map(p => texMap.get(p)).find(Boolean);
    if (!primaryTex) {
      dbg(`Emitter [${emDef.index}] ${emDef.materialName}: no texture found, skipping`, 'warn');
      continue;
    }

    const emitter = createSpriteEmitter(emDef, primaryTex, i, spriteEmitters.length);
    state.emitters.push(emitter);
    state.effectGroup.add(emitter.group);
  }

  dbg(`Created ${state.emitters.length} active sprite emitters`);
  updateDebugOverlay();
}

/* ──────────────────────────────────────────────────────
 * Sprite Emitter — pool of billboard quads that spawn,
 * animate, and recycle over the effect duration.
 * ────────────────────────────────────────────────────── */
function createSpriteEmitter(emDef, texture, emIndex, totalEmitters) {
  const cat = emDef.category || 'other';
  const blend = emDef.blendMode || 'additive';
  const matName = emDef.materialName || '';
  const group = new Group();

  const isAdditive = blend === 'additive';
  const isFade = matName.includes('\u6D88\u6563') || matName.includes('\u7FBD\u5316');

  // Particle pool size per emitter
  const POOL = cat === 'debris' ? 6
             : cat === 'smoke'  ? 5
             : cat === 'light'  ? 3
             : 3;

  // Base size
  const baseSize = cat === 'light'  ? 1.2
                 : cat === 'smoke'  ? 1.6
                 : cat === 'debris' ? 0.3
                 : 0.8;

  // Distribute emitters around a ring so they don't pile up
  const emAngle = (emIndex / Math.max(totalEmitters, 1)) * Math.PI * 2;
  const emRadius = totalEmitters > 8 ? 1.5 : totalEmitters > 4 ? 1.0 : 0.5;
  const ecx = Math.cos(emAngle) * emRadius * (cat === 'debris' ? 1.0 : 0.4);
  const ecz = Math.sin(emAngle) * emRadius * (cat === 'debris' ? 1.0 : 0.4);
  const ecy = cat === 'smoke' ? 0.2 : cat === 'debris' ? 1.5 : 0.8;

  // Spawn spread
  const spread = cat === 'debris' ? 1.2
               : cat === 'smoke'  ? 0.6
               : cat === 'light'  ? 0.4
               : 0.5;

  const particles = [];
  const sharedGeo = new PlaneGeometry(1, 1);

  for (let p = 0; p < POOL; p++) {
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: isAdditive ? AdditiveBlending : NormalBlending,
      opacity: 0,
    });
    const mesh = new Mesh(sharedGeo, mat);
    mesh.visible = false;
    group.add(mesh);

    particles.push({
      mesh, mat,
      alive: false,
      age: 0,
      lifetime: 0,
      size: 0,
      spawnPos: new Vector3(),
      velocity: new Vector3(),
      rotSpeed: 0,
      maxOpacity: 0,
      delay: p * (state.globalDuration / POOL) * (0.4 + Math.random() * 0.4),
    });
  }

  return {
    group, particles, emDef, cat,
    isAdditive, isFade,
    baseSize, spread,
    emCenter: new Vector3(ecx, ecy, ecz),
    elapsed: 0,
  };
}

/* ── Spawn a single particle ───────────────────────── */
function spawnParticle(em, p) {
  const cat = em.cat;

  p.lifetime = cat === 'debris' ? 0.8 + Math.random() * 1.2
             : cat === 'smoke'  ? 1.5 + Math.random() * 2.5
             : cat === 'light'  ? 0.5 + Math.random() * 1.5
             : 0.8 + Math.random() * 1.5;

  p.size = em.baseSize * (0.6 + Math.random() * 0.8);

  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * em.spread;
  p.spawnPos.set(
    em.emCenter.x + Math.cos(a) * r,
    em.emCenter.y + (Math.random() - 0.3) * em.spread * 0.4,
    em.emCenter.z + Math.sin(a) * r,
  );

  if (cat === 'smoke') {
    p.velocity.set((Math.random()-0.5)*0.3, 0.4+Math.random()*0.6, (Math.random()-0.5)*0.3);
  } else if (cat === 'debris') {
    const ta = Math.random() * Math.PI * 2;
    const ts = 1 + Math.random() * 2;
    p.velocity.set(Math.cos(ta)*ts, 2+Math.random()*3, Math.sin(ta)*ts);
  } else if (cat === 'light') {
    p.velocity.set((Math.random()-0.5)*0.15, 0.05+Math.random()*0.2, (Math.random()-0.5)*0.15);
  } else {
    p.velocity.set((Math.random()-0.5)*0.3, Math.random()*0.25, (Math.random()-0.5)*0.3);
  }

  p.rotSpeed = (Math.random()-0.5) * (cat === 'debris' ? 4 : 0.8);
  p.maxOpacity = em.isAdditive ? 0.3+Math.random()*0.35 : 0.5+Math.random()*0.4;
  if (em.isFade) p.maxOpacity *= 0.7;

  p.age = 0;
  p.alive = true;
  p.mesh.visible = true;
  p.mesh.position.copy(p.spawnPos);
  p.mesh.scale.setScalar(p.size);
  p.mesh.rotation.z = Math.random() * Math.PI * 2;
}

/* ── Animation Loop ────────────────────────────────── */
function animate() {
  state.animHandle = requestAnimationFrame(animate);
  const dt = Math.min(state.clock.getDelta(), 0.05);
  const GRAVITY = -4.0;

  for (const em of state.emitters) {
    em.elapsed += dt;

    for (const p of em.particles) {
      if (!p.alive) {
        p.delay -= dt;
        if (p.delay <= 0) {
          spawnParticle(em, p);
          p.delay = 0;
        }
        continue;
      }

      p.age += dt;
      const t = p.age / p.lifetime;

      if (t >= 1) {
        p.alive = false;
        p.mesh.visible = false;
        p.delay = Math.random() * 0.4;
        continue;
      }

      // Opacity fade in/out
      let alpha;
      if (t < 0.12) alpha = t / 0.12;
      else if (t < 0.6) alpha = 1;
      else alpha = 1 - (t - 0.6) / 0.4;
      p.mat.opacity = p.maxOpacity * Math.max(0, alpha);

      // Position
      p.mesh.position.x = p.spawnPos.x + p.velocity.x * p.age;
      p.mesh.position.z = p.spawnPos.z + p.velocity.z * p.age;

      if (em.cat === 'debris') {
        p.mesh.position.y = p.spawnPos.y + p.velocity.y * p.age + 0.5 * GRAVITY * p.age * p.age;
        p.mesh.rotation.z += p.rotSpeed * dt;
        p.mesh.scale.setScalar(p.size * (1 - t * 0.5));
      } else if (em.cat === 'smoke') {
        p.mesh.position.y = p.spawnPos.y + p.velocity.y * p.age;
        p.mesh.scale.setScalar(p.size * (1 + t * 0.8));
      } else if (em.cat === 'light') {
        p.mesh.position.y = p.spawnPos.y + p.velocity.y * p.age;
        const pulse = 1 + 0.15 * Math.sin(p.age * 4);
        p.mesh.scale.setScalar(p.size * pulse);
      } else {
        p.mesh.position.y = p.spawnPos.y + p.velocity.y * p.age;
      }

      // Billboard
      p.mesh.quaternion.copy(state.camera.quaternion);
    }
  }

  state.controls.update();
  state.renderer.render(state.scene, state.camera);
}

/* ── Helpers ───────────────────────────────────────── */
function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Init ──────────────────────────────────────────── */
dom.searchBtn.addEventListener('click', () => loadCatalog(dom.search.value));
dom.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadCatalog(dom.search.value);
});

initRenderer();
loadCatalog('\u9F99\u7259');
