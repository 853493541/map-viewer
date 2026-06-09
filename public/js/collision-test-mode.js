import * as THREE from '../lib/three.module.js';
import { GLTFLoader } from '../lib/GLTFLoader.js';
import { MeshBVH } from '../lib/three-mesh-bvh/src/index.js';

const dom = {
  canvas: document.getElementById('viewport'),
  hud: document.getElementById('hud'),
  status: document.getElementById('status'),
  dataPath: document.getElementById('data-path'),
  reloadList: document.getElementById('reload-list'),
  openInspector: document.getElementById('open-inspector'),
  meshFilter: document.getElementById('mesh-filter'),
  verdictFilter: document.getElementById('verdict-filter'),
  showTextures: document.getElementById('show-textures'),
  showCollision: document.getElementById('show-collision'),
  meshList: document.getElementById('mesh-list'),
  prevMesh: document.getElementById('prev-mesh'),
  nextMesh: document.getElementById('next-mesh'),
  rebuildCollision: document.getElementById('rebuild-collision'),
  frameMesh: document.getElementById('frame-mesh'),
  walkSpeedLevels: document.getElementById('walk-speed-levels'),
  startWalk: document.getElementById('start-walk'),
  stopWalk: document.getElementById('stop-walk'),
  walkResult: document.getElementById('walk-result'),
  probeX: document.getElementById('probe-x'),
  probeY: document.getElementById('probe-y'),
  probeZ: document.getElementById('probe-z'),
  probeEpsilon: document.getElementById('probe-epsilon'),
  surfaceBand: document.getElementById('surface-band'),
  checkProbe: document.getElementById('check-probe'),
  snapProbeToTarget: document.getElementById('snap-probe-to-target'),
  probeResult: document.getElementById('probe-result'),
  scanStep: document.getElementById('scan-step'),
  scanMargin: document.getElementById('scan-margin'),
  runScan: document.getElementById('run-scan'),
  clearMarkers: document.getElementById('clear-markers'),
  scanResult: document.getElementById('scan-result'),
};

const query = new URLSearchParams(window.location.search);
const pkg = query.get('pkg');
const hasExplicitDataPath = query.has('dataPath') || Boolean(pkg);
const defaultPath = pkg ? `/full-exports/${encodeURIComponent(pkg)}/map-data` : 'map-data';

const state = {
  dataPath: normalizeDataPath(query.get('dataPath') || defaultPath),
  meshNames: [],
  filteredMeshNames: [],
  verdictApprovedSet: new Set(),
  verdictDeniedSet: new Set(),
  textureMap: null,
  textureMapByLower: new Map(),
  meshName: '',
  meshGroup: null,
  meshEntry: null,
  collisionEntry: null,
  meshGeometry: null,
  collisionGeometry: null,
  collisionLines: null,
  falsePositivePoints: null,
  falseNegativePoints: null,
  sidecarLocalPositions: null,
  sidecarMeta: null,
  collisionSource: 'none',
  ground: {
    plane: null,
    grid: null,
    y: 0,
    centerX: 0,
    centerZ: 0,
    halfX: 40,
    halfZ: 40,
  },
  maxOrbitRadius: 500,
  walkMode: {
    enabled: false,
    keys: {},
    speed: 2000,
    runMultiplier: 1.8,
    jumpSpeed: 8.6,
    gravity: 19,
    radius: 1.05,
    eyeHeight: 3.1,
    position: new THREE.Vector3(0, 4, 0),
    velocity: new THREE.Vector3(),
    onGround: false,
    marker: null,
    markerBody: null,
    markerHead: null,
    lastHitDistance: Infinity,
    collisionSourceUsed: 'none',
  },
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8db7e6);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);

const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth - 390, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;

const orbit = {
  theta: 0.88,
  phi: 0.96,
  radius: 42,
  target: new THREE.Vector3(0, 3.5, 0),
};

const orbitRuntime = {
  dragging: false,
  dragMode: 'rotate',
  lastX: 0,
  lastY: 0,
};

const gltfLoader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
const tmpVec3 = new THREE.Vector3();
const identityMatrix = new THREE.Matrix4();
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();
const tmpPush = new THREE.Vector3();
const tmpUp = new THREE.Vector3(0, 1, 0);
const walkHitTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const walkGroundRay = new THREE.Ray();
let lastFrameTime = performance.now();
const autoStartWalkMode = true;
const thirdPersonScaleMultiplier = 1;
const SPEED_LEVELS = [500, 1000, 2000, 3000];
const walkSpeedButtons = Array.from(document.querySelectorAll('#walk-speed-levels .speed-btn'));

const probeMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.14, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xffff66 }),
);
scene.add(probeMarker);

initScene();
wireEvents();
window.addEventListener('resize', onResize);

if (dom.verdictFilter) dom.verdictFilter.value = 'approved';
setWalkSpeed(2000, false);
updateWalkHud();
animate();
bootstrap();

function normalizeDataPath(raw) {
  const clean = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return clean || 'map-data';
}

function normalizeMeshName(raw) {
  let name = String(raw || '').trim();
  if (!name) return '';
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
  return name;
}

function encodePathSegments(pathLike) {
  return String(pathLike || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function bootstrap() {
  if (!hasExplicitDataPath) {
    state.dataPath = await resolvePreferredDefaultPath();
  }

  dom.dataPath.value = state.dataPath;
  setStatus('Loading mesh list...');
  await loadMeshList();
}

async function resolvePreferredDefaultPath() {
  try {
    const exportInfo = await fetchJson('/api/full-exports');
    const exportsList = Array.isArray(exportInfo?.exports) ? exportInfo.exports.slice() : [];
    exportsList.sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));

    const preferred = exportsList.find((entry) => {
      const stats = entry?.stats || {};
      return stats.meshCollisionComplete === true || Number(stats.meshCollisionAttached || 0) > 0;
    });

    if (preferred?.packageName) {
      return `/full-exports/${encodeURIComponent(preferred.packageName)}/map-data`;
    }
  } catch {
    // Fall back to the local map-data path when no generated export is available.
  }

  return defaultPath;
}

