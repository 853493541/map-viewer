/**
 * JX3 Map Editor - Main Application
 * Features: resource manager, terrain rendering, entity placement, minimap,
 * mesh browser, verdicts-based visibility, mesh selection/transform,
 * region/arena tool, drag-select, copy/duplicate, map locking
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { TerrainSystem } from './terrain.js';
import { EntitySystem } from './entities.js';
import { CollisionSystem } from './collision.js';
import { PlayerController } from './player-controller.js';

class MapEditor {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      logarithmicDepthBuffer: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 50, 500000);

    this.clock = new THREE.Clock();
    this.frameCount = 0;
    this.fpsTime = 0;
    this.fps = 0;
    this.lodUpdateAccum = 0;

    this.config = null;
    this.environment = null;
    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.playerController = null;
    this.meshPanelVisible = false;
    this.raycaster = null;
    this.selectedEntry = null;

    // Manager state
    this.state = 'manager'; // 'manager' | 'editor'
    this.currentMapPath = null;
    this.isOriginalMap = false; // locked if true
    this.customMaps = []; // saved custom maps

    // Multi-select
    this.multiSelection = []; // array of { entry, instanceId }
    this.isDragSelecting = false;
    this.dragStart = null;

    // Edit mode: 'camera' or 'select'
    this._editMode = 'camera';

    window.addEventListener('resize', () => this.onResize());
  }

  // ─── Resource Manager ─────────────────────────────
  async init() {
    this.loadCustomMapList();
    this.populateManager();
  }

  loadCustomMapList() {
    try {
      const stored = localStorage.getItem('jx3-custom-maps');
      this.customMaps = stored ? JSON.parse(stored) : [];
    } catch { this.customMaps = []; }
  }

  saveCustomMapList() {
    localStorage.setItem('jx3-custom-maps', JSON.stringify(this.customMaps));
  }

  populateManager() {
    this.state = 'manager';
    document.getElementById('resource-manager').style.display = 'flex';
    document.getElementById('canvas').style.display = 'none';
    document.getElementById('exit-to-manager').style.display = 'none';
    document.getElementById('lock-indicator').style.display = 'none';
    document.getElementById('ui-overlay').style.display = 'none';
    document.getElementById('controls-help').style.display = 'none';
    document.getElementById('minimap-container').style.display = 'none';
    document.getElementById('mesh-panel').classList.remove('visible');
    document.getElementById('mesh-panel').style.display = 'none';
    document.getElementById('transform-panel').classList.remove('visible');

    const grid = document.getElementById('map-grid');
    grid.innerHTML = '';

    // Original map card
    const card = document.createElement('div');
    card.className = 'map-card';
    card.innerHTML = `
      <div class="map-thumb"><img src="map-data/minimap.png" onerror="this.style.display='none';this.parentElement.textContent='🗺️'"></div>
      <div class="map-name">龙门寻宝</div>
      <div class="map-meta">8×8 regions · ~4,964 entities · 597 meshes</div>
      <span class="map-badge original">ORIGINAL</span>
    `;
    card.addEventListener('click', () => this.loadMap('map-data', true));
    grid.appendChild(card);

    // Custom maps section
    const customSection = document.getElementById('custom-maps-section');
    const customGrid = document.getElementById('custom-map-grid');
    customGrid.innerHTML = '';

    if (this.customMaps.length > 0) {
      customSection.style.display = 'block';
      for (let idx = 0; idx < this.customMaps.length; idx++) {
        const cm = this.customMaps[idx];
        const ccard = document.createElement('div');
        ccard.className = 'map-card';
        ccard.innerHTML = `
          <button class="map-delete" title="Delete this map">✕</button>
          <div class="map-thumb" style="font-size:40px;color:#a64">🏟️</div>
          <div class="map-name">${this._escapeHtml(cm.name)}</div>
          <div class="map-meta">${cm.entityCount} entities · ${new Date(cm.created).toLocaleDateString()}</div>
          <span class="map-badge custom">CUSTOM</span>
        `;
        ccard.querySelector('.map-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteCustomMap(idx);
        });
        ccard.addEventListener('click', () => this.loadCustomMap(cm));
        customGrid.appendChild(ccard);
      }
    } else {
      customSection.style.display = 'none';
    }
  }

  deleteCustomMap(idx) {
    const name = this.customMaps[idx]?.name || 'map';
    if (!confirm(`Delete custom map "${name}"? This cannot be undone.`)) return;
    this.customMaps.splice(idx, 1);
    this.saveCustomMapList();
    // Also remove stored entity data
    try { localStorage.removeItem('jx3-map-entities-' + name); } catch {}
    this.populateManager();
    this.showToast(`Deleted: ${name}`);
  }

  async loadMap(dataPath, isOriginal = false, regionFilter = null) {    this.state = 'editor';
    this.currentMapPath = dataPath;
    this.isOriginalMap = isOriginal;

    // Switch to editor view
    document.getElementById('resource-manager').style.display = 'none';
    document.getElementById('canvas').style.display = 'block';
    document.getElementById('loading').style.display = 'flex';

    this.updateLoading('Loading configuration...', 5);
    this.config = await this.loadJSON(`${dataPath}/map-config.json`);
    this.environment = await this.loadJSON(`${dataPath}/environment.json`);

    document.getElementById('loading-title').textContent = `JX3 Map Editor — ${this.config.name || dataPath}`;

    this.updateLoading('Setting up environment...', 10);
    this.setupSky();
    this.setupLighting();

    // Terrain
    this.updateLoading('Loading terrain...', 15);
    this.terrainSystem = new TerrainSystem(this.scene, this.config, dataPath);
    await this.terrainSystem.load((p) => {
      this.updateLoading(`Loading terrain: ${Math.round(p * 100)}%`, 15 + p * 40);
    });

    this.collisionSystem = new CollisionSystem(this.terrainSystem);

    // Entities
    this.updateLoading('Loading scene objects...', 58);
    this.entitySystem = new EntitySystem(this.scene, dataPath);
    // Pre-set region filter so only in-region entities are loaded (for custom maps)
    if (regionFilter) this.entitySystem.regionFilter = regionFilter;
    await this.entitySystem.load((p) => {
      this.updateLoading(`Loading objects: ${Math.round(p * 100)}%`, 58 + p * 30);
    });
    this.collisionSystem.setEntityMeshes(this.entitySystem.getCollisionMeshes());

    // Load resource inventory for panel
    try {
      this.resourceInventory = await this.loadJSON(`${dataPath}/resource-inventory.json`);
    } catch { this.resourceInventory = null; }

    // Load texture missing map for panel
    try {
      this.textureMissingMap = await this.loadJSON(`${dataPath}/texture-missing-map.json`);
    } catch { this.textureMissingMap = null; }

    // Player
    this.updateLoading('Initializing...', 92);
    const sp = this.getStartPosition();
    this.playerController = new PlayerController(this.camera, this.canvas, this.collisionSystem);
    this.playerController.setPosition(sp.x, sp.y, sp.z);
    this.playerController.loadSavedState(); // restore camera from last session
    this.entitySystem.updateLOD(this.camera.position);

    // Minimap
    this.setupMinimap();
    // Mesh panel
    this.setupMeshPanel();
    // Keyboard shortcuts
    this.setupShortcuts();
    // Selection & transform
    this.setupSelection();
    this.setupTransformPanel();
    // Region dialog (R key)
    this.setupRegionDialog();
    // Save dialog (Ctrl+S)
    this.setupSaveDialog();
    // Drag-select
    this.setupDragSelect();
    // Region draw on map (3D drag)
    this._regionDrawMode = false;
    this._pendingRegion = null;
    this._setupRegionDrag();
    this._setupPenMode();
    this._setupRegionActionBar();

    // Save Changes button (custom maps) — wire once
    const scBtn = document.getElementById('save-changes-btn');
    if (scBtn && !scBtn._wired) {
      scBtn._wired = true;
      scBtn.addEventListener('click', () => this.openSaveDialog());
    }

    // Mode bar (Camera / Select)
    this._setupModeBar();

    // Show UI
    document.getElementById('loading').style.display = 'none';
    document.getElementById('ui-overlay').style.display = 'block';
    document.getElementById('controls-help').style.display = 'block';
    document.getElementById('minimap-container').style.display = 'block';
    document.getElementById('exit-to-manager').style.display = 'block';

    // Lock indicator for original maps
    if (this.isOriginalMap) {
      document.getElementById('lock-indicator').style.display = 'block';
    } else {
      document.getElementById('lock-indicator').style.display = 'none';
    }

    // Exit button
    document.getElementById('exit-to-manager').onclick = () => this.exitToManager();

    this.animate();
  }

  /** Load a custom map (saved arena) — reuses the terrain from original map */
  async loadCustomMap(cm) {
    // Pass region filter to loadMap so only in-region entities are created in the scene
    await this.loadMap('map-data', false, cm.region || null);
    this._currentCustomMap = cm; // track for save-changes

    // Restore saved entity data if available
    try {
      const stored = localStorage.getItem('jx3-map-entities-' + cm.name);
      if (stored) {
        const savedEntities = JSON.parse(stored);
        if (savedEntities?.length) {
          this._restoreSavedEntities(savedEntities);
          this.showToast(`Restored ${savedEntities.length} saved entities`);
        }
      }
    } catch (e) {
      console.warn('Could not restore saved entities:', e);
    }

    // Apply region filter
    if (cm.region) {
      // entitySystem.regionFilter is already set by loadMap; also apply terrain clip
      if (this.terrainSystem) this.terrainSystem.setRegionClip(cm.region);
      // Set the region dialog fields to match
      document.getElementById('rd-min-x').value = cm.region.minX;
      document.getElementById('rd-max-x').value = cm.region.maxX;
      document.getElementById('rd-min-z').value = cm.region.minZ;
      document.getElementById('rd-max-z').value = cm.region.maxZ;
      this._updateRegionPreviewFromDialog();
    }
    // Show "Save Changes" button for custom maps
    const scBtn = document.getElementById('save-changes-btn');
    if (scBtn) scBtn.style.display = 'block';
    this.showToast(`Loaded: ${cm.name} — Press R to edit region bounds`);
  }

  /** Restore entity transforms from saved data, replacing the loaded state */
  _restoreSavedEntities(savedEntities) {
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    const mat4 = new THREE.Matrix4();

    // Zero out all existing instances
    for (const entry of this.entitySystem.instancedMeshes) {
      const subs = entry.subMeshes || [entry.mesh];
      for (const m of subs) {
        for (let i = 0; i < m.count; i++) m.setMatrixAt(i, zeroMat);
        m.instanceMatrix.needsUpdate = true;
      }
    }

    // Group saved entities by glbName
    const byGlb = new Map();
    for (const e of savedEntities) {
      const key = e.mesh?.toLowerCase();
      if (!key) continue;
      if (!byGlb.has(key)) byGlb.set(key, []);
      byGlb.get(key).push(e);
    }

    // Restore each GLB group
    for (const [glbName, entities] of byGlb) {
      const matchingEntries = this.entitySystem.instancedMeshes.filter(e => e.glbName === glbName);
      if (!matchingEntries.length) continue;

      const entry = matchingEntries[0];
      const subs = entry.subMeshes || [entry.mesh];
      const capacity = subs[0].count;

      // Grow if needed
      if (entities.length > capacity) {
        this._growInstancedMeshEntry(entry, entities.length - capacity);
      }

      const newSubs = entry.subMeshes || [entry.mesh];
      for (let i = 0; i < entities.length; i++) {
        const m = entities[i].matrix;
        // Convert LH→RH: negate Z (element 14)
        const rhMat = [...m];
        rhMat[14] = -rhMat[14];
        mat4.fromArray(rhMat);
        for (const sub of newSubs) {
          sub.setMatrixAt(i, mat4);
          sub.instanceMatrix.needsUpdate = true;
        }
      }

      // Zero out remaining slots
      for (let i = entities.length; i < newSubs[0].count; i++) {
        for (const sub of newSubs) {
          sub.setMatrixAt(i, zeroMat);
          sub.instanceMatrix.needsUpdate = true;
        }
      }

      entry.totalCount = entities.length;
    }
  }

  /** Exit editor back to resource manager */
  exitToManager() {
    // Stop animation
    this._stopAnimation = true;

    // Clean up 3D region box and pen
    this._remove3DRegionBox();
    this._clearPenVisuals();
    this._clearMultiHighlights();
    this._hideRegionActionBar();
    this._hideDrawHint();
    this._penMode = false;
    this._regionDrawMode = false;
    this._currentCustomMap = null;
    const scBtn = document.getElementById('save-changes-btn');
    if (scBtn) scBtn.style.display = 'none';

    // Clean up scene
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0]);
    }
    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    if (this.playerController) {
      this.playerController = null;
    }
    this.selectedEntry = null;
    this.multiSelection = [];
    this.selectionHighlight = null;
    this.config = null;

    // Reset UI
    document.getElementById('mode-bar').classList.remove('visible');
    this.populateManager();
  }

  // ─── Sky ──────────────────────────────────────────
  setupSky() {
    // Gradient sky dome - smaller radius, centered on camera each frame
    const skyGeo = new THREE.SphereGeometry(200000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4488cc) },
        bottomColor: { value: new THREE.Color(0xd4c5a0) },
        horizonColor: { value: new THREE.Color(0xc8b888) },
        exponent: { value: 0.5 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform vec3 horizonColor;
        uniform float exponent;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          float t = max(pow(max(h, 0.0), exponent), 0.0);
          vec3 col = mix(horizonColor, topColor, t);
          if (h < 0.0) col = mix(horizonColor, bottomColor, min(-h * 3.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Fog matching horizon
    this.scene.fog = new THREE.FogExp2(0xc8b888, 0.0000035);
  }

  // ─── Lighting ─────────────────────────────────────
  setupLighting() {
    const env = this.environment;

    if (env?.sunlight) {
      const s = env.sunlight;
      const dir = new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]).normalize();
      const col = new THREE.Color(s.diffuse[0], s.diffuse[1], s.diffuse[2]);

      // Main sunlight with shadows
      const sun = new THREE.DirectionalLight(col, 3.0);
      sun.position.copy(dir.clone().multiplyScalar(100000));
      sun.castShadow = true;

      // Shadow configuration for large terrain
      sun.shadow.mapSize.width = 2048;
      sun.shadow.mapSize.height = 2048;
      sun.shadow.camera.near = 100;
      sun.shadow.camera.far = 200000;
      sun.shadow.camera.left = -50000;
      sun.shadow.camera.right = 50000;
      sun.shadow.camera.top = 50000;
      sun.shadow.camera.bottom = -50000;
      sun.shadow.bias = -0.001;
      sun.shadow.normalBias = 200;
      this.sunLight = sun;
      this.scene.add(sun);

      // Ambient fill using environment data
      const ambCol = s.ambientColor
        ? new THREE.Color(s.ambientColor[0], s.ambientColor[1], s.ambientColor[2])
        : new THREE.Color(0x666655);
      this.scene.add(new THREE.AmbientLight(ambCol, 0.8));

      // Hemisphere sky/ground for natural environmental fill
      const skyCol = s.skyLightColor
        ? new THREE.Color(s.skyLightColor[0] * 0.8, s.skyLightColor[1] * 0.9, s.skyLightColor[2] * 1.2)
        : new THREE.Color(0x88aacc);
      const hemi = new THREE.HemisphereLight(skyCol, 0x8B7355, 1.0);
      this.scene.add(hemi);
    } else {
      this.scene.add(new THREE.AmbientLight(0x888888, 0.6));
      this.scene.add(new THREE.HemisphereLight(0x87CEEB, 0x8B7355, 0.4));
    }
  }

  // ─── Minimap ──────────────────────────────────────
  setupMinimap() {
    const mmCanvas = document.getElementById('minimap');
    const ctx = mmCanvas.getContext('2d');

    // Compute playable inner 4×4 region bounds (regions 2-5 out of 8×8 grid)
    // The minimap image covers only this inner area; outer regions are non-playable
    const cfg = this.config.landscape;
    const regionWorldSize = cfg.regionSize * cfg.unitScaleX;
    const innerStartX = cfg.worldOriginX + 2 * regionWorldSize;
    const innerEndX   = cfg.worldOriginX + 6 * regionWorldSize;
    const innerStartZ_lh = cfg.worldOriginY + 2 * regionWorldSize;
    const innerEndZ_lh   = cfg.worldOriginY + 6 * regionWorldSize;
    // RH: negate Z
    this._innerBounds = {
      minX: innerStartX,
      maxX: innerEndX,
      minZ: -innerEndZ_lh,
      maxZ: -innerStartZ_lh,
    };

    // The minimap container includes gray border for outer regions
    // Image occupies the center 50% (4/8) of each axis
    const mmSize = 256;
    const innerFrac = 4 / 8; // 4×4 out of 8×8
    const borderFrac = (1 - innerFrac) / 2; // 0.25 on each side

    // Try to load minimap.png (from game's RegionInfo/RLSplit.bmp, the real in-game minimap)
    const regionImg = new Image();
    regionImg.onload = () => {
      mmCanvas.width = mmSize;
      mmCanvas.height = mmSize;
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, mmSize, mmSize);
      const innerPx = Math.round(mmSize * innerFrac);
      const borderPx = Math.round(mmSize * borderFrac);
      ctx.drawImage(regionImg, borderPx, borderPx, innerPx, innerPx);
      this._mmReady = true;
    };
    regionImg.onerror = () => {
      // Fallback to regioninfo.png then heightmap
      const fallback = new Image();
      fallback.onload = () => {
        mmCanvas.width = mmSize; mmCanvas.height = mmSize;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, mmSize, mmSize);
        const innerPx = Math.round(mmSize * innerFrac);
        const borderPx = Math.round(mmSize * borderFrac);
        ctx.drawImage(fallback, borderPx, borderPx, innerPx, innerPx);
        this._mmReady = true;
      };
      fallback.onerror = () => this._buildHeightmapMinimap(mmCanvas, ctx);
      fallback.src = `${this.currentMapPath}/regioninfo.png`;
    };
    regionImg.src = `${this.currentMapPath}/minimap.png`;

    // Click to teleport — uses FULL map bounds, so clicking gray area teleports to outer regions
    const container = document.getElementById('minimap-container');
    container.addEventListener('click', (e) => {
      const rect = mmCanvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const bounds = this.terrainSystem.getWorldBounds();
      const wx = bounds.minX + mx * (bounds.maxX - bounds.minX);
      const wz = bounds.maxZ - my * (bounds.maxZ - bounds.minZ);
      let wy = 5000;
      const th = this.terrainSystem.getHeightAt(wx, wz);
      if (th !== null) wy = th + 2000;
      this.playerController.teleport(wx, wy, wz);
    });

    this._mmCanvas = mmCanvas;
    this._mmBounds = this.terrainSystem.getWorldBounds();
    this._mmReady = false;
    this._mmMode = 'region'; // 'region', 'editor', or 'height'
    this._mmSize = mmSize;
    this._mmInnerFrac = innerFrac;
    this._mmBorderFrac = borderFrac;

    // Toggle button cycles: region → editor → height → region
    const modes = ['region', 'editor', 'height'];
    const modeLabels = { region: 'Region zones', editor: 'Editor minimap', height: 'Heightmap' };
    const toggle = document.getElementById('minimap-toggle');
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = modes.indexOf(this._mmMode);
        this._mmMode = modes[(idx + 1) % modes.length];
        this._drawMinimapMode(mmCanvas);
        this.showToast(`Minimap: ${modeLabels[this._mmMode]}`);
      });
    }
  }

  _drawMinimapMode(canvas) {
    const ctx = canvas.getContext('2d');
    const sz = this._mmSize;
    const innerFrac = this._mmInnerFrac;
    const borderFrac = this._mmBorderFrac;
    if (this._mmMode === 'height') {
      this._buildHeightmapMinimap(canvas, ctx);
    } else if (this._mmMode === 'editor') {
      // Editor minimap (RLSplit.bmp) also covers the inner 4×4 playable area
      const img = new Image();
      img.onload = () => {
        canvas.width = sz; canvas.height = sz;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, sz, sz);
        const innerPx = Math.round(sz * innerFrac);
        const borderPx = Math.round(sz * borderFrac);
        ctx.drawImage(img, borderPx, borderPx, innerPx, innerPx);
      };
      img.src = `${this.currentMapPath}/editor-minimap.png`;
    } else {
      // Region mode: image in center, gray border for outer regions
      const img = new Image();
      img.onload = () => {
        canvas.width = sz; canvas.height = sz;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, sz, sz);
        const innerPx = Math.round(sz * innerFrac);
        const borderPx = Math.round(sz * borderFrac);
        ctx.drawImage(img, borderPx, borderPx, innerPx, innerPx);
      };
      img.src = `${this.currentMapPath}/minimap.png`;
    }
  }

  _buildHeightmapMinimap(canvas, ctx) {
    const mmData = this.terrainSystem.minimapData;
    if (!mmData) return;
    const { data, width, height } = mmData;
    canvas.width = width;
    canvas.height = height;
    const img = ctx.createImageData(width, height);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < data.length; i++) {
      minH = Math.min(minH, data[i]);
      maxH = Math.max(maxH, data[i]);
    }
    const range = maxH - minH || 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * width + x] - minH) / range;
        const idx = (y * width + x) * 4;
        img.data[idx] = Math.floor(80 + v * 140);
        img.data[idx + 1] = Math.floor(70 + v * 110);
        img.data[idx + 2] = Math.floor(40 + v * 60);
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this._mmReady = true;
  }

  updateMinimap() {
    if (!this._mmBounds || !this._mmReady) return;
    const b = this._mmBounds;
    const pos = this.camera.position;
    const nx = Math.max(0, Math.min(1, (pos.x - b.minX) / (b.maxX - b.minX)));
    const nz = Math.max(0, Math.min(1, (pos.z - b.minZ) / (b.maxZ - b.minZ)));
    const marker = document.getElementById('minimap-marker');
    marker.style.left = `${nx * 100}%`;
    marker.style.top = `${nz * 100}%`;  // RH Z: no inversion needed (negation already flipped)

    const fov = document.getElementById('minimap-fov');
    const deg = (-this.playerController.yaw * 180 / Math.PI);
    fov.style.left = `${nx * 100}%`;
    fov.style.top = `${nz * 100}%`;  // RH Z: no inversion needed
    fov.style.transform = `translate(-50%, -100%) rotate(${deg + 180}deg)`;
  }

  // ─── Mesh Panel ───────────────────────────────────
  setupMeshPanel() {
    const panel = document.getElementById('mesh-panel');
    const closeBtn = document.getElementById('mesh-panel-close');
    closeBtn.addEventListener('click', () => this.toggleMeshPanel(false));

    // Tab switching
    panel.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        panel.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        if (tab.dataset.tab === 'keyword') this.populateKeywordTab();
        if (tab.dataset.tab === 'tex-missing') this.populateTextureMissingTab();
        if (tab.dataset.tab === 'verdicts') this.populateVerdictsTab();
        if (tab.dataset.tab === 'region') this.populateRegionTab();
      });
    });

    // Search
    document.getElementById('mesh-search').addEventListener('input', (e) => {
      this.filterMeshList(e.target.value.toLowerCase());
    });

    // Sort mode toggle (only applies to loaded/missing tabs)
    this._meshSortMode = 'count'; // 'count' or 'folder'
    const sortBtn = document.getElementById('mesh-sort-toggle');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        this._meshSortMode = this._meshSortMode === 'count' ? 'folder' : 'count';
        sortBtn.textContent = this._meshSortMode === 'count' ? '📊 By Count' : '📁 By Folder';
        this.populateMeshPanel();
      });
    }

    // Format filter
    this._meshFormatFilter = 'mesh';
    document.querySelectorAll('input[name="fmt-filter"]').forEach(radio => {
      radio.addEventListener('change', () => {
        this._meshFormatFilter = radio.value;
        this.populateMeshPanel();
      });
    });

    this.populateResourceOverview();
    this.populateMeshPanel();
    this.populateTextureMissingTab();
  }

  // ─── Resource Overview ─────────────────────────────
  populateResourceOverview() {
    const el = document.getElementById('tab-overview');
    el.innerHTML = '';

    const inv = this.resourceInventory;
    if (!inv) {
      el.innerHTML = '<div style="padding:16px;color:#888;text-align:center">Resource inventory not available</div>';
      return;
    }

    // Helper to create a row
    const row = (key, val, cls = 'info') => {
      const d = document.createElement('div');
      d.className = 'res-row';
      d.innerHTML = `<span class="key">${key}</span><span class="val ${cls}">${val}</span>`;
      return d;
    };

    // Progress bar
    const bar = (current, total, color = '#6a4') => {
      const d = document.createElement('div');
      d.className = 'res-bar';
      const pct = total > 0 ? Math.round(current / total * 100) : 0;
      d.innerHTML = `<div class="fill" style="width:${pct}%;background:${color}"></div>`;
      return d;
    };

    // Note text
    const note = (text) => {
      const d = document.createElement('div');
      d.className = 'res-note';
      d.textContent = text;
      return d;
    };

    const cats = inv.categories;

    // ── Meshes ──
    if (cats.meshes) {
      const c = cats.meshes;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      const mapped = c.items.mapped_to_scene;
      const total = c.items.scene_references;
      sect.appendChild(row('Scene mesh types', `${mapped}/${total} mapped`, mapped === total ? 'good' : 'warn'));
      sect.appendChild(bar(mapped, total, mapped === total ? '#6a4' : '#ca6'));
      sect.appendChild(row('Converted GLBs', c.items.converted_glb, 'info'));
      sect.appendChild(row('Official meshes', c.items.official_meshes, 'good'));
      sect.appendChild(row('Missing (.srt trees)', c.items.missing_srt, c.items.missing_srt > 0 ? 'warn' : 'good'));
      sect.appendChild(row('Source .mesh files', c.source_files.mesh, 'info'));
      sect.appendChild(row('Source .JsonInspack', c.source_files.jsoninspack, 'info'));
      sect.appendChild(row('Source .mtl', c.source_files.mtl, 'info'));
      el.appendChild(sect);
    }

    // ── Terrain ──
    if (cats.terrain) {
      const c = cats.terrain;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      sect.appendChild(row('Heightmaps', `${c.items.heightmaps}/${c.items.total_regions}`, c.items.heightmaps === c.items.total_regions ? 'good' : 'warn'));
      sect.appendChild(bar(c.items.heightmaps, c.items.total_regions));
      sect.appendChild(row('Color textures', `${c.items.terrain_textures_color}/${c.items.total_regions}`, c.items.terrain_textures_color === c.items.total_regions ? 'good' : 'warn'));
      sect.appendChild(bar(c.items.terrain_textures_color, c.items.total_regions));
      sect.appendChild(row('Detail textures', `${c.items.terrain_textures_detail}/${c.items.total_regions}`, 'info'));
      sect.appendChild(row('Source procedural DDS', c.source_files.procedural_dds, 'info'));
      sect.appendChild(row('Source blendmap DDS', c.source_files.blendmap_dds, 'info'));
      el.appendChild(sect);
    }

    // ── Scene Objects ──
    if (cats.entities) {
      const c = cats.entities;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      sect.appendChild(row('Total placements', c.items.total_placements, 'info'));
      sect.appendChild(row('Populated regions', `${c.items.populated_regions}/${c.items.region_files}`, 'good'));
      sect.appendChild(bar(c.items.populated_regions, c.items.region_files));
      el.appendChild(sect);
    }

    // ── Environment ──
    if (cats.environment) {
      const c = cats.environment;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      sect.appendChild(row('Lighting', c.items.environment_json ? '✓ Loaded' : '✗ Missing', c.items.environment_json ? 'good' : 'bad'));
      sect.appendChild(row('Map config', c.items.map_config ? '✓ Loaded' : '✗ Missing', c.items.map_config ? 'good' : 'bad'));
      sect.appendChild(row('Minimap', c.items.minimap ? '✓ Available' : '✗ Missing', c.items.minimap ? 'good' : 'bad'));
      sect.appendChild(row('View probes (IBL)', c.source_files.view_probes, 'info'));
      sect.appendChild(row('Env probes', c.source_files.env_probes, 'info'));
      sect.appendChild(note('View/env probes not yet used in web viewer'));
      el.appendChild(sect);
    }

    // ── Textures ──
    if (cats.textures) {
      const c = cats.textures;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      sect.appendChild(row('Mesh texture references', c.items.mesh_texture_refs, 'info'));
      sect.appendChild(row('Source DDS available', c.items.source_dds_available, 'info'));
      if (c.note) sect.appendChild(note(c.note));
      el.appendChild(sect);
    }

    // ── Water ──
    if (cats.water) {
      const c = cats.water;
      const sect = document.createElement('div');
      sect.className = 'res-category';
      sect.innerHTML = `<div class="res-category-header"><span class="icon">${c.icon}</span><span class="label">${c.label}</span></div>`;
      sect.appendChild(row('Water config files', c.items.water_files, 'info'));
      sect.appendChild(note('Water rendering not yet implemented'));
      el.appendChild(sect);
    }

    // ── Rendering features ──
    const feats = document.createElement('div');
    feats.className = 'res-category';
    feats.innerHTML = `<div class="res-category-header"><span class="icon">🖥️</span><span class="label">Rendering Features</span></div>`;
    feats.appendChild(row('Shadow mapping', '✓ PCF Soft', 'good'));
    feats.appendChild(row('Tone mapping', '✓ ACES Filmic', 'good'));
    feats.appendChild(row('Materials', '✓ PBR Standard', 'good'));
    feats.appendChild(row('Terrain textures', '✓ Baked procedural', 'good'));
    feats.appendChild(row('Anti-aliasing', '✓ MSAA', 'good'));
    feats.appendChild(row('Mesh textures', '✓ 302 GLBs textured (285 missing from cache)', 'warn'));
    feats.appendChild(row('IBL lighting', '✗ Probes available', 'warn'));
    feats.appendChild(row('Water rendering', '✗ Not implemented', 'warn'));
    el.appendChild(feats);
  }

  // ─── Verdicts Tab ──────────────────────────────────
  populateVerdictsTab() {
    const el = document.getElementById('tab-verdicts');
    el.innerHTML = '';
    const es = this.entitySystem;
    const verdicts = es.verdicts;
    if (!verdicts) {
      el.innerHTML = '<div style="padding:16px;color:#888;text-align:center">verdicts.json not loaded</div>';
      return;
    }

    const loadedGLBs = es.getLoadedGLBNames();

    // Controls bar
    const controls = document.createElement('div');
    controls.className = 'verdict-controls';

    const showAllBtn = document.createElement('button');
    showAllBtn.textContent = '✓ Show All Denied';
    showAllBtn.addEventListener('click', () => {
      es.showAllDenied();
      this.populateVerdictsTab();
      this.showToast('Showing all denied meshes');
    });

    const hideAllBtn = document.createElement('button');
    hideAllBtn.textContent = '✗ Hide All Denied';
    hideAllBtn.addEventListener('click', () => {
      es.hideAllDenied();
      this.populateVerdictsTab();
      this.showToast('Hiding all denied meshes');
    });

    const deniedCount = verdicts.denied ? verdicts.denied.length : 0;
    const approvedCount = verdicts.approved ? verdicts.approved.length : 0;
    const hiddenCount = es.hiddenMeshes.size;

    const countLabel = document.createElement('span');
    countLabel.className = 'count-label';
    countLabel.textContent = `${approvedCount} approved · ${deniedCount} denied · ${hiddenCount} hidden`;

    controls.appendChild(showAllBtn);
    controls.appendChild(hideAllBtn);
    controls.appendChild(countLabel);
    el.appendChild(controls);

    // Filter buttons
    const filterBar = document.createElement('div');
    filterBar.className = 'verdict-controls';
    filterBar.style.paddingTop = '0';
    const filters = [
      { label: 'All', value: 'all' },
      { label: 'Denied Only', value: 'denied' },
      { label: 'Approved Only', value: 'approved' },
      { label: 'Hidden', value: 'hidden' },
    ];
    let activeFilter = 'denied'; // default to showing denied
    for (const f of filters) {
      const btn = document.createElement('button');
      btn.textContent = f.label;
      if (f.value === activeFilter) btn.style.background = 'rgba(100,200,100,0.2)';
      btn.addEventListener('click', () => {
        activeFilter = f.value;
        filterBar.querySelectorAll('button').forEach(b => b.style.background = '');
        btn.style.background = 'rgba(100,200,100,0.2)';
        renderList();
      });
      filterBar.appendChild(btn);
    }
    el.appendChild(filterBar);

    // Scrollable list
    const listEl = document.createElement('div');
    listEl.style.cssText = 'overflow-y:auto;flex:1;min-height:0';
    el.appendChild(listEl);

    // Build full mesh list with verdict status
    const allMeshes = [];
    if (verdicts.approved) {
      for (const name of verdicts.approved) {
        const key = name.toLowerCase();
        allMeshes.push({ name, verdict: 'approved', loaded: loadedGLBs.has(key), instances: es.getInstanceCount(name) });
      }
    }
    if (verdicts.denied) {
      for (const name of verdicts.denied) {
        const key = name.toLowerCase();
        allMeshes.push({ name, verdict: 'denied', loaded: loadedGLBs.has(key), instances: es.getInstanceCount(name) });
      }
    }
    // Sort: denied first, then by instance count
    allMeshes.sort((a, b) => {
      if (a.verdict !== b.verdict) return a.verdict === 'denied' ? -1 : 1;
      return b.instances - a.instances;
    });

    const renderList = () => {
      listEl.innerHTML = '';
      const filtered = allMeshes.filter(m => {
        if (activeFilter === 'denied') return m.verdict === 'denied';
        if (activeFilter === 'approved') return m.verdict === 'approved';
        if (activeFilter === 'hidden') return es.isMeshHidden(m.name);
        return true;
      });

      if (filtered.length === 0) {
        listEl.innerHTML = '<div style="padding:16px;color:#888;text-align:center">No meshes match filter</div>';
        return;
      }

      for (const m of filtered) {
        const isHidden = es.isMeshHidden(m.name);
        const item = document.createElement('div');
        item.className = `verdict-item${isHidden ? ' denied' : ''}`;
        item.dataset.search = m.name.toLowerCase();

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'v-check';
        cb.checked = !isHidden;
        cb.title = isHidden ? 'Click to show' : 'Click to hide';
        cb.addEventListener('change', () => {
          es.setMeshHidden(m.name, !cb.checked);
          item.classList.toggle('denied', !cb.checked);
          // Update count label
          countLabel.textContent = `${approvedCount} approved · ${deniedCount} denied · ${es.hiddenMeshes.size} hidden`;
        });

        const nameSpan = document.createElement('span');
        nameSpan.className = 'v-name';
        nameSpan.textContent = m.name;

        const badge = document.createElement('span');
        badge.style.cssText = `font-size:9px;padding:1px 5px;border-radius:2px;color:#fff;margin-right:4px;${
          m.verdict === 'denied' ? 'background:#a44' : 'background:#4a4'
        }`;
        badge.textContent = m.verdict === 'denied' ? 'DENIED' : 'OK';

        const countSpan = document.createElement('span');
        countSpan.className = 'v-count';
        countSpan.textContent = m.instances > 0 ? `×${m.instances}` : '(not on map)';

        // Click name to jump to first instance
        nameSpan.style.cursor = 'pointer';
        nameSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = m.name.toLowerCase().replace('.glb', '');
          const tracked = [...es.loadedMeshes.entries()].find(([k]) =>
            k.toLowerCase().includes(key)
          );
          if (tracked && tracked[1].positions.length > 0) {
            const p = tracked[1].positions[0];
            let y = 3000;
            const th = this.terrainSystem ? this.terrainSystem.getHeightAt(p.x, p.z) : null;
            if (th !== null) y = th + 4000;
            this.playerController.teleport(p.x, y, p.z - 500);
            this.showToast(`Jumped to ${m.name}`);
          }
        });

        item.appendChild(cb);
        item.appendChild(badge);
        item.appendChild(nameSpan);
        item.appendChild(countSpan);
        listEl.appendChild(item);
      }
    };

    renderList();
  }

  // ─── Region/Partial Map Tab ──────────────────────────
  populateRegionTab() {
    const el = document.getElementById('tab-region');
    el.innerHTML = '';

    const bounds = this.terrainSystem ? this.terrainSystem.getWorldBounds() : { minX: 0, maxX: 100000, minZ: -100000, maxZ: 0 };
    const pos = this.camera.position;

    // Default region: 20k×20k square around current camera position
    const defaultSize = 20000;
    const defMinX = Math.round(pos.x - defaultSize / 2);
    const defMaxX = Math.round(pos.x + defaultSize / 2);
    const defMinZ = Math.round(pos.z - defaultSize / 2);
    const defMaxZ = Math.round(pos.z + defaultSize / 2);

    const form = document.createElement('div');
    form.className = 'region-form';
    form.innerHTML = `
      <div style="color:#dca;font-weight:bold;margin-bottom:8px">Partial Map Region</div>
      <div style="color:#888;font-size:10px;margin-bottom:8px">Define a rectangular region to extract as a custom sub-map. Only entities within this box will be visible.</div>
      <div class="coord-row">
        <div><label>Min X</label><input type="number" id="region-min-x" value="${defMinX}" step="1000"></div>
        <div><label>Max X</label><input type="number" id="region-max-x" value="${defMaxX}" step="1000"></div>
      </div>
      <div class="coord-row">
        <div><label>Min Z</label><input type="number" id="region-min-z" value="${defMinZ}" step="1000"></div>
        <div><label>Max Z</label><input type="number" id="region-max-z" value="${defMaxZ}" step="1000"></div>
      </div>
      <button class="region-btn" id="region-use-camera">📍 Use Camera Position (±${defaultSize / 2})</button>
      <button class="region-btn" id="region-preview">👁 Preview Region</button>
      <button class="region-btn" id="region-apply">✂ Apply Region Filter</button>
      <button class="region-btn danger" id="region-clear">↩ Show Full Map</button>
      <button class="region-btn" id="region-export" style="margin-top:8px">💾 Export Custom Map JSON</button>
    `;
    el.appendChild(form);

    const statsEl = document.createElement('div');
    statsEl.className = 'region-stats';
    statsEl.textContent = 'No region filter active';
    el.appendChild(statsEl);

    // Use camera position
    document.getElementById('region-use-camera').addEventListener('click', () => {
      const p = this.camera.position;
      document.getElementById('region-min-x').value = Math.round(p.x - defaultSize / 2);
      document.getElementById('region-max-x').value = Math.round(p.x + defaultSize / 2);
      document.getElementById('region-min-z').value = Math.round(p.z - defaultSize / 2);
      document.getElementById('region-max-z').value = Math.round(p.z + defaultSize / 2);
    });

    // Preview region (show box on minimap)
    document.getElementById('region-preview').addEventListener('click', () => {
      this._updateRegionPreview();
      const r = this._getRegionBounds();
      this._update3DRegionBox(r);
      this.showToast('Region preview shown on minimap + 3D');
    });

    // Apply region filter
    document.getElementById('region-apply').addEventListener('click', () => {
      const r = this._getRegionBounds();
      this.entitySystem.regionFilter = r;
      if (this.terrainSystem) this.terrainSystem.setRegionClip(r);
      this._updateRegionPreview();
      const count = this._countEntitiesInRegion(r);
      statsEl.innerHTML = `<strong>Region filter active:</strong> ${count} entities visible<br>
        X: ${r.minX.toFixed(0)} → ${r.maxX.toFixed(0)} | Z: ${r.minZ.toFixed(0)} → ${r.maxZ.toFixed(0)}<br>
        Size: ${((r.maxX - r.minX) / 1000).toFixed(1)}k × ${((r.maxZ - r.minZ) / 1000).toFixed(1)}k`;
      this.showToast(`Region filter applied: ${count} entities`);
    });

    // Clear region filter
    document.getElementById('region-clear').addEventListener('click', () => {
      this.entitySystem.regionFilter = null;
      if (this.terrainSystem) this.terrainSystem.setRegionClip(null);
      this._hideRegionPreview();
      this._remove3DRegionBox();
      statsEl.textContent = 'No region filter active';
      this.showToast('Full map restored');
    });

    // Export custom map JSON
    document.getElementById('region-export').addEventListener('click', () => {
      const r = this._getRegionBounds();
      const entities = this.entitySystem.allEntities.filter(e => {
        const p = e.worldPos;
        return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
      });
      const exportData = {
        region: r,
        entityCount: entities.length,
        entities: entities.map(e => ({
          mesh: e.mesh,
          matrix: e.matrix,
          worldPos: e.worldPos
        }))
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `custom-map-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast(`Exported ${entities.length} entities`);
    });

    // Show current filter state
    if (this.entitySystem.regionFilter) {
      const r = this.entitySystem.regionFilter;
      const count = this._countEntitiesInRegion(r);
      statsEl.innerHTML = `<strong>Region filter active:</strong> ${count} entities visible<br>
        X: ${r.minX.toFixed(0)} → ${r.maxX.toFixed(0)} | Z: ${r.minZ.toFixed(0)} → ${r.maxZ.toFixed(0)}`;
    }
  }

  _getRegionBounds() {
    return {
      minX: parseFloat(document.getElementById('region-min-x').value) || 0,
      maxX: parseFloat(document.getElementById('region-max-x').value) || 100000,
      minZ: parseFloat(document.getElementById('region-min-z').value) || -100000,
      maxZ: parseFloat(document.getElementById('region-max-z').value) || 0,
    };
  }

  _countEntitiesInRegion(r) {
    return this.entitySystem.allEntities.filter(e => {
      const p = e.worldPos;
      if (p.x < r.minX || p.x > r.maxX || p.z < r.minZ || p.z > r.maxZ) return false;
      if (r.polygon) return this._pointInPolygon(p.x, p.z, r.polygon);
      return true;
    }).length;
  }

  _updateRegionPreview() {
    const box = document.getElementById('minimap-region-box');
    if (!box || !this._mmBounds) return;
    const r = this._getRegionBounds();
    const b = this._mmBounds;
    const canvas = this._mmCanvas;
    const rect = canvas.getBoundingClientRect();

    const x1 = ((r.minX - b.minX) / (b.maxX - b.minX)) * rect.width;
    const x2 = ((r.maxX - b.minX) / (b.maxX - b.minX)) * rect.width;
    const z1 = ((r.minZ - b.minZ) / (b.maxZ - b.minZ)) * rect.height;
    const z2 = ((r.maxZ - b.minZ) / (b.maxZ - b.minZ)) * rect.height;

    box.style.left = `${Math.min(x1, x2)}px`;
    box.style.top = `${Math.min(z1, z2)}px`;
    box.style.width = `${Math.abs(x2 - x1)}px`;
    box.style.height = `${Math.abs(z2 - z1)}px`;
    box.style.display = 'block';
  }

  _hideRegionPreview() {
    const box = document.getElementById('minimap-region-box');
    if (box) box.style.display = 'none';
  }

  /** Extract folder hierarchy from a mesh path */
  _extractFolders(meshPath) {
    // Path like: data/source/maps_source/门派/明教/st_mj戈壁碎石002_002_hd.mesh
    // Extract subfolder after maps_source/ or doodad/
    const lower = meshPath.toLowerCase().replace(/\\/g, '/');
    const markers = ['maps_source/', 'doodad/', 'source/'];
    for (const m of markers) {
      const idx = lower.indexOf(m);
      if (idx >= 0) {
        const rest = meshPath.substring(idx + m.length);
        const parts = rest.split('/');
        parts.pop(); // remove filename
        return parts;
      }
    }
    const parts = meshPath.replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.length > 2 ? parts.slice(-2) : parts;
  }

  populateMeshPanel() {
    const es = this.entitySystem;
    const isFolder = this._meshSortMode === 'folder';

    const _fmtMatch = (path) => {
      const ext = path.split('.').pop().toLowerCase();
      if (this._meshFormatFilter === 'mesh') return ext === 'mesh';
      if (this._meshFormatFilter === 'other') return ext !== 'mesh';
      return true;
    };

    // Loaded tab (no format filter — show everything loaded)
    const loadedEl = document.getElementById('tab-loaded');
    loadedEl.innerHTML = '';
    const loadedArr = Array.from(es.loadedMeshes.entries());
    document.getElementById('loaded-count').textContent = loadedArr.length;

    if (isFolder) {
      this._renderFolderTree(loadedEl, loadedArr.map(([p, info]) => ({ path: p, count: info.count, positions: info.positions, loaded: true, official: !!info.official })));
    } else {
      loadedArr.sort((a, b) => b[1].count - a[1].count);
      for (const [path, info] of loadedArr) {
        loadedEl.appendChild(this._createMeshItem(path, info.count, info.positions, true, !!info.official));
      }
    }

    // Missing tab
    const missingEl = document.getElementById('tab-missing');
    missingEl.innerHTML = '';

    // Build the missing mesh list from allEntities: count per original mesh path
    const missingCounts = new Map();
    for (const ent of es.allEntities) {
      const mp = ent.mesh;
      if (!mp) continue;
      // Check if this mesh was loaded (exists in loadedMeshes by checking mesh-map)
      const isLoaded = es.loadedMeshes.size > 0 && Array.from(es.loadedMeshes.keys()).some(k => mp.toLowerCase().includes(k.split('/').pop().replace('.glb', '').toLowerCase()));
      if (!isLoaded) {
        missingCounts.set(mp, (missingCounts.get(mp) || 0) + 1);
      }
    }
    // Also add meshes from missingMeshes map
    for (const [path, count] of es.missingMeshes) {
      if (!missingCounts.has(path)) {
        missingCounts.set(path, count);
      }
    }

    const missingArr = Array.from(missingCounts.entries()).filter(([p]) => _fmtMatch(p));
    document.getElementById('missing-count').textContent = missingArr.length;

    // Group by keyword family for easy download planning
    const kwGroups = new Map();
    for (const [path, count] of missingArr) {
      const kws = this._extractKeywords(path);
      const key = kws.length > 0 ? kws[0] : '(other)';
      if (!kwGroups.has(key)) kwGroups.set(key, []);
      kwGroups.get(key).push({ path, count });
    }

    const sortedGroups = [...kwGroups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    for (const [kw, items] of sortedGroups) {
      const group = document.createElement('div');
      group.className = 'kw-group';

      const totalUses = items.reduce((s, i) => s + i.count, 0);
      const header = document.createElement('div');
      header.className = 'kw-header';
      header.innerHTML = `
        <span class="kw-word">${this._escapeHtml(kw)}</span>
        <span class="kw-meta">${items.length}\u00a0mesh\u00a0·\u00a0<span style="color:#f87;font-weight:bold">${totalUses}\u00a0uses</span></span>
        <button class="kw-copy" title="Copy for official editor search">📋 Copy</button>
      `;
      const children = document.createElement('div');
      children.className = 'kw-children';
      items.sort((a, b) => b.count - a.count);
      for (const { path, count } of items) {
        children.appendChild(this._createMeshItem(path, count, null, false));
      }
      header.querySelector('.kw-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(kw).then(() => this.showToast(`Copied: ${kw}`));
      });
      header.addEventListener('click', (e) => {
        if (e.target.classList.contains('kw-copy')) return;
        children.style.display = children.style.display !== 'none' ? 'none' : 'block';
      });
      group.appendChild(header);
      group.appendChild(children);
      missingEl.appendChild(group);
    }
  }

  // ─── Texture Missing Tab ───────────────────────────
  populateTextureMissingTab() {
    const el = document.getElementById('tab-tex-missing');
    if (!el) return;
    el.innerHTML = '';

    const tmm = this.textureMissingMap;
    if (!tmm) {
      el.innerHTML = '<div style="padding:16px;color:#888;text-align:center">texture-missing-map.json not found</div>';
      document.getElementById('tex-missing-count').textContent = '?';
      return;
    }

    const entries = Object.entries(tmm);
    document.getElementById('tex-missing-count').textContent = entries.length;

    // Sort alphabetically by GLB name
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Header note
    const note = document.createElement('div');
    note.style.cssText = 'padding:8px 10px;font-size:10px;color:#888;border-bottom:1px solid #333';
    note.textContent = `${entries.length} meshes have textures not yet in cache. Hover to see missing paths.`;
    el.appendChild(note);

    for (const [glbName, missingPaths] of entries) {
      const div = document.createElement('div');
      div.className = 'mesh-item missing';
      div.dataset.search = glbName.toLowerCase();

      // Tooltip: all missing texture paths, one per line
      const tooltip = missingPaths.join('\n');
      div.title = tooltip;

      // Show icon indicating partial vs full miss
      const isPartial = !!(this.entitySystem && this.entitySystem.textureMap && this.entitySystem.textureMap[glbName]);
      const badge = isPartial
        ? '<span style="color:#fa0;font-size:10px;margin-right:4px" title="Partial — some textures found">▲ Partial</span>'
        : '<span style="color:#f55;font-size:10px;margin-right:4px" title="No textures found">✗ None</span>';

      // Count how many paths are missing
      const cnt = missingPaths.length;

      div.innerHTML = `<div class="item-row">${badge}<span class="name">${this._escapeHtml(glbName)}</span>
        <span class="info" style="color:#f87">${cnt} tex</span>
        <button class="copy-btn" title="Copy missing paths to clipboard" style="margin-left:auto;font-size:10px;padding:1px 4px">📋</button>
      </div>
      <div class="path" style="color:#966;font-size:10px;word-break:break-all">${this._escapeHtml(missingPaths[0])}${missingPaths.length > 1 ? ` (+${missingPaths.length - 1} more)` : ''}</div>`;

      div.querySelector('.copy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(missingPaths.join('\n')).then(() => {
          this.showToast(`Copied ${cnt} path(s)`);
        });
      });

      el.appendChild(div);
    }
  }

  _createMeshItem(path, count, positions, isLoaded, isOfficial = false) {
    const div = document.createElement('div');
    div.className = `mesh-item${isLoaded ? '' : ' missing'}${isOfficial ? ' official' : ''}`;
    div.dataset.search = path.toLowerCase();
    const name = path.split('/').pop();
    const nameNoExt = name.replace(/\.[^.]+$/, '');
    const folder = path.substring(0, path.lastIndexOf('/'));

    let buttonsHtml = '';
    if (!isLoaded) {
      buttonsHtml = `<span class="copy-btns">
        <button class="copy-btn" data-copy="folder" title="Copy folder path">📂</button>
        <button class="copy-btn" data-copy="name" title="Copy mesh name">📋</button>
      </span>`;
    }

    const officialBadge = isOfficial ? '<span style="color:#f0c040;font-size:10px;margin-right:3px">★ OFFICIAL</span>' : '';
    const addBtn = isLoaded ? '<button class="copy-btn add-to-map-btn" title="Add instance to map at camera position" style="margin-left:4px;color:#6f6;border-color:rgba(100,200,100,0.4)">+</button>' : '';
    div.innerHTML = `<div class="item-row">${officialBadge}<span class="name">${this._escapeHtml(name)}</span>
      <span class="info">×${count}</span>${buttonsHtml}${addBtn}</div>
      <div class="path">${this._escapeHtml(folder)}</div>`;

    // Copy button handlers
    if (!isLoaded) {
      div.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = btn.dataset.copy === 'folder' ? folder : nameNoExt;
          navigator.clipboard.writeText(text).then(() => {
            this.showToast(`Copied: ${text}`);
          });
        });
      });
    }

    if (isLoaded && positions && positions.length > 0) {
      div.addEventListener('click', (e) => {
        if (e.target.classList.contains('add-to-map-btn')) return;
        const p = positions[0];
        let y = 3000;
        const th = this.terrainSystem ? this.terrainSystem.getHeightAt(p.x, p.z) : null;
        if (th !== null) y = th + 4000;
        // Offset camera to be above and slightly back so the mesh is visible below
        this.playerController.teleport(p.x, y, p.z - 500);
        this.showToast(`Jumped above ${name}`);
      });

      // Add-to-map button handler
      const addBtnEl = div.querySelector('.add-to-map-btn');
      if (addBtnEl) {
        addBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addMeshToMap(path);
        });
      }
    } else {
      div.addEventListener('click', () => {
        navigator.clipboard.writeText(path).then(() => {
          this.showToast(`Copied: ${path}`);
        });
      });
    }
    return div;
  }

  _renderFolderTree(container, items) {
    // Group by subfolder
    const tree = {};
    for (const item of items) {
      const folders = this._extractFolders(item.path);
      const key = folders.length > 0 ? folders.join('/') : '(root)';
      if (!tree[key]) tree[key] = [];
      tree[key].push(item);
    }

    // Sort folders by total count
    const sortedFolders = Object.entries(tree)
      .map(([folder, items]) => ({
        folder,
        items: items.sort((a, b) => b.count - a.count),
        totalCount: items.reduce((s, i) => s + i.count, 0)
      }))
      .sort((a, b) => b.totalCount - a.totalCount);

    for (const { folder, items, totalCount } of sortedFolders) {
      // Folder header
      const folderDiv = document.createElement('div');
      folderDiv.className = 'mesh-folder';
      folderDiv.innerHTML = `<span class="folder-icon">📁</span> <span class="folder-name">${this._escapeHtml(folder)}</span> <span class="folder-count">(${items.length} meshes, ${totalCount} instances)</span>`;
      folderDiv.style.cssText = 'padding:6px 10px;color:#dca;font-size:11px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)';

      const childContainer = document.createElement('div');
      childContainer.style.display = 'none';
      for (const item of items) {
        childContainer.appendChild(this._createMeshItem(item.path, item.count, item.positions, item.loaded, !!item.official));
      }

      folderDiv.addEventListener('click', () => {
        const expanded = childContainer.style.display !== 'none';
        childContainer.style.display = expanded ? 'none' : 'block';
        folderDiv.querySelector('.folder-icon').textContent = expanded ? '📁' : '📂';
      });

      container.appendChild(folderDiv);
      container.appendChild(childContainer);
    }
  }

  /**
   * Extract meaningful keywords from a mesh filename.
   * Returns an array of keyword strings — Chinese word chunks and prefix codes.
   */
  /**
   * Extract the "family key" from a mesh path — the most specific prefix
   * that groups related meshes without being too broad.
   * e.g. cq_龙门城墙001_003_hd  →  "cq_龙门城墙"
   *      wj_cactus001_006_hd     →  "wj_cactus"
   *      st_mj戈壁碎石003_002_hd →  "st_mj戈壁碎石"
   * Returns an array: [familyKey] (single entry — keeps groups tight)
   */
  _extractKeywords(meshPath) {
    const filename = meshPath.replace(/\\/g, '/').split('/').pop();
    // Strip file extension
    let base = filename.replace(/\.[^.]+$/, '');
    // Strip _hd and _lod* suffixes
    base = base.replace(/_(?:hd|lod\d*)$/i, '');
    // Iteratively strip trailing _number or trailing digits until stable
    let prev;
    do {
      prev = base;
      base = base.replace(/_\d+$/, '').replace(/\d+$/, '');
    } while (base !== prev && base.length > 0);

    // Strip leading ASCII prefix (e.g. "cq_", "st_xb", "wj_bhyz") to get the
    // meaningful Chinese name — produces broader groups and better editor search terms.
    // e.g. "cq_龙门城墙" → "龙门城墙"; "st_xb多枝枯树" → "多枝枯树"
    const stripped = base.replace(/^[a-zA-Z\d_]+/, '');
    const key = (stripped.length >= 2 ? stripped : base).toLowerCase();
    return key.length >= 2 ? [key] : [];
  }

  populateKeywordTab() {
    const el = document.getElementById('tab-keyword');
    el.innerHTML = '';

    // ── Toolbar: missing-only toggle ──
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'padding:6px 10px;display:flex;gap:6px;align-items:center;border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0';
    const missingToggle = document.createElement('button');
    missingToggle.textContent = '⬇ Needs Download';
    missingToggle.title = 'Show only groups with undownloaded meshes';
    missingToggle.style.cssText = 'background:rgba(255,120,60,0.2);border:1px solid rgba(255,120,60,0.4);color:#faa;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;';
    let missingOnly = true;
    missingToggle.addEventListener('click', () => {
      missingOnly = !missingOnly;
      missingToggle.style.background = missingOnly ? 'rgba(255,120,60,0.2)' : 'rgba(255,255,255,0.08)';
      missingToggle.style.color = missingOnly ? '#faa' : '#aaa';
      renderGroups();
    });
    const hint = document.createElement('span');
    hint.style.cssText = 'color:#666;font-size:10px;flex:1;text-align:right';
    hint.textContent = 'Paste keyword into official editor search';
    toolbar.appendChild(missingToggle);
    toolbar.appendChild(hint);
    el.appendChild(toolbar);

    const listEl = document.createElement('div');
    listEl.style.cssText = 'overflow-y:auto;flex:1;min-height:0';
    el.appendChild(listEl);

    // ── Gather ALL mesh paths (loaded + missing) ──
    const es = this.entitySystem;
    const allPaths = new Map(); // path -> { count, loaded }

    for (const [path, info] of es.loadedMeshes.entries()) {
      allPaths.set(path, { count: info.count, loaded: true });
    }
    for (const ent of es.allEntities) {
      const mp = ent.mesh;
      if (!mp) continue;
      const isLoaded = Array.from(es.loadedMeshes.keys()).some(
        k => mp.toLowerCase().includes(k.split('/').pop().replace('.glb','').toLowerCase())
      );
      if (!isLoaded) {
        const existing = allPaths.get(mp);
        allPaths.set(mp, { count: (existing?.count || 0) + 1, loaded: false });
      }
    }
    for (const [path, count] of es.missingMeshes) {
      if (!allPaths.has(path)) allPaths.set(path, { count, loaded: false });
    }

    // ── Build keyword → group ──
    const kwMap = new Map();
    for (const [path, info] of allPaths.entries()) {
      const kws = this._extractKeywords(path);
      for (const kw of kws) {
        if (!kwMap.has(kw)) kwMap.set(kw, { paths: new Set() });
        kwMap.get(kw).paths.add(path);
      }
    }

    // Compute per-group stats
    const groups = [...kwMap.entries()].map(([kw, { paths }]) => {
      const missingPaths = [...paths].filter(p => !allPaths.get(p)?.loaded);
      const loadedPaths  = [...paths].filter(p =>  allPaths.get(p)?.loaded);
      return { kw, paths, missingPaths, loadedPaths };
    });

    // Sort: most missing first, then alphabetical
    groups.sort((a, b) => b.missingPaths.length - a.missingPaths.length || a.kw.localeCompare(b.kw));

    const renderGroups = () => {
      listEl.innerHTML = '';
      const visible = missingOnly ? groups.filter(g => g.missingPaths.length > 0) : groups;

      if (visible.length === 0) {
        listEl.innerHTML = '<div style="padding:16px;color:#888;text-align:center">No groups found</div>';
        return;
      }

      for (const { kw, paths, missingPaths, loadedPaths } of visible) {
        const group = document.createElement('div');
        group.className = 'kw-group';

        const missingLabel = missingPaths.length > 0
          ? `<span style="color:#f87;font-weight:bold">${missingPaths.length} to download</span>`
          : `<span style="color:#8c8">✓ all loaded</span>`;

        const header = document.createElement('div');
        header.className = 'kw-header';
        header.innerHTML = `
          <span class="kw-word">${this._escapeHtml(kw)}</span>
          <span class="kw-meta">${paths.size} meshes · ${missingLabel}</span>
          <button class="kw-copy" title="Copy for official editor search">📋 Copy</button>
        `;

        const children = document.createElement('div');
        children.className = 'kw-children';
        // Missing first (so you can see what you still need)
        for (const path of [...missingPaths, ...loadedPaths]) {
          const info = allPaths.get(path);
          children.appendChild(this._createMeshItem(path, info.count, null, info.loaded));
        }

        header.querySelector('.kw-copy').addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(kw).then(() => this.showToast(`Copied: ${kw}`));
        });
        header.addEventListener('click', (e) => {
          if (e.target.classList.contains('kw-copy')) return;
          const open = children.style.display !== 'none';
          children.style.display = open ? 'none' : 'block';
        });

        group.appendChild(header);
        group.appendChild(children);
        listEl.appendChild(group);
      }
    };

    renderGroups();
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  filterMeshList(query) {
    document.querySelectorAll('#mesh-panel .mesh-item').forEach(item => {
      item.style.display = !query || item.dataset.search.includes(query) ? '' : 'none';
    });
  }

  toggleMeshPanel(show) {
    if (show === undefined) show = !this.meshPanelVisible;
    this.meshPanelVisible = show;
    document.getElementById('mesh-panel').classList.toggle('visible', show);
    document.getElementById('mesh-panel').style.display = show ? 'flex' : 'none';
  }

  // ─── Undo Stack ─────────────────────────────────
  _pushUndo(fn) {
    if (!this._undoStack) this._undoStack = [];
    this._undoStack.push(fn);
    if (this._undoStack.length > 40) this._undoStack.shift();
  }

  _undo() {
    if (!this._undoStack?.length) { this.showToast('Nothing to undo'); return; }
    this._undoStack.pop()();
  }

  // ─── Multi-selection Highlights ─────────────────
  _addMultiHighlight(entry, instanceId) {
    const primary = (entry.subMeshes || [entry.mesh])[0];
    if (!primary?.geometry) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.65, depthTest: false,
    });
    const h = new THREE.Mesh(primary.geometry, mat);
    const m4 = new THREE.Matrix4();
    primary.getMatrixAt(instanceId, m4);
    h.applyMatrix4(m4);
    h.renderOrder = 998;
    this.scene.add(h);
    if (!this.multiHighlights) this.multiHighlights = [];
    this.multiHighlights.push(h);
  }

  _clearMultiHighlights() {
    if (!this.multiHighlights) return;
    for (const h of this.multiHighlights) {
      this.scene.remove(h);
      if (h.material) h.material.dispose();
      h.geometry = null; // shared — don't dispose
    }
    this.multiHighlights = [];
  }

  // ─── Grow InstancedMesh capacity ─────────────────
  _growInstancedMeshEntry(entry, extraCount) {
    const subs = entry.subMeshes || [entry.mesh];
    const oldCount = subs[0].count;
    const newCap = oldCount + extraCount;
    const mat4 = new THREE.Matrix4();
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

    const newSubs = subs.map(oldMesh => {
      const newMesh = new THREE.InstancedMesh(oldMesh.geometry, oldMesh.material, newCap);
      newMesh.frustumCulled = false;
      newMesh.castShadow = oldMesh.castShadow;
      newMesh.receiveShadow = oldMesh.receiveShadow;
      newMesh.visible = oldMesh.visible;
      // Copy existing instance matrices
      for (let i = 0; i < oldCount; i++) {
        oldMesh.getMatrixAt(i, mat4);
        newMesh.setMatrixAt(i, mat4);
      }
      // Zero-fill new slots
      for (let i = oldCount; i < newCap; i++) newMesh.setMatrixAt(i, zeroMat);
      newMesh.count = newCap;
      newMesh.instanceMatrix.needsUpdate = true;
      // Replace in scene
      const parent = oldMesh.parent;
      if (parent) { parent.add(newMesh); parent.remove(oldMesh); }
      return newMesh;
    });

    entry.mesh = newSubs[0];
    entry.subMeshes = newSubs;
    entry.totalCount = newCap; // update so LOD doesn't hide new instances
    return oldCount; // returns previous count (first new slot index)
  }

  showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ─── Mode Bar (Camera / Select) ──────────────────
  _setupModeBar() {
    const bar = document.getElementById('mode-bar');
    if (!bar) return;
    bar.classList.add('visible');

    const camBtn = document.getElementById('mode-camera');
    const selBtn = document.getElementById('mode-select');

    const setMode = (mode) => {
      this._editMode = mode;
      camBtn.classList.toggle('active', mode === 'camera');
      selBtn.classList.toggle('active', mode === 'select');
    };

    if (!bar._wired) {
      bar._wired = true;
      camBtn.addEventListener('click', () => setMode('camera'));
      selBtn.addEventListener('click', () => setMode('select'));
    }

    setMode(this._editMode);
  }

  // ─── Shortcuts ────────────────────────────────────
  setupShortcuts() {
    document.addEventListener('keydown', (e) => {
      const inInput = e.target.tagName === 'INPUT';
      // R/M toggle panels even from number/range inputs (not text/search)
      const isTextInput = inInput && (e.target.type === 'text' || e.target.type === 'search');
      if (!isTextInput && e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) { this.toggleMeshPanel(); return; }
      if (!isTextInput && e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) { this.toggleRegionDialog(); return; }
      if (inInput) return;
      // C/V for mode switching (without Ctrl)
      if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey) {
        this._editMode = 'camera';
        this._setupModeBar();
      }
      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey) {
        this._editMode = 'select';
        this._setupModeBar();
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.openSaveDialog();
      }
      if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (this.multiSelection.length > 0) this.copyMultiSelection();
      }
      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._undo();
      }
      // Delete — works for both single selection and multi-selection
      if (e.code === 'Delete' && !document.pointerLockElement) {
        if (this.multiSelection?.length > 0) {
          this.deleteMultiSelection(); e.preventDefault();
        } else if (this.selectedEntry) {
          document.getElementById('xf-delete').click(); e.preventDefault();
        }
      }
    });

    // Draw distance slider
    const slider = document.getElementById('draw-distance');
    const label = document.getElementById('draw-distance-val');
    if (slider && label && this.entitySystem) {
      slider.value = String(this.entitySystem.drawDistance);
      label.textContent = `${Math.round(this.entitySystem.drawDistance / 1000)}k`;
      slider.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        this.entitySystem.drawDistance = val;
        label.textContent = `${Math.round(val / 1000)}k`;
      });
    }

    // Hard visible instance cap slider
    const capSlider = document.getElementById('object-cap');
    const capLabel = document.getElementById('object-cap-val');
    if (capSlider && capLabel && this.entitySystem) {
      capSlider.value = String(this.entitySystem.maxVisibleInstances);
      capLabel.textContent = String(this.entitySystem.maxVisibleInstances);
      capSlider.addEventListener('input', () => {
        const val = parseInt(capSlider.value, 10);
        this.entitySystem.maxVisibleInstances = val;
        capLabel.textContent = String(val);
      });
    }
  }

  // ─── Selection & Raycasting ─────────────────────────
  setupSelection() {
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.selectedEntry = null;      // { entry, instanceId }
    this.selectionHighlight = null; // outline mesh for selected object

    this.canvas.addEventListener('click', (e) => {
      // Only pick if pointer is NOT locked and NOT in drag-select and NOT in pen mode
      if (document.pointerLockElement) return; // don't pick while in FPS mode
      if (this._editMode !== 'select') return; // only pick in select mode
      if (this._justFinishedDrag) { this._justFinishedDrag = false; return; }
      if (this._penMode) return; // pen mode handles its own clicks
      if (this._regionDrawMode) return; // don't pick while drawing region
      this.onCanvasClick(e);
    });

    // Escape to deselect
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.selectedEntry) {
        this.deselectMesh();
      }
    });
  }

  onCanvasClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Collect all visible InstancedMeshes
    const meshes = [];
    for (const entry of this.entitySystem.instancedMeshes) {
      const subs = entry.subMeshes || [entry.mesh];
      for (const m of subs) {
        if (m.visible && m.count > 0) meshes.push(m);
      }
    }

    const intersects = this.raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      const hit = intersects[0];
      const hitMesh = hit.object;
      const instanceId = hit.instanceId;

      // Find which entry this belongs to
      for (const entry of this.entitySystem.instancedMeshes) {
        const subs = entry.subMeshes || [entry.mesh];
        if (subs.includes(hitMesh)) {
          this.selectMesh(entry, instanceId);
          return;
        }
      }
    } else {
      this.deselectMesh();
    }
  }

  selectMesh(entry, instanceId) {
    this.deselectMesh(); // clear previous
    this.selectedEntry = { entry, instanceId };

    // Get the instance transform
    const primaryMesh = entry.subMeshes ? entry.subMeshes[0] : entry.mesh;
    const mat4 = new THREE.Matrix4();
    primaryMesh.getMatrixAt(instanceId, mat4);

    // Create highlight
    if (primaryMesh && primaryMesh.geometry) {
      const highlightMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5
      });
      this.selectionHighlight = new THREE.Mesh(primaryMesh.geometry, highlightMat);
      this.selectionHighlight.applyMatrix4(mat4);
      this.scene.add(this.selectionHighlight);
    }

    // Set up 3D transform gizmo
    this._setupGizmoForSelection(mat4);

    // Show transform panel
    this.updateTransformPanel();
    document.getElementById('transform-panel').classList.add('visible');

    const name = entry.glbName || 'unknown';
    this.showToast(`Selected: ${name} (instance #${instanceId})`);
  }

  _setupGizmoForSelection(mat4) {
    this._removeGizmo();

    // Create a dummy object at the instance's position/rotation/scale
    this._gizmoDummy = new THREE.Object3D();
    this._gizmoDummy.applyMatrix4(mat4);
    this.scene.add(this._gizmoDummy);

    // Snapshot the initial dummy transform for computing deltas
    this._gizmoPrevMatrix = mat4.clone();

    // Create TransformControls
    this._transformControls = new TransformControls(this.camera, this.canvas);
    this._transformControls.setMode('translate');
    this._transformControls.setSpace('world');
    // Lock to translate mode — prevent built-in keyboard shortcuts
    // (THREE.js TransformControls uses R=scale, E=rotate, W=translate which
    //  conflicts with our R=region dialog, E=rotate-selection shortcuts)
    this._transformControls.setMode = () => {};
    this.scene.add(this._transformControls.getHelper());
    this._transformControls.attach(this._gizmoDummy);

    // Block camera controls while dragging the gizmo
    this._transformControls.addEventListener('dragging-changed', (e) => {
      if (this.playerController) {
        this.playerController._blockPointerLock = e.value;
      }
    });

    // Sync changes back to the InstancedMesh
    this._transformControls.addEventListener('objectChange', () => {
      if (!this.selectedEntry) return;
      const { entry, instanceId } = this.selectedEntry;
      const subs = entry.subMeshes || [entry.mesh];

      // Build new matrix from dummy's world transform
      const newMat = new THREE.Matrix4();
      this._gizmoDummy.updateWorldMatrix(true, false);
      newMat.copy(this._gizmoDummy.matrixWorld);

      for (const m of subs) {
        m.setMatrixAt(instanceId, newMat);
        m.instanceMatrix.needsUpdate = true;
      }

      // Update highlight
      if (this.selectionHighlight) {
        this.selectionHighlight.matrix.identity();
        this.selectionHighlight.applyMatrix4(newMat);
      }

      this.updateTransformPanel();
    });

    // Push undo when drag ends
    this._transformControls.addEventListener('mouseUp', () => {
      if (!this.selectedEntry) return;
      const { entry, instanceId } = this.selectedEntry;
      const subs = entry.subMeshes || [entry.mesh];
      const savedPrev = this._gizmoPrevMatrix.clone();

      // Snapshot current for next drag
      const curMat = new THREE.Matrix4();
      subs[0].getMatrixAt(instanceId, curMat);
      this._gizmoPrevMatrix = curMat.clone();

      const savedEntry = entry, savedId = instanceId;
      this._pushUndo(() => {
        const usubs = savedEntry.subMeshes || [savedEntry.mesh];
        for (const m of usubs) { m.setMatrixAt(savedId, savedPrev); m.instanceMatrix.needsUpdate = true; }
        this.showToast('Undo: gizmo transform');
        if (this.selectedEntry?.entry === savedEntry && this.selectedEntry?.instanceId === savedId) {
          if (this._gizmoDummy) {
            this._gizmoDummy.matrix.identity();
            this._gizmoDummy.applyMatrix4(savedPrev);
          }
          if (this.selectionHighlight) {
            this.selectionHighlight.matrix.identity();
            this.selectionHighlight.applyMatrix4(savedPrev);
          }
          this._gizmoPrevMatrix = savedPrev.clone();
          this.updateTransformPanel();
        }
      });
    });
  }

  _removeGizmo() {
    if (this._transformControls) {
      this._transformControls.detach();
      this.scene.remove(this._transformControls.getHelper());
      this._transformControls.dispose();
      this._transformControls = null;
    }
    if (this._gizmoDummy) {
      this.scene.remove(this._gizmoDummy);
      this._gizmoDummy = null;
    }
  }

  rotateSelected(angleDeg) {
    if (!this.selectedEntry) return;
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }
    const { entry, instanceId } = this.selectedEntry;
    const subs = entry.subMeshes || [entry.mesh];
    const mat4 = new THREE.Matrix4();
    subs[0].getMatrixAt(instanceId, mat4);
    const prevMat = mat4.clone();

    // Decompose → rotate around Y → recompose
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    mat4.decompose(pos, quat, scale);
    const rotQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), angleDeg * Math.PI / 180
    );
    quat.premultiply(rotQ);
    mat4.compose(pos, quat, scale);

    for (const m of subs) {
      m.setMatrixAt(instanceId, mat4);
      m.instanceMatrix.needsUpdate = true;
    }

    // Update gizmo dummy + highlight
    if (this._gizmoDummy) {
      this._gizmoDummy.matrix.identity();
      this._gizmoDummy.applyMatrix4(mat4);
      this._gizmoPrevMatrix = mat4.clone();
    }
    if (this.selectionHighlight) {
      this.selectionHighlight.matrix.identity();
      this.selectionHighlight.applyMatrix4(mat4);
    }

    // Push undo
    const savedEntry = entry, savedId = instanceId, savedMat = prevMat;
    this._pushUndo(() => {
      const usubs = savedEntry.subMeshes || [savedEntry.mesh];
      for (const m of usubs) { m.setMatrixAt(savedId, savedMat); m.instanceMatrix.needsUpdate = true; }
      if (this._gizmoDummy) {
        this._gizmoDummy.matrix.identity();
        this._gizmoDummy.applyMatrix4(savedMat);
        this._gizmoPrevMatrix = savedMat.clone();
      }
      if (this.selectionHighlight) {
        this.selectionHighlight.matrix.identity();
        this.selectionHighlight.applyMatrix4(savedMat);
      }
      this.updateTransformPanel();
      this.showToast('Undo: rotate');
    });

    this.updateTransformPanel();
  }

  deselectMesh() {
    this._removeGizmo();
    if (this.selectionHighlight) {
      this.scene.remove(this.selectionHighlight);
      this.selectionHighlight.geometry = null; // don't dispose shared geometry
      this.selectionHighlight = null;
    }
    this.selectedEntry = null;
    document.getElementById('transform-panel').classList.remove('visible');
  }

  // ─── Transform Panel ────────────────────────────────
  setupTransformPanel() {
    const panel = document.getElementById('transform-panel');

    // Close button
    document.getElementById('xf-close').addEventListener('click', () => this.deselectMesh());

    // Copy/duplicate button
    document.getElementById('xf-copy').addEventListener('click', () => {
      if (!this.selectedEntry) return;
      if (this.isOriginalMap) {
        this.showToast('Cannot modify original map — save as custom first');
        return;
      }
      this.duplicateSelected();
    });

    // Delete button
    document.getElementById('xf-delete').addEventListener('click', () => {
      if (!this.selectedEntry) return;
      if (this.isOriginalMap) {
        this.showToast('Cannot modify original map — save as custom first');
        return;
      }
      const { entry, instanceId } = this.selectedEntry;
      const subs = entry.subMeshes || [entry.mesh];
      // Snapshot for undo
      const oldMat = new THREE.Matrix4();
      subs[0].getMatrixAt(instanceId, oldMat);
      const savedMat = oldMat.clone();
      this._pushUndo(() => {
        for (const m of subs) { m.setMatrixAt(instanceId, savedMat); m.instanceMatrix.needsUpdate = true; }
        this.showToast('Undo: restored deleted instance');
      });
      // Hide the instance by setting scale to 0
      const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const m of subs) { m.setMatrixAt(instanceId, zeroMat); m.instanceMatrix.needsUpdate = true; }
      this.showToast('Entity deleted — Ctrl+Z to undo');
      this.deselectMesh();
    });

    // Direction buttons
    panel.querySelectorAll('.xf-btn[data-axis]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.selectedEntry) return;
        const axis = btn.dataset.axis;
        const dir = parseInt(btn.dataset.dir);
        const step = parseFloat(document.getElementById('xf-step').value) || 100;
        this.moveSelected(axis, dir * step);
      });
    });

    // Rotation buttons
    panel.querySelectorAll('.xf-btn[data-rot]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.selectedEntry) return;
        this.rotateSelected(parseInt(btn.dataset.rot));
      });
    });

    // Keyboard shortcuts for transform (arrow keys + PgUp/PgDn + Q/E rotate)
    document.addEventListener('keydown', (e) => {
      const hasMulti = this.multiSelection?.length > 0;
      if (!this.selectedEntry && !hasMulti) return;
      if (document.pointerLockElement) return; // don't interfere with FPS controls
      if (e.target.tagName === 'INPUT') return;

      // Q/E rotation (single selection only)
      if (this.selectedEntry) {
        if (e.code === 'KeyQ') { this.rotateSelected(-90); e.preventDefault(); return; }
        if (e.code === 'KeyE') { this.rotateSelected(90);  e.preventDefault(); return; }
      }

      const step = parseFloat(document.getElementById('xf-step')?.value) || 100;

      // Multi-select arrow movement (no single entity selected)
      if (hasMulti && !this.selectedEntry) {
        switch (e.code) {
          case 'ArrowLeft':  this.moveMultiSelection('x', -step); e.preventDefault(); break;
          case 'ArrowRight': this.moveMultiSelection('x',  step); e.preventDefault(); break;
          case 'ArrowUp':    this.moveMultiSelection('z', -step); e.preventDefault(); break;
          case 'ArrowDown':  this.moveMultiSelection('z',  step); e.preventDefault(); break;
          case 'PageUp':     this.moveMultiSelection('y',  step); e.preventDefault(); break;
          case 'PageDown':   this.moveMultiSelection('y', -step); e.preventDefault(); break;
        }
        return;
      }

      // Single-entity arrow movement
      switch (e.code) {
        case 'ArrowLeft':  this.moveSelected('x', -step); e.preventDefault(); break;
        case 'ArrowRight': this.moveSelected('x',  step); e.preventDefault(); break;
        case 'ArrowUp':    this.moveSelected('z', -step); e.preventDefault(); break;
        case 'ArrowDown':  this.moveSelected('z',  step); e.preventDefault(); break;
        case 'PageUp':     this.moveSelected('y',  step); e.preventDefault(); break;
        case 'PageDown':   this.moveSelected('y', -step); e.preventDefault(); break;
      }
    });
  }

  moveSelected(axis, amount) {
    if (!this.selectedEntry) return;
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }
    const { entry, instanceId } = this.selectedEntry;
    const subs = entry.subMeshes || [entry.mesh];

    // Get current transform
    const mat4 = new THREE.Matrix4();
    subs[0].getMatrixAt(instanceId, mat4);
    const prevMat = mat4.clone();

    // Apply translation
    const offset = new THREE.Vector3();
    if (axis === 'x') offset.x = amount;
    if (axis === 'y') offset.y = amount;
    if (axis === 'z') offset.z = amount;

    const translation = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
    mat4.premultiply(translation);

    // Update all sub-meshes
    for (const m of subs) {
      m.setMatrixAt(instanceId, mat4);
      m.instanceMatrix.needsUpdate = true;
    }

    // Push undo (capture closure values)
    const savedEntry = entry, savedId = instanceId, savedMat = prevMat;
    this._pushUndo(() => {
      const usubs = savedEntry.subMeshes || [savedEntry.mesh];
      for (const m of usubs) { m.setMatrixAt(savedId, savedMat); m.instanceMatrix.needsUpdate = true; }
      if (this.selectionHighlight) {
        this.selectionHighlight.position.sub(offset);
      }
      this.updateTransformPanel();
      this.showToast('Undo: move');
    });

    // Update highlight
    if (this.selectionHighlight) {
      this.selectionHighlight.position.add(offset);
    }

    this.updateTransformPanel();
  }

  moveMultiSelection(axis, amount) {
    if (!this.multiSelection?.length) return;
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }

    const offset = new THREE.Vector3();
    if (axis === 'x') offset.x = amount;
    if (axis === 'y') offset.y = amount;
    if (axis === 'z') offset.z = amount;
    const translation = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
    const mat4 = new THREE.Matrix4();

    // Snapshot for undo
    const snapshots = this.multiSelection.map(({ entry, instanceId }) => {
      const subs = entry.subMeshes || [entry.mesh];
      const m = new THREE.Matrix4();
      subs[0].getMatrixAt(instanceId, m);
      return { entry, instanceId, mat: m.clone() };
    });

    // Apply move to every selected instance
    for (const { entry, instanceId } of this.multiSelection) {
      const subs = entry.subMeshes || [entry.mesh];
      subs[0].getMatrixAt(instanceId, mat4);
      mat4.premultiply(translation);
      for (const m of subs) { m.setMatrixAt(instanceId, mat4); m.instanceMatrix.needsUpdate = true; }
    }

    // Shift the green wireframe highlights
    for (const h of this.multiHighlights) h.position.add(offset);

    // Push undo
    const savedOffset = offset.clone();
    this._pushUndo(() => {
      for (const { entry, instanceId, mat } of snapshots) {
        const subs = entry.subMeshes || [entry.mesh];
        for (const m of subs) { m.setMatrixAt(instanceId, mat); m.instanceMatrix.needsUpdate = true; }
      }
      // Restore highlights at original positions
      this._clearMultiHighlights();
      for (const { entry, instanceId } of this.multiSelection) this._addMultiHighlight(entry, instanceId);
      this.showToast('Undo: move');
    });
  }

  updateTransformPanel() {
    const { entry, instanceId } = this.selectedEntry;
    const subs = entry.subMeshes || [entry.mesh];

    const mat4 = new THREE.Matrix4();
    subs[0].getMatrixAt(instanceId, mat4);
    const pos = new THREE.Vector3();
    pos.setFromMatrixPosition(mat4);

    document.getElementById('xf-title').textContent = `Selected: ${entry.glbName || 'mesh'}`;
    document.getElementById('xf-x').textContent = pos.x.toFixed(0);
    document.getElementById('xf-y').textContent = pos.y.toFixed(0);
    document.getElementById('xf-z').textContent = pos.z.toFixed(0);
  }

  // ─── Region Dialog (R key) ───────────────────────
  setupRegionDialog() {
    if (this._regionDialogSetup) {
      // On re-entry, just update defaults
      const pos = this.camera.position; const ds = 10000;
      document.getElementById('rd-min-x').value = Math.round(pos.x - ds);
      document.getElementById('rd-max-x').value = Math.round(pos.x + ds);
      document.getElementById('rd-min-z').value = Math.round(pos.z - ds);
      document.getElementById('rd-max-z').value = Math.round(pos.z + ds);
      return;
    }
    this._regionDialogSetup = true;

    const dialog = document.getElementById('region-dialog');
    const pos = this.camera.position;
    const defaultSize = 10000;

    // Set defaults
    document.getElementById('rd-min-x').value = Math.round(pos.x - defaultSize);
    document.getElementById('rd-max-x').value = Math.round(pos.x + defaultSize);
    document.getElementById('rd-min-z').value = Math.round(pos.z - defaultSize);
    document.getElementById('rd-max-z').value = Math.round(pos.z + defaultSize);

    // Close
    document.getElementById('rd-close').addEventListener('click', () => {
      dialog.classList.remove('visible');
    });

    // Use camera position
    document.getElementById('rd-use-camera').addEventListener('click', () => {
      const p = this.camera.position;
      document.getElementById('rd-min-x').value = Math.round(p.x - defaultSize);
      document.getElementById('rd-max-x').value = Math.round(p.x + defaultSize);
      document.getElementById('rd-min-z').value = Math.round(p.z - defaultSize);
      document.getElementById('rd-max-z').value = Math.round(p.z + defaultSize);
    });

    // Draw box on map mode
    this._regionDrawMode = false;
    this._rdDrawBtn = document.getElementById('rd-draw-on-map');
    this._rdDrawBtn.addEventListener('click', () => {
      this._regionDrawMode = !this._regionDrawMode;
      if (this._regionDrawMode) {
        this._rdDrawBtn.style.background = 'rgba(0,255,100,0.3)';
        this._rdDrawBtn.textContent = '✏️ Drawing… Click+drag in 3D view (right-click or Esc to cancel)';
        dialog.classList.remove('visible');
        this._showDrawHint('✏️ Box Draw: Click+drag on terrain to define region | Right-click or Esc to cancel');
        this.showToast('Click and drag on the terrain to draw a region box');
      } else {
        this._rdDrawBtn.style.background = '';
        this._rdDrawBtn.textContent = '✏️ Draw Box on Map (click+drag)';
        this._hideDrawHint();
      }
    });

    // Pen mode
    document.getElementById('rd-pen-mode').addEventListener('click', () => {
      this._startPenMode();
    });

    // Preview
    document.getElementById('rd-preview').addEventListener('click', () => {
      this._updateRegionPreviewFromDialog();
      const r = this._getRegionDialogBounds();
      this._update3DRegionBox(r);
      this._pendingRegion = r;
      this._showRegionActionBar(r);
      dialog.classList.remove('visible');
    });

    // Apply (from dialog directly)
    document.getElementById('rd-apply').addEventListener('click', () => {
      this._applyRegionAction();
      dialog.classList.remove('visible');
    });

    // Clear
    document.getElementById('rd-clear').addEventListener('click', () => {
      this.entitySystem.regionFilter = null;
      if (this.terrainSystem) this.terrainSystem.setRegionClip(null);
      this._hideRegionPreview();
      this._remove3DRegionBox();
      this._hideRegionActionBar();
      this._pendingRegion = null;
      document.getElementById('rd-stats').textContent = 'No region filter active';
      this.showToast('Full map restored');
    });

    // Save arena
    document.getElementById('rd-save-arena').addEventListener('click', () => {
      this.openSaveDialog();
    });

    // Full export
    document.getElementById('rd-full-export').addEventListener('click', () => {
      this.exportFullMap();
    });

    // Full import
    document.getElementById('rd-full-import').addEventListener('click', () => {
      this.importFullMap();
    });
  }

  toggleRegionDialog() {
    const dialog = document.getElementById('region-dialog');
    const isVisible = dialog.classList.contains('visible');
    if (isVisible) {
      dialog.classList.remove('visible');
      // Hide the 3D box when dialog is closed (unless filter is active — keep showing then)
      if (!this.entitySystem?.regionFilter) {
        this._remove3DRegionBox();
      }
    } else {
      // Update coords to current camera
      const p = this.camera.position;
      const defaultSize = 10000;
      if (!this.entitySystem.regionFilter) {
        document.getElementById('rd-min-x').value = Math.round(p.x - defaultSize);
        document.getElementById('rd-max-x').value = Math.round(p.x + defaultSize);
        document.getElementById('rd-min-z').value = Math.round(p.z - defaultSize);
        document.getElementById('rd-max-z').value = Math.round(p.z + defaultSize);
      }
      dialog.classList.add('visible');
      // Show the 3D box while dialog is open
      const r = this._getRegionDialogBounds();
      this._update3DRegionBox(r);
    }
  }

  _getRegionDialogBounds() {
    return {
      minX: parseFloat(document.getElementById('rd-min-x').value) || 0,
      maxX: parseFloat(document.getElementById('rd-max-x').value) || 100000,
      minZ: parseFloat(document.getElementById('rd-min-z').value) || -100000,
      maxZ: parseFloat(document.getElementById('rd-max-z').value) || 0,
    };
  }

  // ─── Mouse World Pos helper ─────────────────────────
  _getMouseWorldPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    // Terrain intersection first (most accurate)
    if (this.terrainSystem) {
      const hits = raycaster.intersectObjects(this.terrainSystem.terrainMeshes, false);
      if (hits.length > 0) return hits[0].point;
    }
    // Fallback: horizontal plane slightly below camera
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.camera.position.y - 3000));
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, target)) return target;
    return null;
  }

  _raycastHandles(e) {
    if (!this._regionHandles || !this._regionHandles.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    const hits = raycaster.intersectObjects(this._regionHandles, false);
    return hits.length > 0 ? hits[0].object : null;
  }

  _updateHandleDrag(e) {
    const world = this._getMouseWorldPos(e);
    if (!world || !this._draggingHandle) return;
    const h = this._draggingHandle;
    const idx = h.userData.cornerIndex;

    // Move only the dragged corner
    if (!this._regionCorners) {
      const r = this._getRegionDialogBounds();
      this._regionCorners = [
        { x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ },
        { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.maxZ },
      ];
    }
    this._regionCorners[idx] = { x: world.x, z: world.z };

    // Compute bounding rect from all 4 independent corners
    const xs = this._regionCorners.map(c => c.x);
    const zs = this._regionCorners.map(c => c.z);
    const r = {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };

    // Sync dialog fields
    document.getElementById('rd-min-x').value = Math.round(r.minX);
    document.getElementById('rd-max-x').value = Math.round(r.maxX);
    document.getElementById('rd-min-z').value = Math.round(r.minZ);
    document.getElementById('rd-max-z').value = Math.round(r.maxZ);
    this._update3DRegionBox(r);
    const info = document.getElementById('rab-info');
    if (info) info.textContent = `${((r.maxX-r.minX)/1000).toFixed(1)}k × ${Math.abs((r.maxZ-r.minZ)/1000).toFixed(1)}k — drag white corners to resize`;
  }

  _updateRegionPreviewFromDialog() {
    const box = document.getElementById('minimap-region-box');
    if (!box || !this._mmBounds) return;
    const r = this._getRegionDialogBounds();
    const b = this._mmBounds;
    const canvas = this._mmCanvas;
    const rect = canvas.getBoundingClientRect();

    const x1 = ((r.minX - b.minX) / (b.maxX - b.minX)) * rect.width;
    const x2 = ((r.maxX - b.minX) / (b.maxX - b.minX)) * rect.width;
    const z1 = ((r.minZ - b.minZ) / (b.maxZ - b.minZ)) * rect.height;
    const z2 = ((r.maxZ - b.minZ) / (b.maxZ - b.minZ)) * rect.height;

    box.style.left = `${Math.min(x1, x2)}px`;
    box.style.top = `${Math.min(z1, z2)}px`;
    box.style.width = `${Math.abs(x2 - x1)}px`;
    box.style.height = `${Math.abs(z2 - z1)}px`;
    box.style.display = 'block';
  }

  // ─── 3D Region Box ─────────────────────────────────
  _update3DRegionBox(r) {
    this._remove3DRegionBox();
    // Reset stored corners unless handle drag is in progress
    if (!this._draggingHandle) this._regionCorners = null;
    if (!r) return;

    // Determine the 4 corner positions
    let corners;
    if (this._regionCorners) {
      corners = this._regionCorners.map(c => ({ x: c.x, z: c.z }));
    } else {
      corners = [
        { x: r.minX, z: r.minZ },
        { x: r.maxX, z: r.minZ },
        { x: r.maxX, z: r.maxZ },
        { x: r.minX, z: r.maxZ },
      ];
      this._regionCorners = corners.map(c => ({ ...c }));
    }

    // Sample heights at 4 corners
    let minY = -500, maxY = 8000;
    if (this.terrainSystem) {
      let hMin = Infinity, hMax = -Infinity;
      for (const c of corners) {
        const h = this.terrainSystem.getHeightAt(c.x, c.z);
        if (h !== null) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
      }
      if (hMin !== Infinity) { minY = hMin - 300; maxY = hMax + 5000; }
    }

    const sizeY = maxY - minY;
    const cy = (minY + maxY) / 2;

    this._regionBoxGroup = new THREE.Group();
    this._regionBoxGroup.name = 'region-box-group';
    this.scene.add(this._regionBoxGroup);

    // Build wireframe connecting the 4 corners (top and bottom quads + 4 vertical edges)
    const c = corners; // shorthand: 0=BL, 1=BR, 2=TR, 3=TL
    const edgeVerts = [];
    // Bottom quad
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      edgeVerts.push(a.x, minY, a.z, b.x, minY, b.z);
    }
    // Top quad
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      edgeVerts.push(a.x, maxY, a.z, b.x, maxY, b.z);
    }
    // Vertical edges
    for (const p of c) {
      edgeVerts.push(p.x, minY, p.z, p.x, maxY, p.z);
    }

    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
    const wireMat = new THREE.LineBasicMaterial({ color: 0x00ff55, transparent: true, opacity: 0.85, depthTest: false });
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    wire.renderOrder = 999;
    this._regionBoxGroup.add(wire);

    // Semi-transparent walls (4 sides + top/bottom as triangulated quads)
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x00ff55, transparent: true, opacity: 0.05,
      side: THREE.DoubleSide, depthWrite: false,
    });
    // Build 6 faces from 4 corners (bottom, top, 4 sides)
    const fv = []; // positions
    const fi = []; // indices
    // Helper: add a quad from 4 points as 2 triangles
    const addQuad = (p0, p1, p2, p3) => {
      const base = fv.length / 3;
      fv.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      fi.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // Bottom face
    addQuad(
      { x: c[0].x, y: minY, z: c[0].z }, { x: c[1].x, y: minY, z: c[1].z },
      { x: c[2].x, y: minY, z: c[2].z }, { x: c[3].x, y: minY, z: c[3].z }
    );
    // Top face
    addQuad(
      { x: c[0].x, y: maxY, z: c[0].z }, { x: c[1].x, y: maxY, z: c[1].z },
      { x: c[2].x, y: maxY, z: c[2].z }, { x: c[3].x, y: maxY, z: c[3].z }
    );
    // 4 side walls
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      addQuad(
        { x: a.x, y: minY, z: a.z }, { x: b.x, y: minY, z: b.z },
        { x: b.x, y: maxY, z: b.z }, { x: a.x, y: maxY, z: a.z }
      );
    }
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fv, 3));
    fillGeo.setIndex(fi);
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.renderOrder = 998;
    this._regionBoxGroup.add(fill);

    // Pillar radius proportional to box spread
    const xs = corners.map(p => p.x), zs = corners.map(p => p.z);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanZ = Math.max(...zs) - Math.min(...zs);
    const pillarR = Math.max(spanX, spanZ) * 0.006;

    this._regionHandles = [];
    for (let ci = 0; ci < corners.length; ci++) {
      const corner = corners[ci];
      const groundH = this.terrainSystem?.getHeightAt(corner.x, corner.z) ?? minY;

      // Glowing corner pillar
      const pillarMat = new THREE.MeshBasicMaterial({ color: 0x00ff55, transparent: true, opacity: 0.75 });
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(pillarR, pillarR, sizeY, 8), pillarMat);
      pillar.position.set(corner.x, cy, corner.z);
      pillar.renderOrder = 999;
      this._regionBoxGroup.add(pillar);

      // White sphere handle (drag target) at ground level
      const handleR = pillarR * 4;
      const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(handleR, 12, 8), handleMat);
      sphere.position.set(corner.x, groundH + handleR * 2, corner.z);
      sphere.renderOrder = 1000;
      sphere.userData.cornerIndex = ci;
      this._regionBoxGroup.add(sphere);
      this._regionHandles.push(sphere);
    }
  }

  _remove3DRegionBox() {
    if (this._regionBoxGroup) {
      this._regionBoxGroup.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
      this.scene.remove(this._regionBoxGroup);
      this._regionBoxGroup = null;
    }
    this._regionHandles = [];
  }

  /** Setup ground-plane drag to draw region box in 3D viewport */
  _setupRegionDrag() {
    const canvas = this.canvas;
    let dragging = false;
    let startWorld = null;

    const exitDrawMode = () => {
      if (!this._regionDrawMode) return;
      this._regionDrawMode = false;
      dragging = false;
      startWorld = null;
      if (this.playerController) this.playerController._blockPointerLock = false;
      this.isDragSelecting = false;
      this._hideDrawHint();
      if (this._rdDrawBtn) {
        this._rdDrawBtn.style.background = '';
        this._rdDrawBtn.textContent = '✏️ Draw Box on Map (click+drag)';
      }
    };

    // RIGHT-CLICK exits draw mode
    canvas.addEventListener('contextmenu', (e) => {
      if (this._regionDrawMode) { e.preventDefault(); exitDrawMode(); this.showToast('Draw mode cancelled'); }
    });

    // ESC exits draw mode
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._regionDrawMode) { exitDrawMode(); this.showToast('Draw mode cancelled'); }
    });

    canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement) return;
      if (e.button !== 0) return;
      if (!this._regionDrawMode) return;

      const world = this._getMouseWorldPos(e);
      if (!world) return;
      startWorld = world.clone();
      dragging = true;
      this.isDragSelecting = true;
      if (this.playerController) this.playerController._blockPointerLock = true;
      e.preventDefault();
      e.stopPropagation();
    }, true); // capture phase — runs before drag-select

    window.addEventListener('mousemove', (e) => {
      if (!dragging || !startWorld || !this._regionDrawMode) return;
      const world = this._getMouseWorldPos(e);
      if (!world) return;
      const r = {
        minX: Math.min(startWorld.x, world.x), maxX: Math.max(startWorld.x, world.x),
        minZ: Math.min(startWorld.z, world.z), maxZ: Math.max(startWorld.z, world.z),
      };
      this._update3DRegionBox(r);
      document.getElementById('rd-min-x').value = Math.round(r.minX);
      document.getElementById('rd-max-x').value = Math.round(r.maxX);
      document.getElementById('rd-min-z').value = Math.round(r.minZ);
      document.getElementById('rd-max-z').value = Math.round(r.maxZ);
    });

    window.addEventListener('mouseup', (e) => {
      if (!dragging || !this._regionDrawMode) return;
      dragging = false;
      this._justFinishedDrag = true;
      exitDrawMode();

      const world = this._getMouseWorldPos(e);
      if (!world || !startWorld) return;
      const r = {
        minX: Math.min(startWorld.x, world.x), maxX: Math.max(startWorld.x, world.x),
        minZ: Math.min(startWorld.z, world.z), maxZ: Math.max(startWorld.z, world.z),
      };
      if ((r.maxX - r.minX) < 100 || Math.abs(r.maxZ - r.minZ) < 100) {
        this.showToast('Box too small — drag more to define a region');
        return;
      }

      document.getElementById('rd-min-x').value = Math.round(r.minX);
      document.getElementById('rd-max-x').value = Math.round(r.maxX);
      document.getElementById('rd-min-z').value = Math.round(r.minZ);
      document.getElementById('rd-max-z').value = Math.round(r.maxZ);
      this._pendingRegion = r;
      this._update3DRegionBox(r);
      this._showRegionActionBar(r);
      startWorld = null;
    });
  }

  // ─── Region Action Bar ─────────────────────────────
  _setupRegionActionBar() {
    document.getElementById('rab-apply').addEventListener('click', () => {
      this._applyRegionAction();
    });
    document.getElementById('rab-save').addEventListener('click', () => {
      this.openSaveDialog();
    });
    document.getElementById('rab-edit').addEventListener('click', () => {
      document.getElementById('region-dialog').classList.add('visible');
      // Show the 3D box when entering edit mode
      const r = this._getRegionDialogBounds();
      this._update3DRegionBox(r);
    });
    document.getElementById('rab-cancel').addEventListener('click', () => {
      this._remove3DRegionBox();
      this._hideRegionActionBar();
      this._hideDrawHint();
      this._pendingRegion = null;
      this._exitPenMode();
    });
  }

  _applyRegionAction() {
    const r = { ...this._getRegionDialogBounds() };
    if (this._pendingRegion?.polygon) r.polygon = this._pendingRegion.polygon;
    this.entitySystem.regionFilter = r;
    if (this.terrainSystem) this.terrainSystem.setRegionClip(r);
    this._updateRegionPreviewFromDialog();
    const count = this._countEntitiesInRegion(r);
    document.getElementById('rd-stats').innerHTML =
      `<strong>Active:</strong> ${count} entities | ${((r.maxX-r.minX)/1000).toFixed(1)}k × ${Math.abs((r.maxZ-r.minZ)/1000).toFixed(1)}k`;
    this._hideRegionActionBar();
    this._hideDrawHint();
    this.showToast(`Region applied — ${count} entities visible`);
  }

  _showRegionActionBar(r) {
    const bar = document.getElementById('region-action-bar');
    const info = document.getElementById('rab-info');
    if (r) {
      const w = ((r.maxX - r.minX) / 1000).toFixed(1);
      const h = Math.abs((r.maxZ - r.minZ) / 1000).toFixed(1);
      info.textContent = `${w}k × ${h}k — drag the white corner handles to resize`;
    }
    bar.classList.add('visible');
  }

  _hideRegionActionBar() {
    document.getElementById('region-action-bar').classList.remove('visible');
  }

  _showDrawHint(text) {
    const el = document.getElementById('draw-hint');
    el.textContent = text;
    el.classList.add('visible');
  }

  _hideDrawHint() {
    document.getElementById('draw-hint').classList.remove('visible');
  }

  // ─── Pen / Polygon Mode ───────────────────────────
  _setupPenMode() {
    if (this._penModeSetup) return;
    this._penModeSetup = true;
    this._penMode = false;
    this._penPoints = [];
    this._penGroup = null;
    this._penLastClick = 0;

    this.canvas.addEventListener('click', (e) => {
      if (!this._penMode) return;
      if (document.pointerLockElement) return;
      if (this._justFinishedDrag) return;
      const world = this._getMouseWorldPos(e);
      if (!world) return;
      const now = performance.now();
      const dbl = (now - this._penLastClick) < 380;
      this._penLastClick = now;
      if (dbl) { this._finishPenPolygon(); return; }
      this._addPenPoint(world);
    });

    document.addEventListener('keydown', (e) => {
      if (!this._penMode) return;
      if (e.code === 'Backspace' && e.target.tagName !== 'INPUT') {
        e.preventDefault(); this._removePenLastPoint();
      }
      if (e.code === 'Enter') this._finishPenPolygon();
      if (e.code === 'Escape') this._exitPenMode();
    });
  }

  _startPenMode() {
    this._penMode = true;
    this._penPoints = [];
    this._clearPenVisuals();
    this._regionDrawMode = false;
    if (this.playerController) this.playerController._blockPointerLock = true;
    document.getElementById('region-dialog').classList.remove('visible');
    this._showDrawHint('🖊 Pen: click terrain to add points | Double-click or Enter to finish | Backspace to undo | Esc to cancel');
  }

  _addPenPoint(worldPos) {
    this._penPoints.push(worldPos.clone());
    this._drawPenVisuals();
    this.showToast(`Point ${this._penPoints.length} added`);
  }

  _removePenLastPoint() {
    if (this._penPoints.length > 0) {
      this._penPoints.pop();
      this._drawPenVisuals();
      this.showToast(`Removed — ${this._penPoints.length} points`);
    }
  }

  _drawPenVisuals() {
    this._clearPenVisuals();
    const pts = this._penPoints;
    if (pts.length === 0) return;
    this._penGroup = new THREE.Group();
    this._penGroup.name = 'pen-group';
    this.scene.add(this._penGroup);

    const dotGeo = new THREE.SphereGeometry(180, 8, 6);
    for (let i = 0; i < pts.length; i++) {
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: i === 0 ? 0xffff00 : 0x00ffff, depthTest: false }));
      dot.position.set(pts[i].x, pts[i].y + 50, pts[i].z);
      dot.renderOrder = 1002;
      this._penGroup.add(dot);
    }

    if (pts.length >= 2) {
      const linePts = [...pts.map(p => new THREE.Vector3(p.x, p.y + 50, p.z)), new THREE.Vector3(pts[0].x, pts[0].y + 50, pts[0].z)];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.85, depthTest: false }));
      line.renderOrder = 1001;
      this._penGroup.add(line);
    }
  }

  _clearPenVisuals() {
    if (this._penGroup) {
      this._penGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
      this.scene.remove(this._penGroup);
      this._penGroup = null;
    }
  }

  _finishPenPolygon() {
    if (this._penPoints.length < 3) { this.showToast('Need at least 3 points'); return; }
    const xs = this._penPoints.map(p => p.x);
    const zs = this._penPoints.map(p => p.z);
    const r = {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
      polygon: this._penPoints.map(p => ({ x: p.x, z: p.z })),
    };
    document.getElementById('rd-min-x').value = Math.round(r.minX);
    document.getElementById('rd-max-x').value = Math.round(r.maxX);
    document.getElementById('rd-min-z').value = Math.round(r.minZ);
    document.getElementById('rd-max-z').value = Math.round(r.maxZ);
    this._pendingRegion = r;
    this._update3DRegionBox(r);
    this._clearPenVisuals();
    this._showRegionActionBar(r);
    this._hideDrawHint();
    this._penMode = false;
    if (this.playerController) this.playerController._blockPointerLock = false;
  }

  _exitPenMode() {
    this._penMode = false;
    this._penPoints = [];
    this._clearPenVisuals();
    if (this.playerController) this.playerController._blockPointerLock = false;
    this._hideDrawHint();
    this.showToast('Pen mode cancelled');
  }

  _pointInPolygon(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ─── Save Dialog (Ctrl+S) ─────────────────────────
  setupSaveDialog() {
    document.getElementById('save-cancel').addEventListener('click', () => {
      document.getElementById('save-dialog').classList.remove('visible');
    });

    document.getElementById('save-confirm').addEventListener('click', () => {
      this.performSave();
    });

    // Enter key in name field triggers save
    document.getElementById('save-map-name').addEventListener('keydown', (e) => {
      if (e.code === 'Enter') this.performSave();
    });
  }

  openSaveDialog() {
    const dialog = document.getElementById('save-dialog');
    const nameInput = document.getElementById('save-map-name');
    const overwriteSection = document.getElementById('save-overwrite-section');
    const overwriteNameSpan = document.getElementById('save-overwrite-name');
    const overwriteRadio = document.getElementById('save-mode-overwrite');
    const newRadio = document.getElementById('save-mode-new');

    // Show overwrite option if editing an existing custom map
    if (this._currentCustomMap) {
      overwriteSection.style.display = 'block';
      overwriteNameSpan.textContent = this._currentCustomMap.name;
      overwriteRadio.checked = true;
      nameInput.value = this._currentCustomMap.name;
    } else {
      overwriteSection.style.display = 'none';
      newRadio.checked = true;
      // Auto-suggest name based on current region
      const r = this.entitySystem?.regionFilter;
      if (r) {
        nameInput.value = `arena-${Math.round(r.minX/1000)}k-${Math.round(r.maxX/1000)}k`;
      } else {
        nameInput.value = `full-map-${Date.now()}`;
      }
    }

    dialog.classList.add('visible');
    nameInput.focus();
    nameInput.select();
  }

  performSave() {
    const nameInput = document.getElementById('save-map-name');
    const name = nameInput.value.trim();
    if (!name) {
      this.showToast('Please enter a map name');
      return;
    }

    // Sanitize name
    const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-');

    const r = this.entitySystem.regionFilter;

    // Read CURRENT scene state (reflects moves/deletes/additions)
    const entities = this.entitySystem.getCurrentEntities().filter(e => {
      if (!r) return true;
      const p = e.worldPos;
      return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
    });

    const exportData = {
      name: safeName,
      region: r || null,
      entityCount: entities.length,
      created: Date.now(),
      entities,
    };

    // Download as file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Check if overwriting existing or saving as new
    const isOverwrite = this._currentCustomMap &&
      document.getElementById('save-mode-overwrite')?.checked;

    if (isOverwrite) {
      // Update existing entry
      const idx = this.customMaps.indexOf(this._currentCustomMap);
      if (idx >= 0) {
        this.customMaps[idx] = {
          name: safeName, region: r, entityCount: entities.length,
          created: this._currentCustomMap.created, updated: Date.now(),
        };
        this._currentCustomMap = this.customMaps[idx];
      }
    } else {
      // Save as new custom map
      const cmEntry = {
        name: safeName, region: r, entityCount: entities.length,
        created: Date.now(),
      };
      this.customMaps.push(cmEntry);
      this._currentCustomMap = cmEntry;
    }

    this.saveCustomMapList();

    // Store entity data separately (keyed by map name)
    try {
      localStorage.setItem('jx3-map-entities-' + safeName, JSON.stringify(entities));
    } catch (e) {
      console.warn('Could not store entities in localStorage:', e);
      this.showToast('Warning: entity data too large for local storage — use the downloaded JSON file');
    }

    document.getElementById('save-dialog').classList.remove('visible');
    this.showToast(`Saved: ${safeName} (${entities.length} entities)`);

    // Unlock the map for editing after saving a copy
    if (this.isOriginalMap) {
      this.isOriginalMap = false;
      document.getElementById('lock-indicator').style.display = 'none';
      this.showToast('Map unlocked for editing');
    }
  }

  _collectCurrentSceneEntities(region = null) {
    if (!this.entitySystem) return [];

    const out = [];
    const mat4 = new THREE.Matrix4();

    for (const entry of this.entitySystem.instancedMeshes) {
      const glbName = entry.glbName || '';
      if (!glbName) continue;

      const subs = entry.subMeshes || [entry.mesh];
      const primary = subs[0];
      if (!primary) continue;

      for (let i = 0; i < primary.count; i++) {
        primary.getMatrixAt(i, mat4);
        const e = mat4.elements;

        // Skip deleted/zero-scale slots.
        const sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
        if (sx < 0.001) continue;

        const worldPos = { x: e[12], y: e[13], z: e[14] };
        if (region) {
          if (worldPos.x < region.minX || worldPos.x > region.maxX ||
              worldPos.z < region.minZ || worldPos.z > region.maxZ) {
            continue;
          }
          if (region.polygon && !this._pointInPolygon(worldPos.x, worldPos.z, region.polygon)) {
            continue;
          }
        }

        out.push({
          mesh: glbName,
          matrix: Array.from(e),
          worldPos,
        });
      }
    }

    return out;
  }

  // ─── Full Export (terrain + entities + GLBs list) ────
  async exportFullMap() {
    if (!this.entitySystem) {
      this.showToast('Entity system not ready');
      return;
    }

    const region = this.entitySystem.regionFilter || null;
    const entities = this._collectCurrentSceneEntities(region);
    if (entities.length === 0) {
      this.showToast('No entities to export');
      return;
    }

    const btn = document.getElementById('rd-full-export');
    const prevText = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Building full export on Desktop...';
    }

    try {
      const exportName = this._currentCustomMap?.name || `full-map-${Date.now()}`;
      const payload = {
        name: exportName,
        sourceMapPath: this.currentMapPath || 'map-data',
        region,
        regionCorners: this._regionCorners || null,
        entities,
      };

      const res = await fetch('/api/export-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Export failed (${res.status})`);
      }

      const st = data.stats || {};
      const msg = `FULL export done: ${st.entities || entities.length} entities, ${st.meshesCopied || 0}/${st.meshesRequested || 0} GLBs, ${st.heightmapsCopied || 0} heightmaps`;
      this.showToast(msg);

      // Open full viewer directly to the new package.
      if (data.viewerUrl) {
        const win = window.open(data.viewerUrl, '_blank');
        if (!win) this.showToast('Export done. Open /full-viewer.html to load the package');
      }
    } catch (err) {
      console.error('Full export failed:', err);
      this.showToast(`Full export failed: ${err.message || err}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText || '📦 Full Export';
      }
    }
  }

  // ─── Import Full Export ────────────────────────────
  importFullMap() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await this._loadImportedMap(data);
      } catch (err) {
        console.error('Import error:', err);
        this.showToast('Import failed: ' + err.message);
      }
    });
    input.click();
  }

  async _loadImportedMap(data) {
    if (!data.entities?.length) {
      this.showToast('No entities in import data');
      return;
    }

    // If version 2 export with terrain data — rebuild terrain
    if (data.version >= 2 && data.terrainTiles && data.terrainConfig) {
      // Reconstruct terrain heightmaps from base64
      const ts = this.terrainSystem;
      if (ts) {
        for (const [key, b64] of Object.entries(data.terrainTiles)) {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const hd = new Float32Array(bytes.buffer);
          ts.heightmaps.set(key, hd);
          // Rebuild mesh for this tile
          const [rx, ry] = key.split('_').map(Number);
          ts.createRegionMesh(rx, ry, hd);
        }
        ts.buildMinimap();
        this.showToast(`Rebuilt ${Object.keys(data.terrainTiles).length} terrain tiles`);
      }
    }

    // Apply region filter
    if (data.region) {
      this.entitySystem.regionFilter = data.region;
      if (this.terrainSystem) this.terrainSystem.setRegionClip(data.region);
      document.getElementById('rd-min-x').value = Math.round(data.region.minX);
      document.getElementById('rd-max-x').value = Math.round(data.region.maxX);
      document.getElementById('rd-min-z').value = Math.round(data.region.minZ);
      document.getElementById('rd-max-z').value = Math.round(data.region.maxZ);
      this._update3DRegionBox(data.region);
    }

    // Restore corners if present
    if (data.regionCorners) {
      this._regionCorners = data.regionCorners;
      if (data.region) this._update3DRegionBox(data.region);
    }

    // Restore entities
    this._restoreSavedEntities(data.entities);
    this.showToast(`Imported: ${data.entities.length} entities from "${data.name}"`);

    // Track as custom map
    this._currentCustomMap = {
      name: data.name,
      region: data.region,
      entityCount: data.entities.length,
      created: data.created,
    };
    this.isOriginalMap = false;
    document.getElementById('lock-indicator').style.display = 'none';
  }

  // ─── Drag-Select ─────────────────────────────────
  setupDragSelect() {
    const box = document.getElementById('drag-select-box');
    let startX = 0, startY = 0;
    let isDragging = false;

    this.canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement) return;
      if (e.button !== 0) return; // left button only
      if (document.getElementById('region-dialog').classList.contains('visible')) return;
      if (document.getElementById('save-dialog').classList.contains('visible')) return;
      if (this._penMode) return; // pen mode handles clicks separately
      if (this._regionDrawMode) return; // don't drag-select while drawing region

      // Priority: check corner handles before drag-select (works in all modes)
      if (this._regionHandles?.length) {
        const hit = this._raycastHandles(e);
        if (hit) {
          this._draggingHandle = hit;
          this.isDragSelecting = true;
          if (this.playerController) this.playerController._blockPointerLock = true;
          return; // don't start box drag-select
        }
      }

      // Only start drag-select in select mode
      if (this._editMode !== 'select') return;

      // Start potential drag-select
      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;
      this.isDragSelecting = false;
    });

    window.addEventListener('mousemove', (e) => {
      // Handle corner drag takes priority over everything
      if (this._draggingHandle) { this._updateHandleDrag(e); return; }
      if (document.pointerLockElement) return;
      if (e.buttons !== 1) return; // left button held
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      // Start drag-select after moving 10px threshold
      if (!this.isDragSelecting && (dx > 10 || dy > 10)) {
        this.isDragSelecting = true;
        isDragging = true;
        // Block pointer lock during drag
        if (this.playerController) this.playerController._blockPointerLock = true;
        box.style.display = 'block';
      }
      if (this.isDragSelecting) {
        const x = Math.min(e.clientX, startX);
        const y = Math.min(e.clientY, startY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
      }
    });

    window.addEventListener('mouseup', (e) => {
      // Finish handle drag
      if (this._draggingHandle) {
        this._draggingHandle = null;
        this.isDragSelecting = false;
        this._justFinishedDrag = true;
        setTimeout(() => { if (this.playerController) this.playerController._blockPointerLock = false; }, 50);
        // Update action bar with new bounds
        const r = this._getRegionDialogBounds();
        this._showRegionActionBar(r);
        return;
      }

      if (this.isDragSelecting) {
        this.isDragSelecting = false;
        this._justFinishedDrag = true; // prevent click-to-pick right after drag
        box.style.display = 'none';
        setTimeout(() => {
          if (this.playerController) this.playerController._blockPointerLock = false;
        }, 50);

        const x1 = Math.min(e.clientX, startX);
        const y1 = Math.min(e.clientY, startY);
        const x2 = Math.max(e.clientX, startX);
        const y2 = Math.max(e.clientY, startY);

        if ((x2 - x1) > 10 || (y2 - y1) > 10) {
          this.performBoxSelect(x1, y1, x2, y2);
        }
      }
      isDragging = false;
    });

    // Multi-select bar buttons
    document.getElementById('msb-deselect').addEventListener('click', () => this.clearMultiSelection());
    document.getElementById('msb-delete').addEventListener('click', () => this.deleteMultiSelection());
    document.getElementById('msb-copy').addEventListener('click', () => this.copyMultiSelection());
  }

  performBoxSelect(x1, y1, x2, y2) {
    const rect = this.canvas.getBoundingClientRect();
    this.clearMultiSelection();

    // For each visible instanced mesh group, project center to screen and check if in box
    for (const entry of this.entitySystem.instancedMeshes) {
      const subs = entry.subMeshes || [entry.mesh];
      if (!subs[0].visible || subs[0].count === 0) continue;

      const primaryMesh = subs[0];
      const mat4 = new THREE.Matrix4();

      for (let i = 0; i < primaryMesh.count; i++) {
        primaryMesh.getMatrixAt(i, mat4);
        const pos = new THREE.Vector3();
        pos.setFromMatrixPosition(mat4);

        // Check if scale is zero (deleted instance)
        const sx = mat4.elements[0] * mat4.elements[0] + mat4.elements[1] * mat4.elements[1] + mat4.elements[2] * mat4.elements[2];
        if (sx < 0.001) continue;

        // Project to screen
        const projected = pos.clone().project(this.camera);
        const screenX = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
        const screenY = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;

        // Check if behind camera
        if (projected.z > 1) continue;

        if (screenX >= x1 && screenX <= x2 && screenY >= y1 && screenY <= y2) {
          this.multiSelection.push({ entry, instanceId: i });
          this._addMultiHighlight(entry, i);
        }
      }
    }

    if (this.multiSelection.length > 0) {
      this.deselectMesh(); // clear single selection
      document.getElementById('msb-info').textContent = `${this.multiSelection.length} selected`;
      document.getElementById('multi-select-bar').classList.add('visible');
      this.showToast(`Selected ${this.multiSelection.length} instances`);
    }
  }

  clearMultiSelection() {
    this.multiSelection = [];
    this._clearMultiHighlights();
    document.getElementById('multi-select-bar').classList.remove('visible');
  }

  deleteMultiSelection() {
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }
    // Snapshot transforms for undo
    const snapshots = this.multiSelection.map(({ entry, instanceId }) => {
      const subs = entry.subMeshes || [entry.mesh];
      const m = new THREE.Matrix4();
      subs[0].getMatrixAt(instanceId, m);
      return { entry, instanceId, mat: m.clone() };
    });
    this._pushUndo(() => {
      for (const { entry, instanceId, mat } of snapshots) {
        const subs = entry.subMeshes || [entry.mesh];
        for (const m of subs) { m.setMatrixAt(instanceId, mat); m.instanceMatrix.needsUpdate = true; }
      }
      this.showToast(`Undo: restored ${snapshots.length} instances`);
    });

    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const { entry, instanceId } of this.multiSelection) {
      const subs = entry.subMeshes || [entry.mesh];
      for (const m of subs) {
        m.setMatrixAt(instanceId, zeroMat);
        m.instanceMatrix.needsUpdate = true;
      }
    }
    this.showToast(`Deleted ${this.multiSelection.length} instances — Ctrl+Z to undo`);
    this.clearMultiSelection();
  }

  copyMultiSelection() {
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }
    if (!this.multiSelection.length) { this.showToast('Nothing selected'); return; }

    // Group selected items by entry
    const byEntry = new Map();
    for (const item of this.multiSelection) {
      if (!byEntry.has(item.entry)) byEntry.set(item.entry, []);
      byEntry.get(item.entry).push(item);
    }

    const placed = [];
    const checkMat = new THREE.Matrix4();
    const srcMat = new THREE.Matrix4();

    for (const [entry, items] of byEntry) {
      const subs = entry.subMeshes || [entry.mesh];
      const primary = subs[0];
      const oldCount = primary.count;

      // Find existing zero-scale (deleted) slots
      const freeSlots = [];
      for (let i = 0; i < primary.count; i++) {
        primary.getMatrixAt(i, checkMat);
        const sx = checkMat.elements[0] ** 2 + checkMat.elements[1] ** 2 + checkMat.elements[2] ** 2;
        if (sx < 0.001) { freeSlots.push(i); if (freeSlots.length >= items.length) break; }
      }

      // Grow InstancedMesh if not enough free slots
      const deficit = items.length - freeSlots.length;
      if (deficit > 0) {
        const prevCount = this._growInstancedMeshEntry(entry, deficit);
        for (let i = prevCount; i < prevCount + deficit; i++) freeSlots.push(i);
      }

      // Place copies adjacent to originals
      for (let i = 0; i < items.length; i++) {
        const { instanceId } = items[i];
        // Re-ref subs after potential grow
        const newSubs = entry.subMeshes || [entry.mesh];
        newSubs[0].getMatrixAt(instanceId, srcMat);
        const newMat = srcMat.clone();
        // Offset: 600 units in X + small Z spread so copies aren't stacked
        newMat.elements[12] += 600 + i * 30;
        newMat.elements[14] += i * 30;

        for (const m of newSubs) {
          m.setMatrixAt(freeSlots[i], newMat);
          m.instanceMatrix.needsUpdate = true;
        }
        placed.push({ entry, instanceId: freeSlots[i] });
      }
    }

    // Push undo: zero out the placed copies
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    const placedSnapshot = [...placed];
    this._pushUndo(() => {
      for (const { entry, instanceId } of placedSnapshot) {
        const subs = entry.subMeshes || [entry.mesh];
        for (const m of subs) { m.setMatrixAt(instanceId, zeroMat); m.instanceMatrix.needsUpdate = true; }
      }
      this.clearMultiSelection();
      this.showToast(`Undo: removed ${placedSnapshot.length} duplicates`);
    });

    // Select the new copies with green outlines
    this._clearMultiHighlights();
    this.multiSelection = placed;
    for (const { entry, instanceId } of placed) this._addMultiHighlight(entry, instanceId);
    document.getElementById('msb-info').textContent = `${placed.length} copied — move with arrow keys`;
    document.getElementById('multi-select-bar').classList.add('visible');
    this.showToast(`Duplicated ${placed.length} instances — Ctrl+Z to undo`);
  }

  // ─── Duplicate Selected ──────────────────────────
  duplicateSelected() {
    if (!this.selectedEntry) return;
    const { entry, instanceId } = this.selectedEntry;
    const subs = entry.subMeshes || [entry.mesh];

    // Get current transform
    const srcMat = new THREE.Matrix4();
    subs[0].getMatrixAt(instanceId, srcMat);

    // Offset the copy by 500 units in X
    const offset = new THREE.Matrix4().makeTranslation(500, 0, 0);
    const newMat = srcMat.clone().premultiply(offset);

    // Find an unused instance slot (scale=0) in the same group
    let placed = false;
    for (let i = 0; i < subs[0].count; i++) {
      const checkMat = new THREE.Matrix4();
      subs[0].getMatrixAt(i, checkMat);
      const sx = checkMat.elements[0] * checkMat.elements[0] +
                 checkMat.elements[1] * checkMat.elements[1] +
                 checkMat.elements[2] * checkMat.elements[2];
      if (sx < 0.001) {
        // This slot is "deleted" — reuse it
        for (const m of subs) {
          m.setMatrixAt(i, newMat);
          m.instanceMatrix.needsUpdate = true;
        }
        this.showToast(`Duplicated to slot #${i} (offset +500 X)`);
        this.selectMesh(entry, i);
        placed = true;
        break;
      }
    }

    if (!placed) {
      this.showToast('No free instance slots — delete an instance first');
    }
  }

  // ─── Add Mesh to Map ──────────────────────────────
  addMeshToMap(glbPath) {
    if (this.isOriginalMap) {
      this.showToast('Cannot modify original map — save as custom first');
      return;
    }

    // Find an existing InstancedMesh group for this glbPath
    const targetGlbName = glbPath.split('/').pop().toLowerCase();
    let targetEntry = null;
    for (const entry of this.entitySystem.instancedMeshes) {
      if (entry.glbName === targetGlbName) {
        targetEntry = entry;
        break;
      }
    }

    if (!targetEntry) {
      this.showToast('Mesh not loaded — cannot add unloaded mesh');
      return;
    }

    // Place at camera position
    const pos = this.camera.position.clone();
    // Look for terrain height at camera XZ
    if (this.terrainSystem) {
      const th = this.terrainSystem.getHeightAt(pos.x, pos.z);
      if (th !== null) pos.y = th;
    }

    const newMat = new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z);
    const subs = targetEntry.subMeshes || [targetEntry.mesh];

    // Find a deleted (zero-scale) slot or grow capacity
    let slotFound = false;
    for (let i = 0; i < subs[0].count; i++) {
      const checkMat = new THREE.Matrix4();
      subs[0].getMatrixAt(i, checkMat);
      const sx = checkMat.elements[0] * checkMat.elements[0] +
                 checkMat.elements[1] * checkMat.elements[1] +
                 checkMat.elements[2] * checkMat.elements[2];
      if (sx < 0.001) {
        for (const m of subs) {
          m.setMatrixAt(i, newMat);
          m.instanceMatrix.needsUpdate = true;
        }
        this.showToast(`Added ${targetGlbName} at camera position`);
        this.selectMesh(targetEntry, i);
        slotFound = true;
        break;
      }
    }

    if (!slotFound) {
      // Grow InstancedMesh capacity and use the new slot
      const prevCount = this._growInstancedMeshEntry(targetEntry, 1);
      const newSubs = targetEntry.subMeshes || [targetEntry.mesh];
      for (const m of newSubs) {
        m.setMatrixAt(prevCount, newMat);
        m.instanceMatrix.needsUpdate = true;
      }
      this.showToast(`Added ${targetGlbName} at camera position`);
      this.selectMesh(targetEntry, prevCount);
    }
  }

  // ─── Start position ──────────────────────────────
  getStartPosition() {
    // Prefer starting near entities if loaded, otherwise map center
    if (this.entitySystem && this.entitySystem.allEntities.length > 0) {
      // Compute median entity position (more robust than mean for outliers)
      const ents = this.entitySystem.allEntities;
      const xs = ents.map(e => e.worldPos.x).sort((a, b) => a - b);
      const zs = ents.map(e => e.worldPos.z).sort((a, b) => a - b);
      const mid = Math.floor(ents.length / 2);
      const cx = xs[mid], cz = zs[mid];
      let y = 5000;
      if (this.terrainSystem) {
        const th = this.terrainSystem.getHeightAt(cx, cz);
        if (th !== null) y = th + 3000;
      }
      return { x: cx, y, z: cz };
    }

    const cfg = this.config.landscape;
    const cx = cfg.worldOriginX + (cfg.regionGridX * cfg.regionSize * cfg.unitScaleX) / 2;
    const cz = -(cfg.worldOriginY + (cfg.regionGridY * cfg.regionSize * cfg.unitScaleY) / 2); // LH→RH
    let y = 5000;
    if (this.terrainSystem) {
      const th = this.terrainSystem.getHeightAt(cx, cz);
      if (th !== null) y = th + 3000;
    }
    return { x: cx, y, z: cz };
  }

  // ─── Render loop ──────────────────────────────────
  animate() {
    if (this._stopAnimation) {
      this._stopAnimation = false;
      return;
    }
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.1); // cap delta to avoid huge jumps

    this.frameCount++;
    this.fpsTime += delta;
    if (this.fpsTime >= 1) {
      this.fps = Math.round(this.frameCount / this.fpsTime);
      this.fpsTime = 0;
      this.frameCount = 0;
    }

    if (this.playerController) this.playerController.update(delta);
    if (this.terrainSystem) this.terrainSystem.updateLOD(this.camera.position);
    if (this.entitySystem) {
      this.lodUpdateAccum += delta;
      if (this.lodUpdateAccum >= 0.12) {
        this.entitySystem.updateLOD(this.camera.position);
        this.lodUpdateAccum = 0;
      }
    }
    // Keep sky centered on camera so it never clips
    if (this.sky) this.sky.position.copy(this.camera.position);

    // Move shadow camera to follow the player for consistent shadow quality
    if (this.sunLight) {
      const target = this.camera.position;
      const dir = this.sunLight.position.clone().normalize();
      this.sunLight.position.copy(target).add(dir.multiplyScalar(100000));
      this.sunLight.target.position.copy(target);
      this.sunLight.target.updateMatrixWorld();
    }

    this.renderer.render(this.scene, this.camera);
    this.updateUI();
    this.updateMinimap();
  }

  // ─── UI ───────────────────────────────────────────
  updateUI() {
    const pos = this.camera.position;
    document.getElementById('info-cam-x').textContent = pos.x.toFixed(0);
    document.getElementById('info-cam-y').textContent = pos.y.toFixed(0);
    document.getElementById('info-cam-z').textContent = pos.z.toFixed(0);

    // Current region
    if (this.terrainSystem) {
      const cfg = this.config.landscape;
      const lx = pos.x - cfg.worldOriginX;
      const lz = (-pos.z) - cfg.worldOriginY; // RH→LH for region calc
      const rx = Math.floor(lx / this.terrainSystem.regionWorldSize);
      const rz = Math.floor(lz / this.terrainSystem.regionWorldSize);
      document.getElementById('info-region').textContent = `Region: ${rx},${rz}`;

      const h = this.terrainSystem.getHeightAt(pos.x, pos.z);
      document.getElementById('info-terrain').textContent =
        `Ground: ${h !== null ? h.toFixed(0) : 'N/A'} | Alt: ${(pos.y - (h || 0)).toFixed(0)}`;
    }

    document.getElementById('info-fps').textContent = `FPS: ${this.fps}`;

    if (this.entitySystem) {
      document.getElementById('info-objects').textContent =
        `Vis: ${this.entitySystem.visibleCount} / ${this.entitySystem.loadedCount} objs | Cap: ${this.entitySystem.maxVisibleInstances}`;
    }

    if (this.playerController) {
      const spd = this.playerController.currentSpeed;
      const mode = this.playerController.gravityEnabled ? 'Walk' : 'Fly';
      document.getElementById('info-speed').textContent =
        `Speed: ${(spd / 100).toFixed(0)} m/s [${mode}] Lvl ${this.playerController.speedLevel}`;
    }

    // Debug render stats
    const info = this.renderer.info;
    const dbg = document.getElementById('info-debug');
    if (dbg) {
      const badGeo = this.entitySystem ? this.entitySystem.invalidGeometryCount : 0;
      const badXf = this.entitySystem ? this.entitySystem.invalidTransformCount : 0;
      dbg.textContent = `Draw: ${info.render.calls} | Tri: ${(info.render.triangles / 1000).toFixed(0)}k | Geo: ${info.memory.geometries} | BadGLB: ${badGeo} | BadXf: ${badXf}`;
    }
  }

  updateLoading(status, pct) {
    document.getElementById('loading-status').textContent = status;
    document.getElementById('loading-bar').style.width = `${pct}%`;
  }

  async loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Failed: ${path} (${r.status})`);
    return r.json();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

const editor = new MapEditor();
editor.init().catch(err => {
  console.error('Init failed:', err);
});
