import * as THREE from 'three';
import { TerrainSystem } from './terrain.js';
import { EntitySystem } from './entities.js';
import { CollisionSystem } from './collision.js';
import { PlayerController } from './player-controller.js';

class FullMapViewer {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.packageSelect = document.getElementById('package-select');
    this.statusEl = document.getElementById('status');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
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
    this.fpsTime = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.lodUpdateAccum = 0;

    this.currentPackage = null;
    this.currentManifest = null;

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.playerController = null;

    this.sky = null;
    this.sunLight = null;
    this._envNodes = [];
    this._animStarted = false;

    window.addEventListener('resize', () => this.onResize());
  }

  async init() {
    document.getElementById('refresh-packages').addEventListener('click', () => this.refreshPackages());
    document.getElementById('load-package').addEventListener('click', () => this.loadSelectedPackage());
    document.getElementById('open-walk-reader').addEventListener('click', () => this.openWalkReaderForCurrentPackage());
    document.getElementById('open-resources').addEventListener('click', () => this.openResourcesForCurrentPackage());
    document.getElementById('open-validator').addEventListener('click', () => this.openValidatorForCurrentPackage());

    await this.refreshPackages();

    const q = new URLSearchParams(window.location.search);
    const pkg = q.get('pkg');
    if (pkg) {
      this.packageSelect.value = pkg;
      await this.loadPackage(pkg);
    } else if (this.packageSelect.options.length > 0) {
      await this.loadPackage(this.packageSelect.value);
    }

    if (!this._animStarted) {
      this._animStarted = true;
      this.animate();
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  setLoading(text, pct = 0) {
    const layer = document.getElementById('loading');
    layer.style.display = 'flex';
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  hideLoading() {
    document.getElementById('loading').style.display = 'none';
  }

  async fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed ${path} (${res.status})`);
    return res.json();
  }

  async tryFetchJson(path) {
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async refreshPackages() {
    this.setStatus('Fetching Desktop exports...');
    const prev = this.packageSelect.value;
    this.packageSelect.innerHTML = '';

    try {
      const data = await this.fetchJson('/api/full-exports');
      const list = Array.isArray(data?.exports) ? data.exports : [];

      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No Desktop full exports found';
        this.packageSelect.appendChild(opt);
        this.setStatus('No exports found');
        return;
      }

      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.packageName;

        const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'unknown time';
        const entities = item.stats?.entities ?? '?';
        opt.textContent = `${item.packageName} | ${entities} entities | ${created}`;

        this.packageSelect.appendChild(opt);
      }

      if (prev && list.some((x) => x.packageName === prev)) {
        this.packageSelect.value = prev;
      }

      this.setStatus(`Found ${list.length} exports`);
    } catch (err) {
      console.error(err);
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Failed to read exports';
      this.packageSelect.appendChild(opt);
      this.setStatus(`Error: ${err.message || err}`);
    }
  }

  async loadSelectedPackage() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    await this.loadPackage(pkg);
  }

  openValidatorForCurrentPackage() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const url = `/full-validator.html?pkg=${encodeURIComponent(pkg)}`;
    const win = window.open(url, '_blank');
    if (!win) this.setStatus('Popup blocked. Open /full-validator.html manually.');
  }

  openResourcesForCurrentPackage() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const url = `/mesh-inspector.html?pkg=${encodeURIComponent(pkg)}`;
    const win = window.open(url, '_blank');
    if (!win) this.setStatus('Popup blocked. Open /mesh-inspector.html manually.');
  }

  openWalkReaderForCurrentPackage() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const url = `/export-reader.html?pkg=${encodeURIComponent(pkg)}`;
    const win = window.open(url, '_blank');
    if (!win) this.setStatus('Popup blocked. Open /export-reader.html manually.');
  }

  _disposeObjectTree(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.geometry) {
        child.geometry.dispose();
      }
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    if (obj.parent) obj.parent.remove(obj);
  }

  _cleanupCurrentMap() {
    if (this.terrainSystem?.terrainGroup) {
      this._disposeObjectTree(this.terrainSystem.terrainGroup);
    }
    if (this.entitySystem?.entityGroup) {
      this._disposeObjectTree(this.entitySystem.entityGroup);
    }

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.playerController = null;

    this._clearEnvironment();
  }

  _clearEnvironment() {
    for (const n of this._envNodes) {
      if (n.parent) n.parent.remove(n);
    }
    this._envNodes = [];
    this.sky = null;
    this.sunLight = null;
  }

  _setupEnvironment(environment) {
    this._clearEnvironment();

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
    this._envNodes.push(this.sky);

    this.scene.fog = new THREE.FogExp2(0xc8b888, 0.0000035);

    if (environment?.sunlight) {
      const s = environment.sunlight;
      const dir = new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]).normalize();
      const col = new THREE.Color(s.diffuse[0], s.diffuse[1], s.diffuse[2]);

      const sun = new THREE.DirectionalLight(col, 3.0);
      sun.position.copy(dir.clone().multiplyScalar(100000));
      sun.castShadow = true;
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
      this.scene.add(sun);
      this._envNodes.push(sun);
      this._envNodes.push(sun.target);
      this.sunLight = sun;

      const ambCol = s.ambientColor
        ? new THREE.Color(s.ambientColor[0], s.ambientColor[1], s.ambientColor[2])
        : new THREE.Color(0x666655);
      const amb = new THREE.AmbientLight(ambCol, 0.8);
      this.scene.add(amb);
      this._envNodes.push(amb);

      const skyCol = s.skyLightColor
        ? new THREE.Color(s.skyLightColor[0] * 0.8, s.skyLightColor[1] * 0.9, s.skyLightColor[2] * 1.2)
        : new THREE.Color(0x88aacc);
      const hemi = new THREE.HemisphereLight(skyCol, 0x8b7355, 1.0);
      this.scene.add(hemi);
      this._envNodes.push(hemi);
    } else {
      const amb = new THREE.AmbientLight(0x888888, 0.6);
      const hemi = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.4);
      this.scene.add(amb);
      this.scene.add(hemi);
      this._envNodes.push(amb, hemi);
    }
  }

  _getStartPosition(config) {
    if (this.entitySystem && this.entitySystem.allEntities.length > 0) {
      const ents = this.entitySystem.allEntities;
      const xs = ents.map((e) => e.worldPos.x).sort((a, b) => a - b);
      const zs = ents.map((e) => e.worldPos.z).sort((a, b) => a - b);
      const mid = Math.floor(ents.length / 2);
      const cx = xs[mid];
      const cz = zs[mid];
      let y = 5000;
      if (this.terrainSystem) {
        const th = this.terrainSystem.getHeightAt(cx, cz);
        if (th !== null) y = th + 3000;
      }
      return { x: cx, y, z: cz };
    }

    const l = config.landscape;
    const cx = l.worldOriginX + (l.regionGridX * l.regionSize * l.unitScaleX) / 2;
    const cz = -(l.worldOriginY + (l.regionGridY * l.regionSize * l.unitScaleY) / 2);
    let y = 5000;
    if (this.terrainSystem) {
      const th = this.terrainSystem.getHeightAt(cx, cz);
      if (th !== null) y = th + 3000;
    }
    return { x: cx, y, z: cz };
  }

  async loadPackage(pkgName) {
    this.currentPackage = pkgName;
    const enc = encodeURIComponent(pkgName);
    const packageBase = `/full-exports/${enc}`;
    const dataPath = `${packageBase}/map-data`;

    this.setLoading('Loading package manifest...', 4);
    this.setStatus(`Loading ${pkgName}...`);

    try {
      this._cleanupCurrentMap();

      const manifest = await this.tryFetchJson(`${packageBase}/manifest.json`);
      const config = await this.fetchJson(`${dataPath}/map-config.json`);
      const environment = await this.tryFetchJson(`${dataPath}/environment.json`);
      this.currentManifest = manifest;

      this._setupEnvironment(environment);

      this.setLoading('Loading terrain...', 15);
      this.terrainSystem = new TerrainSystem(this.scene, config, dataPath);
      await this.terrainSystem.load((p) => {
        this.setLoading(`Loading terrain: ${Math.round(p * 100)}%`, 15 + p * 45);
      });

      this.collisionSystem = new CollisionSystem(this.terrainSystem);

      this.setLoading('Loading entities...', 62);
      this.entitySystem = new EntitySystem(this.scene, dataPath);
      if (manifest?.region) this.entitySystem.regionFilter = manifest.region;

      await this.entitySystem.load((p) => {
        this.setLoading(`Loading entities: ${Math.round(p * 100)}%`, 62 + p * 30);
      });

      this.collisionSystem.setEntityMeshes(this.entitySystem.getCollisionMeshes());

      this.setLoading('Initializing controls...', 94);
      this.playerController = new PlayerController(this.camera, this.canvas, this.collisionSystem);
      const sp = this._getStartPosition(config);
      this.playerController.setPosition(sp.x, sp.y, sp.z);
      this.playerController.loadSavedState();

      this.entitySystem.updateLOD(this.camera.position);

      this.hideLoading();
      this.setStatus(`Loaded ${pkgName}`);
    } catch (err) {
      console.error(err);
      this.hideLoading();
      this.setStatus(`Load failed: ${err.message || err}`);
    }
  }

  updateUI() {
    document.getElementById('info-package').textContent = `Package: ${this.currentPackage || '-'}`;

    const pos = this.camera.position;
    document.getElementById('info-cam').textContent = `Cam: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`;
    document.getElementById('info-fps').textContent = `FPS: ${this.fps}`;

    if (this.entitySystem) {
      document.getElementById('info-objects').textContent =
        `Objects: ${this.entitySystem.visibleCount} / ${this.entitySystem.loadedCount}`;
    } else {
      document.getElementById('info-objects').textContent = 'Objects: -';
    }

    if (this.terrainSystem) {
      const cfg = this.terrainSystem.config;
      const lx = pos.x - cfg.worldOriginX;
      const lz = (-pos.z) - cfg.worldOriginY;
      const rx = Math.floor(lx / this.terrainSystem.regionWorldSize);
      const rz = Math.floor(lz / this.terrainSystem.regionWorldSize);
      document.getElementById('info-region').textContent = `Region: ${rx}, ${rz}`;
    } else {
      document.getElementById('info-region').textContent = 'Region: -';
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.1);

    this.frameCount++;
    this.fpsTime += delta;
    if (this.fpsTime >= 1.0) {
      this.fps = Math.round(this.frameCount / this.fpsTime);
      this.frameCount = 0;
      this.fpsTime = 0;
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

    if (this.sky) this.sky.position.copy(this.camera.position);

    if (this.sunLight) {
      const target = this.camera.position;
      const dir = this.sunLight.position.clone().normalize();
      this.sunLight.position.copy(target).add(dir.multiplyScalar(100000));
      this.sunLight.target.position.copy(target);
      this.sunLight.target.updateMatrixWorld();
    }

    this.renderer.render(this.scene, this.camera);
    this.updateUI();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

const viewer = new FullMapViewer();
viewer.init().catch((err) => {
  console.error('Full viewer init failed:', err);
});