function normalizeMeshList(list) {
  const seen = new Set();
  const out = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const name = normalizeMeshName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function applyTextureMap(rawTextureMap) {
  state.textureMap = rawTextureMap && typeof rawTextureMap === 'object' ? rawTextureMap : null;
  state.textureMapByLower = new Map();

  if (!state.textureMap) return;

  for (const [rawName, info] of Object.entries(state.textureMap)) {
    const normalized = normalizeMeshName(rawName).toLowerCase();
    if (!normalized) continue;
    if (!state.textureMapByLower.has(normalized)) {
      state.textureMapByLower.set(normalized, info);
    }
  }
}

function getTextureInfoForMesh(meshName) {
  if (!state.textureMap) return null;
  if (state.textureMap[meshName]) return state.textureMap[meshName];
  return state.textureMapByLower.get(normalizeMeshName(meshName).toLowerCase()) || null;
}

function applyVerdicts(raw) {
  state.verdictApprovedSet.clear();
  state.verdictDeniedSet.clear();

  const approved = Array.isArray(raw?.approved) ? raw.approved : [];
  const denied = Array.isArray(raw?.denied) ? raw.denied : [];

  for (const item of approved) {
    const normalized = normalizeMeshName(item).toLowerCase();
    if (normalized) state.verdictApprovedSet.add(normalized);
  }

  for (const item of denied) {
    const normalized = normalizeMeshName(item).toLowerCase();
    if (!normalized || state.verdictApprovedSet.has(normalized)) continue;
    state.verdictDeniedSet.add(normalized);
  }
}

async function loadTextureMap(diagnostics) {
  try {
    const texMap = await fetchJson(`${state.dataPath}/texture-map.json`);
    applyTextureMap(texMap);
    diagnostics.push(`texture-map=${Object.keys(texMap || {}).length}`);
  } catch (err) {
    applyTextureMap(null);
    diagnostics.push(`texture-map failed: ${err.message || err}`);
  }
}

async function loadVerdicts(diagnostics) {
  try {
    const verdicts = await fetchJson(`/api/verdicts?dataPath=${encodeURIComponent(state.dataPath)}`);
    applyVerdicts(verdicts);
    diagnostics.push(`verdicts(api)=A${state.verdictApprovedSet.size}/D${state.verdictDeniedSet.size}`);
    return;
  } catch (err) {
    diagnostics.push(`verdicts api failed: ${err.message || err}`);
  }

  try {
    const verdicts = await fetchJson(`${state.dataPath}/verdicts.json`);
    applyVerdicts(verdicts);
    diagnostics.push(`verdicts(file)=A${state.verdictApprovedSet.size}/D${state.verdictDeniedSet.size}`);
  } catch (err) {
    applyVerdicts({ approved: [], denied: [] });
    diagnostics.push(`verdicts file failed: ${err.message || err}`);
  }
}

function loadTexCached(pngName, linear) {
  if (!pngName) return null;

  const key = `${state.dataPath}|${pngName}|${linear ? 'lin' : 'srgb'}`;
  if (!textureCache.has(key)) {
    const tex = textureLoader.load(`${state.dataPath}/textures/` + encodeURIComponent(pngName));
    tex.colorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    textureCache.set(key, tex);
  }

  return textureCache.get(key);
}

function loadMRECached(pngName) {
  if (!pngName) return null;

  const key = `${state.dataPath}|${pngName}|mre`;
  if (!textureCache.has(key)) {
    const tex = textureLoader.load(
      `${state.dataPath}/textures/` + encodeURIComponent(pngName),
      (t) => {
        const canv = document.createElement('canvas');
        const img = t.image;
        canv.width = img.width;
        canv.height = img.height;

        const ctx = canv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, canv.width, canv.height);
        const px = d.data;

        for (let i = 0; i < px.length; i += 4) {
          const r = px[i];
          px[i] = px[i + 2];
          px[i + 2] = r;
        }

        ctx.putImageData(d, 0, 0);
        t.image = canv;
        t.needsUpdate = true;
      },
    );

    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.flipY = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    textureCache.set(key, tex);
  }

  return textureCache.get(key);
}

function applyMeshMaterials(group, meshName) {
  if (!group) return;

  const showTextures = dom.showTextures?.checked !== false;
  const textureInfo = showTextures ? getTextureInfoForMesh(meshName) : null;
  let childMeshIndex = 0;

  group.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    const geom = child.geometry;
    const hasColors = geom.hasAttribute('color');
    const subTex = (textureInfo && textureInfo.subsets && childMeshIndex < textureInfo.subsets.length)
      ? textureInfo.subsets[childMeshIndex]
      : textureInfo;
    childMeshIndex++;

    if (subTex && subTex.albedo) {
      const opts = {
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.2,
        side: THREE.DoubleSide,
        map: loadTexCached(subTex.albedo, false),
      };
      if (subTex.mre) {
        opts.roughnessMap = opts.metalnessMap = loadMRECached(subTex.mre);
      }
      if (subTex.normal) {
        opts.normalMap = loadTexCached(subTex.normal, true);
      }
      child.material = new THREE.MeshStandardMaterial(opts);
    } else {
      child.material = new THREE.MeshPhongMaterial({
        color: hasColors ? 0xffffff : 0xccbbaa,
        vertexColors: hasColors,
        shininess: 8,
        side: THREE.DoubleSide,
      });
    }
  });
}

function updateCollisionVisibility() {
  const visible = dom.showCollision?.checked !== false;
  if (state.collisionLines) state.collisionLines.visible = visible;
  if (state.falsePositivePoints) state.falsePositivePoints.visible = visible;
  if (state.falseNegativePoints) state.falseNegativePoints.visible = visible;
}

async function loadMeshList() {
  state.dataPath = normalizeDataPath(dom.dataPath.value);
  dom.dataPath.value = state.dataPath;

  let meshNames = [];
  const diagnostics = [];

  try {
    const rows = await fetchJson(`/api/meshes?dataPath=${encodeURIComponent(state.dataPath)}`);
    meshNames = normalizeMeshList(rows);
    diagnostics.push(`api/meshes=${meshNames.length}`);
  } catch (err) {
    diagnostics.push(`api/meshes failed: ${err.message || err}`);
  }

  if (meshNames.length === 0) {
    try {
      const rows = await fetchJson(`${state.dataPath}/mesh-list.json`);
      meshNames = normalizeMeshList(rows);
      diagnostics.push(`mesh-list.json=${meshNames.length}`);
    } catch (err) {
      diagnostics.push(`mesh-list failed: ${err.message || err}`);
    }
  }

  if (meshNames.length === 0) {
    try {
      const meshMap = await fetchJson(`${state.dataPath}/mesh-map.json`);
      meshNames = normalizeMeshList(Object.values(meshMap || {}));
      diagnostics.push(`mesh-map.json=${meshNames.length}`);
    } catch (err) {
      diagnostics.push(`mesh-map failed: ${err.message || err}`);
    }
  }

  await Promise.all([
    loadTextureMap(diagnostics),
    loadVerdicts(diagnostics),
  ]);

  state.meshNames = meshNames;
  applyMeshFilter();

  if (meshNames.length === 0) {
    setStatus(`No meshes found. ${diagnostics.join(' | ')}`, 'warn');
    setResult(dom.probeResult, 'No meshes available in this data path.', 'warn');
    setResult(dom.scanResult, 'No meshes available in this data path.', 'warn');
    return;
  }

  const selectedName = dom.meshList.disabled ? '' : dom.meshList.value;
  if (selectedName) {
    await loadSingleMesh(selectedName);
    return;
  }

  setStatus(`Loaded ${meshNames.length} meshes. ${diagnostics.join(' | ')}`);
}

