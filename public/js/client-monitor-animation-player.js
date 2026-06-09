import * as THREE from 'three';
import { DDSLoader } from '/vendor/three/examples/jsm/loaders/DDSLoader.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';

const params = new URLSearchParams(window.location.search);
const EMBED_CLIENT_MONITOR = params.get('embed') === 'client-monitor';
const STRICT_RENDER_MODE = params.get('strict') === '1';
const MONITOR_SKILL_ID = params.get('monitorSkillId') || '';
const AUTO_TANI = params.get('autoTani') || params.get('tani') || params.get('path') || '';

if (EMBED_CLIENT_MONITOR) document.body.classList.add('embed-client-monitor');

const canvas = document.getElementById('viewport');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const countsEl = document.getElementById('counts');
const issuesEl = document.getElementById('issues');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const camera = new THREE.PerspectiveCamera(46, 1, 0.01, 2000);
camera.position.set(0, 1.6, 8);
camera.lookAt(0, 0.6, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const root = new THREE.Group();
scene.add(root);
scene.add(new THREE.AmbientLight(0xffffff, 0.62));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
keyLight.position.set(3, 5, 5);
scene.add(keyLight);

const ddsLoader = new DDSLoader();
const gltfLoader = new GLTFLoader();
const textureCache = new Map();
const meshCache = new Map();
const planeGeometry = new THREE.PlaneGeometry(1, 1);
const clock = new THREE.Clock();

const state = {
  taniPath: normalizePath(AUTO_TANI),
  tani: null,
  aniHeader: null,
  effects: [],
  sprites: [],
  meshes: [],
  blockers: [],
  warnings: [],
  loadErrors: [],
  renderCounts: { sprite: 0, mesh: 0, track: 0 },
  timelineMs: 0,
  totalMs: 10000,
  loaded: false,
};

window.__clientMonitorAnimationPlayerInternals = { state, scene, root, camera, renderer };

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function fileName(path) {
  return normalizePath(path).split('/').pop() || path || '';
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pushUnique(list, item) {
  const key = `${item.category || ''}\n${item.text || ''}`;
  if (!list.some((existing) => `${existing.category || ''}\n${existing.text || ''}` === key)) list.push(item);
}

function addBlocker(category, text, data = null) {
  pushUnique(state.blockers, { category, text, data });
}

function addWarning(category, text, data = null) {
  pushUnique(state.warnings, { category, text, data });
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function textureUrl(info) {
  if (!info) return '';
  if (info.rawUrl) return info.rawUrl;
  const path = info.texturePath || info.originalPath || info;
  return path ? `/api/pss/texture?path=${encodeURIComponent(path)}` : '';
}

async function loadTexture(info) {
  const url = textureUrl(info);
  if (!url) throw new Error('missing texture URL');
  if (textureCache.has(url)) return textureCache.get(url);
  const promise = new Promise((resolve, reject) => {
    ddsLoader.load(url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      resolve(texture);
    }, undefined, reject);
  });
  textureCache.set(url, promise);
  return promise;
}

async function loadMesh(path) {
  const sourcePath = normalizePath(path);
  const url = `/api/pss/mesh-glb?path=${encodeURIComponent(sourcePath)}`;
  if (meshCache.has(url)) return meshCache.get(url);
  const promise = new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
  meshCache.set(url, promise);
  return promise;
}

function mergeCurveInfo(analyzed, debugDump) {
  if (!analyzed || !Array.isArray(analyzed.emitters) || !debugDump || !Array.isArray(debugDump.blocks)) return;
  const byIndex = new Map();
  for (const block of debugDump.blocks) {
    if (block?.parsed?.curveInfo) byIndex.set(block.index, block.parsed.curveInfo);
  }
  for (const emitter of analyzed.emitters) {
    const curveInfo = byIndex.get(emitter.index);
    if (curveInfo) emitter.curveInfo = curveInfo;
  }
}

function pickCurveEntry(emitter, key) {
  const entries = emitter?.curveInfo?.[key];
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry && entry.decoded !== false && Array.isArray(entry.keys) && entry.keys.length > 0) || null;
}

function keyValue(key, channel = 'value') {
  if (!key) return null;
  if (Number.isFinite(key[channel])) return key[channel];
  if (channel === 'value' && Number.isFinite(key.x)) return key.x;
  if (Number.isFinite(key.value)) return key.value;
  return null;
}

function sampleKeys(keys, t, channel = 'value') {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  if (keys.length === 1) return keyValue(keys[0], channel);
  const time = THREE.MathUtils.clamp(t, 0, 1);
  const scaled = time * (keys.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(keys.length - 1, leftIndex + 1);
  const mix = scaled - leftIndex;
  const left = keyValue(keys[leftIndex], channel);
  const right = keyValue(keys[rightIndex], channel);
  if (!Number.isFinite(left) && !Number.isFinite(right)) return null;
  if (!Number.isFinite(left)) return right;
  if (!Number.isFinite(right)) return left;
  return left + (right - left) * mix;
}

function sampleSize(runtime, t) {
  if (Array.isArray(runtime?.sizeCurveKeyframes) && runtime.sizeCurveKeyframes.length >= 2) return sampleKeys(runtime.sizeCurveKeyframes.map((value, index) => ({ index, value: Number(value) })), t);
  if (Array.isArray(runtime?.sizeCurve) && runtime.sizeCurve.length === 3) {
    const [a, b, c] = runtime.sizeCurve.map(Number);
    if (t <= 0.5) return a + (b - a) * (t / 0.5);
    return b + (c - b) * ((t - 0.5) / 0.5);
  }
  if (Number.isFinite(Number(runtime?.spatialScalar)) && Number(runtime.spatialScalar) > 0) return Number(runtime.spatialScalar);
  return 1;
}

function normalizeRgba(color) {
  const rgba = [0, 1, 2, 3].map((index) => {
    const value = Number(color?.[index]);
    return Number.isFinite(value) ? value : 1;
  });
  const divisor = Math.max(rgba[0], rgba[1], rgba[2], rgba[3]) > 8 ? 255 : 1;
  return rgba.map((value) => THREE.MathUtils.clamp(value / divisor, 0, 1));
}

function sampleColor(colorCurve, t) {
  if (!Array.isArray(colorCurve) || colorCurve.length === 0) return [1, 1, 1, 1];
  if (colorCurve.length === 1) return colorCurve[0];
  const scaled = THREE.MathUtils.clamp(t, 0, 1) * (colorCurve.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(colorCurve.length - 1, leftIndex + 1);
  const mix = scaled - leftIndex;
  const left = colorCurve[leftIndex] || colorCurve[0];
  const right = colorCurve[rightIndex] || left;
  return [0, 1, 2, 3].map((i) => {
    const a = Number(left[i]);
    const b = Number(right[i]);
    const safeA = Number.isFinite(a) ? a : 1;
    const safeB = Number.isFinite(b) ? b : safeA;
    return safeA + (safeB - safeA) * mix;
  });
}

function report(context = '') {
  const renderCounts = {
    sprite: state.sprites.length,
    mesh: state.meshes.length,
    track: 0,
  };
  state.renderCounts = renderCounts;
  if (state.loaded && renderCounts.sprite + renderCounts.mesh + renderCounts.track === 0) {
    addBlocker('renderer', 'No renderable TANI/PSS objects were created.');
  }
  const payload = {
    strict: STRICT_RENDER_MODE,
    monitorSkillId: MONITOR_SKILL_ID,
    context,
    status: state.blockers.length ? 'blocked' : 'ok',
    sourcePath: state.taniPath,
    renderCounts,
    timelineTotalMs: state.totalMs,
    blockers: state.blockers,
    warnings: state.warnings,
    fallbackCount: 0,
    errorCount: state.loadErrors.length,
    textureMissingCount: state.blockers.filter((item) => item.category === 'texture').length,
    meshErrorCount: state.blockers.filter((item) => item.category === 'mesh').length,
    socketRouting: [],
  };
  document.body.dataset.strictRenderStatus = payload.status;
  document.body.dataset.strictBlockers = String(payload.blockers.length);
  window.__clientMonitorAnimationPlayerReport = payload;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      source: 'jx3-client-monitor-animation-player',
      type: 'strict-render-report',
      monitorSkillId: MONITOR_SKILL_ID,
      report: payload,
    }, window.location.origin);
  }
  updateHud(payload);
  return payload;
}