function applyMeshFilter() {
  const filter = String(dom.meshFilter.value || '').trim().toLowerCase();
  const verdictFilter = dom.verdictFilter?.value || 'all';

  state.filteredMeshNames = state.meshNames.filter((name) => {
    if (filter && !name.toLowerCase().includes(filter)) return false;

    const key = normalizeMeshName(name).toLowerCase();
    const isApproved = state.verdictApprovedSet.has(key);
    const isDenied = state.verdictDeniedSet.has(key);

    if (verdictFilter === 'approved') return isApproved;
    if (verdictFilter === 'denied') return isDenied;
    if (verdictFilter === 'undecided') return !isApproved && !isDenied;
    return true;
  });

  const previous = dom.meshList.value;
  dom.meshList.innerHTML = '';

  for (const name of state.filteredMeshNames) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name.replace(/\.glb$/i, '');
    dom.meshList.appendChild(option);
  }

  if (state.filteredMeshNames.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '(no meshes match filter)';
    dom.meshList.appendChild(option);
    dom.meshList.disabled = true;
    return;
  }

  dom.meshList.disabled = false;

  if (previous && state.filteredMeshNames.includes(previous)) {
    dom.meshList.value = previous;
  } else {
    dom.meshList.value = state.filteredMeshNames[0];
  }
}

function setWalkSpeed(speed, updateHud = true) {
  const numeric = Number(speed);
  const safe = Number.isFinite(numeric) ? numeric : 2000;
  state.walkMode.speed = safe;

  for (const btn of walkSpeedButtons) {
    const btnSpeed = Number(btn.dataset.speed);
    btn.classList.toggle('active', btnSpeed === safe);
  }

  if (updateHud) updateWalkHud();
}

function autoChooseSpeedLevelForMesh() {
  if (!state.meshGeometry?.boundingBox) {
    setWalkSpeed(2000);
    return;
  }

  const sphere = new THREE.Sphere();
  state.meshGeometry.boundingBox.getBoundingSphere(sphere);
  const r = Math.max(0, sphere.radius || 0);

  let picked = 2000;
  if (r < 120) picked = 500;
  else if (r < 380) picked = 1000;
  else if (r > 1800) picked = 3000;

  setWalkSpeed(picked);
}

function wireEvents() {
  dom.reloadList.addEventListener('click', () => {
    setStatus('Reloading mesh list...');
    loadMeshList();
  });

  dom.openInspector.addEventListener('click', () => {
    const url = `/mesh-inspector.html?dataPath=${encodeURIComponent(normalizeDataPath(dom.dataPath.value))}`;
    window.location.href = url;
  });

  dom.meshFilter.addEventListener('input', () => {
    applyMeshFilter();
  });

  dom.verdictFilter?.addEventListener('change', () => {
    applyMeshFilter();
  });

  dom.showTextures?.addEventListener('change', () => {
    if (!state.meshGroup || !state.meshName) return;
    applyMeshMaterials(state.meshGroup, state.meshName);
    setStatus(dom.showTextures.checked ? 'Texture preview enabled.' : 'Texture preview disabled.');
  });

  dom.showCollision?.addEventListener('change', () => {
    updateCollisionVisibility();
    setStatus(dom.showCollision.checked ? 'Collision overlay enabled.' : 'Collision overlay hidden.');
  });

  dom.meshList.addEventListener('change', () => {
    const name = dom.meshList.value;
    if (!name) return;
    loadSingleMesh(name);
  });

  dom.prevMesh.addEventListener('click', () => stepMeshSelection(-1));
  dom.nextMesh.addEventListener('click', () => stepMeshSelection(1));

  dom.rebuildCollision.addEventListener('click', () => {
    if (!state.meshGroup) return;
    rebuildPrecisionData();
    setStatus('Collision rebuilt from current mesh.');
  });

  dom.frameMesh?.addEventListener('click', () => {
    frameCameraToCurrentMesh();
    setStatus('Camera framed to current mesh bounds.');
  });

  for (const btn of walkSpeedButtons) {
    btn.addEventListener('click', () => {
      const speed = Number(btn.dataset.speed);
      if (!SPEED_LEVELS.includes(speed)) return;
      setWalkSpeed(speed);
    });
  }

  dom.startWalk?.addEventListener('click', () => {
    startWalkMode();
  });

  dom.stopWalk?.addEventListener('click', () => {
    stopWalkMode();
  });

  dom.checkProbe?.addEventListener('click', () => {
    evaluateProbePoint();
  });

  dom.snapProbeToTarget?.addEventListener('click', () => {
    if (!dom.probeX || !dom.probeY || !dom.probeZ) return;
    dom.probeX.value = orbit.target.x.toFixed(3);
    dom.probeY.value = orbit.target.y.toFixed(3);
    dom.probeZ.value = orbit.target.z.toFixed(3);
    evaluateProbePoint();
  });

  dom.runScan?.addEventListener('click', () => {
    runSweepScan();
  });

  dom.clearMarkers?.addEventListener('click', () => {
    clearMismatchMarkers();
    setStatus('Cleared mismatch markers.');
  });

  dom.canvas.addEventListener('pointerdown', onPointerDown);
  dom.canvas.addEventListener('pointermove', onPointerMove);
  dom.canvas.addEventListener('pointerup', onPointerUp);
  dom.canvas.addEventListener('pointerleave', onPointerUp);
  dom.canvas.addEventListener('wheel', onWheel, { passive: false });

  window.addEventListener('keydown', onWalkKeyDown);
  window.addEventListener('keyup', onWalkKeyUp);
}

function onPointerDown(event) {
  orbitRuntime.dragging = true;
  orbitRuntime.lastX = event.clientX;
  orbitRuntime.lastY = event.clientY;
  orbitRuntime.dragMode = event.shiftKey ? 'pan' : 'rotate';
  dom.canvas.classList.add('dragging');
}

function onPointerMove(event) {
  if (!orbitRuntime.dragging) return;

  const dx = event.clientX - orbitRuntime.lastX;
  const dy = event.clientY - orbitRuntime.lastY;
  orbitRuntime.lastX = event.clientX;
  orbitRuntime.lastY = event.clientY;

  if (orbitRuntime.dragMode === 'pan') {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.getWorldDirection(tmpVec3);
    right.crossVectors(tmpVec3, camera.up).normalize();
    up.copy(camera.up).normalize();

    const panScale = Math.max(0.02, orbit.radius * 0.0025);
    orbit.target.addScaledVector(right, -dx * panScale);
    orbit.target.addScaledVector(up, dy * panScale);
  } else {
    orbit.theta -= dx * 0.005;
    orbit.phi -= dy * 0.005;
    orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi));
  }

  updateCameraFromOrbit();
}

function onPointerUp() {
  orbitRuntime.dragging = false;
  dom.canvas.classList.remove('dragging');
}

function onWheel(event) {
  event.preventDefault();
  orbit.radius *= Math.exp(event.deltaY * 0.0012);
  orbit.radius = Math.max(1.5, Math.min(state.maxOrbitRadius || 500, orbit.radius));
  updateCameraFromOrbit();
}

function initScene() {
  const hemi = new THREE.HemisphereLight(0xc9e4ff, 0x62744f, 1.28);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffffff, 0.58);
  scene.add(ambient);

  const keySun = new THREE.DirectionalLight(0xfff3d0, 2.55);
  keySun.position.set(160, 220, 90);
  scene.add(keySun);

  const fillSun = new THREE.DirectionalLight(0xd9e9ff, 1.0);
  fillSun.position.set(-130, 120, -140);
  scene.add(fillSun);

  const axes = new THREE.AxesHelper(6);
  scene.add(axes);

  rebuildGroundAroundMesh();
  createWalkMarker();

  probeMarker.position.set(0, 0, 0);
  updateCameraFromOrbit();
  onResize();
}

function updateCameraFromOrbit() {
  const sinPhi = Math.sin(orbit.phi);
  const x = orbit.target.x + orbit.radius * sinPhi * Math.sin(orbit.theta);
  const y = orbit.target.y + orbit.radius * Math.cos(orbit.phi);
  const z = orbit.target.z + orbit.radius * sinPhi * Math.cos(orbit.theta);
  camera.position.set(x, y, z);
  camera.lookAt(orbit.target);
}

function onResize() {
  const panelWidth = document.getElementById('panel').getBoundingClientRect().width;
  const width = Math.max(320, window.innerWidth - panelWidth);
  const height = Math.max(320, window.innerHeight);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (state.walkMode.enabled) {
    updateWalkMode(dt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function setStatus(message, level = 'info') {
  dom.status.textContent = message;
  dom.status.style.color = level === 'warn'
    ? '#d29922'
    : level === 'error'
      ? '#ff7b72'
      : '#8b949e';
}

function setResult(element, text, level = 'info') {
  if (!element) return;
  element.textContent = text;
  element.classList.remove('pass', 'fail', 'warn');
  if (level === 'pass') element.classList.add('pass');
  if (level === 'fail') element.classList.add('fail');
  if (level === 'warn') element.classList.add('warn');
}

function stepMeshSelection(direction) {
  const names = state.filteredMeshNames;
  if (names.length === 0) return;

  const current = dom.meshList.value;
  let index = names.indexOf(current);
  if (index < 0) index = 0;

  index += direction;
  if (index < 0) index = names.length - 1;
  if (index >= names.length) index = 0;

  dom.meshList.value = names[index];
  loadSingleMesh(names[index]);
}

function clearObjectTree(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();

    if (Array.isArray(child.material)) {
      for (const mat of child.material) {
        if (mat && typeof mat.dispose === 'function') mat.dispose();
      }
    } else if (child.material && typeof child.material.dispose === 'function') {
      child.material.dispose();
    }
  });
}

function clearPrecisionData() {
  if (state.meshGeometry) {
    state.meshGeometry.dispose();
    state.meshGeometry = null;
  }
  if (state.collisionGeometry) {
    state.collisionGeometry.dispose();
    state.collisionGeometry = null;
  }

  state.meshEntry = null;
  state.collisionEntry = null;

  if (state.collisionLines) {
    scene.remove(state.collisionLines);
    state.collisionLines.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && typeof obj.material.dispose === 'function') obj.material.dispose();
    });
    state.collisionLines = null;
  }

  clearMismatchMarkers();
}

function clearCurrentMesh() {
  stopWalkMode();
  clearPrecisionData();

  if (state.meshGroup) {
    scene.remove(state.meshGroup);
    clearObjectTree(state.meshGroup);
    state.meshGroup = null;
  }

  state.meshName = '';
  state.sidecarLocalPositions = null;
  state.sidecarMeta = null;
  state.collisionSource = 'none';
  rebuildGroundAroundMesh();
  updateHud();
}

function disposeGroundAroundMesh() {
  const ground = state.ground;

  if (ground.plane) {
    scene.remove(ground.plane);
    ground.plane.geometry?.dispose();
    if (ground.plane.material && typeof ground.plane.material.dispose === 'function') {
      ground.plane.material.dispose();
    }
    ground.plane = null;
  }

  if (ground.grid) {
    scene.remove(ground.grid);
    ground.grid.geometry?.dispose();
    if (Array.isArray(ground.grid.material)) {
      for (const mat of ground.grid.material) {
        if (mat && typeof mat.dispose === 'function') mat.dispose();
      }
    } else if (ground.grid.material && typeof ground.grid.material.dispose === 'function') {
      ground.grid.material.dispose();
    }
    ground.grid = null;
  }
}

function rebuildGroundAroundMesh() {
  const ground = state.ground;
  disposeGroundAroundMesh();

  let centerX = 0;
  let centerZ = 0;
  let sizeX = 90;
  let sizeZ = 90;
  let groundY = 0;

  if (state.meshGeometry?.boundingBox) {
    const box = state.meshGeometry.boundingBox;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    centerX = center.x;
    centerZ = center.z;
    groundY = box.min.y - 0.03;
    sizeX = Math.max(90, size.x);
    sizeZ = Math.max(90, size.z);

    const pad = Math.max(16, Math.max(sizeX, sizeZ) * 0.35);
    sizeX += pad * 2;
    sizeZ += pad * 2;
  }

  ground.centerX = centerX;
  ground.centerZ = centerZ;
  ground.y = groundY;
  ground.halfX = sizeX * 0.5;
  ground.halfZ = sizeZ * 0.5;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(sizeX, sizeZ),
    new THREE.MeshStandardMaterial({
      color: 0x1a222b,
      roughness: 0.97,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  plane.rotation.x = -Math.PI * 0.5;
  plane.position.set(centerX, groundY, centerZ);
  plane.renderOrder = -1;
  scene.add(plane);
  ground.plane = plane;

  const gridSize = Math.max(sizeX, sizeZ);
  const gridDivisions = Math.max(24, Math.min(360, Math.round(gridSize / 2)));
  const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x41698f, 0x273341);
  grid.position.set(centerX, groundY + 0.01, centerZ);
  scene.add(grid);
  ground.grid = grid;
}

function sampleGroundPlaneHeight(position) {
  const ground = state.ground;
  if (!ground) return null;

  const edgePadding = 3.5;
  if (Math.abs(position.x - ground.centerX) > ground.halfX + edgePadding) return null;
  if (Math.abs(position.z - ground.centerZ) > ground.halfZ + edgePadding) return null;
  return ground.y;
}

function createWalkMarker() {
  const walk = state.walkMode;
  if (walk.marker) return;

  const marker = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffb347,
    roughness: 0.65,
    metalness: 0.05,
    emissive: 0x221400,
  });

  const bodyHeight = Math.max(walk.eyeHeight * 0.72, walk.radius * 2.3);
  const headRadius = walk.radius * 0.72;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(walk.radius * 0.92, walk.radius * 1.04, bodyHeight, 16),
    mat,
  );
  body.position.y = bodyHeight * 0.5;

  const head = new THREE.Mesh(new THREE.SphereGeometry(headRadius, 16, 14), mat);
  head.position.y = bodyHeight + headRadius * 1.12;

  marker.add(body);
  marker.add(head);
  marker.visible = false;
  scene.add(marker);

  walk.marker = marker;
  walk.markerBody = body;
  walk.markerHead = head;
}

function syncWalkMarkerGeometry() {
  const walk = state.walkMode;
  if (!walk.markerBody || !walk.markerHead) return;

  const bodyHeight = Math.max(walk.eyeHeight * 0.72, walk.radius * 2.3);
  const headRadius = walk.radius * 0.72;

  if (walk.markerBody.geometry) walk.markerBody.geometry.dispose();
  walk.markerBody.geometry = new THREE.CylinderGeometry(walk.radius * 0.92, walk.radius * 1.04, bodyHeight, 16);
  walk.markerBody.position.y = bodyHeight * 0.5;

  if (walk.markerHead.geometry) walk.markerHead.geometry.dispose();
  walk.markerHead.geometry = new THREE.SphereGeometry(headRadius, 16, 14);
  walk.markerHead.position.y = bodyHeight + headRadius * 1.12;
}