function updateHud(payload = null) {
  const current = payload || window.__clientMonitorAnimationPlayerReport || report('hud');
  const badgeClass = current.status === 'ok' ? 'ok' : 'blocked';
  titleEl.innerHTML = `<span class="badge ${badgeClass}">${current.status}</span>${fileName(state.taniPath) || 'New animation player'}`;
  subtitleEl.textContent = state.taniPath || 'No TANI supplied';
  countsEl.textContent = `S:${current.renderCounts.sprite} M:${current.renderCounts.mesh} T:${current.renderCounts.track} | ${(state.timelineMs / 1000).toFixed(2)}s / ${(state.totalMs / 1000).toFixed(2)}s`;
  const rows = [...state.blockers.slice(0, 4), ...state.warnings.slice(0, 2)];
  issuesEl.innerHTML = rows.map((item) => `<div class="issue ${state.blockers.includes(item) ? '' : 'warn'}">${escapeHtml(item.text)}</div>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function resize() {
  const width = Math.max(1, canvas.clientWidth || window.innerWidth);
  const height = Math.max(1, canvas.clientHeight || window.innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function makeSpriteMaterial(texture, blendMode) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTint: { value: new THREE.Vector4(1, 1, 1, 1) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec4 uTint;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(uMap, vUv);
        float rgbMax = max(texel.r, max(texel.g, texel.b));
        vec3 sourceRgb = rgbMax > 0.02 ? texel.rgb : vec3(texel.a);
        float sourceAlpha = max(texel.a, rgbMax);
        vec4 outColor = vec4(sourceRgb * uTint.rgb, sourceAlpha * uTint.a);
        if (outColor.a <= 0.003) discard;
        gl_FragColor = outColor;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: blendMode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

function validateSpriteEmitter(emitter, sourcePath) {
  if (emitter.type !== 'sprite') return false;
  if (emitter.sizeCurveStatus === 'unparsed') {
    addBlocker('size-curve', `${fileName(sourcePath)} emitter ${emitter.index} has an undecoded size/scale payload.`, { emitterIndex: emitter.index, sourcePath });
    return false;
  }
  if (emitter.colorCurveStatus === 'unparsed') {
    addBlocker('color-curve', `${fileName(sourcePath)} emitter ${emitter.index} has an undecoded color payload.`, { emitterIndex: emitter.index, sourcePath });
    return false;
  }
  const runtime = emitter.runtimeParams || {};
  if (runtime.source && String(runtime.source).includes('inferred')) {
    addBlocker('runtime', `${fileName(sourcePath)} emitter ${emitter.index} uses inferred runtime fields; it is skipped in the new player.`, { emitterIndex: emitter.index, sourcePath, source: runtime.source });
    return false;
  }
  if (!Number.isFinite(Number(runtime.lifetimeSeconds)) || Number(runtime.lifetimeSeconds) <= 0) {
    addBlocker('lifetime', `${fileName(sourcePath)} emitter ${emitter.index} has no decoded lifetimeSeconds.`, { emitterIndex: emitter.index, sourcePath });
    return false;
  }
  if (emitter.sizeCurveStatus === 'authored') {
    const hasSize = Array.isArray(runtime.sizeCurveKeyframes) || Array.isArray(runtime.sizeCurve);
    const hasScale = !!pickCurveEntry(emitter, 'scale');
    if (!hasSize && !hasScale) {
      addBlocker('scale', `${fileName(sourcePath)} emitter ${emitter.index} says size/scale is authored but no decoded curve reached the new player.`, { emitterIndex: emitter.index, sourcePath });
      return false;
    }
  }
  return true;
}

async function createSprite(effect, emitter) {
  if (!validateSpriteEmitter(emitter, effect.sourcePath)) return;
  const textureInfos = Array.isArray(emitter.resolvedTextures) && emitter.resolvedTextures.length
    ? emitter.resolvedTextures
    : (emitter.texturePaths || []).map((texturePath) => ({ texturePath }));
  const authoredLayerCount = finiteNumber(emitter.layerCount) || finiteNumber(emitter.detectedLayerCount) || textureInfos.length;
  const layers = textureInfos.slice(0, Math.max(1, Math.min(textureInfos.length, authoredLayerCount || textureInfos.length)));
  if (!layers.length) {
    addBlocker('texture', `${fileName(effect.sourcePath)} emitter ${emitter.index} has no authored texture layers.`, { emitterIndex: emitter.index, sourcePath: effect.sourcePath });
    return;
  }

  const group = new THREE.Group();
  group.visible = false;
  group.userData.emitterIndex = emitter.index;
  group.userData.sourcePath = effect.sourcePath;
  group.position.set(0, 0, 0);
  effect.root.add(group);

  const planes = [];
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const info = layers[layerIndex];
    let texture;
    try {
      texture = await loadTexture(info);
    } catch (error) {
      addBlocker('texture', `${fileName(effect.sourcePath)} emitter ${emitter.index} texture failed: ${info.texturePath || info.rawUrl || 'unknown'} (${error.message})`, { emitterIndex: emitter.index, sourcePath: effect.sourcePath });
      continue;
    }
    const mesh = new THREE.Mesh(planeGeometry, makeSpriteMaterial(texture, emitter.blendMode));
    mesh.frustumCulled = false;
    mesh.position.z = layerIndex * 0.002;
    group.add(mesh);
    planes.push(mesh);
  }
  if (!planes.length) {
    group.removeFromParent();
    return;
  }
  const sprite = { effect, emitter, group, planes, lifetimeMs: Number(emitter.runtimeParams.lifetimeSeconds) * 1000 };
  state.sprites.push(sprite);
  effect.sprites.push(sprite);
}

async function createMeshes(effect, analyzed) {
  const assets = Array.isArray(analyzed.meshAssets) ? analyzed.meshAssets.filter((asset) => asset?.sourcePath) : [];
  for (const asset of assets) {
    try {
      const loaded = await loadMesh(asset.sourcePath);
      const object = loaded.clone(true);
      object.visible = false;
      effect.root.add(object);
      const mesh = { effect, object, sourcePath: asset.sourcePath };
      state.meshes.push(mesh);
      effect.meshes.push(mesh);
    } catch (error) {
      addBlocker('mesh', `${fileName(effect.sourcePath)} mesh failed: ${asset.sourcePath} (${error.message})`, { sourcePath: effect.sourcePath, meshPath: asset.sourcePath });
    }
  }
}

async function loadPssEffect(entry) {
  const sourcePath = normalizePath(entry.path);
  const startMs = finiteNumber(entry.effectiveStartTimeMs) ?? finiteNumber(entry.startTimeMs);
  if (!sourcePath) return null;
  if (!Number.isFinite(startMs)) {
    addBlocker('timing', `${fileName(sourcePath)} has no authoritative start time.`, { sourcePath });
    return null;
  }
  let analyzed;
  let dump;
  try {
    [analyzed, dump] = await Promise.all([
      fetchJson(`/api/pss/analyze?sourcePath=${encodeURIComponent(sourcePath)}`),
      fetchJson(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`),
    ]);
  } catch (error) {
    addBlocker('pss', `${fileName(sourcePath)} failed to parse: ${error.message}`, { sourcePath });
    return null;
  }
  if (!analyzed.ok) {
    addBlocker('pss', `${fileName(sourcePath)} analyzer returned not-ok.`, { sourcePath });
    return null;
  }
  mergeCurveInfo(analyzed, dump);
  if (dump?.socket?.reason && /no authored/i.test(dump.socket.reason)) {
    addWarning('socket', `${fileName(sourcePath)} has no authored socket binding in the currently decoded sources.`, { sourcePath, reason: dump.socket.reason });
  }
  const durationMs = finiteNumber(entry.pssPlayDurationMs) ?? finiteNumber(analyzed.globalPlayDuration) ?? finiteNumber(analyzed.globalDuration);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    addBlocker('timing', `${fileName(sourcePath)} has no decoded play duration.`, { sourcePath });
    return null;
  }
  const effect = {
    sourcePath,
    startMs,
    durationMs,
    root: new THREE.Group(),
    sprites: [],
    meshes: [],
  };
  effect.root.visible = false;
  root.add(effect.root);
  state.effects.push(effect);
  for (const emitter of analyzed.emitters || []) {
    if (emitter.type === 'sprite') await createSprite(effect, emitter);
  }
  await createMeshes(effect, analyzed);
  return effect;
}