function autoFitWalkCharacterToMesh() {
  if (!state.meshGeometry?.boundingBox) return;

  const walk = state.walkMode;
  const box = state.meshGeometry.boundingBox;
  const size = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  box.getSize(size);
  box.getBoundingSphere(sphere);

  const horizontal = Math.max(size.x, size.z);
  const baseRadius = Math.max(sphere.radius * 0.03, horizontal * 0.012);
  const targetRadius = THREE.MathUtils.clamp(baseRadius * thirdPersonScaleMultiplier, 0.9, 120);
  const targetEyeHeight = THREE.MathUtils.clamp(targetRadius * 2.95, 2.7, 350);

  walk.radius = targetRadius;
  walk.eyeHeight = targetEyeHeight;
  walk.jumpSpeed = THREE.MathUtils.clamp(targetEyeHeight * 2.65, 7.8, 650);
  walk.gravity = THREE.MathUtils.clamp(targetEyeHeight * 5.8, 18, 1800);

  syncWalkMarkerGeometry();
}

function isEditableElement(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!target.closest('input, textarea, select');
}

function onWalkKeyDown(event) {
  if (!state.walkMode.enabled) return;

  state.walkMode.keys[event.code] = true;
  if (event.code === 'KeyW' || event.code === 'Space' || event.code.startsWith('Arrow')) {
    event.preventDefault();
  }
}

function onWalkKeyUp(event) {
  state.walkMode.keys[event.code] = false;
}

function getWalkCollisionEntries() {
  return state.collisionEntry ? [state.collisionEntry] : [];
}

function getWalkSpawnPosition() {
  if (state.meshGeometry?.boundingBox) {
    const box = state.meshGeometry.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);
    return new THREE.Vector3(center.x, box.max.y + state.walkMode.eyeHeight * 0.55, center.z);
  }
  return new THREE.Vector3(0, state.walkMode.radius + state.walkMode.eyeHeight, 0);
}

function startWalkMode() {
  if (!state.meshGroup || !state.collisionEntry) {
    setStatus('Walk mode needs sidecar collision. This mesh has no sidecar.', 'warn');
    setResult(dom.walkResult, 'Walk mode cannot start: sidecar collision missing.', 'warn');
    return;
  }

  const walk = state.walkMode;
  walk.enabled = true;
  walk.keys = {};

  walk.position.copy(getWalkSpawnPosition());
  walk.velocity.set(0, 0, 0);
  walk.onGround = false;
  walk.lastHitDistance = Infinity;
  walk.collisionSourceUsed = 'sidecar';

  if (walk.marker) {
    walk.marker.visible = true;
    walk.marker.position.set(walk.position.x, walk.position.y - walk.radius, walk.position.z);
  }

  let meshRadius = 0;
  if (state.meshGeometry?.boundingBox) {
    const sphere = new THREE.Sphere();
    state.meshGeometry.boundingBox.getBoundingSphere(sphere);
    meshRadius = Math.max(0, sphere.radius || 0);
  }

  orbit.target.set(walk.position.x, walk.position.y + walk.eyeHeight * 0.45, walk.position.z);
  const cameraCeiling = Math.max(
    state.maxOrbitRadius || 500,
    meshRadius * 8,
    walk.eyeHeight * 14,
  );
  const desiredFarRadius = THREE.MathUtils.clamp(
    Math.max(
      orbit.radius,
      walk.eyeHeight * 7.5,
      meshRadius * 1.35,
      180,
    ),
    60,
    cameraCeiling,
  );
  orbit.radius = desiredFarRadius;
  orbit.phi = 1.04;
  updateCameraFromOrbit();

  updateWalkHud();
  setStatus('Walk mode started (sidecar collision). Use W/A/S/D (hold W to auto-jump).', 'info');
}

function stopWalkMode() {
  const walk = state.walkMode;
  if (!walk.enabled) {
    if (walk.marker) walk.marker.visible = false;
    return;
  }

  walk.enabled = false;
  walk.keys = {};
  walk.velocity.set(0, 0, 0);
  walk.onGround = false;
  if (walk.marker) walk.marker.visible = false;
  setResult(dom.walkResult, 'Walk mode is off.', 'info');
  updateHud();
  setStatus('Walk mode stopped.');
}

function resolveWalkSphereCollision(entry, position, radius, velocity) {
  if (!entry?.bvh) return { onGround: false, hitDistance: Infinity };

  let onGround = false;
  let hitDistance = Infinity;

  for (let i = 0; i < 4; i++) {
    walkHitTarget.point.set(0, 0, 0);
    walkHitTarget.distance = Infinity;
    walkHitTarget.faceIndex = -1;

    const hit = entry.bvh.closestPointToPoint(position, walkHitTarget, 0, radius + 0.35);
    if (!hit) break;
    hitDistance = Math.min(hitDistance, hit.distance);
    if (hit.distance >= radius) break;

    tmpPush.subVectors(position, hit.point);
    let len = tmpPush.length();
    if (len < 1e-6) {
      tmpPush.set(0, 1, 0);
      len = 1;
    }

    const penetration = radius - hit.distance + 0.001;
    tmpPush.multiplyScalar(penetration / len);
    position.add(tmpPush);

    if (tmpPush.y > Math.abs(tmpPush.x) * 0.35 && tmpPush.y > Math.abs(tmpPush.z) * 0.35) {
      onGround = true;
      if (velocity.y < 0) velocity.y = 0;
    }
  }

  return { onGround, hitDistance };
}

function resolveWalkAgainstEntries(entries, position, radius, velocity) {
  let onGround = false;
  let hitDistance = Infinity;

  for (const entry of entries) {
    const result = resolveWalkSphereCollision(entry, position, radius, velocity);
    onGround = onGround || result.onGround;
    hitDistance = Math.min(hitDistance, result.hitDistance);
  }

  return { onGround, hitDistance };
}

function sampleGroundHeight(entry, position) {
  if (!entry?.bvh) return null;

  const bbox = state.meshGeometry?.boundingBox;
  const maxDrop = bbox
    ? Math.max(1000, (bbox.max.y - bbox.min.y) + 3000)
    : 4000;

  walkGroundRay.origin.set(position.x, position.y + 3, position.z);
  walkGroundRay.direction.set(0, -1, 0);

  const hit = entry.bvh.raycastFirst(walkGroundRay, THREE.DoubleSide, 0, maxDrop);
  if (!hit || !hit.point || !Number.isFinite(hit.point.y)) return null;
  return hit.point.y;
}

function updateWalkMode(dt) {
  if (!state.walkMode.enabled || !state.walkMode.marker) return;

  const walk = state.walkMode;
  const keys = walk.keys;

  tmpForward.copy(camera.position).sub(orbit.target);
  tmpForward.y = 0;
  if (tmpForward.lengthSq() < 1e-8) {
    tmpForward.set(0, 0, 1);
  }
  tmpForward.normalize().negate();
  tmpRight.crossVectors(tmpForward, tmpUp).normalize();

  tmpMove.set(0, 0, 0);
  if (keys.KeyW) tmpMove.add(tmpForward);
  if (keys.KeyS) tmpMove.sub(tmpForward);
  if (keys.KeyD) tmpMove.add(tmpRight);
  if (keys.KeyA) tmpMove.sub(tmpRight);
  if (keys.ArrowUp) tmpMove.add(tmpForward);
  if (keys.ArrowDown) tmpMove.sub(tmpForward);
  if (keys.ArrowRight) tmpMove.add(tmpRight);
  if (keys.ArrowLeft) tmpMove.sub(tmpRight);

  if (tmpMove.lengthSq() > 1e-8) tmpMove.normalize();
  const runBoost = (keys.ShiftLeft || keys.ShiftRight) ? walk.runMultiplier : 1;
  const moveSpeed = walk.speed * runBoost;
  const collisionEntries = getWalkCollisionEntries();

  const horizontalDistance = moveSpeed * dt;
  const stepSpan = Math.max(0.12, walk.radius * 0.32);
  const horizontalSteps = tmpMove.lengthSq() > 1e-8
    ? Math.max(1, Math.min(12, Math.ceil(horizontalDistance / stepSpan)))
    : 1;

  if (tmpMove.lengthSq() > 1e-8) {
    const stepDistance = horizontalDistance / horizontalSteps;
    for (let i = 0; i < horizontalSteps; i++) {
      walk.position.addScaledVector(tmpMove, stepDistance);
      resolveWalkAgainstEntries(collisionEntries, walk.position, walk.radius, walk.velocity);
    }
  }

  if ((keys.KeyW || keys.Space) && walk.onGround) {
    walk.velocity.y = walk.jumpSpeed;
    walk.onGround = false;
  }

  walk.velocity.y -= walk.gravity * dt;
  walk.position.y += walk.velocity.y * dt;

  const collisionResult = resolveWalkAgainstEntries(collisionEntries, walk.position, walk.radius, walk.velocity);
  walk.onGround = collisionResult.onGround;
  walk.lastHitDistance = collisionResult.hitDistance;
  walk.collisionSourceUsed = 'sidecar';

  let meshGroundY = null;
  for (const entry of collisionEntries) {
    const y = sampleGroundHeight(entry, walk.position);
    if (y === null) continue;
    meshGroundY = meshGroundY === null ? y : Math.max(meshGroundY, y);
  }
  const planeGroundY = sampleGroundPlaneHeight(walk.position);
  let supportY = -Infinity;
  if (meshGroundY !== null) supportY = Math.max(supportY, meshGroundY);
  if (planeGroundY !== null) supportY = Math.max(supportY, planeGroundY);

  if (Number.isFinite(supportY)) {
    const desiredY = supportY + walk.radius + 0.02;
    if (walk.position.y <= desiredY + 0.18 && walk.velocity.y <= 0) {
      walk.position.y = desiredY;
      walk.velocity.y = 0;
      walk.onGround = true;
    }
  }

  const minYBase = Number.isFinite(state.ground?.y)
    ? state.ground.y
    : (state.meshGeometry?.boundingBox?.min.y ?? -Infinity);
  const minY = minYBase - 180;
  if (walk.position.y < minY) {
    walk.position.copy(getWalkSpawnPosition());
    walk.velocity.set(0, 0, 0);
  }

  walk.marker.position.set(walk.position.x, walk.position.y - walk.radius, walk.position.z);
  orbit.target.set(walk.position.x, walk.position.y + walk.eyeHeight * 0.45, walk.position.z);
  updateCameraFromOrbit();

  updateWalkHud();
}

function updateWalkHud() {
  const walk = state.walkMode;
  if (!dom.walkResult) return;

  if (!walk.enabled) {
    setResult(dom.walkResult, 'Walk mode is off.', 'info');
    return;
  }

  const lines = [
    'Walk mode: ON',
    `Source: ${walk.collisionSourceUsed}`,
    `On ground: ${walk.onGround ? 'YES' : 'NO'}`,
    `Avatar size: radius=${walk.radius.toFixed(2)} eye=${walk.eyeHeight.toFixed(2)}`,
    `Speed: ${walk.speed.toFixed(2)} (Shift x${walk.runMultiplier.toFixed(1)})`,
    `Nearest collision distance: ${Number.isFinite(walk.lastHitDistance) ? walk.lastHitDistance.toFixed(4) : 'INF'}`,
    `Position: (${walk.position.x.toFixed(2)}, ${walk.position.y.toFixed(2)}, ${walk.position.z.toFixed(2)})`,
    'Keys: W/A/S/D move, hold W for repeated jumps, Shift run',
    `Collision lines visible: ${dom.showCollision?.checked ? 'YES' : 'NO'} (visual only)`
  ];

  const severity = walk.collisionSourceUsed === 'none' ? 'warn' : 'pass';
  setResult(dom.walkResult, lines.join('\n'), severity);
}

function collectWorldPositionsFromGroup(group) {
  const positions = [];
  group.updateMatrixWorld(true);

  group.traverse((child) => {
    if (!child.isMesh || !child.geometry || !child.geometry.attributes?.position) return;

    const working = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    working.applyMatrix4(child.matrixWorld);

    const posArray = working.attributes.position.array;
    for (let i = 0; i < posArray.length; i++) positions.push(posArray[i]);

    working.dispose();
  });

  return positions;
}

function buildGeometryFromPositions(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  return geometry;
}

function extractSidecarTriangles(json) {
  const positions = [];
  const shells = Array.isArray(json?.shells) ? json.shells : [];

  for (const shell of shells) {
    const triangles = Array.isArray(shell?.triangles) ? shell.triangles : [];
    for (const tri of triangles) {
      if (!Array.isArray(tri) || tri.length < 9) continue;
      if (!Number.isFinite(tri[0]) || !Number.isFinite(tri[1]) || !Number.isFinite(tri[2])) continue;
      if (!Number.isFinite(tri[3]) || !Number.isFinite(tri[4]) || !Number.isFinite(tri[5])) continue;
      if (!Number.isFinite(tri[6]) || !Number.isFinite(tri[7]) || !Number.isFinite(tri[8])) continue;
      positions.push(
        tri[0], tri[1], tri[2],
        tri[3], tri[4], tri[5],
        tri[6], tri[7], tri[8],
      );
    }
  }

  return positions;
}

let cachedSidecarIndexDataPath = '';
let cachedSidecarPathByMeshKey = new Map();

async function getSidecarPathByMeshKey() {
  if (cachedSidecarIndexDataPath === state.dataPath) {
    return cachedSidecarPathByMeshKey;
  }

  cachedSidecarIndexDataPath = state.dataPath;
  cachedSidecarPathByMeshKey = new Map();

  try {
    const sidecarIndex = await fetchJson(`${state.dataPath}/mesh-collision-index.json`);
    if (Array.isArray(sidecarIndex?.entries)) {
      for (const entry of sidecarIndex.entries) {
        const meshName = normalizeMeshName(entry?.mesh);
        const sidecarRel = String(entry?.sidecar || '').trim().replace(/^\/+/, '');
        if (!meshName || !sidecarRel) continue;
        cachedSidecarPathByMeshKey.set(meshName.toLowerCase(), sidecarRel);
      }
    }
  } catch {
    // Fall back to direct per-mesh sidecar paths when no index is present.
  }

  return cachedSidecarPathByMeshKey;
}