async function loadTani(path) {
  const taniPath = normalizePath(path);
  if (!taniPath) {
    addBlocker('tani', 'No TANI path was supplied to the new player.');
    state.loaded = true;
    return;
  }
  state.taniPath = taniPath;
  titleEl.textContent = fileName(taniPath);
  subtitleEl.textContent = taniPath;
  try {
    state.tani = await fetchJson(`/api/player-anim/tani-parse?path=${encodeURIComponent(taniPath)}`);
  } catch (error) {
    addBlocker('tani', `TANI parse failed: ${error.message}`, { taniPath });
    state.loaded = true;
    return;
  }
  if (state.tani?.aniPath) {
    try {
      state.aniHeader = await fetchJson(`/api/player-anim/ani-header?path=${encodeURIComponent(state.tani.aniPath)}`);
    } catch (error) {
      addWarning('ani', `ANI header did not load: ${normalizePath(state.tani.aniPath)} (${error.message})`);
    }
  } else {
    addWarning('ani', 'TANI did not expose a base ANI path.');
  }

  const entries = Array.isArray(state.tani?.pssEntries) && state.tani.pssEntries.length
    ? state.tani.pssEntries
    : (state.tani?.pssPaths || []).map((pathValue) => ({ path: pathValue }));
  if (!entries.length) addBlocker('tani', 'TANI contains no PSS entries.', { taniPath });
  for (const entry of entries) await loadPssEffect(entry);
  let endMs = 0;
  for (const effect of state.effects) endMs = Math.max(endMs, effect.startMs + effect.durationMs + 1000);
  if (endMs > 0) state.totalMs = Math.max(1000, endMs);
  state.loaded = true;
  frameScene();
}