async function loadSidecarPositions(meshName) {
  const normalizedMeshName = normalizeMeshName(meshName);
  const sidecarPathByMeshKey = await getSidecarPathByMeshKey();
  const indexedRelPath = sidecarPathByMeshKey.get(normalizedMeshName.toLowerCase());
  const directRelPath = `meshes/${normalizedMeshName}.collision.json`;
  const candidateRelPaths = indexedRelPath && indexedRelPath !== directRelPath
    ? [directRelPath, indexedRelPath]
    : [directRelPath];

  for (const relPath of candidateRelPaths) {
    try {
      const data = await fetchJson(`${state.dataPath}/${encodePathSegments(relPath)}`);
      const positions = extractSidecarTriangles(data);
      if (positions.length === 0) continue;
      return {
        positions,
        meta: data,
      };
    } catch {
      // Try the next known sidecar location.
    }
  }

  return null;
}

async function loadSingleMesh(meshName) {
  clearCurrentMesh();
  setStatus(`Loading ${meshName} ...`);

  const meshUrl = `${state.dataPath}/meshes/${encodeURIComponent(meshName)}`;

  try {
    const gltf = await new Promise((resolve, reject) => {
      gltfLoader.load(meshUrl, resolve, undefined, reject);
    });

    const group = gltf.scene;
    applyMeshMaterials(group, meshName);
    group.position.set(0, 0, 0);

    scene.add(group);

    state.meshGroup = group;
    state.meshName = meshName;

    const sidecar = await loadSidecarPositions(meshName);
    state.sidecarLocalPositions = sidecar?.positions || null;
    state.sidecarMeta = sidecar?.meta || null;

    stopWalkMode();

    rebuildPrecisionData();
    autoFitWalkCharacterToMesh();
    autoChooseSpeedLevelForMesh();
    frameCameraToCurrentMesh();
    if (autoStartWalkMode) {
      startWalkMode();
    }

    setStatus(`Loaded ${meshName}. Collision source: ${state.collisionSource}.`);
  } catch (err) {
    clearCurrentMesh();
    setStatus(`Failed to load mesh: ${err.message || err}`, 'error');
    setResult(dom.walkResult, `Failed to load mesh\n${err.message || err}`, 'fail');
  }
}

function rebuildPrecisionData() {
  if (!state.meshGroup) return;

  clearPrecisionData();

  const worldMeshPositions = collectWorldPositionsFromGroup(state.meshGroup);
  if (worldMeshPositions.length === 0) {
    setStatus('Loaded mesh has no renderable triangles.', 'warn');
    return;
  }

  state.meshGeometry = buildGeometryFromPositions(worldMeshPositions);
  state.meshEntry = {
    geometry: state.meshGeometry,
    bvh: new MeshBVH(state.meshGeometry, { maxLeafSize: 24 }),
  };

  if (state.sidecarLocalPositions && state.sidecarLocalPositions.length > 0) {
    state.collisionGeometry = buildGeometryFromPositions(state.sidecarLocalPositions);
    state.collisionGeometry.applyMatrix4(state.meshGroup.matrixWorld);
    state.collisionGeometry.computeBoundingBox();
    state.collisionSource = 'attached-sidecar';
  } else {
    state.collisionGeometry = null;
    state.collisionEntry = null;
    state.collisionSource = 'missing-sidecar';
    updateCollisionVisibility();
    rebuildGroundAroundMesh();
    clearMismatchMarkers();
    updateHud();
    updateWalkHud();
    setStatus('Sidecar collision not found for this mesh.', 'warn');
    return;
  }

  state.collisionEntry = {
    geometry: state.collisionGeometry,
    bvh: new MeshBVH(state.collisionGeometry, { maxLeafSize: 24 }),
  };

  const edgeGeometry = new THREE.EdgesGeometry(state.collisionGeometry, 20);
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x33dd66,
    transparent: false,
    opacity: 1.0,
    depthTest: true,
  });

  state.collisionLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  state.collisionLines.renderOrder = 2;
  scene.add(state.collisionLines);

  updateCollisionVisibility();
  rebuildGroundAroundMesh();
  clearMismatchMarkers();
  updateHud();
  updateWalkHud();
}

function frameCameraToCurrentMesh() {
  if (!state.meshGeometry?.boundingBox) return;

  const box = state.meshGeometry.boundingBox;
  const center = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  box.getCenter(center);
  box.getBoundingSphere(sphere);

  const radius = Math.max(0.001, sphere.radius);
  const aspect = Math.max(0.3, camera.aspect || 1);
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
  const fitDistV = radius / Math.sin(Math.max(0.01, vFov * 0.5));
  const fitDistH = radius / Math.sin(Math.max(0.01, hFov * 0.5));
  const fitDist = Math.max(fitDistV, fitDistH) * 1.2;

  orbit.target.copy(center);
  orbit.radius = Math.max(5, fitDist);
  state.maxOrbitRadius = Math.max(500, orbit.radius * 8);
  orbit.theta = 0.9;
  orbit.phi = 0.75;

  camera.near = Math.max(0.01, orbit.radius / 5000);
  camera.far = Math.max(5000, orbit.radius * 60, radius * 120);
  camera.updateProjectionMatrix();

  updateCameraFromOrbit();
}

function closestDistance(entry, point, maxThreshold = Infinity) {
  if (!entry?.bvh) return Infinity;
  const hit = entry.bvh.closestPointToPoint(point, {}, 0, maxThreshold);
  return hit ? hit.distance : Infinity;
}

function evaluateProbePoint(showStatus = true) {
  if (!state.meshEntry || !state.collisionEntry) {
    setResult(dom.probeResult, 'Load one mesh first.', 'warn');
    return null;
  }

  const probePoint = new THREE.Vector3(
    parseFloat(dom.probeX.value) || 0,
    parseFloat(dom.probeY.value) || 0,
    parseFloat(dom.probeZ.value) || 0,
  );

  probeMarker.position.copy(probePoint);

  const epsilon = Math.max(0.001, parseFloat(dom.probeEpsilon.value) || 0.12);
  const meshDistance = closestDistance(state.meshEntry, probePoint);
  const collisionDistance = closestDistance(state.collisionEntry, probePoint);

  const meshPresent = meshDistance <= epsilon;
  const collisionPresent = collisionDistance <= epsilon;
  const consistent = meshPresent === collisionPresent;

  const lines = [
    `Probe XYZ: (${probePoint.x.toFixed(3)}, ${probePoint.y.toFixed(3)}, ${probePoint.z.toFixed(3)})`,
    `Presence epsilon: ${epsilon.toFixed(3)}`,
    `Mesh distance: ${Number.isFinite(meshDistance) ? meshDistance.toFixed(5) : 'INF'}`,
    `Collision distance: ${Number.isFinite(collisionDistance) ? collisionDistance.toFixed(5) : 'INF'}`,
    `Mesh present: ${meshPresent ? 'YES' : 'NO'}`,
    `Collision present: ${collisionPresent ? 'YES' : 'NO'}`,
    consistent ? 'Result: CONSISTENT' : 'Result: MISMATCH',
  ];

  setResult(dom.probeResult, lines.join('\n'), consistent ? 'pass' : 'fail');

  if (showStatus) {
    setStatus(
      consistent
        ? 'Probe check passed: mesh and collision agree at this XYZ.'
        : 'Probe mismatch: mesh and collision disagree at this XYZ.',
      consistent ? 'info' : 'warn',
    );
  }

  return {
    meshDistance,
    collisionDistance,
    meshPresent,
    collisionPresent,
    consistent,
  };
}

async function runSweepScan() {
  if (!state.meshEntry || !state.collisionEntry) {
    setResult(dom.scanResult, 'Load one mesh first.', 'warn');
    return;
  }

  if (dom.runScan) dom.runScan.disabled = true;

  try {
    const epsilon = Math.max(0.001, parseFloat(dom.probeEpsilon.value) || 0.12);
    const step = Math.max(0.05, parseFloat(dom.scanStep.value) || 0.6);
    const margin = Math.max(0, parseFloat(dom.scanMargin.value) || 1.2);
    const band = Math.max(epsilon, parseFloat(dom.surfaceBand.value) || 0.7);

    const bounds = state.meshGeometry.boundingBox.clone();
    bounds.union(state.collisionGeometry.boundingBox);
    bounds.expandByScalar(margin);

    const nx = Math.max(1, Math.floor((bounds.max.x - bounds.min.x) / step) + 1);
    const ny = Math.max(1, Math.floor((bounds.max.y - bounds.min.y) / step) + 1);
    const nz = Math.max(1, Math.floor((bounds.max.z - bounds.min.z) / step) + 1);

    const totalSamples = nx * ny * nz;
    if (totalSamples > 650000) {
      setResult(
        dom.scanResult,
        `Sweep too dense (${totalSamples} points). Increase step or reduce margin.`,
        'warn',
      );
      setStatus('Sweep aborted: too many sample points.', 'warn');
      return;
    }

    let considered = 0;
    let falsePositive = 0;
    let falseNegative = 0;

    const maxMarkerPoints = 8000;
    const fpPositions = [];
    const fnPositions = [];

    const point = new THREE.Vector3();

    setStatus(`Running sweep scan (${totalSamples} grid points) ...`);

    for (let ix = 0; ix < nx; ix++) {
      const x = bounds.min.x + ix * step;
      for (let iy = 0; iy < ny; iy++) {
        const y = bounds.min.y + iy * step;
        for (let iz = 0; iz < nz; iz++) {
          const z = bounds.min.z + iz * step;
          point.set(x, y, z);

          const meshDistance = closestDistance(state.meshEntry, point);
          const collisionDistance = closestDistance(state.collisionEntry, point);

          // Focus the scan near surfaces. Empty volume far away is not meaningful.
          if (meshDistance > band && collisionDistance > band) continue;

          considered++;
          const meshPresent = meshDistance <= epsilon;
          const collisionPresent = collisionDistance <= epsilon;

          if (meshPresent === collisionPresent) continue;

          if (collisionPresent && !meshPresent) {
            falsePositive++;
            if (fpPositions.length / 3 < maxMarkerPoints) fpPositions.push(x, y, z);
          } else if (meshPresent && !collisionPresent) {
            falseNegative++;
            if (fnPositions.length / 3 < maxMarkerPoints) fnPositions.push(x, y, z);
          }
        }
      }

      if (ix % Math.max(1, Math.floor(nx / 24)) === 0) {
        const pct = Math.round((ix / Math.max(1, nx - 1)) * 100);
        setStatus(`Sweep scan running: ${pct}%`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    showMismatchMarkers(fpPositions, fnPositions);

    const consistent = falsePositive === 0 && falseNegative === 0;
    const lines = [
      `Grid dimensions: ${nx} x ${ny} x ${nz}`,
      `Total sampled points: ${totalSamples}`,
      `Surface-band points checked: ${considered}`,
      `False positives (collision only): ${falsePositive}`,
      `False negatives (mesh only): ${falseNegative}`,
      consistent
        ? 'PASS: no collision where mesh is absent, and no mesh where collision is absent.'
        : 'FAIL: mismatch points detected (see markers in viewport).',
      `Marker limit per class: ${maxMarkerPoints}`,
    ];

    setResult(dom.scanResult, lines.join('\n'), consistent ? 'pass' : 'fail');
    setStatus(
      consistent
        ? 'Sweep passed with zero mismatches in sampled surface band.'
        : 'Sweep found mismatch points. Tune collision or inspect marker clusters.',
      consistent ? 'info' : 'warn',
    );
  } finally {
    if (dom.runScan) dom.runScan.disabled = false;
  }
}

function createPointCloud(positions, color) {
  if (!positions || positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color,
    size: 0.21,
    sizeAttenuation: true,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = 4;
  return points;
}

function clearMismatchMarkers() {
  if (state.falsePositivePoints) {
    scene.remove(state.falsePositivePoints);
    state.falsePositivePoints.geometry.dispose();
    state.falsePositivePoints.material.dispose();
    state.falsePositivePoints = null;
  }

  if (state.falseNegativePoints) {
    scene.remove(state.falseNegativePoints);
    state.falseNegativePoints.geometry.dispose();
    state.falseNegativePoints.material.dispose();
    state.falseNegativePoints = null;
  }
}

function showMismatchMarkers(falsePositivePositions, falseNegativePositions) {
  clearMismatchMarkers();

  state.falsePositivePoints = createPointCloud(falsePositivePositions, 0xff5555);
  state.falseNegativePoints = createPointCloud(falseNegativePositions, 0x4ea1ff);

  if (state.falsePositivePoints) scene.add(state.falsePositivePoints);
  if (state.falseNegativePoints) scene.add(state.falseNegativePoints);
  updateCollisionVisibility();
}

function updateHud() {
  const meshName = state.meshName || 'none';

  const meshTris = state.meshGeometry
    ? Math.floor(state.meshGeometry.attributes.position.count / 3)
    : 0;

  const collisionTris = state.collisionGeometry
    ? Math.floor(state.collisionGeometry.attributes.position.count / 3)
    : 0;

  const meshPos = state.meshGroup
    ? `(${state.meshGroup.position.x.toFixed(3)}, ${state.meshGroup.position.y.toFixed(3)}, ${state.meshGroup.position.z.toFixed(3)})`
    : '(0, 0, 0)';

  const walkModeText = state.walkMode.enabled ? 'ON' : 'OFF';
  const walkSource = 'collision';

  dom.hud.textContent = [
    `Mesh: ${meshName}`,
    `Collision source: ${state.collisionSource}`,
    `Texture preview: ${dom.showTextures?.checked ? 'ON' : 'OFF'}`,
    `Collision overlay: ${dom.showCollision?.checked ? 'ON' : 'OFF'}`,
    `Walk mode: ${walkModeText} (source=${walkSource})`,
    `Mesh triangles: ${meshTris}`,
    `Collision triangles: ${collisionTris}`,
    `Mesh XYZ: ${meshPos}`,
    'Shift + drag: pan target',
    'Drag: orbit, wheel: zoom',
    'Markers: red=collision-only, blue=mesh-only',
  ].join('\n');
}