function frameScene() {
  camera.position.set(0, 1.4, 8);
  camera.lookAt(0, 0, 0);
}

function updateSprite(sprite, localMs) {
  sprite.group.visible = true;
  const lifetimeMs = Math.max(50, sprite.lifetimeMs || sprite.effect.durationMs);
  const t = THREE.MathUtils.clamp((localMs % lifetimeMs) / lifetimeMs, 0, 1);
  const runtime = sprite.emitter.runtimeParams || {};
  const size = sampleSize(runtime, t);
  const scaleEntry = pickCurveEntry(sprite.emitter, 'scale');
  const scale = scaleEntry ? sampleKeys(scaleEntry.keys, t) : 1;
  const currentSize = Math.max(0.0001, (Number.isFinite(size) ? size : 1) * (Number.isFinite(scale) ? scale : 1));
  sprite.group.scale.setScalar(currentSize);
  sprite.group.quaternion.copy(camera.quaternion);
  const color = sampleColor(sprite.emitter.colorCurve, t);
  const tint = normalizeRgba(color);
  for (const plane of sprite.planes) {
    plane.material.uniforms.uTint.value.set(tint[0], tint[1], tint[2], tint[3]);
  }
}

function updateTimeline(deltaSeconds) {
  state.timelineMs = (state.timelineMs + deltaSeconds * 1000) % Math.max(1000, state.totalMs || 10000);
  for (const effect of state.effects) {
    const localMs = state.timelineMs - effect.startMs;
    const active = localMs >= 0 && localMs <= effect.durationMs;
    effect.root.visible = active;
    if (!active) {
      for (const sprite of effect.sprites) sprite.group.visible = false;
      for (const mesh of effect.meshes) mesh.object.visible = false;
      continue;
    }
    for (const sprite of effect.sprites) updateSprite(sprite, localMs);
    for (const mesh of effect.meshes) mesh.object.visible = active;
  }
}

function animate() {
  requestAnimationFrame(animate);
  resize();
  updateTimeline(clock.getDelta());
  renderer.render(scene, camera);
  if (state.loaded) updateHud(window.__clientMonitorAnimationPlayerReport || report('frame'));
}

window.__clientMonitorAnimationPlayerSnapshot = () => report('snapshot');
window.addEventListener('resize', resize);
window.addEventListener('error', (event) => {
  const text = event?.message || String(event?.error || 'window error');
  state.loadErrors.push(text);
  addBlocker('runtime', text);
  report('window-error');
});
window.addEventListener('unhandledrejection', (event) => {
  const text = event?.reason?.message || String(event?.reason || 'unhandled rejection');
  state.loadErrors.push(text);
  addBlocker('runtime', text);
  report('unhandledrejection');
});

resize();
animate();
loadTani(AUTO_TANI).then(() => report('load-complete')).catch((error) => {
  state.loadErrors.push(error.message || String(error));
  addBlocker('runtime', error.message || String(error));
  state.loaded = true;
  report('load-error');
});