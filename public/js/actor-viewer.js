import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function basenameFromPath(pathLike) {
  const normalized = String(pathLike || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function formatCount(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

function formatBodyType(value) {
  return value ? String(value).toUpperCase() : 'unknown';
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dirnameFromUrl(url) {
  const normalized = String(url || '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : normalized;
}

function buildMeshNameSet(meshPath) {
  const names = new Set();
  const baseName = basenameFromPath(meshPath).replace(/\.mesh$/i, '').replace(/\.mdl$/i, '');
  if (!baseName) return names;
  names.add(baseName);
  names.add(`${baseName}mesh`);
  return names;
}

const ACTOR_PART_SLOT_LABELS = {
  1: 'hair',
  2: 'body',
  3: 'leg',
  4: 'hand',
  5: 'belt',
  6: 'plait',
  7: 'bang',
  8: 'face',
  9: 'hat',
  10: 'cape',
  11: 'weapon',
  12: 'left glove',
  13: 'right glove',
};

const RESOURCE_TEXTURE_FIELDS = [
  { key: 'map', label: 'Color' },
  { key: 'alphaMap', label: 'Alpha' },
  { key: 'normalMap', label: 'Normal' },
  { key: 'roughnessMap', label: 'Roughness' },
  { key: 'metalnessMap', label: 'Metalness' },
  { key: 'emissiveMap', label: 'Emissive' },
  { key: 'specularMap', label: 'Specular' },
  { key: 'aoMap', label: 'AO' },
  { key: 'bumpMap', label: 'Bump' },
  { key: 'displacementMap', label: 'Displacement' },
  { key: 'envMap', label: 'Environment' },
  { key: 'lightMap', label: 'Light' },
];

function prettifyResourceName(value) {
  const baseName = basenameFromPath(value).replace(/\.(mesh|mdl|jsoninspack)$/i, '');
  const normalized = baseName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return 'component';
  return normalized.toLowerCase();
}

function inferResourceNameFromMeshPath(meshPath) {
  const lowerName = basenameFromPath(meshPath).replace(/\.(mesh|mdl|jsoninspack)$/i, '').toLowerCase();
  if (!lowerName) return 'component';

  const candidates = [
    ['right glove', ['rightglove', 'glove_r', 'rglove']],
    ['left glove', ['leftglove', 'glove_l', 'lglove']],
    ['body', ['body']],
    ['leg', ['leg']],
    ['belt', ['belt']],
    ['hand', ['hand']],
    ['plait', ['plait', 'braid']],
    ['bang', ['bang']],
    ['face', ['face']],
    ['hat', ['hat', 'helmet']],
    ['hair', ['hair', 'head']],
    ['cape', ['cape', 'mantle', 'shawl']],
    ['weapon', ['weapon', 'sword', 'blade', 'staff']],
  ];

  for (const [label, tokens] of candidates) {
    if (tokens.some((token) => lowerName.includes(token))) {
      return label;
    }
  }

  return prettifyResourceName(lowerName);
}

function collectTextureNamesFromMaterial(material) {
  if (!material) return [];

  const names = new Set();
  for (const { key } of RESOURCE_TEXTURE_FIELDS) {
    const texture = material[key];
    if (!texture) continue;
    names.add(basenameFromPath(texture.name || texture.image?.currentSrc || texture.image?.src || key));
  }

  return [...names].filter(Boolean);
}

class ActorViewerApp {
  constructor() {
    this.dom = {
      canvas: document.getElementById('canvas'),
      actorSelect: document.getElementById('actor-select'),
      actorExportList: document.getElementById('actor-export-list'),
      exportRoot: document.getElementById('export-root'),
      openExportFolder: document.getElementById('open-export-folder'),
      refreshExports: document.getElementById('refresh-exports'),
      loadExport: document.getElementById('load-export'),
      frameActor: document.getElementById('frame-actor'),
      status: document.getElementById('status'),
      clipSourceSelect: document.getElementById('clip-source-select'),
      clipSourceList: document.getElementById('clip-source-list'),
      animationSelect: document.getElementById('animation-select'),
      clipList: document.getElementById('clip-list'),
      autoRunAnimation: document.getElementById('auto-run-animation'),
      togglePlayback: document.getElementById('toggle-playback'),
      restartAnimation: document.getElementById('restart-animation'),
      speed: document.getElementById('speed'),
      speedLabel: document.getElementById('speed-label'),
      showSkeleton: document.getElementById('show-skeleton'),
      showGrid: document.getElementById('show-grid'),
      showFloor: document.getElementById('show-floor'),
      autoLoadFirst: document.getElementById('auto-load-first'),
      facts: document.getElementById('facts'),
      partList: document.getElementById('part-list'),
      loading: document.getElementById('loading'),
      loadingText: document.getElementById('loading-text'),
      loadingFill: document.getElementById('loading-fill'),
      attachmentStatus: document.getElementById('attachment-status'),
      attachmentOffsetX: document.getElementById('attachment-offset-x'),
      attachmentOffsetY: document.getElementById('attachment-offset-y'),
      attachmentOffsetZ: document.getElementById('attachment-offset-z'),
      attachmentRotX: document.getElementById('attachment-rot-x'),
      attachmentRotY: document.getElementById('attachment-rot-y'),
      attachmentRotZ: document.getElementById('attachment-rot-z'),
      attachmentShowDetachedHead: document.getElementById('attachment-show-detached-head'),
      attachmentShowOriginalHead: document.getElementById('attachment-show-original-head'),
      attachmentReset: document.getElementById('attachment-reset'),
      attachmentResetPose: document.getElementById('attachment-reset-pose'),
      attachmentStartTest: document.getElementById('attachment-start-test'),
      attachmentModeNeck: document.getElementById('attachment-mode-neck'),
      attachmentModeReplace: document.getElementById('attachment-mode-replace'),
      attachmentGizmoTranslate: document.getElementById('attachment-gizmo-translate'),
      attachmentGizmoRotate: document.getElementById('attachment-gizmo-rotate'),
      attachmentGizmoOff: document.getElementById('attachment-gizmo-off'),
      resourceStatus: document.getElementById('resource-status'),
      resourceSelectionSummary: document.getElementById('resource-selection-summary'),
      resourceList: document.getElementById('resource-list'),
      resourceGizmoTranslate: document.getElementById('resource-gizmo-translate'),
      resourceGizmoRotate: document.getElementById('resource-gizmo-rotate'),
      resourceGizmoOff: document.getElementById('resource-gizmo-off'),
    };

    this.query = new URLSearchParams(window.location.search);
    this.requestedExportName = this.query.get('name');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.dom.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070b10');
    this.scene.fog = new THREE.FogExp2('#070b10', 0.00035);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 50000);
    this.camera.position.set(180, 120, 360);

    this.controls = new OrbitControls(this.camera, this.dom.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 12000;
    this.controls.target.set(0, 100, 0);

    this.clock = new THREE.Clock();
    this.loader = null;
    this.textureLoader = new THREE.TextureLoader();
    this.textureCache = new Map();
    this.textureAlphaCache = new Map();
    this.exports = [];
    this.exportRoot = '';
    this.current = null;
    this.currentStats = null;
    this.currentAnimationIndex = -1;
    this.playbackRate = 1;
    this.isPlaying = false;
    this.hasInitialLoad = false;
    this.activeLoadState = null;
    this.sharedClipLibraries = new Map();
    this.currentClipSourceName = '';
    this.isScanningClipSources = false;
    this.clipSourceScanToken = 0;

    this.attachmentGizmoMode = 'off';
    this.attachmentGizmoDummy = null;
    this.attachmentGizmoAttachment = null;
    this.attachmentTransformControls = null;
    this.attachmentGizmoSyncing = false;
    this.attachmentBaseInverse = new THREE.Matrix4();
    this.attachmentTweakMatrix = new THREE.Matrix4();
    this.attachmentTweakQuaternion = new THREE.Quaternion();

    this.resourceGizmoMode = 'off';
    this.resourceTransformControls = null;
    this.resourceSelectionPivot = null;
    this.resourceSelectionHelpers = [];
    this.resourceSelectionSyncing = false;
    this.resourceSelectionBaseStates = [];
    this.resourcePivotStartMatrix = new THREE.Matrix4();
    this.resourcePivotStartInverse = new THREE.Matrix4();
    this.resourceSelectionDeltaMatrix = new THREE.Matrix4();
    this.resourceSelectionWorldMatrix = new THREE.Matrix4();
    this.resourceSelectionLocalMatrix = new THREE.Matrix4();

    this.stage = new THREE.Group();
    this.scene.add(this.stage);

    this.setupScene();
    this.bindEvents();
    this.updateSpeedLabel();
    this.setStatus('Scanning MovieEditor exports...', 'warn');
    this.setFacts(null, null);
    this.setPartList([]);
    this.resetAttachmentTestPanel();
    this.resetResourceManagerPanel();
  }

  setupScene() {
    const hemisphere = new THREE.HemisphereLight('#c8ddf2', '#16202a', 1.7);
    this.scene.add(hemisphere);

    const ambient = new THREE.AmbientLight('#a8bfd5', 0.95);
    this.scene.add(ambient);

    this.keyLight = new THREE.DirectionalLight('#fff3dd', 2.25);
    this.keyLight.position.set(230, 360, 180);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 3000;
    this.keyLight.shadow.camera.left = -800;
    this.keyLight.shadow.camera.right = 800;
    this.keyLight.shadow.camera.top = 800;
    this.keyLight.shadow.camera.bottom = -800;
    this.scene.add(this.keyLight);

    const rimLight = new THREE.DirectionalLight('#6e97c7', 1.55);
    rimLight.position.set(-260, 160, -220);
    this.scene.add(rimLight);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.MeshStandardMaterial({ color: '#11161d', roughness: 0.95, metalness: 0.04 })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.grid = new THREE.GridHelper(2400, 60, '#567da4', '#263546');
    this.grid.material.opacity = 0.55;
    this.grid.material.transparent = true;
    this.scene.add(this.grid);
  }

  bindEvents() {
    window.addEventListener('resize', () => this.onResize());

    this.dom.actorSelect.addEventListener('change', () => {
      if (!this.dom.actorSelect.value) return;
      this.loadSelectedExport();
    });

    this.dom.actorExportList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-export-name]');
      if (!button) return;

      const exportName = String(button.getAttribute('data-export-name') || '');
      if (!exportName || exportName === this.dom.actorSelect.value) return;
      this.dom.actorSelect.value = exportName;
      this.renderActorExportList();
      this.loadSelectedExport();
    });

    this.dom.openExportFolder.addEventListener('click', () => {
      this.openSelectedExportFolder();
    });

    this.dom.refreshExports.addEventListener('click', () => {
      this.refreshExports({ preserveSelection: true });
    });

    this.dom.loadExport.addEventListener('click', () => {
      this.loadSelectedExport();
    });

    this.dom.frameActor.addEventListener('click', () => {
      this.frameCurrentActor();
    });

    this.dom.animationSelect.addEventListener('change', () => {
      const index = Number(this.dom.animationSelect.value);
      if (Number.isFinite(index)) {
        this.playClip(index);
      }
    });

    if (this.dom.clipSourceSelect) {
      this.dom.clipSourceSelect.addEventListener('change', () => {
        this.applySelectedClipSource({ preserveCurrentIndex: true });
      });
    }

    if (this.dom.clipSourceList && this.dom.clipSourceSelect) {
      this.dom.clipSourceList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-clip-source-name]');
        if (!button) return;

        const exportName = String(button.getAttribute('data-clip-source-name') || '');
        if (!exportName || exportName === this.dom.clipSourceSelect.value) return;
        this.dom.clipSourceSelect.value = exportName;
        this.renderClipSourceList();
        this.applySelectedClipSource({ preserveCurrentIndex: false });
      });
    }

    this.dom.clipList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-clip-index]');
      if (!button) return;

      const clipIndex = Number(button.getAttribute('data-clip-index'));
      if (!Number.isFinite(clipIndex)) return;
      this.playClip(clipIndex);
    });

    this.dom.togglePlayback.addEventListener('click', () => {
      this.togglePlayback();
    });

    this.dom.restartAnimation.addEventListener('click', () => {
      this.restartCurrentClip();
    });

    this.dom.speed.addEventListener('input', () => {
      this.playbackRate = Number(this.dom.speed.value) || 1;
      this.updateSpeedLabel();
    });

    [
      this.dom.attachmentOffsetX,
      this.dom.attachmentOffsetY,
      this.dom.attachmentOffsetZ,
      this.dom.attachmentRotX,
      this.dom.attachmentRotY,
      this.dom.attachmentRotZ,
    ].forEach((element) => {
      element.addEventListener('input', () => {
        this.applyAttachmentTestUiToSelection();
      });
    });

    this.dom.attachmentShowDetachedHead.addEventListener('change', () => {
      this.applyAttachmentTestVisibility();
    });

    this.dom.attachmentShowOriginalHead.addEventListener('change', () => {
      this.applyAttachmentTestVisibility();
    });

    this.dom.attachmentReset.addEventListener('click', () => {
      this.resetAttachmentTestTweaks();
    });

    this.dom.attachmentResetPose.addEventListener('click', () => {
      this.resetAttachmentTestPose();
    });

    this.dom.attachmentStartTest.addEventListener('click', () => {
      this.startAttachmentTestPlayback();
    });

    this.dom.attachmentModeNeck.addEventListener('click', () => {
      this.applyAttachmentTestMode('neck-follow');
    });

    this.dom.attachmentModeReplace.addEventListener('click', () => {
      this.applyAttachmentTestMode('direct-replace');
    });

    this.dom.attachmentGizmoTranslate.addEventListener('click', () => {
      this.setAttachmentGizmoMode('translate');
      this.syncAttachmentGizmoToSelection();
    });

    this.dom.attachmentGizmoRotate.addEventListener('click', () => {
      this.setAttachmentGizmoMode('rotate');
      this.syncAttachmentGizmoToSelection();
    });

    this.dom.attachmentGizmoOff.addEventListener('click', () => {
      this.setAttachmentGizmoMode('off');
    });

    this.dom.showSkeleton.addEventListener('change', () => {
      if (this.current?.skeletonHelper) {
        this.current.skeletonHelper.visible = this.dom.showSkeleton.checked;
      }
    });

    this.dom.showGrid.addEventListener('change', () => {
      this.grid.visible = this.dom.showGrid.checked;
    });

    this.dom.showFloor.addEventListener('change', () => {
      this.floor.visible = this.dom.showFloor.checked;
    });

    this.dom.resourceList.addEventListener('click', (event) => {
      this.handleResourceListClick(event);
    });

    this.dom.resourceList.addEventListener('change', (event) => {
      this.handleResourceListChange(event);
    });

    this.dom.resourceGizmoTranslate.addEventListener('click', () => {
      this.setResourceGizmoMode('translate');
    });

    this.dom.resourceGizmoRotate.addEventListener('click', () => {
      this.setResourceGizmoMode('rotate');
    });

    this.dom.resourceGizmoOff.addEventListener('click', () => {
      this.setResourceGizmoMode('off');
    });

    window.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || String(event.key || '').toLowerCase() !== 'g') return;
      event.preventDefault();
      this.toggleSelectedResourceGrouping();
    });
  }

/*

function formatCount(value) {

  getSelectedResourceDisplayItems() {
    const state = this.current?.resourceManager;
    if (!state) return [];
    return state.selectedDisplayIds
      .map((displayId) => state.displayItemMap.get(displayId))
      .filter(Boolean);
  }

  getDisplayItemVisibility(displayItem) {
    return displayItem.memberIds.every((memberId) => {
      const item = this.current?.resourceManager?.itemMap.get(memberId);
      return item?.meshObjects?.every((meshObject) => meshObject.visible) ?? false;
    });
  }

  getDisplayItemMeshes(displayItem) {
    const state = this.current?.resourceManager;
    if (!state || !displayItem) return [];

    const seen = new Set();
    const meshes = [];
    for (const memberId of displayItem.memberIds || []) {
      const item = state.itemMap.get(memberId);
      if (!item) continue;
      for (const meshObject of item.meshObjects || []) {
        if (seen.has(meshObject.uuid)) continue;
        seen.add(meshObject.uuid);
        meshes.push(meshObject);
      }
    }

    return meshes;
  }

  getTextureSourceName(texture, fallback = '') {
    return basenameFromPath(texture?.name || texture?.image?.currentSrc || texture?.image?.src || fallback);
  }

  getResourceMeshAppearanceState(meshObject) {
    if (!meshObject?.userData) return null;

    if (!meshObject.userData.resourceAppearanceState) {
      const originalMaterials = Array.isArray(meshObject.material)
        ? meshObject.material.filter(Boolean)
        : [meshObject.material].filter(Boolean);

      meshObject.userData.resourceAppearanceState = {
        originalMaterial: meshObject.material,
        usesMaterialArray: Array.isArray(meshObject.material),
        materialStates: originalMaterials.map((material, materialIndex) => {
          const textures = RESOURCE_TEXTURE_FIELDS
            .map(({ key, label }) => {
              const texture = material?.[key];
              if (!texture) return null;

              const textureName = this.getTextureSourceName(texture, key);
              return {
                key,
                channelLabel: label,
                label: textureName ? `${label} - ${textureName}` : label,
              };
            })
            .filter(Boolean);

          return {
            materialIndex,
            label: material?.name || meshObject.name || `material ${materialIndex + 1}`,
            originalMaterial: material,
            visible: true,
            neutralMaterial: null,
            variantCache: new Map(),
            textures,
            textureVisibility: new Map(textures.map((textureInfo) => [textureInfo.key, true])),
          };
        }),
        texturesVisible: true,
        materialsVisible: true,
      };
    }

    return meshObject.userData.resourceAppearanceState;
  }

  getResourceMeshMaterialStates(meshObject) {
    return this.getResourceMeshAppearanceState(meshObject)?.materialStates || [];
  }

  collectDisplayItemAppearanceEntries(displayItem) {
    const materialEntryMap = new Map();
    const textureEntryMap = new Map();

    for (const meshObject of this.getDisplayItemMeshes(displayItem)) {
      for (const materialState of this.getResourceMeshMaterialStates(meshObject)) {
        const materialKey = String(materialState.label || `material-${materialState.materialIndex}`);
        let materialEntry = materialEntryMap.get(materialKey);
        if (!materialEntry) {
          materialEntry = {
            entryId: `material:${materialKey}`,
            label: materialKey,
            targets: [],
          };
          materialEntryMap.set(materialKey, materialEntry);
        }

        materialEntry.targets.push({
          meshObject,
          materialIndex: materialState.materialIndex,
        });

        for (const textureInfo of materialState.textures || []) {
          const textureKey = `${textureInfo.key}:${textureInfo.label}`;
          let textureEntry = textureEntryMap.get(textureKey);
          if (!textureEntry) {
            textureEntry = {
              entryId: `texture:${textureKey}`,
              label: textureInfo.label,
              targets: [],
            };
            textureEntryMap.set(textureKey, textureEntry);
          }

          textureEntry.targets.push({
            meshObject,
            materialIndex: materialState.materialIndex,
            textureKey: textureInfo.key,
          });
        }
      }
    }

    const sortByLabel = (left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    return {
      materialEntries: [...materialEntryMap.values()].sort(sortByLabel),
      textureEntries: [...textureEntryMap.values()].sort(sortByLabel),
    };
  }

  isResourceMaterialEntryVisible(entry) {
    return entry.targets.every(({ meshObject, materialIndex }) => {
      const materialState = this.getResourceMeshMaterialStates(meshObject)[materialIndex];
      return materialState?.visible !== false;
    });
  }

  isResourceTextureEntryVisible(entry) {
    return entry.targets.every(({ meshObject, materialIndex, textureKey }) => {
      const materialState = this.getResourceMeshMaterialStates(meshObject)[materialIndex];
      return materialState?.textureVisibility?.get(textureKey) !== false;
    });
  }

  cloneResourceMaterialVariant(material, meshObject, variant) {
    if (!material?.clone) {
      const fallback = new THREE.MeshStandardMaterial({ color: 0xc7ced8, roughness: 1, metalness: 0 });
      fallback.skinning = Boolean(meshObject?.isSkinnedMesh);
      return fallback;
    }

    const clone = material.clone();

    for (const { key } of RESOURCE_TEXTURE_FIELDS) {
      if (key in clone) {
        clone[key] = null;
      }
    }

    if (variant === 'neutral') {
      if (clone.color?.setHex) clone.color.setHex(0xc7ced8);
      if (clone.emissive?.setHex) clone.emissive.setHex(0x000000);
      if ('roughness' in clone) clone.roughness = 1;
      if ('metalness' in clone) clone.metalness = 0;
      if ('shininess' in clone) clone.shininess = 0;
      if (clone.specular?.setHex) clone.specular.setHex(0x111111);
      if ('transparent' in clone) clone.transparent = false;
      if ('opacity' in clone) clone.opacity = 1;
      if ('alphaTest' in clone) clone.alphaTest = 0;
    }

    if ('skinning' in clone) clone.skinning = Boolean(meshObject?.isSkinnedMesh);
    clone.needsUpdate = true;
    return clone;
  }

  getResourceMaterialVariant(meshObject, materialState, variant) {
    if (variant === 'neutral') {
      if (!materialState.neutralMaterial) {
        materialState.neutralMaterial = this.cloneResourceMaterialVariant(materialState.originalMaterial, meshObject, 'neutral');
      }

      return materialState.neutralMaterial;
    }

    const signature = (materialState.textures || [])
      .map((textureInfo) => `${textureInfo.key}:${materialState.textureVisibility.get(textureInfo.key) === false ? '0' : '1'}`)
      .join('|');

    if (!signature || !signature.includes('0')) {
      return materialState.originalMaterial;
    }

    if (!materialState.variantCache.has(signature)) {
      const clone = materialState.originalMaterial?.clone
        ? materialState.originalMaterial.clone()
        : new THREE.MeshStandardMaterial({ color: 0xc7ced8, roughness: 1, metalness: 0 });

      for (const textureInfo of materialState.textures || []) {
        if (materialState.textureVisibility.get(textureInfo.key) === false && textureInfo.key in clone) {
          clone[textureInfo.key] = null;
        }
      }

      if ('skinning' in clone) clone.skinning = Boolean(meshObject?.isSkinnedMesh);
      clone.needsUpdate = true;
      materialState.variantCache.set(signature, clone);
    }

    return materialState.variantCache.get(signature);
  }

  applyResourceMeshAppearance(meshObject) {
    const appearanceState = this.getResourceMeshAppearanceState(meshObject);
    if (!appearanceState) return;

    const nextMaterials = appearanceState.materialStates.map((materialState) => {
      if (!materialState.visible) {
        return this.getResourceMaterialVariant(meshObject, materialState, 'neutral');
      }

      return this.getResourceMaterialVariant(meshObject, materialState, 'masked');
    });

    appearanceState.materialsVisible = appearanceState.materialStates.every((materialState) => materialState.visible !== false);
    appearanceState.texturesVisible = appearanceState.materialStates.every((materialState) =>
      (materialState.textures || []).every((textureInfo) => materialState.textureVisibility.get(textureInfo.key) !== false)
    );

    meshObject.material = appearanceState.usesMaterialArray
      ? nextMaterials
      : nextMaterials[0] || appearanceState.originalMaterial;

    const materials = Array.isArray(meshObject.material) ? meshObject.material : [meshObject.material];
    for (const material of materials) {
      if (material) material.needsUpdate = true;
    }
  }

  getDisplayItemMaterialVisibility(displayItem) {
    const meshes = this.getDisplayItemMeshes(displayItem);
    if (!meshes.length) return true;
    return meshes.every((meshObject) => this.getResourceMeshMaterialStates(meshObject).every((materialState) => materialState.visible !== false));
  }

  getDisplayItemTextureVisibility(displayItem) {
    const meshes = this.getDisplayItemMeshes(displayItem);
    if (!meshes.length) return true;
    return meshes.every((meshObject) => this.getResourceMeshMaterialStates(meshObject).every((materialState) =>
      (materialState.textures || []).every((textureInfo) => materialState.textureVisibility.get(textureInfo.key) !== false)
    ));
  }

  getSelectedResourceItems() {
    const state = this.current?.resourceManager;
    if (!state) return [];

    const selectedIds = new Set(this.getSelectedResourceDisplayItems().flatMap((displayItem) => displayItem.memberIds));
    return [...selectedIds].map((itemId) => state.itemMap.get(itemId)).filter(Boolean);
  }

  getSelectedResourceMeshes() {
    const seen = new Set();
    const meshes = [];

    for (const item of this.getSelectedResourceItems()) {
      for (const meshObject of item.meshObjects || []) {
        if (seen.has(meshObject.uuid)) continue;
        seen.add(meshObject.uuid);
        meshes.push(meshObject);
      }
    }

    return meshes;
  }

  renderResourceList() {
    const state = this.current?.resourceManager;
    if (!state?.displayItems?.length) {
      this.dom.resourceList.innerHTML = `
        <div class="resource-item">
          <div class="resource-meta">No mesh resources found in the loaded actor.</div>
        </div>
      `;
      return;
    }

    const selectedSet = new Set(state.selectedDisplayIds);

    this.dom.resourceList.innerHTML = state.displayItems.map((displayItem) => {
      const visible = this.getDisplayItemVisibility(displayItem);
      const selected = selectedSet.has(displayItem.displayId);
      const expanded = state.expandedIds.has(displayItem.displayId);
      const appearanceEntries = this.collectDisplayItemAppearanceEntries(displayItem);
      const materialsVisible = this.getDisplayItemMaterialVisibility(displayItem);
      const texturesVisible = this.getDisplayItemTextureVisibility(displayItem);

      const materialsHtml = appearanceEntries.materialEntries.length
        ? `<div class="resource-toggle-list">${appearanceEntries.materialEntries.map((entry) => {
            const entryVisible = this.isResourceMaterialEntryVisible(entry);
            return `
              <div class="resource-toggle-row">
                <label class="resource-visibility ${entryVisible ? 'visible' : 'hidden'}">
                  <input
                    data-resource-material-entry-visibility="${escapeHtml(displayItem.displayId)}"
                    data-entry-id="${escapeHtml(entry.entryId)}"
                    type="checkbox"
                    ${entryVisible ? 'checked' : ''}
                  >
                  <span>${entryVisible ? 'On' : 'Off'}</span>
                </label>
                <div class="resource-toggle-name">${escapeHtml(entry.label)}</div>
              </div>
            `;
          }).join('')}</div>`
        : '<div class="resource-empty">No material slots found.</div>';

      const texturesHtml = appearanceEntries.textureEntries.length
        ? `<div class="resource-toggle-list">${appearanceEntries.textureEntries.map((entry) => {
            const entryVisible = this.isResourceTextureEntryVisible(entry);
            return `
              <div class="resource-toggle-row">
                <label class="resource-visibility ${entryVisible ? 'visible' : 'hidden'}">
                  <input
                    data-resource-texture-entry-visibility="${escapeHtml(displayItem.displayId)}"
                    data-entry-id="${escapeHtml(entry.entryId)}"
                    type="checkbox"
                    ${entryVisible ? 'checked' : ''}
                  >
                  <span>${entryVisible ? 'On' : 'Off'}</span>
                </label>
                <div class="resource-toggle-name">${escapeHtml(entry.label)}</div>
              </div>
            `;
          }).join('')}</div>`
        : '<div class="resource-empty">No texture maps found.</div>';

      const componentsHtml = displayItem.components.map((component) => {
        const componentVisible = component.meshObjects.every((meshObject) => meshObject.visible);
        return `
          <div class="resource-component-row">
            <label class="resource-visibility ${componentVisible ? 'visible' : 'hidden'}">
              <input
                data-resource-component-visibility="${escapeHtml(displayItem.displayId)}"
                data-component-id="${escapeHtml(component.componentId)}"
                type="checkbox"
                ${componentVisible ? 'checked' : ''}
              >
              <span>${componentVisible ? 'Shown' : 'Hidden'}</span>
            </label>
            <div class="resource-component-name">${escapeHtml(component.label)}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="resource-item ${selected ? 'selected' : ''} ${visible ? '' : 'hidden-item'}">
          <div class="resource-header">
            <label class="resource-visibility ${visible ? 'visible' : 'hidden'}">
              <input data-resource-visibility="${escapeHtml(displayItem.displayId)}" type="checkbox" ${visible ? 'checked' : ''}>
              <span>${visible ? 'Shown' : 'Hidden'}</span>
            </label>
            <button class="resource-main" data-resource-select="${escapeHtml(displayItem.displayId)}" type="button">
              <div class="resource-title-wrap">
                <div class="resource-title">${escapeHtml(displayItem.label)}</div>
                ${displayItem.badge ? `<div class="resource-badge">${escapeHtml(displayItem.badge)}</div>` : ''}
              </div>
            </button>
            <button class="resource-icon ${selected ? 'active' : ''}" data-resource-select="${escapeHtml(displayItem.displayId)}" type="button" title="Select row">${selected ? '&#9679;' : '&#9675;'}</button>
            <button class="resource-icon" data-resource-expand="${escapeHtml(displayItem.displayId)}" type="button" title="Toggle details">
              <div class="resource-caret">${expanded ? '&#9662;' : '&#9656;'}</div>
            </button>
          </div>
          ${expanded ? `
            <div class="resource-details">
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Materials</div>
                  <label class="resource-visibility ${materialsVisible ? 'visible' : 'hidden'}">
                    <input data-resource-material-visibility="${escapeHtml(displayItem.displayId)}" type="checkbox" ${materialsVisible ? 'checked' : ''}>
                    <span>${materialsVisible ? 'Applied' : 'Neutral'}</span>
                  </label>
                </div>
                <div class="resource-tags">${materialsHtml}</div>
              </div>
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Textures</div>
                  <label class="resource-visibility ${texturesVisible ? 'visible' : 'hidden'}">
                    <input data-resource-texture-visibility="${escapeHtml(displayItem.displayId)}" type="checkbox" ${texturesVisible ? 'checked' : ''}>
                    <span>${texturesVisible ? 'Shown' : 'Off'}</span>
                  </label>
                </div>
                <div class="resource-tags">${texturesHtml}</div>
              </div>
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Components</div>
                </div>
                <div class="resource-components">${componentsHtml}</div>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  handleResourceListClick(event) {
    const selectButton = event.target.closest('[data-resource-select]');
    if (selectButton) {
      const displayId = selectButton.getAttribute('data-resource-select');
      const append = event.ctrlKey || event.metaKey;
      this.selectResourceDisplayIds([displayId], { append });
      return;
    }

    const expandButton = event.target.closest('[data-resource-expand]');
    if (!expandButton) return;

    const displayId = expandButton.getAttribute('data-resource-expand');
    this.toggleResourceExpansion(displayId);
  }

  handleResourceListChange(event) {
    const visibilityInput = event.target.closest('[data-resource-visibility]');
    if (visibilityInput) {
      const displayId = visibilityInput.getAttribute('data-resource-visibility');
      this.setDisplayItemVisibility(displayId, visibilityInput.checked);
      return;
    }

    const materialInput = event.target.closest('[data-resource-material-visibility]');
    if (materialInput) {
      const displayId = materialInput.getAttribute('data-resource-material-visibility');
      this.setDisplayItemMaterialVisibility(displayId, materialInput.checked);
      return;
    }

    const textureInput = event.target.closest('[data-resource-texture-visibility]');
    if (textureInput) {
      const displayId = textureInput.getAttribute('data-resource-texture-visibility');
      this.setDisplayItemTextureVisibility(displayId, textureInput.checked);
      return;
    }

    const materialEntryInput = event.target.closest('[data-resource-material-entry-visibility]');
    if (materialEntryInput) {
      const displayId = materialEntryInput.getAttribute('data-resource-material-entry-visibility');
      const entryId = materialEntryInput.getAttribute('data-entry-id');
      this.setDisplayItemMaterialEntryVisibility(displayId, entryId, materialEntryInput.checked);
      return;
    }

    const textureEntryInput = event.target.closest('[data-resource-texture-entry-visibility]');
    if (textureEntryInput) {
      const displayId = textureEntryInput.getAttribute('data-resource-texture-entry-visibility');
      const entryId = textureEntryInput.getAttribute('data-entry-id');
      this.setDisplayItemTextureEntryVisibility(displayId, entryId, textureEntryInput.checked);
      return;
    }

    const componentInput = event.target.closest('[data-resource-component-visibility]');
    if (!componentInput) return;

    const displayId = componentInput.getAttribute('data-resource-component-visibility');
    const componentId = componentInput.getAttribute('data-component-id');
    this.setDisplayComponentVisibility(displayId, componentId, componentInput.checked);
  }

  toggleResourceExpansion(displayId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    if (state.expandedIds.has(displayId)) {
      state.expandedIds.delete(displayId);
    } else {
      state.expandedIds = new Set([displayId]);
    }

    this.renderResourceList();
  }

  selectResourceDisplayIds(displayIds, { append = false } = {}) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const validIds = displayIds.filter((displayId) => state.displayItemMap.has(displayId));
    if (!validIds.length) return;

    if (!append) {
      state.selectedDisplayIds = validIds;
    } else {
      const next = new Set(state.selectedDisplayIds);
      const allSelected = validIds.every((displayId) => next.has(displayId));
      for (const displayId of validIds) {
        if (allSelected) next.delete(displayId);
        else next.add(displayId);
      }
      state.selectedDisplayIds = [...next];
    }

    if (state.selectedDisplayIds.length && this.resourceGizmoMode === 'off') {
      this.resourceGizmoMode = 'translate';
      this.updateResourceGizmoButtons(this.resourceGizmoMode);
    }

    this.updateResourceSelectionUi();
  }

  updateResourceSelectionUi() {
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();
    this.renderResourceList();
    this.refreshResourceSelectionHelpers();

    if (!selectedDisplayItems.length) {
      this.setResourceSelectionSummary('No resource selected.');
      this.removeResourceGizmo();
      return;
    }

    const hiddenCount = selectedDisplayItems.filter((displayItem) => !this.getDisplayItemVisibility(displayItem)).length;
    const labels = selectedDisplayItems.map((item) => item.label);
    let summary = labels.length === 1 ? labels[0] : `${labels.length} targeted`;
    if (hiddenCount > 0) summary += ` • ${hiddenCount} hidden`;
    this.setResourceSelectionSummary(summary, 'good');
    this.syncResourceGizmoToSelection();
  }

  setDisplayItemVisibility(displayId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    for (const memberId of displayItem.memberIds) {
      const item = state.itemMap.get(memberId);
      if (!item) continue;
      for (const meshObject of item.meshObjects || []) {
        meshObject.visible = Boolean(visible);
      }
    }

    this.renderResourceList();
    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`${displayItem.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
    this.updateResourceSelectionUi();
  }

  setDisplayComponentVisibility(displayId, componentId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    const component = (displayItem.components || []).find((entry) => entry.componentId === componentId);
    if (!component) return;

    for (const meshObject of component.meshObjects || []) {
      meshObject.visible = Boolean(visible);
    }

    this.renderResourceList();
    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`${component.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
    this.updateResourceSelectionUi();
  }

  createResourceSelectionHelper(meshObject) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd54a,
      wireframe: true,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });

    let helper;
    if (meshObject.isSkinnedMesh) {
      helper = new THREE.SkinnedMesh(meshObject.geometry, material);
      helper.bind(meshObject.skeleton, meshObject.bindMatrix);
      helper.bindMatrixInverse.copy(meshObject.bindMatrixInverse);
    } else {
      helper = new THREE.Mesh(meshObject.geometry, material);
    }

    helper.name = '__resource_selection_helper__';
    helper.frustumCulled = false;
    helper.renderOrder = 999;
    helper.raycast = () => {};
    helper.position.set(0, 0, 0);
    helper.quaternion.identity();
    helper.scale.set(1, 1, 1);
    meshObject.add(helper);
    return helper;
  }

  clearResourceSelectionHelpers() {
    for (const helper of this.resourceSelectionHelpers) {
      if (helper.parent) {
        helper.parent.remove(helper);
      }
      helper.material?.dispose?.();
    }
    this.resourceSelectionHelpers = [];
  }

  refreshResourceSelectionHelpers() {
    this.clearResourceSelectionHelpers();

    for (const meshObject of this.getSelectedResourceMeshes()) {
      this.resourceSelectionHelpers.push(this.createResourceSelectionHelper(meshObject));
    }
  }

  updateResourceGizmoButtons(mode) {
    this.dom.resourceGizmoTranslate.className = `${mode === 'translate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoRotate.className = `${mode === 'rotate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoOff.className = `${mode === 'off' ? 'primary' : 'secondary'} button-grow`;
  }

  setResourceGizmoMode(mode) {
    this.resourceGizmoMode = mode === 'rotate' || mode === 'translate' ? mode : 'off';
    this.updateResourceGizmoButtons(this.resourceGizmoMode);

    if (this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.syncResourceGizmoToSelection();
  }

  ensureResourceGizmo() {
    if (!this.resourceTransformControls) {
      this.resourceTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.resourceTransformControls.setSpace('world');
      this.resourceTransformControls.setMode(this.resourceGizmoMode);
      this.scene.add(this.resourceTransformControls.getHelper());

      this.resourceTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (event.value) {
          this.snapshotResourceSelectionTransforms();
        }
      });

      this.resourceTransformControls.addEventListener('objectChange', () => {
        if (this.resourceSelectionSyncing) return;
        this.applyResourceSelectionDelta();
      });
    }

    if (!this.resourceSelectionPivot) {
      this.resourceSelectionPivot = new THREE.Object3D();
      this.resourceSelectionPivot.name = '__resource_manager_pivot__';
      this.scene.add(this.resourceSelectionPivot);
    }
  }

  removeResourceGizmo() {
    this.controls.enabled = true;

    if (this.resourceTransformControls) {
      this.resourceTransformControls.detach();
      this.scene.remove(this.resourceTransformControls.getHelper());
      this.resourceTransformControls.dispose();
      this.resourceTransformControls = null;
    }

    if (this.resourceSelectionPivot?.parent) {
      this.resourceSelectionPivot.parent.remove(this.resourceSelectionPivot);
    }

    this.resourceSelectionPivot = null;
    this.resourceSelectionBaseStates = [];
  }

  snapshotResourceSelectionTransforms() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || !this.resourceSelectionPivot) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourcePivotStartMatrix.copy(this.resourceSelectionPivot.matrix);
    this.resourcePivotStartInverse.copy(this.resourcePivotStartMatrix).invert();

    this.resourceSelectionBaseStates = selectedMeshes.map((meshObject) => ({
      meshObject,
      worldMatrix: meshObject.matrixWorld.clone(),
      parentInverse: meshObject.parent
        ? meshObject.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4(),
    }));
  }

  applyResourceSelectionDelta() {
    if (!this.resourceSelectionPivot || !this.resourceSelectionBaseStates.length) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceSelectionDeltaMatrix.multiplyMatrices(this.resourceSelectionPivot.matrix, this.resourcePivotStartInverse);

    for (const state of this.resourceSelectionBaseStates) {
      this.resourceSelectionWorldMatrix.multiplyMatrices(this.resourceSelectionDeltaMatrix, state.worldMatrix);
      this.resourceSelectionLocalMatrix.multiplyMatrices(state.parentInverse, this.resourceSelectionWorldMatrix);
      this.resourceSelectionLocalMatrix.decompose(
        state.meshObject.position,
        state.meshObject.quaternion,
        state.meshObject.scale,
      );
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    this.setResourceStatus(`Moving ${this.resourceSelectionBaseStates.length} mesh piece(s).`, 'good');
  }

  syncResourceGizmoToSelection() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.ensureResourceGizmo();

    const box = new THREE.Box3();
    const itemBox = new THREE.Box3();
    const center = new THREE.Vector3();
    let hasBox = false;

    for (const meshObject of selectedMeshes) {
      itemBox.setFromObject(meshObject);
      if (itemBox.isEmpty()) continue;
      if (!hasBox) box.copy(itemBox);
      else box.union(itemBox);
      hasBox = true;
    }

    if (!hasBox) {
      selectedMeshes[0].getWorldPosition(center);
    } else {
      box.getCenter(center);
    }

    this.resourceSelectionSyncing = true;
    this.resourceSelectionPivot.position.copy(center);
    this.resourceSelectionPivot.quaternion.identity();
    this.resourceSelectionPivot.scale.set(1, 1, 1);
    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceTransformControls.attach(this.resourceSelectionPivot);
    this.resourceTransformControls.setSpace('world');
    this.resourceTransformControls.setMode(this.resourceGizmoMode);
    this.resourceSelectionSyncing = false;

    this.snapshotResourceSelectionTransforms();
  }

  async toggleSelectedResourceGrouping() {
    const state = this.current?.resourceManager;
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();
    if (!state || !selectedDisplayItems.length) {
      this.setResourceStatus('Target one or more rows first.', 'warn');
      return;
    }

    if (selectedDisplayItems.length === 1 && selectedDisplayItems[0].type === 'group') {
      await this.ungroupResourceByGroupId(String(selectedDisplayItems[0].displayId || '').replace(/^group:/, ''));
      return;
    }

    const memberIds = [...new Set(selectedDisplayItems.flatMap((displayItem) => displayItem.memberIds))];
    if (memberIds.length < 2) {
      this.setResourceStatus('Target at least two rows to create a group.', 'warn');
      return;
    }

    await this.groupSelectedResources(memberIds);
  }

  async groupSelectedResources(memberIds) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const selectedSet = new Set(memberIds);
    const nextGroups = [];
    for (const group of state.groups) {
      const members = group.members.filter((member) => !selectedSet.has(member));
      if (members.length >= 2) {
        nextGroups.push({ ...group, members });
      }
    }

    const nextNumber = nextGroups.reduce((maxValue, group) => {
      const match = /^Group\s+(\d+)$/i.exec(group.name || '');
      return Math.max(maxValue, match ? Number(match[1]) : 0);
    }, 0) + 1;

    const groupId = `group-${Date.now()}`;
    nextGroups.push({
      id: groupId,
      name: `Group ${nextNumber}`,
      members: [...selectedSet],
    });

    state.groups = nextGroups;
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Saved Group ${nextNumber}.`, 'good');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = [`group:${groupId}`];
    this.updateResourceSelectionUi();
  }

  async ungroupResourceByGroupId(groupId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    state.groups = state.groups.filter((entry) => entry.id !== groupId);
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Ungrouped ${group.name}.`, 'warn');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = group.members.filter((memberId) => state.displayItemMap.has(memberId));
    this.updateResourceSelectionUi();
  }
    this.updateResourceGizmoButtons(this.resourceGizmoMode);

    if (this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.syncResourceGizmoToSelection();
  }

  ensureResourceGizmo() {
    if (!this.resourceTransformControls) {
      this.resourceTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.resourceTransformControls.setSpace('world');
      this.resourceTransformControls.setMode(this.resourceGizmoMode);
      this.scene.add(this.resourceTransformControls.getHelper());

      this.resourceTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (event.value) {
          this.snapshotResourceSelectionTransforms();
        }
      });

      this.resourceTransformControls.addEventListener('objectChange', () => {
        if (this.resourceSelectionSyncing) return;
        this.applyResourceSelectionDelta();
      });
    }

    if (!this.resourceSelectionPivot) {
      this.resourceSelectionPivot = new THREE.Object3D();
      this.resourceSelectionPivot.name = '__resource_manager_pivot__';
      this.scene.add(this.resourceSelectionPivot);
    }
  }

  removeResourceGizmo() {
    this.controls.enabled = true;

    if (this.resourceTransformControls) {
      this.resourceTransformControls.detach();
      this.scene.remove(this.resourceTransformControls.getHelper());
      this.resourceTransformControls.dispose();
      this.resourceTransformControls = null;
    }

    if (this.resourceSelectionPivot?.parent) {
      this.resourceSelectionPivot.parent.remove(this.resourceSelectionPivot);
    }

    this.resourceSelectionPivot = null;
    this.resourceSelectionBaseStates = [];
  }

  snapshotResourceSelectionTransforms() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || !this.resourceSelectionPivot) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourcePivotStartMatrix.copy(this.resourceSelectionPivot.matrix);
    this.resourcePivotStartInverse.copy(this.resourcePivotStartMatrix).invert();

    this.resourceSelectionBaseStates = selectedMeshes.map((meshObject) => ({
      meshObject,
      worldMatrix: meshObject.matrixWorld.clone(),
      parentInverse: meshObject.parent
        ? meshObject.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4(),
    }));
  }

  applyResourceSelectionDelta() {
    if (!this.resourceSelectionPivot || !this.resourceSelectionBaseStates.length) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceSelectionDeltaMatrix.multiplyMatrices(this.resourceSelectionPivot.matrix, this.resourcePivotStartInverse);

    for (const state of this.resourceSelectionBaseStates) {
      this.resourceSelectionWorldMatrix.multiplyMatrices(this.resourceSelectionDeltaMatrix, state.worldMatrix);
      this.resourceSelectionLocalMatrix.multiplyMatrices(state.parentInverse, this.resourceSelectionWorldMatrix);
      this.resourceSelectionLocalMatrix.decompose(
        state.meshObject.position,
        state.meshObject.quaternion,
        state.meshObject.scale,
      );
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    this.setResourceStatus(`Moving ${this.resourceSelectionBaseStates.length} mesh piece(s).`, 'good');
  }

  syncResourceGizmoToSelection() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.ensureResourceGizmo();

    const box = new THREE.Box3();
    const itemBox = new THREE.Box3();
    const center = new THREE.Vector3();
    let hasBox = false;

    for (const meshObject of selectedMeshes) {
      itemBox.setFromObject(meshObject);
      if (itemBox.isEmpty()) continue;
      if (!hasBox) box.copy(itemBox);
      else box.union(itemBox);
      hasBox = true;
    }

    if (!hasBox) {
      selectedMeshes[0].getWorldPosition(center);
    } else {
      box.getCenter(center);
    }

    this.resourceSelectionSyncing = true;
    this.resourceSelectionPivot.position.copy(center);
    this.resourceSelectionPivot.quaternion.identity();
    this.resourceSelectionPivot.scale.set(1, 1, 1);
    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceTransformControls.attach(this.resourceSelectionPivot);
    this.resourceTransformControls.setSpace('world');
    this.resourceTransformControls.setMode(this.resourceGizmoMode);
    this.resourceSelectionSyncing = false;

    this.snapshotResourceSelectionTransforms();
  }

  async toggleSelectedResourceGrouping() {
    const state = this.current?.resourceManager;
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();
    if (!state || !selectedDisplayItems.length) {
      this.setResourceStatus('Target one or more rows first.', 'warn');
      return;
    }

    if (selectedDisplayItems.length === 1 && selectedDisplayItems[0].type === 'group') {
      await this.ungroupResourceByGroupId(String(selectedDisplayItems[0].displayId || '').replace(/^group:/, ''));
      return;
    }

    const memberIds = [...new Set(selectedDisplayItems.flatMap((displayItem) => displayItem.memberIds))];
    if (memberIds.length < 2) {
      this.setResourceStatus('Target at least two rows to create a group.', 'warn');
      return;
    }

    await this.groupSelectedResources(memberIds);
  }

  async groupSelectedResources(memberIds) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const selectedSet = new Set(memberIds);
    const nextGroups = [];
    for (const group of state.groups) {
      const members = group.members.filter((member) => !selectedSet.has(member));
      if (members.length >= 2) {
        nextGroups.push({ ...group, members });
      }
    }

    const nextNumber = nextGroups.reduce((maxValue, group) => {
      const match = /^Group\s+(\d+)$/i.exec(group.name || '');
      return Math.max(maxValue, match ? Number(match[1]) : 0);
    }, 0) + 1;

    const groupId = `group-${Date.now()}`;
    nextGroups.push({
      id: groupId,
      name: `Group ${nextNumber}`,
      members: [...selectedSet],
    });

    state.groups = nextGroups;
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Saved Group ${nextNumber}.`, 'good');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = [`group:${groupId}`];
    this.updateResourceSelectionUi();
  }

  async ungroupResourceByGroupId(groupId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    state.groups = state.groups.filter((entry) => entry.id !== groupId);
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Ungrouped ${group.name}.`, 'warn');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = group.members.filter((memberId) => state.displayItemMap.has(memberId));
    this.updateResourceSelectionUi();
  }
      this.dom.attachmentRotZ,
    ].forEach((element) => {
      element.addEventListener('input', () => {
        this.applyAttachmentTestUiToSelection();
      });
    });

    this.dom.attachmentShowDetachedHead.addEventListener('change', () => {
      this.applyAttachmentTestVisibility();
    });

    this.dom.attachmentShowOriginalHead.addEventListener('change', () => {
      this.applyAttachmentTestVisibility();
    });

    this.dom.attachmentReset.addEventListener('click', () => {
      this.resetAttachmentTestTweaks();
    });

    this.dom.attachmentResetPose.addEventListener('click', () => {
      this.resetAttachmentTestPose();
    });

    this.dom.attachmentStartTest.addEventListener('click', () => {
      this.startAttachmentTestPlayback();
    });

    this.dom.attachmentModeNeck.addEventListener('click', () => {
      this.applyAttachmentTestMode('neck-follow');
    });

    this.dom.attachmentModeReplace.addEventListener('click', () => {
      this.applyAttachmentTestMode('direct-replace');
    });

    this.dom.attachmentGizmoTranslate.addEventListener('click', () => {
      this.setAttachmentGizmoMode('translate');
      this.syncAttachmentGizmoToSelection();
    });

    this.dom.attachmentGizmoRotate.addEventListener('click', () => {
      this.setAttachmentGizmoMode('rotate');
      this.syncAttachmentGizmoToSelection();
    });

    this.dom.attachmentGizmoOff.addEventListener('click', () => {
      this.setAttachmentGizmoMode('off');
    });

    this.dom.showSkeleton.addEventListener('change', () => {
      if (this.current?.skeletonHelper) {
        this.current.skeletonHelper.visible = this.dom.showSkeleton.checked;
      }
    });

    this.dom.showGrid.addEventListener('change', () => {
      this.grid.visible = this.dom.showGrid.checked;
    });

    this.dom.showFloor.addEventListener('change', () => {
      this.floor.visible = this.dom.showFloor.checked;
    });

    this.dom.resourceList.addEventListener('click', (event) => {
      this.handleResourceListClick(event);
    });

    this.dom.resourceList.addEventListener('change', (event) => {
      this.handleResourceListChange(event);
    });

    this.dom.resourceGizmoTranslate.addEventListener('click', () => {
      this.setResourceGizmoMode('translate');
    });

    this.dom.resourceGizmoRotate.addEventListener('click', () => {
      this.setResourceGizmoMode('rotate');
    });

    this.dom.resourceGizmoOff.addEventListener('click', () => {
      this.setResourceGizmoMode('off');
    });

    window.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || String(event.key || '').toLowerCase() !== 'g') return;
      event.preventDefault();
      this.toggleSelectedResourceGrouping();
    });
  }

*/
  async init() {
    await this.refreshExports({ preserveSelection: false });
    this.animate();
  }

  async refreshExports({ preserveSelection }) {
    const previous = preserveSelection ? this.dom.actorSelect.value : '';
    this.clipSourceScanToken += 1;
    this.isScanningClipSources = false;

    try {
      this.setStatus('Scanning MovieEditor export folders...', 'warn');
      const response = await fetch('/api/actor-exports');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      this.exportRoot = payload.root || '';
      this.dom.exportRoot.textContent = this.exportRoot
        ? `Root: ${this.exportRoot}`
        : 'Root: MovieEditor/source/fbx';
      this.exports = (Array.isArray(payload.exports) ? payload.exports : []).map((exportInfo) => ({
        ...exportInfo,
        textureFileLookup: new Map(
          (Array.isArray(exportInfo.textureFiles) ? exportInfo.textureFiles : [])
            .map((name) => [String(name).toLowerCase(), name])
        ),
      }));
      this.populateActorSelect(previous || this.requestedExportName || '');
      this.populateClipSourceSelect(this.currentClipSourceName || previous || this.requestedExportName || '');

      if (this.exports.length === 0) {
        this.setStatus(`No exports found under ${payload.root || 'MovieEditor/source/fbx'}`, 'warn');
        return;
      }

      this.setStatus(`Found ${this.exports.length} actor export folder(s)`, 'good');

      const shouldAutoLoad = !this.hasInitialLoad && this.dom.autoLoadFirst.checked;
      this.hasInitialLoad = true;
      if (shouldAutoLoad) {
        await this.loadSelectedExport();
      }

      this.renderClipSourceList();
      this.renderClipList();
    } catch (err) {
      this.setStatus(`Could not read actor exports: ${err?.message || err}`, 'warn');
    }
  }

  populateActorSelect(preferredName) {
    const select = this.dom.actorSelect;
    select.innerHTML = '';

    if (!this.exports.length) {
      const option = document.createElement('option');
      option.textContent = 'No MovieEditor exports detected';
      option.value = '';
      select.appendChild(option);
      select.disabled = true;
      this.dom.loadExport.disabled = true;
      this.dom.frameActor.disabled = true;
      this.dom.openExportFolder.disabled = true;
      this.renderActorExportList();
      return;
    }

    select.disabled = false;
    this.dom.loadExport.disabled = false;
    this.dom.frameActor.disabled = false;
    this.dom.openExportFolder.disabled = false;

    for (const exportInfo of this.exports) {
      const option = document.createElement('option');
      option.value = exportInfo.name;
      option.textContent = `${exportInfo.name} (${exportInfo.fbxFileName || 'no fbx'})`;
      select.appendChild(option);
    }

    const preferred = this.exports.find((item) => item.name === preferredName);
    select.value = preferred?.name || this.exports[0].name;
    this.renderActorExportList();
  }

  populateClipSourceSelect(preferredName = '') {
    const select = this.dom.clipSourceSelect;
    select.innerHTML = '';

    const matchingExport = this.current?.exportInfo
      || this.exports.find((item) => item.name === preferredName)
      || this.exports.find((item) => item.name === this.dom.actorSelect.value)
      || this.exports[0];

    if (!matchingExport) {
      const option = document.createElement('option');
      option.textContent = 'No matching clip source';
      option.value = '';
      select.appendChild(option);
      select.disabled = true;
      this.renderClipSourceList();
      return;
    }

    const option = document.createElement('option');
    option.value = matchingExport.name;
    option.textContent = `${matchingExport.name} • matching clips`;
    select.appendChild(option);
    select.value = matchingExport.name;
    select.disabled = true;
    this.renderClipSourceList();
  }

  renderActorExportList() {
    const container = this.dom.actorExportList;
    if (!container) return;

    if (!this.exports.length) {
      container.innerHTML = '<div class="selection-empty">No MovieEditor actor exports were found.</div>';
      return;
    }

    const selectedName = this.dom.actorSelect.value;
    container.innerHTML = this.exports.map((exportInfo) => `
      <button
        class="selection-item ${exportInfo.name === selectedName ? 'active' : ''}"
        data-export-name="${escapeHtml(exportInfo.name)}"
        type="button"
      >
        <div class="selection-item-title">${escapeHtml(exportInfo.name)}</div>
      </button>
    `).join('');
  }

  getVisibleClipSourceExports() {
    const matchingExport = this.current?.exportInfo || this.getSelectedExport();
    return matchingExport ? [matchingExport] : [];
  }

  renderClipSourceList() {
    const container = this.dom.clipSourceList;
    if (!container) return;

    const matchingExport = this.current?.exportInfo || this.getSelectedExport();
    if (!matchingExport) {
      container.innerHTML = '<div class="selection-empty">Load an actor to use its matching clips.</div>';
      return;
    }

    container.innerHTML = `
      <div class="selection-empty">Using matching clips from ${escapeHtml(matchingExport.name)}.</div>
    `;
  }

  renderClipList() {
    const container = this.dom.clipList;
    if (!container) return;

    const clips = Array.isArray(this.current?.clips) ? this.current.clips : [];
    if (!clips.length) {
      container.innerHTML = this.current?.exportInfo
        ? `<div class="selection-empty">${escapeHtml(this.current.exportInfo.name)} has no embedded clips.</div>`
        : '<div class="selection-empty">Load an actor to see its matching clips.</div>';
      return;
    }

    container.innerHTML = clips.map((clip, index) => `
      <button
        class="selection-item ${index === this.currentAnimationIndex ? 'active' : ''}"
        data-clip-index="${index}"
        type="button"
      >
        <div class="selection-item-title">${escapeHtml(clip.name || `Clip ${index + 1}`)}</div>
      </button>
    `).join('');
  }

  async scanClipSourcesInBackground() {
    const scanToken = ++this.clipSourceScanToken;

    if (!this.exports.length) {
      this.isScanningClipSources = false;
      this.renderClipSourceList();
      return;
    }

    this.isScanningClipSources = true;
    this.renderClipSourceList();

    for (const exportInfo of this.exports) {
      if (scanToken !== this.clipSourceScanToken) return;

      const cached = this.sharedClipLibraries.get(exportInfo.name);
      if (!cached?.loaded) {
        try {
          await this.ensureClipSourceLoaded(exportInfo);
        } catch {
          // Ignore clip scan failures here; interactive loading will surface the error if needed.
        }
      }

      if (scanToken !== this.clipSourceScanToken) return;
      this.renderClipSourceList();
    }

    if (scanToken !== this.clipSourceScanToken) return;
    this.isScanningClipSources = false;
    this.renderClipSourceList();
  }

  async openSelectedExportFolder() {
    const exportName = String(this.dom.actorSelect.value || '').trim();

    if (!exportName && !this.exports.length) {
      this.setStatus('No actor export is available to open yet.', 'warn');
      return;
    }

    try {
      const url = exportName
        ? `/api/open-actor-export-folder?name=${encodeURIComponent(exportName)}`
        : '/api/open-actor-export-folder';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(await response.text() || `HTTP ${response.status}`);
      }

      this.setStatus(exportName ? `Opened ${exportName} on disk.` : 'Opened export root on disk.', 'good');
    } catch (err) {
      this.setStatus(`Could not open export folder: ${err?.message || err}`, 'warn');
    }
  }

  suppressKnownFbxWarnings() {
    if (!ActorViewerApp.originalConsoleWarn) {
      ActorViewerApp.originalConsoleWarn = console.warn.bind(console);
      ActorViewerApp.fbxWarningSuppressionDepth = 0;
    }

    if (ActorViewerApp.fbxWarningSuppressionDepth === 0) {
      console.warn = (...args) => {
        const message = args.map((arg) => String(arg)).join(' ');
        if (message.includes('THREE.FBXLoader: The FBX file contains invalid (negative) material indices.')) {
          return;
        }

        ActorViewerApp.originalConsoleWarn(...args);
      };
    }

    ActorViewerApp.fbxWarningSuppressionDepth += 1;
    return () => {
      ActorViewerApp.fbxWarningSuppressionDepth = Math.max(0, (ActorViewerApp.fbxWarningSuppressionDepth || 0) - 1);
      if (ActorViewerApp.fbxWarningSuppressionDepth === 0 && ActorViewerApp.originalConsoleWarn) {
        console.warn = ActorViewerApp.originalConsoleWarn;
      }
    };
  }

  getSelectedExport() {
    const exportName = this.dom.actorSelect.value;
    return this.exports.find((item) => item.name === exportName) || null;
  }

  getSelectedClipSourceExport() {
    const exportName = this.dom.clipSourceSelect.value;
    return this.exports.find((item) => item.name === exportName) || null;
  }

  normalizeAnimationTrackName(trackName) {
    const name = String(trackName || '');
    const propertyIndex = name.lastIndexOf('.');
    if (propertyIndex < 0) return name;

    const bindingPath = name.slice(0, propertyIndex);
    const propertyName = name.slice(propertyIndex);
    const normalizedBindingPath = bindingPath
      .split('/')
      .map((segment) => String(segment || '').split(':').pop())
      .join('/');

    return `${normalizedBindingPath}${propertyName}`;
  }

  prepareClipLibraryClips(clips) {
    if (!Array.isArray(clips)) return [];

    return clips.map((clip) => {
      const preparedClip = clip.clone();
      preparedClip.tracks = preparedClip.tracks.map((track) => {
        const preparedTrack = track.clone();
        preparedTrack.name = this.normalizeAnimationTrackName(track.name);
        return preparedTrack;
      });
      preparedClip.resetDuration();
      return preparedClip;
    });
  }

  storeClipLibrary(exportInfo, clips, { prepared = false } = {}) {
    const entry = {
      exportInfo,
      clips: prepared ? (Array.isArray(clips) ? clips : []) : this.prepareClipLibraryClips(clips),
      loaded: true,
    };
    this.sharedClipLibraries.set(exportInfo.name, entry);
    this.renderClipSourceList();
    return entry;
  }

  async ensureClipSourceLoaded(exportInfoOrName) {
    const exportInfo = typeof exportInfoOrName === 'string'
      ? this.exports.find((item) => item.name === exportInfoOrName)
      : exportInfoOrName;

    if (!exportInfo) {
      throw new Error('Clip source export not found.');
    }

    const cached = this.sharedClipLibraries.get(exportInfo.name);
    if (cached?.loaded) return cached;
    if (cached?.promise) return cached.promise;

    if (!exportInfo.fbxUrl) {
      return this.storeClipLibrary(exportInfo, []);
    }

    const loader = new FBXLoader();
    const resourcePath = this.getTextureBaseUrl(exportInfo);
    if (resourcePath) {
      loader.setResourcePath(`${resourcePath.replace(/\/+$/, '')}/`);
    }

    const pending = new Promise((resolve, reject) => {
      const restoreWarn = this.suppressKnownFbxWarnings();
      loader.load(
        exportInfo.fbxUrl,
        (root) => {
          restoreWarn();
          resolve(this.storeClipLibrary(exportInfo, Array.isArray(root.animations) ? root.animations : []));
        },
        undefined,
        (err) => {
          restoreWarn();
          this.sharedClipLibraries.delete(exportInfo.name);
          reject(err);
        },
      );
    });

    this.sharedClipLibraries.set(exportInfo.name, {
      exportInfo,
      clips: [],
      loaded: false,
      promise: pending,
    });

    return pending;
  }

  async loadSelectedExport() {
    const exportInfo = this.getSelectedExport();
    if (!exportInfo) {
      this.setStatus('No actor export selected.', 'warn');
      return;
    }

    if (!exportInfo.fbxUrl) {
      this.setStatus(`Export ${exportInfo.name} has no FBX file.`, 'warn');
      this.setFacts(exportInfo, null);
      this.setPartList(this.buildPartItems(exportInfo));
      return;
    }

    this.showLoading(`Loading ${exportInfo.fbxFileName}`, 0);
    this.setStatus(`Loading ${exportInfo.fbxFileName}...`, 'warn');

    const loadState = {
      failed: false,
      finished: false,
      dependenciesReady: false,
      sceneReady: false,
    };
    this.activeLoadState = loadState;

    const finishLoading = () => {
      if (this.activeLoadState !== loadState) return;
      if (loadState.failed || loadState.finished) return;
      if (!loadState.sceneReady || !loadState.dependenciesReady) return;
      loadState.finished = true;
      this.hideLoading();
    };

    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => {
      if (this.activeLoadState !== loadState || loadState.failed || loadState.finished) return;
      const ratio = total > 0 ? loaded / total : 0;
      this.showLoading(`Resolving linked textures ${loaded}/${Math.max(loaded, total)}`, ratio);
    };
    manager.onLoad = () => {
      if (this.activeLoadState !== loadState) return;
      loadState.dependenciesReady = true;
      finishLoading();
    };
    manager.onError = (url) => {
      if (this.activeLoadState !== loadState) return;
      this.setStatus(`Referenced asset missing: ${basenameFromPath(url)}`, 'warn');
    };

    const loader = new FBXLoader(manager);
    const resourcePath = this.getTextureBaseUrl(exportInfo);
    if (resourcePath) {
      loader.setResourcePath(`${resourcePath.replace(/\/+$/, '')}/`);
    }
    const restoreWarn = this.suppressKnownFbxWarnings();
    loader.load(
      exportInfo.fbxUrl,
      (root) => {
        restoreWarn();
        if (this.activeLoadState !== loadState || loadState.failed) return;
        Promise.resolve(this.onFbxLoaded(exportInfo, root)).then(() => {
          if (this.activeLoadState !== loadState || loadState.failed) return;
          loadState.sceneReady = true;
          finishLoading();
        }).catch((err) => {
          loadState.failed = true;
          this.hideLoading();
          this.setStatus(`Post-load setup failed: ${err?.message || err}`, 'warn');
          console.error('Actor post-load setup failed', err);
        });
      },
      (event) => {
        if (this.activeLoadState !== loadState || loadState.failed || loadState.finished) return;
        if (event?.lengthComputable && event.total > 0) {
          this.showLoading(
            `Downloading FBX ${Math.round((event.loaded / event.total) * 100)}%`,
            event.loaded / event.total,
          );
        }
      },
      (err) => {
        restoreWarn();
        loadState.failed = true;
        this.hideLoading();
        this.setStatus(`FBX load failed: ${err?.message || err}`, 'warn');
      }
    );
  }

  async onFbxLoaded(exportInfo, root) {
    this.clearCurrentActor();
    await this.prepareMaterials(exportInfo, root);
    const partVisibility = this.applyActorPartVisibility(exportInfo, root);

    const placementRoot = new THREE.Group();
    const orientationRoot = new THREE.Group();
    orientationRoot.add(root);
    placementRoot.add(orientationRoot);
    this.stage.add(placementRoot);

    const stats = this.collectStats(root);
    const embeddedClips = this.prepareClipLibraryClips(Array.isArray(root.animations) ? root.animations : []);
    this.current = {
      exportInfo,
      root,
      presentation: this.createPresentationState(root, placementRoot, orientationRoot),
      embeddedClips,
      clips: [],
      clipSourceName: '',
      mixer: new THREE.AnimationMixer(root),
      activeAction: null,
      skeletonHelper: null,
      partVisibility,
    };
    this.currentStats = stats;
    this.current.attachments = this.createHeadAttachments(exportInfo, root);
    this.current.attachmentTest = null;

    this.updateHeadAttachments();

    this.current.skeletonHelper = new THREE.SkeletonHelper(root);
    this.current.skeletonHelper.visible = this.dom.showSkeleton.checked;
    this.scene.add(this.current.skeletonHelper);

    this.frameCurrentActor();

    try {
      await this.setupResourceManager(exportInfo, root);
    } catch (err) {
      const message = `Resource panel failed to build: ${err?.message || err}`;
      console.error('Resource manager setup failed', err);
      this.resetResourceManagerPanel(message, message);
      this.setResourceStatus(message, 'warn');
    }

    this.storeClipLibrary(exportInfo, embeddedClips, { prepared: true });
    this.populateClipSourceSelect(this.currentClipSourceName || exportInfo.name);
    if (!this.currentClipSourceName || !this.exports.find((item) => item.name === this.currentClipSourceName)) {
      this.currentClipSourceName = exportInfo.name;
      this.dom.clipSourceSelect.value = exportInfo.name;
    }
    await this.applySelectedClipSource({ preserveCurrentIndex: false });
    this.setFacts(exportInfo, stats);
    this.setPartList(this.buildPartItems(exportInfo));

    if (!this.current.clips.length) {
      this.currentAnimationIndex = -1;
      this.isPlaying = false;
      this.updatePlaybackButton();
      this.setStatus(`Loaded ${exportInfo.name}. This export has no matching embedded clips.`, 'warn');
    }

    if (this.current.clips.length > 0) {
      this.setStatus(
        `Loaded ${exportInfo.name}: ${stats.bones} bones, ${stats.skinnedMeshes} skinned meshes, using ${this.current.clips.length} matching clip(s).`,
        'good',
      );
    }

  }

  getTextureBaseUrl(exportInfo) {
    if (exportInfo?.textureBaseUrl) return exportInfo.textureBaseUrl;
    if (!exportInfo?.fbxUrl) return null;
    return `${dirnameFromUrl(exportInfo.fbxUrl)}/tex`;
  }

  findTextureFile(exportInfo, materialName, suffix) {
    const lookup = exportInfo?.textureFileLookup;
    if (!(lookup instanceof Map) || !materialName) return null;

    const prefix = `${materialName}${suffix}`.toLowerCase();
    for (const [lowerName, originalName] of lookup.entries()) {
      if (lowerName === `${prefix}.png` || lowerName === `${prefix}.tga`) {
        return originalName;
      }
    }

    return null;
  }

  buildTextureUrl(exportInfo, fileName) {
    if (!fileName) return null;
    const baseUrl = this.getTextureBaseUrl(exportInfo);
    return baseUrl ? `${baseUrl}/${encodeURIComponent(fileName)}` : null;
  }

  loadTexture(url, colorSpace = null) {
    if (!url) return Promise.resolve(null);

    const cacheKey = `${url}|${colorSpace || 'none'}`;
    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey);
    }

    const promise = new Promise((resolve) => {
      this.textureLoader.load(
        url,
        (texture) => {
          if (colorSpace) texture.colorSpace = colorSpace;
          resolve(texture);
        },
        undefined,
        () => resolve(null),
      );
    });

    this.textureCache.set(cacheKey, promise);
    return promise;
  }

  async textureHasAlpha(texture) {
    const image = texture?.image;
    const cacheKey = image?.currentSrc || image?.src || texture?.uuid || null;
    if (!image || !cacheKey) return false;

    if (this.textureAlphaCache.has(cacheKey)) {
      return this.textureAlphaCache.get(cacheKey);
    }

    let hasAlpha = false;
    try {
      const width = Math.min(64, image.naturalWidth || image.width || 0);
      const height = Math.min(64, image.naturalHeight || image.height || 0);
      if (width > 0 && height > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(image, 0, 0, width, height);
          const pixels = ctx.getImageData(0, 0, width, height).data;
          for (let index = 3; index < pixels.length; index += 16) {
            if (pixels[index] < 250) {
              hasAlpha = true;
              break;
            }
          }
        }
      }
    } catch {
      hasAlpha = false;
    }

    this.textureAlphaCache.set(cacheKey, hasAlpha);
    return hasAlpha;
  }

  findPrimarySkinnedMesh(root) {
    let bestMatch = null;

    root.traverse((object) => {
      if (!object.isSkinnedMesh || !Array.isArray(object.skeleton?.bones) || object.skeleton.bones.length === 0) {
        return;
      }

      const bones = object.skeleton.bones;
      const lowerNames = new Set(bones.map((bone) => String(bone.name || '').toLowerCase()));
      const score =
        (lowerNames.has('bip01_pelvis') ? 1000 : 0) +
        (lowerNames.has('bip01_head') ? 1000 : 0) +
        bones.length;

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { object, score };
      }
    });

    return bestMatch?.object || null;
  }

  createHeadAttachments(exportInfo, root) {
    const primaryMesh = this.findPrimarySkinnedMesh(root);
    const primaryBones = primaryMesh?.skeleton?.bones || [];
    const primaryRestWorldMap = new Map(
      primaryBones.map((bone) => [String(bone.name || '').toLowerCase(), bone.matrixWorld.clone()])
    );
    const anchorBone = primaryMesh?.skeleton?.bones?.find((bone) => bone.name === 'bip01_head') || null;
    if (!anchorBone) {
      return { boneLinks: [], rootLinks: [], primaryBones, primaryRestWorldMap };
    }

    const primaryBoneMap = new Map(
      primaryMesh.skeleton.bones.map((bone) => [String(bone.name || '').toLowerCase(), bone])
    );

    root.updateMatrixWorld(true);

    const boneLinks = [];
    const rootLinks = [];
    root.traverse((object) => {
      if (!object.isSkinnedMesh || !object.skeleton?.bones?.length) return;
      if (object === primaryMesh) return;
      if (!/head|face|bang|plait|hat/i.test(object.name)) return;

      for (const bone of object.skeleton.bones) {
        const sourceBone = primaryBoneMap.get(String(bone.name || '').toLowerCase());
        if (!sourceBone || sourceBone === bone) continue;

        boneLinks.push({
          meshName: object.name,
          mesh: object,
          sourceBone,
          targetBone: bone,
          parentInverse: new THREE.Matrix4(),
          targetWorld: new THREE.Matrix4(),
          localMatrix: new THREE.Matrix4(),
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
          scale: new THREE.Vector3(),
        });
      }

      const boneSet = new Set(object.skeleton.bones);
      const roots = object.skeleton.bones.filter((bone) => !boneSet.has(bone.parent));
      for (const rootBone of roots) {
        if (primaryBoneMap.has(String(rootBone.name || '').toLowerCase())) continue;

        const localOffset = new THREE.Matrix4()
          .copy(anchorBone.matrixWorld)
          .invert()
          .multiply(rootBone.matrixWorld);

        rootLinks.push({
          meshName: object.name,
          mesh: object,
          rootBone,
          anchorBone,
          defaultAnchorName: String(anchorBone.name || ''),
          selectedAnchorName: String(anchorBone.name || ''),
          rootRestWorld: rootBone.matrixWorld.clone(),
          defaultLocalOffset: localOffset.clone(),
          baseLocalOffset: new THREE.Matrix4().copy(localOffset),
          localOffset,
          tweakPosition: new THREE.Vector3(),
          tweakEuler: new THREE.Euler(0, 0, 0, 'XYZ'),
          tweakQuaternion: new THREE.Quaternion(),
          tweakScale: new THREE.Vector3(1, 1, 1),
          tweakMatrix: new THREE.Matrix4(),
          parentInverse: new THREE.Matrix4(),
          targetWorld: new THREE.Matrix4(),
          localMatrix: new THREE.Matrix4(),
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
          scale: new THREE.Vector3(),
        });
      }
    });

    return { boneLinks, rootLinks, faceCalibration: null, primaryBones, primaryRestWorldMap };
  }

  createPresentationState(root, placementRoot, orientationRoot) {
    const primaryMesh = this.findPrimarySkinnedMesh(root);
    const lowerNames = new Map(
      (primaryMesh?.skeleton?.bones || []).map((bone) => [String(bone.name || '').toLowerCase(), bone])
    );

    return {
      placementRoot,
      orientationRoot,
      pelvisBone: lowerNames.get('bip01_pelvis') || lowerNames.get('pelvis') || null,
      headBone: lowerNames.get('bip01_head') || lowerNames.get('head') || null,
      hasPlacement: false,
      hasUprightCorrection: false,
      rawBox: new THREE.Box3(),
      placedBox: new THREE.Box3(),
      center: new THREE.Vector3(),
      size: new THREE.Vector3(),
      pelvisPosition: new THREE.Vector3(),
      headPosition: new THREE.Vector3(),
      upVector: new THREE.Vector3(),
      uprightCorrection: new THREE.Quaternion(),
    };
  }

  getAttachmentBonePriority(name) {
    const lowerName = String(name || '').toLowerCase();
    if (lowerName === 'bip01_head') return 1000;
    if (lowerName === 'bip01_neck1') return 950;
    if (lowerName === 'bip01_neck') return 900;
    if (lowerName === 'head') return 860;
    if (lowerName === 'neck1') return 820;
    if (lowerName === 'neck') return 780;
    if (lowerName.includes('head')) return 720;
    if (lowerName.includes('neck')) return 680;
    if (lowerName.includes('spine2')) return 620;
    if (lowerName.includes('spine1')) return 580;
    if (lowerName.includes('spine')) return 540;
    if (lowerName.includes('clavicle')) return 420;
    if (lowerName.includes('pelvis')) return 320;
    return 0;
  }

  buildAttachmentBoneOptions(bones) {
    return [...(bones || [])]
      .sort((left, right) => {
        const priorityDiff = this.getAttachmentBonePriority(right.name) - this.getAttachmentBonePriority(left.name);
        if (priorityDiff !== 0) return priorityDiff;
        return String(left.name || '').localeCompare(String(right.name || ''));
      })
      .map((bone) => {
        const priority = this.getAttachmentBonePriority(bone.name);
        return {
          name: String(bone.name || ''),
          label: priority >= 900
            ? `${bone.name} [recommended]`
            : String(bone.name || ''),
        };
      });
  }

  setAttachmentTestControlsEnabled(enabled) {
    [
      this.dom.attachmentOffsetX,
      this.dom.attachmentOffsetY,
      this.dom.attachmentOffsetZ,
      this.dom.attachmentRotX,
      this.dom.attachmentRotY,
      this.dom.attachmentRotZ,
      this.dom.attachmentShowDetachedHead,
      this.dom.attachmentShowOriginalHead,
      this.dom.attachmentReset,
      this.dom.attachmentResetPose,
      this.dom.attachmentStartTest,
      this.dom.attachmentModeNeck,
      this.dom.attachmentModeReplace,
      this.dom.attachmentGizmoTranslate,
      this.dom.attachmentGizmoRotate,
      this.dom.attachmentGizmoOff,
    ].forEach((element) => {
      element.disabled = !enabled;
    });

    if (this.attachmentTransformControls) {
      this.attachmentTransformControls.enabled = enabled;
    }
  }

  setAttachmentTestStatus(message, tone = '') {
    this.dom.attachmentStatus.textContent = message;
    this.dom.attachmentStatus.className = `status-chip ${tone}`.trim();
  }

  resetAttachmentTestPanel() {
    this.removeAttachmentGizmo();
    this.dom.attachmentOffsetX.value = '0';
    this.dom.attachmentOffsetY.value = '0';
    this.dom.attachmentOffsetZ.value = '0';
    this.dom.attachmentRotX.value = '0';
    this.dom.attachmentRotY.value = '0';
    this.dom.attachmentRotZ.value = '0';
    this.dom.attachmentShowDetachedHead.checked = true;
    this.dom.attachmentShowOriginalHead.checked = true;
    this.setAttachmentGizmoMode('off');
    this.updateAttachmentModeButtons('');
    this.setAttachmentTestStatus('Load an actor with a detached head rig to test attachment.');
    this.setAttachmentTestControlsEnabled(false);
  }

  getSelectedAttachmentLink() {
    const test = this.current?.attachmentTest;
    if (!test) return null;
    return test.targets.find((t) => t.kind === 'detached-head') || test.targets[0] || null;
  }

  getAttachmentBoneByName(name) {
    const lowerName = String(name || '').toLowerCase();
    return (this.current?.attachments?.primaryBones || []).find((bone) => String(bone.name || '').toLowerCase() === lowerName) || null;
  }

  getAttachmentTargetKind(attachment) {
    const fullName = `${attachment?.meshName || ''} ${attachment?.rootBone?.name || ''}`.toLowerCase();
    if (fullName.includes('hat')) return 'detached-hat';
    if (/head|face|plait|bang/.test(fullName)) return 'detached-head';
    return `detached-${String(attachment?.rootBone?.name || attachment?.meshName || 'component').toLowerCase()}`;
  }

  getAttachmentTargetLabel(kind, members) {
    if (kind === 'detached-head') return 'Detached Head Set';
    if (kind === 'detached-hat') return 'Detached Hat';
    const first = members[0];
    return `${first?.meshName || 'Detached Component'} -> ${first?.rootBone?.name || 'root'}`;
  }

  pickAttachmentTargetRepresentative(kind, members) {
    if (!members.length) return null;

    if (kind === 'detached-head') {
      return members.find((attachment) => /head/i.test(attachment.meshName) && !/face|plait|bang|hat/i.test(attachment.meshName))
        || members.find((attachment) => /face|faceroot/i.test(`${attachment.meshName} ${attachment.rootBone?.name || ''}`))
        || members[0];
    }

    return members[0];
  }

  buildAttachmentTestTargets(attachments) {
    const rootLinks = attachments?.rootLinks || [];
    const boneLinks = attachments?.boneLinks || [];
    const groupedTargets = new Map();

    for (const attachment of rootLinks) {
      const kind = this.getAttachmentTargetKind(attachment);
      const existing = groupedTargets.get(kind);
      if (existing) {
        existing.members.push(attachment);
      } else {
        groupedTargets.set(kind, { kind, members: [attachment] });
      }
    }

    for (const boneLink of boneLinks) {
      const kind = this.getAttachmentTargetKind(boneLink);
      if (!groupedTargets.has(kind)) {
        groupedTargets.set(kind, { kind, members: [] });
      }
    }

    return [...groupedTargets.values()].map((entry, index) => {
      const representative = this.pickAttachmentTargetRepresentative(entry.kind, entry.members);
      const defaultAnchorName = String(representative?.defaultAnchorName || representative?.anchorBone?.name || '');
      const meshObjects = [
        ...new Map(
          [
            ...entry.members.map((attachment) => attachment.mesh).filter(Boolean),
            ...boneLinks
              .filter((boneLink) => this.getAttachmentTargetKind(boneLink) === entry.kind)
              .map((boneLink) => boneLink.mesh)
              .filter(Boolean),
          ].map((mesh) => [mesh.uuid, mesh])
        ).values(),
      ];

      return {
        testId: String(index),
        kind: entry.kind,
        label: this.getAttachmentTargetLabel(entry.kind, entry.members),
        meshName: this.getAttachmentTargetLabel(entry.kind, entry.members),
        members: entry.members,
        meshObjects,
        representative,
        rootBone: representative?.rootBone || null,
        anchorBone: representative?.anchorBone || null,
        defaultAnchorName,
        selectedAnchorName: defaultAnchorName,
        tweakPosition: new THREE.Vector3(),
        tweakEuler: new THREE.Euler(0, 0, 0, 'XYZ'),
        tweakQuaternion: new THREE.Quaternion(),
        tweakScale: new THREE.Vector3(1, 1, 1),
        tweakMatrix: new THREE.Matrix4(),
      };
    });
  }

  refreshAttachmentLinkOffset(target) {
    if (!target || !this.current?.attachments) return;

    const anchorBone = this.getAttachmentBoneByName(target.selectedAnchorName) || target.anchorBone || target.representative?.anchorBone;
    if (!anchorBone) return;

    target.anchorBone = anchorBone;
    target.rootBone = target.representative?.rootBone || target.rootBone;

    target.tweakQuaternion.setFromEuler(target.tweakEuler);
    target.tweakMatrix.compose(target.tweakPosition, target.tweakQuaternion, target.tweakScale);

    for (const attachment of target.members || []) {
      attachment.anchorBone = anchorBone;
      attachment.selectedAnchorName = target.selectedAnchorName;

      const restAnchorWorld = this.current.attachments.primaryRestWorldMap?.get(String(anchorBone.name || '').toLowerCase()) || null;
      if (restAnchorWorld) {
        attachment.baseLocalOffset.copy(restAnchorWorld).invert().multiply(attachment.rootRestWorld);
      } else {
        attachment.baseLocalOffset.copy(attachment.defaultLocalOffset);
      }

      attachment.localOffset.copy(target.tweakMatrix).multiply(attachment.baseLocalOffset);
    }
  }

  updateAttachmentModeButtons(mode = this.current?.attachmentTest?.mode || '') {
    this.dom.attachmentModeNeck.className = `${mode === 'neck-follow' ? 'primary' : 'secondary'} button-grow`;
    this.dom.attachmentModeReplace.className = `${mode === 'direct-replace' ? 'primary' : 'secondary'} button-grow`;
  }

  classifyAttachmentTestTarget(target) {
    return String(target?.kind || 'other');
  }

  pickAttachmentTestTarget() {
    const targets = this.current?.attachmentTest?.targets || [];
    const current = this.getSelectedAttachmentLink();
    if (!targets.length) return null;

    if (this.classifyAttachmentTestTarget(current) === 'detached-head') return current;

    return targets.find((target) => this.classifyAttachmentTestTarget(target) === 'detached-head')
      || current
      || targets[0];
  }

  findPreferredAttachmentAnchor(mode) {
    const preferredNames = mode === 'neck-follow'
      ? ['bip01_neck1', 'bip01_neck', 'neck1', 'neck', 'bip01_head', 'head']
      : ['bip01_head', 'head', 'bip01_neck1', 'bip01_neck', 'neck1', 'neck'];

    for (const name of preferredNames) {
      const bone = this.getAttachmentBoneByName(name);
      if (bone) return bone;
    }

    return null;
  }

  applyAttachmentTestMode(mode) {
    const test = this.current?.attachmentTest;
    if (!test?.targets?.length) return;

    const preferredAnchor = this.findPreferredAttachmentAnchor(mode);
    test.mode = mode;

    const headTarget = test.targets.find((t) => t.kind === 'detached-head') || test.targets[0];

    // Refresh ALL targets with the same anchor so hat + head stay together
    const anchorName = String(preferredAnchor?.name || headTarget.defaultAnchorName || '');
    for (const target of test.targets) {
      target.selectedAnchorName = anchorName;
      target.tweakPosition.set(0, 0, 0);
      target.tweakEuler.set(0, 0, 0, 'XYZ');
      this.refreshAttachmentLinkOffset(target);
    }

    // Compare: show detached head, hide original head
    this.dom.attachmentShowDetachedHead.checked = true;
    this.dom.attachmentShowOriginalHead.checked = false;

    this.syncAttachmentTestInputsFromSelection();
    this.updateHeadAttachments();
    this.applyAttachmentTestVisibility();
    this.syncAttachmentGizmoToSelection();
    this.updateAttachmentModeButtons(mode);

    this.setAttachmentTestStatus(`Detached head at ${anchorName} (${mode}).`, 'good');
  }

  setAttachmentGizmoMode(mode) {
    this.attachmentGizmoMode = mode === 'rotate' || mode === 'translate' ? mode : 'off';

    this.dom.attachmentGizmoTranslate.className = `${this.attachmentGizmoMode === 'translate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.attachmentGizmoRotate.className = `${this.attachmentGizmoMode === 'rotate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.attachmentGizmoOff.className = `${this.attachmentGizmoMode === 'off' ? 'primary' : 'secondary'} button-grow`;

    if (this.attachmentGizmoMode === 'off') {
      this.removeAttachmentGizmo();
      return;
    }

    if (this.attachmentTransformControls) {
      this.attachmentTransformControls.setSpace('local');
      this.attachmentTransformControls.setMode(this.attachmentGizmoMode);
    }
  }

  removeAttachmentGizmo() {
    this.attachmentGizmoAttachment = null;
    this.controls.enabled = true;

    if (this.attachmentTransformControls) {
      this.attachmentTransformControls.detach();
      this.scene.remove(this.attachmentTransformControls.getHelper());
      this.attachmentTransformControls.dispose();
      this.attachmentTransformControls = null;
    }

    if (this.attachmentGizmoDummy?.parent) {
      this.attachmentGizmoDummy.parent.remove(this.attachmentGizmoDummy);
    }

    this.attachmentGizmoDummy = null;
  }

  ensureAttachmentGizmo() {
    if (!this.attachmentTransformControls) {
      this.attachmentTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.attachmentTransformControls.setSpace('local');
      this.attachmentTransformControls.setMode(this.attachmentGizmoMode);
      this.scene.add(this.attachmentTransformControls.getHelper());

      this.attachmentTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
      });

      this.attachmentTransformControls.addEventListener('objectChange', () => {
        if (this.attachmentGizmoSyncing) return;

        const target = this.attachmentGizmoAttachment;
        const dummy = this.attachmentGizmoDummy;
        const representative = target?.representative;
        if (!target || !dummy || !representative) return;

        dummy.updateMatrix();
        this.attachmentBaseInverse.copy(representative.baseLocalOffset).invert();
        this.attachmentTweakMatrix.multiplyMatrices(dummy.matrix, this.attachmentBaseInverse);
        this.attachmentTweakMatrix.decompose(
          target.tweakPosition,
          this.attachmentTweakQuaternion,
          target.tweakScale,
        );
        target.tweakEuler.setFromQuaternion(this.attachmentTweakQuaternion, 'XYZ');

        this.refreshAttachmentLinkOffset(target);

        // Propagate same tweak to all other targets (hat follows head)
        for (const otherTarget of this.current?.attachmentTest?.targets || []) {
          if (otherTarget === target) continue;
          otherTarget.tweakPosition.copy(target.tweakPosition);
          otherTarget.tweakEuler.copy(target.tweakEuler);
          this.refreshAttachmentLinkOffset(otherTarget);
        }

        this.syncAttachmentTestInputsFromSelection();
        this.updateHeadAttachments();
        this.applyAttachmentTestVisibility();
        this.setAttachmentTestStatus(`Dragging detached head (${this.attachmentGizmoMode}).`, 'good');
      });
    }

    if (!this.attachmentGizmoDummy) {
      this.attachmentGizmoDummy = new THREE.Object3D();
      this.attachmentGizmoDummy.name = '__attachment_test_gizmo__';
    }
  }

  syncAttachmentGizmoToSelection() {
    const target = this.getSelectedAttachmentLink();
    if (!target || this.attachmentGizmoMode === 'off') {
      this.removeAttachmentGizmo();
      return;
    }

    this.ensureAttachmentGizmo();
    const representative = target.representative;
    if (!representative?.anchorBone) return;

    this.attachmentGizmoAttachment = target;

    if (this.attachmentGizmoDummy.parent !== representative.anchorBone) {
      representative.anchorBone.add(this.attachmentGizmoDummy);
    }

    this.attachmentGizmoSyncing = true;
    representative.localOffset.decompose(
      this.attachmentGizmoDummy.position,
      this.attachmentGizmoDummy.quaternion,
      this.attachmentGizmoDummy.scale,
    );
    this.attachmentGizmoDummy.updateMatrix();
    this.attachmentGizmoDummy.updateMatrixWorld(true);
    this.attachmentTransformControls.attach(this.attachmentGizmoDummy);
    this.attachmentTransformControls.setSpace('local');
    this.attachmentTransformControls.setMode(this.attachmentGizmoMode);
    this.attachmentGizmoSyncing = false;
  }

  setupAttachmentTest() {
    const attachments = this.current?.attachments;
    const rootLinks = attachments?.rootLinks || [];
    if (!rootLinks.length) {
      this.current.attachmentTest = null;
      this.resetAttachmentTestPanel();
      return;
    }

    const targets = this.buildAttachmentTestTargets(attachments);
    targets.forEach((target) => {
      this.refreshAttachmentLinkOffset(target);
    });

    const selectedAttachment =
      targets.find((target) => target.kind === 'detached-head') ||
      targets[0] ||
      null;

    this.current.attachmentTest = {
      targets,
      mode: '',
    };

    this.populateAttachmentTestPanel();
    this.applyAttachmentTestVisibility();
    this.updateHeadAttachments();
  }

  populateAttachmentTestPanel() {
    const test = this.current?.attachmentTest;
    if (!test?.targets?.length) {
      this.resetAttachmentTestPanel();
      return;
    }

    this.setAttachmentTestControlsEnabled(true);
    this.syncAttachmentTestInputsFromSelection();
    this.syncAttachmentGizmoToSelection();
    this.updateAttachmentModeButtons(test.mode || '');
  }

  syncAttachmentTestInputsFromSelection() {
    const target = this.getSelectedAttachmentLink();
    if (!target) {
      this.setAttachmentTestStatus('No detached head found.', 'warn');
      return;
    }

    this.dom.attachmentOffsetX.value = target.tweakPosition.x.toFixed(2);
    this.dom.attachmentOffsetY.value = target.tweakPosition.y.toFixed(2);
    this.dom.attachmentOffsetZ.value = target.tweakPosition.z.toFixed(2);
    this.dom.attachmentRotX.value = THREE.MathUtils.radToDeg(target.tweakEuler.x).toFixed(1);
    this.dom.attachmentRotY.value = THREE.MathUtils.radToDeg(target.tweakEuler.y).toFixed(1);
    this.dom.attachmentRotZ.value = THREE.MathUtils.radToDeg(target.tweakEuler.z).toFixed(1);

    const mode = this.current?.attachmentTest?.mode;
    if (!mode) {
      this.setAttachmentTestStatus('Use Compare to position the detached head.', 'warn');
    } else {
      this.setAttachmentTestStatus(`Detached head anchored at ${target.selectedAnchorName} (${mode}).`, 'good');
    }
  }

  applyAttachmentTestUiToSelection() {
    const test = this.current?.attachmentTest;
    const target = this.getSelectedAttachmentLink();
    if (!target) return;

    target.tweakPosition.set(
      toFiniteNumber(this.dom.attachmentOffsetX.value, 0),
      toFiniteNumber(this.dom.attachmentOffsetY.value, 0),
      toFiniteNumber(this.dom.attachmentOffsetZ.value, 0),
    );
    target.tweakEuler.set(
      THREE.MathUtils.degToRad(toFiniteNumber(this.dom.attachmentRotX.value, 0)),
      THREE.MathUtils.degToRad(toFiniteNumber(this.dom.attachmentRotY.value, 0)),
      THREE.MathUtils.degToRad(toFiniteNumber(this.dom.attachmentRotZ.value, 0)),
      'XYZ',
    );

    this.refreshAttachmentLinkOffset(target);

    // Propagate same tweak to all other targets so hat and head stay together
    for (const otherTarget of test?.targets || []) {
      if (otherTarget === target) continue;
      otherTarget.tweakPosition.copy(target.tweakPosition);
      otherTarget.tweakEuler.copy(target.tweakEuler);
      this.refreshAttachmentLinkOffset(otherTarget);
    }

    this.updateHeadAttachments();
    this.applyAttachmentTestVisibility();
    this.syncAttachmentGizmoToSelection();
    this.setAttachmentTestStatus(`Offset adjusted. Anchor: ${target.selectedAnchorName}.`, 'good');
  }

  applyAttachmentTestVisibility() {
    const partVisibility = this.current?.partVisibility;
    const test = this.current?.attachmentTest;
    if (!partVisibility || !test) return;

    // Original head: the body's slot-1 hair — directly controlled by checkbox, no guards
    const showOriginalHead = this.dom.attachmentShowOriginalHead.checked;
    for (const mesh of partVisibility.headMeshes || []) {
      mesh.visible = showOriginalHead;
    }

    // Body face meshes (slot-8): always hidden in attachment test — detached rig takes over
    for (const mesh of partVisibility.faceMeshes || []) {
      mesh.visible = false;
    }

    // All detached targets (head sphere + hat) treated as one unit via single checkbox
    const showDetachedHead = this.dom.attachmentShowDetachedHead.checked;
    for (const target of test.targets || []) {
      for (const mesh of target.meshObjects || []) {
        mesh.visible = showDetachedHead;
      }
    }
  }

  resetAttachmentTestTweaks() {
    const target = this.getSelectedAttachmentLink();
    if (!target) return;

    target.tweakPosition.set(0, 0, 0);
    target.tweakEuler.set(0, 0, 0, 'XYZ');
    this.refreshAttachmentLinkOffset(target);
    this.syncAttachmentTestInputsFromSelection();
    this.updateHeadAttachments();
    this.applyAttachmentTestVisibility();
    this.syncAttachmentGizmoToSelection();
    this.setAttachmentTestStatus(`Reset ${target.meshName} tweak to zero.`, 'warn');
  }

  resetAttachmentTestPose() {
    if (!this.current?.mixer || !this.current?.clips?.length) return;

    const selectedIndex = Math.max(0, toFiniteNumber(this.dom.animationSelect.value, 0));
    if (this.currentAnimationIndex !== selectedIndex || !this.current.activeAction) {
      this.playClip(selectedIndex);
    }

    if (!this.current.activeAction) return;

    this.current.activeAction.reset().play();
    this.current.mixer.setTime(0);
    this.isPlaying = false;
    this.updatePlaybackButton();
    this.current.root.updateMatrixWorld(true);
    this.updateHeadAttachments();
    this.applyAttachmentTestVisibility();
    this.setAttachmentTestStatus('Pose reset. Adjust attachment, then click Start Test to run the clip.', 'warn');
  }

  startAttachmentTestPlayback() {
    if (!this.current?.clips?.length) return;

    const selectedIndex = Math.max(0, toFiniteNumber(this.dom.animationSelect.value, 0));
    if (this.currentAnimationIndex !== selectedIndex || !this.current.activeAction) {
      this.playClip(selectedIndex);
    }

    this.restartCurrentClip();
    this.isPlaying = true;
    this.updatePlaybackButton();

    const attachment = this.getSelectedAttachmentLink();
    if (attachment) {
      this.setAttachmentTestStatus(`Running ${this.current.clips[selectedIndex]?.name || `Clip ${selectedIndex + 1}`} with ${attachment.meshName} attached to ${attachment.selectedAnchorName}.`, 'good');
    }
  }

  updateActorPresentation({ recenterCamera = false, recomputePlacement = false, recomputeOrientation = false } = {}) {
    const presentation = this.current?.presentation;
    if (!presentation || !this.current?.root) return;

    const {
      placementRoot,
      orientationRoot,
      pelvisBone,
      headBone,
      rawBox,
      placedBox,
      center,
      size,
      pelvisPosition,
      headPosition,
      upVector,
      uprightCorrection,
      hasUprightCorrection,
    } = presentation;

    if (recomputeOrientation || !hasUprightCorrection) {
      orientationRoot.quaternion.identity();
      this.current.root.updateMatrixWorld(true);

      if (pelvisBone && headBone) {
        pelvisBone.getWorldPosition(pelvisPosition);
        headBone.getWorldPosition(headPosition);
        upVector.subVectors(headPosition, pelvisPosition);

        if (upVector.lengthSq() > 0.0001) {
          upVector.normalize();
          if (upVector.y < 0.6) {
            uprightCorrection.setFromUnitVectors(upVector, new THREE.Vector3(0, 1, 0));
          } else {
            uprightCorrection.identity();
          }
        } else {
          uprightCorrection.identity();
        }
      } else {
        uprightCorrection.identity();
      }

      presentation.hasUprightCorrection = true;
    }

    orientationRoot.quaternion.copy(uprightCorrection);
    orientationRoot.updateMatrixWorld(true);

    if (recomputePlacement || !presentation.hasPlacement) {
      rawBox.setFromObject(orientationRoot);
      if (rawBox.isEmpty()) return;

      rawBox.getCenter(center);
      placementRoot.position.set(-center.x, -rawBox.min.y, -center.z);
      presentation.hasPlacement = true;
    }

    placementRoot.updateMatrixWorld(true);

    if (!recenterCamera) return;

    placedBox.setFromObject(placementRoot);
    if (placedBox.isEmpty()) return;

    const adjustedCenter = placedBox.getCenter(new THREE.Vector3());
    const adjustedSize = placedBox.getSize(size);
    const maxDim = Math.max(adjustedSize.x, adjustedSize.y, adjustedSize.z, 1);
    const fitDistance = maxDim / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));

    this.camera.near = Math.max(0.1, maxDim / 500);
    this.camera.far = Math.max(6000, fitDistance * 20);
    this.camera.position.set(maxDim * 0.28, adjustedSize.y * 0.62 + fitDistance * 0.1, fitDistance * 0.72);
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(adjustedCenter);
    this.controls.maxDistance = Math.max(1000, fitDistance * 8);
    this.controls.update();
  }

  updateHeadAttachments() {
    const attachments = this.current?.attachments;
    if (!attachments) return;

    for (const attachment of attachments.rootLinks || []) {
      const parent = attachment.rootBone.parent;
      attachment.targetWorld.multiplyMatrices(attachment.anchorBone.matrixWorld, attachment.localOffset);

      if (parent) {
        attachment.parentInverse.copy(parent.matrixWorld).invert();
        attachment.localMatrix.multiplyMatrices(attachment.parentInverse, attachment.targetWorld);
      } else {
        attachment.localMatrix.copy(attachment.targetWorld);
      }

      attachment.localMatrix.decompose(
        attachment.position,
        attachment.quaternion,
        attachment.scale,
      );

      attachment.rootBone.position.copy(attachment.position);
      attachment.rootBone.quaternion.copy(attachment.quaternion);
      attachment.rootBone.scale.copy(attachment.scale);
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    for (const attachment of attachments.boneLinks || []) {
      const parent = attachment.targetBone.parent;
      attachment.targetWorld.copy(attachment.sourceBone.matrixWorld);

      if (parent) {
        attachment.parentInverse.copy(parent.matrixWorld).invert();
        attachment.localMatrix.multiplyMatrices(attachment.parentInverse, attachment.targetWorld);
      } else {
        attachment.localMatrix.copy(attachment.targetWorld);
      }

      attachment.localMatrix.decompose(
        attachment.position,
        attachment.quaternion,
        attachment.scale,
      );

      attachment.targetBone.position.copy(attachment.position);
      attachment.targetBone.quaternion.copy(attachment.quaternion);
      attachment.targetBone.scale.copy(attachment.scale);
    }
  }

  async applyFallbackMaterialTextures(exportInfo, material) {
    if (!material?.name) return;

    const materialName = String(material.name).trim();
    if (!materialName) return;

    let changed = false;

    const diffuseFile = this.findTextureFile(exportInfo, materialName, '_Diffuse');
    if (diffuseFile) {
      const diffuseMap = await this.loadTexture(
        this.buildTextureUrl(exportInfo, diffuseFile),
        THREE.SRGBColorSpace,
      );
      if (diffuseMap) {
        material.map = diffuseMap;
        if (material.color) material.color.setHex(0xffffff);
        changed = true;
      }
    } else if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
    }

    const normalFile = this.findTextureFile(exportInfo, materialName, '_TangentSpace_Normal');
    if (normalFile) {
      const normalMap = await this.loadTexture(this.buildTextureUrl(exportInfo, normalFile));
      if (normalMap) {
        material.normalMap = normalMap;
        changed = true;
      }
    }

    const specularFile = this.findTextureFile(exportInfo, materialName, '_SpecularColor');
    if (specularFile) {
      const specularMap = await this.loadTexture(
        this.buildTextureUrl(exportInfo, specularFile),
        THREE.SRGBColorSpace,
      );
      if (specularMap) {
        material.specularMap = specularMap;
        changed = true;
      }
    }

    if (changed) {
      material.needsUpdate = true;
    }
  }

  async prepareMaterials(exportInfo, root) {
    const tasks = [];

    root.traverse((object) => {
      if (!object.isMesh) return;

      object.castShadow = true;
      object.receiveShadow = true;

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        tasks.push(this.applyFallbackMaterialTextures(exportInfo, material));
      }
    });

    await Promise.all(tasks);

    const alphaTasks = [];

    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        if (material.map) {
          material.map.colorSpace = THREE.SRGBColorSpace;
          alphaTasks.push((async () => {
            const hasAlpha = await this.textureHasAlpha(material.map);
            if (hasAlpha) {
              material.transparent = true;
              material.alphaTest = Math.max(material.alphaTest || 0, 0.06);
              material.side = THREE.DoubleSide;
              material.depthWrite = false;
            }
          })());
        }
        if (material.emissiveMap) material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        material.needsUpdate = true;
      }
    });

    await Promise.all(alphaTasks);

    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.needsUpdate = true;
      }
    });
  }

  applyActorPartVisibility(exportInfo, root) {
    const actorParts = Array.isArray(exportInfo?.sourceActor?.parts) ? exportInfo.sourceActor.parts : [];
    if (!actorParts.length) {
      return { mode: 'none', headMeshes: [], faceMeshes: [], plaitMeshes: [], bangMeshes: [], hatMeshes: [] };
    }

    const headPart = actorParts.find((part) => Number(part.slot) === 1 && part.mesh);
    const facePart = actorParts.find((part) => Number(part.slot) === 8 && part.mesh);
    const plaitPart = actorParts.find((part) => Number(part.slot) === 6 && part.mesh);
    const bangPart = actorParts.find((part) => Number(part.slot) === 7 && part.mesh);
    const hatPart = actorParts.find((part) => Number(part.slot) === 9 && part.mesh);

    const headNames = headPart ? buildMeshNameSet(headPart.mesh) : new Set();
    const faceNames = facePart ? buildMeshNameSet(facePart.mesh) : new Set();
    const plaitNames = plaitPart ? buildMeshNameSet(plaitPart.mesh) : new Set();
    const bangNames = bangPart ? buildMeshNameSet(bangPart.mesh) : new Set();
    const hatNames = hatPart ? buildMeshNameSet(hatPart.mesh) : new Set();
    const faceDefinition = String(exportInfo?.sourceActor?.faceDefinition || '').trim();

    const headMeshes = [];
    const faceMeshes = [];
    const plaitMeshes = [];
    const bangMeshes = [];
    const hatMeshes = [];
    const faceSkinnedMeshes = [];
    root.traverse((object) => {
      if (!object.isMesh) return;
      if (headNames.has(object.name)) {
        headMeshes.push(object);
      }
      if (plaitNames.has(object.name)) {
        plaitMeshes.push(object);
      }
      if (bangNames.has(object.name)) {
        bangMeshes.push(object);
      }
      if (hatNames.has(object.name)) {
        hatMeshes.push(object);
      }
      if (faceNames.has(object.name)) {
        faceMeshes.push(object);
        if (object.isSkinnedMesh) {
          faceSkinnedMeshes.push(object);
        }
      }
    });

    for (const mesh of [...headMeshes, ...plaitMeshes, ...bangMeshes]) {
      mesh.visible = false;
    }

    const hasDetachedFaceRig = faceSkinnedMeshes.some((object) => {
      const bones = object.skeleton?.bones || [];
      if (!bones.length) return false;
      const boneSet = new Set(bones);
      const roots = bones.filter((bone) => !boneSet.has(bone.parent));
      return roots.length === 1 && String(roots[0].name || '').toLowerCase() === 'faceroot';
    });

    const useAnimatedHead = !faceDefinition && hasDetachedFaceRig;
    const mode = headPart && facePart
      ? (useAnimatedHead ? 'animated-head' : (hasDetachedFaceRig ? 'detached-face-overlay' : 'face-overlay'))
      : 'none';

    return {
      mode,
      hiddenPart: useAnimatedHead ? 'face' : 'head',
      hasDetachedFaceRig,
      hasFaceDefinition: Boolean(faceDefinition),
      headMeshes,
      faceMeshes,
      plaitMeshes,
      bangMeshes,
      hatMeshes,
    };
  }

  collectStats(root) {
    let bones = 0;
    let meshes = 0;
    let skinnedMeshes = 0;
    const materials = new Set();
    let texturedMaterials = 0;

    root.traverse((object) => {
      if (object.isBone) bones += 1;
      if (object.isMesh) {
        meshes += 1;
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) {
          if (material?.uuid) materials.add(material.uuid);
          if (material?.map) texturedMaterials += 1;
        }
      }
      if (object.isSkinnedMesh) skinnedMeshes += 1;
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());

    return {
      bones,
      meshes,
      skinnedMeshes,
      materials: materials.size,
      texturedMaterials,
      animationCount: Array.isArray(root.animations) ? root.animations.length : 0,
      size,
    };
  }

  frameCurrentActor() {
    this.updateActorPresentation({
      recenterCamera: true,
      recomputePlacement: true,
      recomputeOrientation: true,
    });
  }

  populateAnimationSelect(clips, clipSourceName = '') {
    const select = this.dom.animationSelect;
    select.innerHTML = '';

    if (!clips.length) {
      const option = document.createElement('option');
      option.value = '-1';
      option.textContent = clipSourceName ? `No clips in ${clipSourceName}` : 'No clips available';
      select.appendChild(option);
      select.disabled = true;
      this.dom.togglePlayback.disabled = true;
      this.dom.restartAnimation.disabled = true;
      this.renderClipList();
      return;
    }

    select.disabled = false;
    this.dom.togglePlayback.disabled = false;
    this.dom.restartAnimation.disabled = false;

    clips.forEach((clip, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = clip.name || `Clip ${index + 1}`;
      select.appendChild(option);
    });

    this.renderClipList();
  }

  stopCurrentAnimationPlayback() {
    if (!this.current?.mixer) return;

    if (this.current.activeAction) {
      this.current.activeAction.paused = false;
      this.current.activeAction.stop();
      this.current.activeAction = null;
    }

    this.current.mixer.stopAllAction();
    this.current.mixer.setTime(0);
    this.currentAnimationIndex = -1;
    this.isPlaying = false;
    this.updatePlaybackButton();
    this.renderClipList();
  }

  shouldAutoRunAnimation() {
    return this.dom.autoRunAnimation?.checked !== false;
  }

  async applySelectedClipSource({ preserveCurrentIndex = false } = {}) {
    if (!this.current) return;

    const clipSourceExport = this.current.exportInfo;
    if (!clipSourceExport) {
      this.current.clips = [];
      this.current.clipSourceName = '';
      this.populateAnimationSelect([], '');
      this.stopCurrentAnimationPlayback();
      return;
    }

    const requestedSourceName = clipSourceExport.name;
    const preferredIndex = preserveCurrentIndex
      ? Math.max(0, toFiniteNumber(this.dom.animationSelect.value, 0))
      : 0;

    const entry = {
      exportInfo: clipSourceExport,
      clips: this.current.embeddedClips,
      loaded: true,
    };

    this.currentClipSourceName = requestedSourceName;
    this.current.clipSourceName = requestedSourceName;
    this.current.clips = entry.clips;
    this.populateClipSourceSelect(requestedSourceName);
    this.stopCurrentAnimationPlayback();
    this.populateAnimationSelect(entry.clips, requestedSourceName);

    if (entry.clips.length) {
      const nextIndex = Math.min(preferredIndex, entry.clips.length - 1);
      const autoRunAnimation = this.shouldAutoRunAnimation();
      this.playClip(nextIndex, { autoplay: autoRunAnimation });
      this.setStatus(
        `Using ${entry.clips.length} matching clip(s) from ${requestedSourceName}${autoRunAnimation ? '.' : ' with auto-run disabled.'}`,
        'good',
      );
    } else {
      this.setStatus(`${requestedSourceName} has no embedded clips.`, 'warn');
    }
  }

  playClip(index, { autoplay = this.shouldAutoRunAnimation() } = {}) {
    if (!this.current?.mixer || !this.current.clips[index]) return;

    const nextClip = this.current.clips[index];
    this.current.mixer.stopAllAction();

    if (this.current.activeAction) {
      this.current.activeAction.paused = false;
      this.current.activeAction.stop();
    }

    const nextAction = this.current.mixer.clipAction(nextClip);
    nextAction.enabled = true;
    nextAction.paused = false;
    nextAction.clampWhenFinished = false;
    nextAction.setLoop(THREE.LoopRepeat, Infinity);
    nextAction.setEffectiveTimeScale(1);
    nextAction.setEffectiveWeight(1);
    nextAction.reset();
    nextAction.play();
    nextAction.paused = false;

    this.current.mixer.update(0);
    this.current.root.updateMatrixWorld(true);

    if (!autoplay) {
      nextAction.paused = true;
    }

    this.current.activeAction = nextAction;
    this.currentAnimationIndex = index;
    this.isPlaying = Boolean(autoplay);
    this.dom.animationSelect.value = String(index);
    this.updatePlaybackButton();
    this.renderClipList();
  }

  togglePlayback() {
    if (!this.current?.mixer || !this.current.activeAction) return;
    this.isPlaying = !this.isPlaying;
    this.current.activeAction.paused = !this.isPlaying;
    this.updatePlaybackButton();
    this.renderClipList();
  }

  restartCurrentClip() {
    if (!this.current?.activeAction) return;
    this.current.activeAction.enabled = true;
    this.current.activeAction.paused = false;
    this.current.activeAction.reset().play();
    this.current.mixer.setTime(0);
    this.current.root.updateMatrixWorld(true);
    this.isPlaying = true;
    this.updatePlaybackButton();
    this.renderClipList();
  }

  updatePlaybackButton() {
    this.dom.togglePlayback.textContent = this.isPlaying ? 'Pause' : 'Play';
  }

  updateSpeedLabel() {
    this.dom.speedLabel.textContent = `Speed ${this.playbackRate.toFixed(1)}x`;
  }

  resetResourceManagerPanel(emptyMessage = 'No actor loaded yet.', statusMessage = 'Load an actor to inspect every mesh piece and manage groups.') {
    if (this.current?.resourceManager) {
      this.current.resourceManager = null;
    }

    this.removeResourceGizmo();
    this.clearResourceSelectionHelpers();
    this.updateResourceGizmoButtons(this.resourceGizmoMode);
    this.setResourceStatus(statusMessage);
    this.setResourceSelectionSummary('');
    this.dom.resourceList.innerHTML = `
      <div class="resource-item">
        <div class="resource-meta">${escapeHtml(emptyMessage)}</div>
      </div>
    `;
  }

  setResourceStatus(message, tone = '') {
    this.dom.resourceStatus.textContent = message;
    this.dom.resourceStatus.className = `status-chip ${tone}`.trim();
  }

  setResourceSelectionSummary(message, tone = '') {
    this.dom.resourceSelectionSummary.textContent = message;
    this.dom.resourceSelectionSummary.className = `status-chip ${tone}`.trim();
  }

  buildResourceDescriptor(root, object) {
    const pathSegments = [];
    let current = object;

    while (current && current !== root) {
      pathSegments.push(current.name || current.type || current.uuid.slice(0, 8));
      current = current.parent;
    }

    pathSegments.push(root?.name || 'actor');
    pathSegments.reverse();

    return {
      id: object.uuid,
      path: pathSegments.join(' / '),
    };
  }

  collectResourceMaterialInfo(meshObjects) {
    const materialNames = new Set();
    const textureNames = new Set();

    for (const meshObject of meshObjects || []) {
      const materials = Array.isArray(meshObject.material)
        ? meshObject.material
        : [meshObject.material].filter(Boolean);

      for (const material of materials) {
        materialNames.add(material.name || meshObject.name || 'material');
        for (const textureName of collectTextureNamesFromMaterial(material)) {
          textureNames.add(textureName);
        }
      }
    }

    return {
      materialNames: [...materialNames].filter(Boolean).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      textureNames: [...textureNames].filter(Boolean).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
    };
  }

  findResourceMeshesForPart(root, meshPath, claimedMeshIds) {
    if (!meshPath) return [];

    const targets = [...buildMeshNameSet(meshPath)].map((name) => name.toLowerCase().replace(/[\s_-]+/g, ''));
    const matches = [];

    const collectMatches = (matcher) => {
      root.traverse((object) => {
        if (!object.isMesh || claimedMeshIds.has(object.uuid)) return;
        if (!matcher(object)) return;
        matches.push(object);
      });
    };

    collectMatches((object) => {
      const compactName = String(object.name || '').toLowerCase().replace(/[\s_-]+/g, '');
      return targets.some((target) => compactName === target || compactName.includes(target) || target.includes(compactName));
    });

    if (!matches.length) {
      const inferredName = inferResourceNameFromMeshPath(meshPath);
      collectMatches((object) => inferResourceNameFromMeshPath(object.name || '') === inferredName);
    }

    for (const object of matches) {
      claimedMeshIds.add(object.uuid);
    }

    return matches;
  }

  buildResourceManagerItems(exportInfo, root) {
    const items = [];
    const claimedMeshIds = new Set();
    const actorParts = Array.isArray(exportInfo?.sourceActor?.parts) ? exportInfo.sourceActor.parts : [];

    actorParts.forEach((part, index) => {
      const meshObjects = this.findResourceMeshesForPart(root, part.mesh, claimedMeshIds);
      if (!meshObjects.length) return;

      const descriptor = this.buildResourceDescriptor(root, meshObjects[0]);
      const info = this.collectResourceMaterialInfo(meshObjects);
      const slotNumber = Number(part.slot || 0);
      const label = ACTOR_PART_SLOT_LABELS[slotNumber]
        || inferResourceNameFromMeshPath(part.mesh || part.material || part.section)
        || prettifyResourceName(part.section || part.mesh || `part ${index + 1}`);

      items.push({
        id: `part:${slotNumber}:${index}`,
        label,
        slot: slotNumber,
        section: String(part.section || ''),
        meshPath: String(part.mesh || ''),
        materialPath: String(part.material || ''),
        path: descriptor.path,
        meshObjects,
        materialNames: info.materialNames,
        textureNames: info.textureNames,
        groupId: '',
        groupName: '',
      });
    });

    root.traverse((object) => {
      if (!object.isMesh || claimedMeshIds.has(object.uuid)) return;

      const descriptor = this.buildResourceDescriptor(root, object);
      const info = this.collectResourceMaterialInfo([object]);

      items.push({
        id: `mesh:${object.uuid}`,
        label: inferResourceNameFromMeshPath(object.name || descriptor.path),
        slot: 9999,
        section: '',
        meshPath: '',
        materialPath: '',
        path: descriptor.path,
        meshObjects: [object],
        materialNames: info.materialNames,
        textureNames: info.textureNames,
        groupId: '',
        groupName: '',
      });
    });

    items.sort((left, right) => {
      const slotDiff = Number(left.slot || 0) - Number(right.slot || 0);
      if (slotDiff !== 0) return slotDiff;
      return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' });
    });

    return items;
  }

  normalizeResourceGroups(groups, items) {
    const validIds = new Set((items || []).map((item) => item.id));
    return (Array.isArray(groups) ? groups : [])
      .map((group, index) => ({
        id: String(group?.id || `group-${index + 1}`),
        name: String(group?.name || `Group ${index + 1}`),
        members: [...new Set((Array.isArray(group?.members) ? group.members : [])
          .map((member) => String(member || ''))
          .filter((member) => validIds.has(member)))],
      }))
      .filter((group) => group.members.length >= 2);
  }

  rebuildResourceGroupIndex() {
    const state = this.current?.resourceManager;
    if (!state) return;

    state.groupByMember = new Map();
    for (const item of state.items) {
      item.groupId = '';
      item.groupName = '';
    }

    for (const group of state.groups) {
      for (const memberId of group.members) {
        state.groupByMember.set(memberId, group);
        const item = state.itemMap.get(memberId);
        if (!item) continue;
        item.groupId = group.id;
        item.groupName = group.name;
      }
    }

    this.rebuildResourceDisplayItems();
  }

  buildDisplayItemFromBaseItem(item) {
    return {
      displayId: item.id,
      type: 'item',
      label: item.label,
      badge: '',
      memberIds: [item.id],
      materialNames: [...item.materialNames],
      textureNames: [...item.textureNames],
      components: item.meshObjects.map((meshObject, index) => ({
        componentId: `${item.id}:mesh:${index}`,
        label: prettifyResourceName(meshObject.name || `${item.label} ${index + 1}`),
        meshObjects: [meshObject],
      })),
    };
  }

  buildDisplayItemFromGroup(group, memberItems) {
    const labelParts = memberItems.map((item) => item.label);
    const label = labelParts.length <= 3
      ? labelParts.join(' + ')
      : `${labelParts[0]} + ${labelParts.length - 1} more`;

    const materialNames = new Set();
    const textureNames = new Set();
    for (const item of memberItems) {
      for (const materialName of item.materialNames) materialNames.add(materialName);
      for (const textureName of item.textureNames) textureNames.add(textureName);
    }

    return {
      displayId: `group:${group.id}`,
      type: 'group',
      label,
      badge: group.name,
      memberIds: memberItems.map((item) => item.id),
      materialNames: [...materialNames].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      textureNames: [...textureNames].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      components: memberItems.map((item) => ({
        componentId: `group-member:${item.id}`,
        label: item.label,
        meshObjects: item.meshObjects,
      })),
    };
  }

  rebuildResourceDisplayItems() {
    const state = this.current?.resourceManager;
    if (!state) return;

    const groupedMemberIds = new Set();
    const displayItems = [];

    for (const group of state.groups) {
      const memberItems = group.members
        .map((memberId) => state.itemMap.get(memberId))
        .filter(Boolean);

      if (memberItems.length < 2) continue;

      for (const memberItem of memberItems) {
        groupedMemberIds.add(memberItem.id);
      }

      displayItems.push(this.buildDisplayItemFromGroup(group, memberItems));
    }

    for (const item of state.items) {
      if (groupedMemberIds.has(item.id)) continue;
      displayItems.push(this.buildDisplayItemFromBaseItem(item));
    }

    displayItems.sort((left, right) => {
      const leftItem = state.itemMap.get(left.memberIds[0]);
      const rightItem = state.itemMap.get(right.memberIds[0]);
      const slotDiff = Number(leftItem?.slot || 0) - Number(rightItem?.slot || 0);
      if (slotDiff !== 0) return slotDiff;
      return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' });
    });

    state.displayItems = displayItems;
    state.displayItemMap = new Map(displayItems.map((item) => [item.displayId, item]));
    state.expandedIds = new Set([...state.expandedIds].filter((displayId) => state.displayItemMap.has(displayId)));
    state.selectedDisplayIds = (state.selectedDisplayIds || []).filter((displayId) => state.displayItemMap.has(displayId));
  }

  async fetchResourceGroups(actorName) {
    try {
      const response = await fetch(`/api/resource-groups?actor=${encodeURIComponent(actorName)}`);
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload?.groups) ? payload.groups : [];
    } catch {
      return [];
    }
  }

  async persistResourceGroups() {
    const state = this.current?.resourceManager;
    if (!state?.actorName) return;

    const response = await fetch(`/api/resource-groups?actor=${encodeURIComponent(state.actorName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groups: state.groups.map((group) => ({
          id: group.id,
          name: group.name,
          members: [...group.members],
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text() || `HTTP ${response.status}`);
    }
  }

  async setupResourceManager(exportInfo, root) {
    const items = this.buildResourceManagerItems(exportInfo, root);
    const groups = this.normalizeResourceGroups(await this.fetchResourceGroups(exportInfo.name), items);

    this.current.resourceManager = {
      actorName: exportInfo.name,
      items,
      itemMap: new Map(items.map((item) => [item.id, item])),
      groups,
      groupByMember: new Map(),
      displayItems: [],
      displayItemMap: new Map(),
      selectedDisplayIds: [],
      expandedIds: new Set(),
    };

    this.rebuildResourceGroupIndex();
    this.updateResourceGizmoButtons(this.resourceGizmoMode);
    this.renderResourceList();
    this.setResourceStatus(`${items.length} part row(s) loaded. Use the arrow to open details, then toggle rows with the checkboxes.`, 'good');
    this.setResourceSelectionSummary('');
  }

  async refreshCurrentResourceManager() {
    if (!this.current?.exportInfo || !this.current?.root) return;
    await this.setupResourceManager(this.current.exportInfo, this.current.root);
    this.clearResourceSelectionHelpers();
    this.removeResourceGizmo();
  }

  getSelectedResourceDisplayItems() {
    return [];
  }

  getDisplayItemVisibility(displayItem) {
    return displayItem.memberIds.every((memberId) => {
      const item = this.current?.resourceManager?.itemMap.get(memberId);
      return item?.meshObjects?.every((meshObject) => meshObject.visible) ?? false;
    });
  }

  getDisplayItemMeshes(displayItem) {
    const state = this.current?.resourceManager;
    if (!state || !displayItem) return [];

    const seen = new Set();
    const meshes = [];
    for (const memberId of displayItem.memberIds || []) {
      const item = state.itemMap.get(memberId);
      if (!item) continue;
      for (const meshObject of item.meshObjects || []) {
        if (seen.has(meshObject.uuid)) continue;
        seen.add(meshObject.uuid);
        meshes.push(meshObject);
      }
    }

    return meshes;
  }

  getTextureSourceName(texture, fallback = '') {
    return basenameFromPath(texture?.name || texture?.image?.currentSrc || texture?.image?.src || fallback);
  }

  getResourceMeshAppearanceState(meshObject) {
    if (!meshObject?.userData) return null;

    if (!meshObject.userData.resourceAppearanceState) {
      const originalMaterials = Array.isArray(meshObject.material)
        ? meshObject.material.filter(Boolean)
        : [meshObject.material].filter(Boolean);

      meshObject.userData.resourceAppearanceState = {
        originalMaterial: meshObject.material,
        usesMaterialArray: Array.isArray(meshObject.material),
        materialStates: originalMaterials.map((material, materialIndex) => {
          const textures = RESOURCE_TEXTURE_FIELDS
            .map(({ key, label }) => {
              const texture = material?.[key];
              if (!texture) return null;

              const textureName = this.getTextureSourceName(texture, key);
              return {
                key,
                channelLabel: label,
                label: textureName ? `${label} - ${textureName}` : label,
              };
            })
            .filter(Boolean);

          return {
            materialIndex,
            label: material?.name || meshObject.name || `material ${materialIndex + 1}`,
            originalMaterial: material,
            visible: true,
            neutralMaterial: null,
            variantCache: new Map(),
            textures,
            textureVisibility: new Map(textures.map((textureInfo) => [textureInfo.key, true])),
          };
        }),
        texturesVisible: true,
        materialsVisible: true,
      };
    }

    return meshObject.userData.resourceAppearanceState;
  }

  getResourceMeshMaterialStates(meshObject) {
    return this.getResourceMeshAppearanceState(meshObject)?.materialStates || [];
  }

  collectDisplayItemAppearanceEntries(displayItem) {
    const materialEntryMap = new Map();
    const textureEntryMap = new Map();

    for (const meshObject of this.getDisplayItemMeshes(displayItem)) {
      for (const materialState of this.getResourceMeshMaterialStates(meshObject)) {
        const materialKey = String(materialState.label || `material-${materialState.materialIndex}`);
        let materialEntry = materialEntryMap.get(materialKey);
        if (!materialEntry) {
          materialEntry = {
            entryId: `material:${materialKey}`,
            label: materialKey,
            targets: [],
          };
          materialEntryMap.set(materialKey, materialEntry);
        }

        materialEntry.targets.push({
          meshObject,
          materialIndex: materialState.materialIndex,
        });

        for (const textureInfo of materialState.textures || []) {
          const textureKey = `${textureInfo.key}:${textureInfo.label}`;
          let textureEntry = textureEntryMap.get(textureKey);
          if (!textureEntry) {
            textureEntry = {
              entryId: `texture:${textureKey}`,
              label: textureInfo.label,
              targets: [],
            };
            textureEntryMap.set(textureKey, textureEntry);
          }

          textureEntry.targets.push({
            meshObject,
            materialIndex: materialState.materialIndex,
            textureKey: textureInfo.key,
          });
        }
      }
    }

    const sortByLabel = (left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    return {
      materialEntries: [...materialEntryMap.values()].sort(sortByLabel),
      textureEntries: [...textureEntryMap.values()].sort(sortByLabel),
    };
  }

  isResourceMaterialEntryVisible(entry) {
    return entry.targets.every(({ meshObject, materialIndex }) => {
      const materialState = this.getResourceMeshMaterialStates(meshObject)[materialIndex];
      return materialState?.visible !== false;
    });
  }

  isResourceTextureEntryVisible(entry) {
    return entry.targets.every(({ meshObject, materialIndex, textureKey }) => {
      const materialState = this.getResourceMeshMaterialStates(meshObject)[materialIndex];
      return materialState?.textureVisibility?.get(textureKey) !== false;
    });
  }

  cloneResourceMaterialVariant(material, meshObject, variant) {
    if (!material?.clone) {
      const fallback = new THREE.MeshStandardMaterial({ color: 0xc7ced8, roughness: 1, metalness: 0 });
      fallback.skinning = Boolean(meshObject?.isSkinnedMesh);
      return fallback;
    }

    const clone = material.clone();

    for (const { key } of RESOURCE_TEXTURE_FIELDS) {
      if (key in clone) {
        clone[key] = null;
      }
    }

    if (variant === 'neutral') {
      if (clone.color?.setHex) clone.color.setHex(0xc7ced8);
      if (clone.emissive?.setHex) clone.emissive.setHex(0x000000);
      if ('roughness' in clone) clone.roughness = 1;
      if ('metalness' in clone) clone.metalness = 0;
      if ('shininess' in clone) clone.shininess = 0;
      if (clone.specular?.setHex) clone.specular.setHex(0x111111);
      if ('transparent' in clone) clone.transparent = false;
      if ('opacity' in clone) clone.opacity = 1;
      if ('alphaTest' in clone) clone.alphaTest = 0;
    }

    if ('skinning' in clone) clone.skinning = Boolean(meshObject?.isSkinnedMesh);
    clone.needsUpdate = true;
    return clone;
  }

  getResourceMaterialVariant(meshObject, materialState, variant) {
    if (variant === 'neutral') {
      if (!materialState.neutralMaterial) {
        materialState.neutralMaterial = this.cloneResourceMaterialVariant(materialState.originalMaterial, meshObject, 'neutral');
      }

      return materialState.neutralMaterial;
    }

    const signature = (materialState.textures || [])
      .map((textureInfo) => `${textureInfo.key}:${materialState.textureVisibility.get(textureInfo.key) === false ? '0' : '1'}`)
      .join('|');

    if (!signature || !signature.includes('0')) {
      return materialState.originalMaterial;
    }

    if (!materialState.variantCache.has(signature)) {
      const clone = materialState.originalMaterial?.clone
        ? materialState.originalMaterial.clone()
        : new THREE.MeshStandardMaterial({ color: 0xc7ced8, roughness: 1, metalness: 0 });

      for (const textureInfo of materialState.textures || []) {
        if (materialState.textureVisibility.get(textureInfo.key) === false && textureInfo.key in clone) {
          clone[textureInfo.key] = null;
        }
      }

      if ('skinning' in clone) clone.skinning = Boolean(meshObject?.isSkinnedMesh);
      clone.needsUpdate = true;
      materialState.variantCache.set(signature, clone);
    }

    return materialState.variantCache.get(signature);
  }

  applyResourceMeshAppearance(meshObject) {
    const appearanceState = this.getResourceMeshAppearanceState(meshObject);
    if (!appearanceState) return;

    const nextMaterials = appearanceState.materialStates.map((materialState) => {
      if (!materialState.visible) {
        return this.getResourceMaterialVariant(meshObject, materialState, 'neutral');
      }

      return this.getResourceMaterialVariant(meshObject, materialState, 'masked');
    });

    appearanceState.materialsVisible = appearanceState.materialStates.every((materialState) => materialState.visible !== false);
    appearanceState.texturesVisible = appearanceState.materialStates.every((materialState) =>
      (materialState.textures || []).every((textureInfo) => materialState.textureVisibility.get(textureInfo.key) !== false)
    );

    meshObject.material = appearanceState.usesMaterialArray
      ? nextMaterials
      : nextMaterials[0] || appearanceState.originalMaterial;

    const materials = Array.isArray(meshObject.material) ? meshObject.material : [meshObject.material];
    for (const material of materials) {
      if (material) material.needsUpdate = true;
    }
  }

  getDisplayItemMaterialVisibility(displayItem) {
    const meshes = this.getDisplayItemMeshes(displayItem);
    if (!meshes.length) return true;
    return meshes.every((meshObject) => this.getResourceMeshMaterialStates(meshObject).every((materialState) => materialState.visible !== false));
  }

  getDisplayItemTextureVisibility(displayItem) {
    const meshes = this.getDisplayItemMeshes(displayItem);
    if (!meshes.length) return true;
    return meshes.every((meshObject) => this.getResourceMeshMaterialStates(meshObject).every((materialState) =>
      (materialState.textures || []).every((textureInfo) => materialState.textureVisibility.get(textureInfo.key) !== false)
    ));
  }

  getSelectedResourceItems() {
    const state = this.current?.resourceManager;
    if (!state) return [];

    const selectedIds = new Set(this.getSelectedResourceDisplayItems().flatMap((displayItem) => displayItem.memberIds));
    return [...selectedIds].map((itemId) => state.itemMap.get(itemId)).filter(Boolean);
  }

  getSelectedResourceMeshes() {
    const seen = new Set();
    const meshes = [];

    for (const item of this.getSelectedResourceItems()) {
      for (const meshObject of item.meshObjects || []) {
        if (seen.has(meshObject.uuid)) continue;
        seen.add(meshObject.uuid);
        meshes.push(meshObject);
      }
    }

    return meshes;
  }

  renderResourceList() {
    const state = this.current?.resourceManager;
    if (!state?.displayItems?.length) {
      this.dom.resourceList.innerHTML = `
        <div class="resource-item">
          <div class="resource-meta">No mesh resources found in the loaded actor.</div>
        </div>
      `;
      return;
    }

    this.dom.resourceList.innerHTML = state.displayItems.map((displayItem) => {
      const visible = this.getDisplayItemVisibility(displayItem);
      const expanded = state.expandedIds.has(displayItem.displayId);
      const appearanceEntries = this.collectDisplayItemAppearanceEntries(displayItem);

      const materialsHtml = appearanceEntries.materialEntries.length
        ? `<div class="resource-toggle-list">${appearanceEntries.materialEntries.map((entry) => {
            const entryVisible = this.isResourceMaterialEntryVisible(entry);
            return `
              <label class="resource-toggle-row">
                <div class="resource-toggle-name">${escapeHtml(entry.label)}</div>
                <input
                  class="resource-row-checkbox"
                  data-resource-material-entry-visibility="${escapeHtml(displayItem.displayId)}"
                  data-entry-id="${escapeHtml(entry.entryId)}"
                  type="checkbox"
                  ${entryVisible ? 'checked' : ''}
                >
              </label>
            `;
          }).join('')}</div>`
        : '<div class="resource-empty">No material slots found.</div>';

      const texturesHtml = appearanceEntries.textureEntries.length
        ? `<div class="resource-toggle-list">${appearanceEntries.textureEntries.map((entry) => {
            const entryVisible = this.isResourceTextureEntryVisible(entry);
            return `
              <label class="resource-toggle-row">
                <div class="resource-toggle-name">${escapeHtml(entry.label)}</div>
                <input
                  class="resource-row-checkbox"
                  data-resource-texture-entry-visibility="${escapeHtml(displayItem.displayId)}"
                  data-entry-id="${escapeHtml(entry.entryId)}"
                  type="checkbox"
                  ${entryVisible ? 'checked' : ''}
                >
              </label>
            `;
          }).join('')}</div>`
        : '<div class="resource-empty">No texture maps found.</div>';

      const componentsHtml = displayItem.components.map((component) => {
        const componentVisible = component.meshObjects.every((meshObject) => meshObject.visible);
        return `
          <label class="resource-component-row">
            <div class="resource-component-name">${escapeHtml(component.label)}</div>
            <input
              class="resource-row-checkbox"
              data-resource-component-visibility="${escapeHtml(displayItem.displayId)}"
              data-component-id="${escapeHtml(component.componentId)}"
              type="checkbox"
              ${componentVisible ? 'checked' : ''}
            >
          </label>
        `;
      }).join('');

      return `
        <div class="resource-item ${visible ? '' : 'hidden-item'}">
          <div class="resource-header">
            <div class="resource-main">
              <div class="resource-title-wrap">
                <div class="resource-title">${escapeHtml(displayItem.label)}</div>
                ${displayItem.badge ? `<div class="resource-badge">${escapeHtml(displayItem.badge)}</div>` : ''}
              </div>
            </div>
            <button class="resource-detail-toggle" data-resource-expand="${escapeHtml(displayItem.displayId)}" type="button">
              <div class="resource-caret">${expanded ? '&#9662;' : '&#9656;'}</div>
            </button>
            <input class="resource-row-checkbox" data-resource-visibility="${escapeHtml(displayItem.displayId)}" type="checkbox" ${visible ? 'checked' : ''}>
          </div>
          ${expanded ? `
            <div class="resource-details">
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Materials</div>
                </div>
                ${materialsHtml}
              </div>
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Textures</div>
                </div>
                ${texturesHtml}
              </div>
              <div class="resource-section">
                <div class="resource-section-head">
                  <div class="resource-section-title">Components</div>
                </div>
                <div class="resource-components">${componentsHtml}</div>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  handleResourceListClick(event) {
    const expandButton = event.target.closest('[data-resource-expand]');
    if (expandButton) {
      const displayId = expandButton.getAttribute('data-resource-expand');
      this.toggleResourceExpansion(displayId);
    }
  }

  handleResourceListChange(event) {
    const visibilityInput = event.target.closest('[data-resource-visibility]');
    if (visibilityInput) {
      const displayId = visibilityInput.getAttribute('data-resource-visibility');
      this.setDisplayItemVisibility(displayId, visibilityInput.checked);
      return;
    }

    const materialInput = event.target.closest('[data-resource-material-visibility]');
    if (materialInput) {
      const displayId = materialInput.getAttribute('data-resource-material-visibility');
      this.setDisplayItemMaterialVisibility(displayId, materialInput.checked);
      return;
    }

    const textureInput = event.target.closest('[data-resource-texture-visibility]');
    if (textureInput) {
      const displayId = textureInput.getAttribute('data-resource-texture-visibility');
      this.setDisplayItemTextureVisibility(displayId, textureInput.checked);
      return;
    }

    const materialEntryInput = event.target.closest('[data-resource-material-entry-visibility]');
    if (materialEntryInput) {
      const displayId = materialEntryInput.getAttribute('data-resource-material-entry-visibility');
      const entryId = materialEntryInput.getAttribute('data-entry-id');
      this.setDisplayItemMaterialEntryVisibility(displayId, entryId, materialEntryInput.checked);
      return;
    }

    const textureEntryInput = event.target.closest('[data-resource-texture-entry-visibility]');
    if (textureEntryInput) {
      const displayId = textureEntryInput.getAttribute('data-resource-texture-entry-visibility');
      const entryId = textureEntryInput.getAttribute('data-entry-id');
      this.setDisplayItemTextureEntryVisibility(displayId, entryId, textureEntryInput.checked);
      return;
    }

    const componentInput = event.target.closest('[data-resource-component-visibility]');
    if (!componentInput) return;

    const displayId = componentInput.getAttribute('data-resource-component-visibility');
    const componentId = componentInput.getAttribute('data-component-id');
    this.setDisplayComponentVisibility(displayId, componentId, componentInput.checked);
  }

  toggleResourceExpansion(displayId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    if (state.expandedIds.has(displayId)) state.expandedIds.delete(displayId);
    else state.expandedIds = new Set([displayId]);
    this.renderResourceList();
  }

  selectResourceDisplayIds(displayIds, { append = false } = {}) {
    return;
  }

  updateResourceSelectionUi() {
    const state = this.current?.resourceManager;
    if (state) {
      state.selectedDisplayIds = [];
    }

    this.renderResourceList();
    this.clearResourceSelectionHelpers();
    this.removeResourceGizmo();
    this.setResourceSelectionSummary('');
  }

  setDisplayItemVisibility(displayId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    for (const memberId of displayItem.memberIds) {
      const item = state.itemMap.get(memberId);
      if (!item) continue;
      for (const meshObject of item.meshObjects || []) {
        meshObject.visible = Boolean(visible);
      }
    }

    this.setResourceStatus(`${displayItem.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
    this.updateResourceSelectionUi();
  }

  setDisplayComponentVisibility(displayId, componentId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    const component = (displayItem.components || []).find((entry) => entry.componentId === componentId);
    if (!component) return;

    for (const meshObject of component.meshObjects || []) {
      meshObject.visible = Boolean(visible);
    }

    this.setResourceStatus(`${component.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
    this.updateResourceSelectionUi();
  }

  setDisplayItemMaterialVisibility(displayId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    for (const meshObject of this.getDisplayItemMeshes(displayItem)) {
      for (const materialState of this.getResourceMeshMaterialStates(meshObject)) {
        materialState.visible = Boolean(visible);
      }

      this.applyResourceMeshAppearance(meshObject);
    }

    this.setResourceStatus(
      `${displayItem.label} materials ${visible ? 'restored' : 'set to neutral'}.`,
      visible ? 'good' : 'warn',
    );
    this.updateResourceSelectionUi();
  }

  setDisplayItemTextureVisibility(displayId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    for (const meshObject of this.getDisplayItemMeshes(displayItem)) {
      for (const materialState of this.getResourceMeshMaterialStates(meshObject)) {
        for (const textureInfo of materialState.textures || []) {
          materialState.textureVisibility.set(textureInfo.key, Boolean(visible));
        }
      }

      this.applyResourceMeshAppearance(meshObject);
    }

    this.setResourceStatus(
      `${displayItem.label} textures ${visible ? 'restored' : 'hidden'}.`,
      visible ? 'good' : 'warn',
    );
    this.updateResourceSelectionUi();
  }

  setDisplayItemMaterialEntryVisibility(displayId, entryId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    const materialEntry = this.collectDisplayItemAppearanceEntries(displayItem).materialEntries
      .find((entry) => entry.entryId === entryId);
    if (!materialEntry) return;

    for (const target of materialEntry.targets) {
      const materialState = this.getResourceMeshMaterialStates(target.meshObject)[target.materialIndex];
      if (!materialState) continue;
      materialState.visible = Boolean(visible);
      this.applyResourceMeshAppearance(target.meshObject);
    }

    this.setResourceStatus(
      `${materialEntry.label} ${visible ? 'restored' : 'set to neutral'}.`,
      visible ? 'good' : 'warn',
    );
    this.updateResourceSelectionUi();
  }

  setDisplayItemTextureEntryVisibility(displayId, entryId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    const textureEntry = this.collectDisplayItemAppearanceEntries(displayItem).textureEntries
      .find((entry) => entry.entryId === entryId);
    if (!textureEntry) return;

    for (const target of textureEntry.targets) {
      const materialState = this.getResourceMeshMaterialStates(target.meshObject)[target.materialIndex];
      if (!materialState) continue;
      materialState.textureVisibility.set(target.textureKey, Boolean(visible));
      this.applyResourceMeshAppearance(target.meshObject);
    }

    this.setResourceStatus(
      `${textureEntry.label} ${visible ? 'restored' : 'hidden'}.`,
      visible ? 'good' : 'warn',
    );
    this.updateResourceSelectionUi();
  }

  createResourceSelectionHelper(meshObject) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd54a,
      wireframe: true,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });

    let helper;
    if (meshObject.isSkinnedMesh) {
      helper = new THREE.SkinnedMesh(meshObject.geometry, material);
      helper.bind(meshObject.skeleton, meshObject.bindMatrix);
      helper.bindMatrixInverse.copy(meshObject.bindMatrixInverse);
    } else {
      helper = new THREE.Mesh(meshObject.geometry, material);
    }

    helper.name = '__resource_selection_helper__';
    helper.frustumCulled = false;
    helper.renderOrder = 999;
    helper.raycast = () => {};
    helper.position.set(0, 0, 0);
    helper.quaternion.identity();
    helper.scale.set(1, 1, 1);
    meshObject.add(helper);
    return helper;
  }

  clearResourceSelectionHelpers() {
    for (const helper of this.resourceSelectionHelpers) {
      if (helper.parent) {
        helper.parent.remove(helper);
      }
      helper.material?.dispose?.();
    }
    this.resourceSelectionHelpers = [];
  }

  refreshResourceSelectionHelpers() {
    this.clearResourceSelectionHelpers();

    for (const meshObject of this.getSelectedResourceMeshes()) {
      this.resourceSelectionHelpers.push(this.createResourceSelectionHelper(meshObject));
    }
  }

  updateResourceGizmoButtons(mode) {
    this.dom.resourceGizmoTranslate.className = `${mode === 'translate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoRotate.className = `${mode === 'rotate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoOff.className = `${mode === 'off' ? 'primary' : 'secondary'} button-grow`;
  }

  setResourceGizmoMode(mode) {
    this.resourceGizmoMode = mode === 'rotate' || mode === 'translate' ? mode : 'off';
    this.updateResourceGizmoButtons(this.resourceGizmoMode);

    if (this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.syncResourceGizmoToSelection();
  }

  ensureResourceGizmo() {
    if (!this.resourceTransformControls) {
      this.resourceTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.resourceTransformControls.setSpace('world');
      this.resourceTransformControls.setMode(this.resourceGizmoMode);
      this.scene.add(this.resourceTransformControls.getHelper());

      this.resourceTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (event.value) {
          this.snapshotResourceSelectionTransforms();
        }
      });

      this.resourceTransformControls.addEventListener('objectChange', () => {
        if (this.resourceSelectionSyncing) return;
        this.applyResourceSelectionDelta();
      });
    }

    if (!this.resourceSelectionPivot) {
      this.resourceSelectionPivot = new THREE.Object3D();
      this.resourceSelectionPivot.name = '__resource_manager_pivot__';
      this.scene.add(this.resourceSelectionPivot);
    }
  }

  removeResourceGizmo() {
    this.controls.enabled = true;

    if (this.resourceTransformControls) {
      this.resourceTransformControls.detach();
      this.scene.remove(this.resourceTransformControls.getHelper());
      this.resourceTransformControls.dispose();
      this.resourceTransformControls = null;
    }

    if (this.resourceSelectionPivot?.parent) {
      this.resourceSelectionPivot.parent.remove(this.resourceSelectionPivot);
    }

    this.resourceSelectionPivot = null;
    this.resourceSelectionBaseStates = [];
  }

  snapshotResourceSelectionTransforms() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || !this.resourceSelectionPivot) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourcePivotStartMatrix.copy(this.resourceSelectionPivot.matrix);
    this.resourcePivotStartInverse.copy(this.resourcePivotStartMatrix).invert();

    this.resourceSelectionBaseStates = selectedMeshes.map((meshObject) => ({
      meshObject,
      worldMatrix: meshObject.matrixWorld.clone(),
      parentInverse: meshObject.parent
        ? meshObject.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4(),
    }));
  }

  applyResourceSelectionDelta() {
    if (!this.resourceSelectionPivot || !this.resourceSelectionBaseStates.length) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceSelectionDeltaMatrix.multiplyMatrices(this.resourceSelectionPivot.matrix, this.resourcePivotStartInverse);

    for (const state of this.resourceSelectionBaseStates) {
      this.resourceSelectionWorldMatrix.multiplyMatrices(this.resourceSelectionDeltaMatrix, state.worldMatrix);
      this.resourceSelectionLocalMatrix.multiplyMatrices(state.parentInverse, this.resourceSelectionWorldMatrix);
      this.resourceSelectionLocalMatrix.decompose(
        state.meshObject.position,
        state.meshObject.quaternion,
        state.meshObject.scale,
      );
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    this.setResourceStatus(`Moving ${this.resourceSelectionBaseStates.length} mesh piece(s).`, 'good');
  }

  syncResourceGizmoToSelection() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.ensureResourceGizmo();

    const box = new THREE.Box3();
    const itemBox = new THREE.Box3();
    const center = new THREE.Vector3();
    let hasBox = false;

    for (const meshObject of selectedMeshes) {
      itemBox.setFromObject(meshObject);
      if (itemBox.isEmpty()) continue;
      if (!hasBox) box.copy(itemBox);
      else box.union(itemBox);
      hasBox = true;
    }

    if (!hasBox) {
      selectedMeshes[0].getWorldPosition(center);
    } else {
      box.getCenter(center);
    }

    this.resourceSelectionSyncing = true;
    this.resourceSelectionPivot.position.copy(center);
    this.resourceSelectionPivot.quaternion.identity();
    this.resourceSelectionPivot.scale.set(1, 1, 1);
    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceTransformControls.attach(this.resourceSelectionPivot);
    this.resourceTransformControls.setSpace('world');
    this.resourceTransformControls.setMode(this.resourceGizmoMode);
    this.resourceSelectionSyncing = false;

    this.snapshotResourceSelectionTransforms();
  }

  async toggleSelectedResourceGrouping() {
    const state = this.current?.resourceManager;
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();
    if (!state || !selectedDisplayItems.length) {
      this.setResourceStatus('Select one or more rows first.', 'warn');
      return;
    }

    if (selectedDisplayItems.length === 1 && selectedDisplayItems[0].type === 'group') {
      await this.ungroupResourceByGroupId(String(selectedDisplayItems[0].displayId || '').replace(/^group:/, ''));
      return;
    }

    const memberIds = [...new Set(selectedDisplayItems.flatMap((displayItem) => displayItem.memberIds))];
    if (memberIds.length < 2) {
      this.setResourceStatus('Select at least two rows to create a group.', 'warn');
      return;
    }

    await this.groupSelectedResources(memberIds);
  }

  async groupSelectedResources(memberIds) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const selectedSet = new Set(memberIds);
    const nextGroups = [];
    for (const group of state.groups) {
      const members = group.members.filter((member) => !selectedSet.has(member));
      if (members.length >= 2) {
        nextGroups.push({ ...group, members });
      }
    }

    const nextNumber = nextGroups.reduce((maxValue, group) => {
      const match = /^Group\s+(\d+)$/i.exec(group.name || '');
      return Math.max(maxValue, match ? Number(match[1]) : 0);
    }, 0) + 1;

    const groupId = `group-${Date.now()}`;
    nextGroups.push({
      id: groupId,
      name: `Group ${nextNumber}`,
      members: [...selectedSet],
    });

    state.groups = nextGroups;
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Saved Group ${nextNumber}.`, 'good');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = [`group:${groupId}`];
    this.updateResourceSelectionUi();
  }

  async ungroupResourceByGroupId(groupId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    state.groups = state.groups.filter((entry) => entry.id !== groupId);
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Ungrouped ${group.name}.`, 'warn');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = group.members.filter((memberId) => state.displayItemMap.has(memberId));
    this.updateResourceSelectionUi();
  }

/*

  resetResourceManagerPanel() {
    this.removeResourceGizmo();
    this.clearResourceSelectionHelpers();
    this.updateResourceGizmoButtons(this.resourceGizmoMode);
    this.setResourceStatus('Load an actor to inspect every mesh piece and manage groups.');
    this.setResourceSelectionSummary('No resource selected.');
    this.dom.resourceList.innerHTML = `
      <div class="resource-item">
        <div class="resource-meta">No actor loaded yet.</div>
      </div>
    `;
  }

  setResourceStatus(message, tone = '') {
    this.dom.resourceStatus.textContent = message;
    this.dom.resourceStatus.className = `status-chip ${tone}`.trim();
  }

  setResourceSelectionSummary(message, tone = '') {
    this.dom.resourceSelectionSummary.textContent = message;
    this.dom.resourceSelectionSummary.className = `status-chip ${tone}`.trim();
  }

  buildResourceDescriptor(root, object) {
    const idSegments = [];
    const pathSegments = [];
    let current = object;

    while (current && current !== root) {
      const parent = current.parent;
      if (!parent) break;
      const childIndex = parent.children.indexOf(current);
      idSegments.push(String(childIndex));
      pathSegments.push(String(current.name || current.type || `Object ${childIndex}`));
      current = parent;
    }

    idSegments.reverse();
    pathSegments.reverse();

    return {
      id: `mesh:${idSegments.join('.') || 'root'}`,
      path: pathSegments.join(' / ') || String(object.name || object.type || 'Mesh'),
    };
  }

  collectResourceMaterialInfo(meshObjects) {
    const materialNames = new Set();
    const textureNames = new Set();

    for (const meshObject of meshObjects || []) {
      const materials = (Array.isArray(meshObject.material) ? meshObject.material : [meshObject.material]).filter(Boolean);
      for (const material of materials) {
        const materialName = basenameFromPath(String(material?.name || '').trim()) || String(material?.name || '').trim();
        if (materialName) {
          materialNames.add(materialName);
        }

        for (const textureName of collectTextureNamesFromMaterial(material)) {
          textureNames.add(textureName);
        }
      }
    }

    return {
      materialNames: [...materialNames].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      textureNames: [...textureNames].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
    };
  }

  findResourceMeshesForPart(root, meshPath, claimedMeshIds) {
    const meshNames = buildMeshNameSet(meshPath);
    const lowerNames = new Set([...meshNames].map((name) => String(name || '').toLowerCase()));
    const matches = [];

    root.traverse((object) => {
      if (!object.isMesh || claimedMeshIds.has(object.uuid)) return;
      if (lowerNames.has(String(object.name || '').toLowerCase())) {
        matches.push(object);
      }
    });

    if (!matches.length) {
      const baseName = basenameFromPath(meshPath).replace(/\.(mesh|mdl)$/i, '').toLowerCase();
      root.traverse((object) => {
        if (!object.isMesh || claimedMeshIds.has(object.uuid)) return;
        const lowerName = String(object.name || '').toLowerCase();
        if (baseName && (lowerName === baseName || lowerName.includes(baseName))) {
          matches.push(object);
        }
      });
    }

    for (const match of matches) {
      claimedMeshIds.add(match.uuid);
    }

    return matches;
  }

  buildResourceManagerItems(exportInfo, root) {
    const items = [];
    const claimedMeshIds = new Set();
    const actorParts = Array.isArray(exportInfo?.sourceActor?.parts) ? exportInfo.sourceActor.parts : [];

    for (const part of actorParts) {
      const meshObjects = this.findResourceMeshesForPart(root, part.mesh, claimedMeshIds);
      if (!meshObjects.length) continue;

      const descriptor = this.buildResourceDescriptor(root, meshObjects[0]);
      const info = this.collectResourceMaterialInfo(meshObjects);
      const itemId = `part:${Number(part.slot) || 0}:${basenameFromPath(part.mesh).replace(/\.(mesh|mdl)$/i, '').toLowerCase()}`;

      items.push({
        id: itemId,
        label: inferResourceNameFromMeshPath(part.mesh, part.slot),
        slot: Number(part.slot) || 0,
        section: String(part.section || ''),
        meshPath: String(part.mesh || ''),
        materialPath: String(part.material || ''),
        path: descriptor.path,
        meshObjects,
        materialNames: info.materialNames,
        textureNames: info.textureNames,
        groupId: '',
        groupName: '',
      });
    }

    root.traverse((object) => {
      if (!object.isMesh || claimedMeshIds.has(object.uuid)) return;

      const descriptor = this.buildResourceDescriptor(root, object);
      const info = this.collectResourceMaterialInfo([object]);
      const itemId = `mesh:${descriptor.id}`;

      items.push({
        id: itemId,
        label: prettifyResourceName(object.name || descriptor.path),
        slot: 9999,
        section: '',
        meshPath: '',
        materialPath: '',
        path: descriptor.path,
        meshObjects: [object],
        materialNames: info.materialNames,
        textureNames: info.textureNames,
        groupId: '',
        groupName: '',
      });
    });

    items.sort((left, right) => {
      const slotDiff = Number(left.slot || 0) - Number(right.slot || 0);
      if (slotDiff !== 0) return slotDiff;
      return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' });
    });

    return items;
  }

  normalizeResourceGroups(groups, items) {
    const validIds = new Set((items || []).map((item) => item.id));
    return (Array.isArray(groups) ? groups : [])
      .map((group, index) => {
        const members = [...new Set((Array.isArray(group?.members) ? group.members : [])
          .map((member) => String(member || ''))
          .filter((member) => validIds.has(member)))];

        return {
          id: String(group?.id || `group-${index + 1}`),
          name: String(group?.name || `Group ${index + 1}`),
          members,
        };
      })
      .filter((group) => group.members.length >= 2);
  }

  rebuildResourceGroupIndex() {
    const state = this.current?.resourceManager;
    if (!state) return;

    state.groupByMember = new Map();
    for (const item of state.items) {
      item.groupId = '';
      item.groupName = '';
    }

    for (const group of state.groups) {
      for (const memberId of group.members) {
        state.groupByMember.set(memberId, group);
        const item = state.itemMap.get(memberId);
        if (!item) continue;
        item.groupId = group.id;
        item.groupName = group.name;
      }
    }

    this.rebuildResourceDisplayItems();
  }

  buildDisplayItemFromBaseItem(item) {
    return {
      displayId: item.id,
      type: 'item',
      label: item.label,
      badge: '',
      memberIds: [item.id],
      materialNames: [...item.materialNames],
      textureNames: [...item.textureNames],
      components: item.meshObjects.map((meshObject, index) => ({
        componentId: `${item.id}:mesh:${index}`,
        label: prettifyResourceName(meshObject.name || `${item.label} ${index + 1}`),
        meshObjects: [meshObject],
      })),
    };
  }

  buildDisplayItemFromGroup(group, memberItems) {
    const labelParts = memberItems.map((item) => item.label);
    const label = labelParts.length <= 3
      ? labelParts.join(' + ')
      : `${labelParts[0]} + ${labelParts.length - 1} more`;

    const materials = new Set();
    const textures = new Set();
    for (const item of memberItems) {
      for (const name of item.materialNames) materials.add(name);
      for (const name of item.textureNames) textures.add(name);
    }

    return {
      displayId: `group:${group.id}`,
      type: 'group',
      label,
      badge: group.name,
      memberIds: memberItems.map((item) => item.id),
      materialNames: [...materials].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      textureNames: [...textures].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
      components: memberItems.map((item) => ({
        componentId: `group-member:${item.id}`,
        label: item.label,
        meshObjects: item.meshObjects,
      })),
    };
  }

  rebuildResourceDisplayItems() {
    const state = this.current?.resourceManager;
    if (!state) return;

    const groupedMemberIds = new Set();
    const displayItems = [];

    for (const group of state.groups) {
      const memberItems = group.members
        .map((memberId) => state.itemMap.get(memberId))
        .filter(Boolean);
      if (memberItems.length < 2) continue;
      for (const memberItem of memberItems) {
        groupedMemberIds.add(memberItem.id);
      }
      displayItems.push(this.buildDisplayItemFromGroup(group, memberItems));
    }

    for (const item of state.items) {
      if (groupedMemberIds.has(item.id)) continue;
      displayItems.push(this.buildDisplayItemFromBaseItem(item));
    }

    displayItems.sort((left, right) => {
      const leftItem = state.itemMap.get(left.memberIds[0]);
      const rightItem = state.itemMap.get(right.memberIds[0]);
      const slotDiff = Number(leftItem?.slot || 0) - Number(rightItem?.slot || 0);
      if (slotDiff !== 0) return slotDiff;
      return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' });
    });

    state.displayItems = displayItems;
    state.displayItemMap = new Map(displayItems.map((item) => [item.displayId, item]));

    const nextExpanded = new Set();
    for (const displayId of state.expandedIds || []) {
      if (state.displayItemMap.has(displayId)) nextExpanded.add(displayId);
    }
    state.expandedIds = nextExpanded;
    state.selectedDisplayIds = (state.selectedDisplayIds || []).filter((displayId) => state.displayItemMap.has(displayId));
  }

  async fetchResourceGroups(actorName) {
    try {
      const response = await fetch(`/api/resource-groups?actor=${encodeURIComponent(actorName)}`);
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload?.groups) ? payload.groups : [];
    } catch {
      return [];
    }
  }

  async persistResourceGroups() {
    const state = this.current?.resourceManager;
    if (!state?.actorName) return;

    const payload = {
      groups: state.groups.map((group) => ({
        id: group.id,
        name: group.name,
        members: [...group.members],
      })),
    };

    const response = await fetch(`/api/resource-groups?actor=${encodeURIComponent(state.actorName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const payloadText = await response.text();
      throw new Error(payloadText || `HTTP ${response.status}`);
    }
  }

  async setupResourceManager(exportInfo, root) {
    const items = this.buildResourceManagerItems(exportInfo, root);
    const groups = this.normalizeResourceGroups(await this.fetchResourceGroups(exportInfo.name), items);

    this.current.resourceManager = {
      actorName: exportInfo.name,
      items,
      itemMap: new Map(items.map((item) => [item.id, item])),
      groups,
      groupByMember: new Map(),
      displayItems: [],
      displayItemMap: new Map(),
      selectedDisplayIds: [],
      expandedIds: new Set(),
    };

    this.rebuildResourceGroupIndex();
    this.updateResourceGizmoButtons(this.resourceGizmoMode);
    this.renderResourceList();
    this.setResourceStatus(`${items.length} part row(s) loaded. Click a row to inspect details, or Target to move it.`, 'good');
    this.setResourceSelectionSummary('No resource selected.');
  }

  async refreshCurrentResourceManager() {
    if (!this.current?.exportInfo || !this.current?.root) return;
    await this.setupResourceManager(this.current.exportInfo, this.current.root);
    this.clearResourceSelectionHelpers();
    this.removeResourceGizmo();
  }

  expandResourceIdsByGroup(resourceIds) {
    const state = this.current?.resourceManager;
    if (!state) return [];

    const expanded = new Set();
    for (const resourceId of resourceIds) {
      const group = state.groupByMember.get(resourceId);
      if (group) {
        for (const memberId of group.members) {
          expanded.add(memberId);
        }
      } else {
        expanded.add(resourceId);
      }
    }

    return [...expanded];
  }

  getSelectedResourceItems() {
    const state = this.current?.resourceManager;
    if (!state) return [];
    return state.selectedIds
      .map((resourceId) => state.itemMap.get(resourceId))
      .filter(Boolean);
  }

  renderResourceList() {
    const state = this.current?.resourceManager;
    if (!state?.items?.length) {
      this.dom.resourceList.innerHTML = `
        <div class="resource-item">
          <div class="resource-meta">No mesh resources found in the loaded actor.</div>
        </div>
      `;
      return;
    }

    const selectedSet = new Set(state.selectedIds);

    this.dom.resourceList.innerHTML = state.items.map((item) => {
  getSelectedResourceDisplayItems() {
      const selected = selectedSet.has(item.id);
      const meta = [
    return state.selectedDisplayIds
      .map((displayId) => state.displayItemMap.get(displayId))
        `${item.textureCount} tex`,
      ].join(' • ');

  getDisplayItemVisibility(displayItem) {
    return displayItem.memberIds.every((memberId) => {
      const item = this.current?.resourceManager?.itemMap.get(memberId);
      return item?.meshObjects?.every((meshObject) => meshObject.visible) ?? false;
    });
  }

  getSelectedResourceItems() {
    const state = this.current?.resourceManager;
    if (!state) return [];

    const selectedIds = new Set(this.getSelectedResourceDisplayItems().flatMap((displayItem) => displayItem.memberIds));
    return [...selectedIds].map((itemId) => state.itemMap.get(itemId)).filter(Boolean);
  }

  getSelectedResourceMeshes() {
    const seen = new Set();
    const meshes = [];

    for (const item of this.getSelectedResourceItems()) {
      for (const meshObject of item.meshObjects || []) {
        if (seen.has(meshObject.uuid)) continue;
        seen.add(meshObject.uuid);
        meshes.push(meshObject);
      }
    }

    return meshes;
  }

      return `
        <div class="resource-item ${selected ? 'selected' : ''} ${visible ? '' : 'hidden-item'}" data-resource-row="${escapeHtml(item.id)}">
    if (!state?.displayItems?.length) {
            <button class="resource-toggle ${visible ? '' : 'hidden'}" data-resource-visibility="${escapeHtml(item.id)}" type="button">${visible ? 'Shown' : 'Hidden'}</button>
            <div class="resource-title">${escapeHtml(item.label)}</div>
            ${item.groupName ? `<div class="resource-badge">${escapeHtml(item.groupName)}</div>` : ''}
          </div>
          <div class="resource-meta">${escapeHtml(meta)}</div>
          <div class="resource-path">${escapeHtml(item.path)}</div>
        </div>
      `;
    const selectedSet = new Set(state.selectedDisplayIds);

    this.dom.resourceList.innerHTML = state.displayItems.map((displayItem) => {
      const visible = this.getDisplayItemVisibility(displayItem);
      const selected = selectedSet.has(displayItem.displayId);
      const expanded = state.expandedIds.has(displayItem.displayId);

      const materialsHtml = displayItem.materialNames.length
        ? displayItem.materialNames.map((name) => `<span class="resource-tag">${escapeHtml(name)}</span>`).join('')
        : '<div class="resource-empty">No material names found.</div>';

      const texturesHtml = displayItem.textureNames.length
        ? displayItem.textureNames.map((name) => `<span class="resource-tag">${escapeHtml(name)}</span>`).join('')
        : '<div class="resource-empty">No texture names found.</div>';

      const componentsHtml = displayItem.components.map((component) => {
        const componentVisible = component.meshObjects.every((meshObject) => meshObject.visible);
        return `
          <div class="resource-component-row">
            <label class="resource-visibility ${componentVisible ? 'visible' : 'hidden'}">
              <input
                data-resource-component-visibility="${escapeHtml(displayItem.displayId)}"
                data-component-id="${escapeHtml(component.componentId)}"
                type="checkbox"
                ${componentVisible ? 'checked' : ''}
              >
              <span>${componentVisible ? 'Shown' : 'Hidden'}</span>
            </label>
            <div class="resource-component-name">${escapeHtml(component.label)}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="resource-item ${selected ? 'selected' : ''} ${visible ? '' : 'hidden-item'}">
          <div class="resource-header">
            <label class="resource-visibility ${visible ? 'visible' : 'hidden'}">
              <input data-resource-visibility="${escapeHtml(displayItem.displayId)}" type="checkbox" ${visible ? 'checked' : ''}>
              <span>${visible ? 'Shown' : 'Hidden'}</span>
            </label>
            <button class="resource-expand" data-resource-expand="${escapeHtml(displayItem.displayId)}" type="button">
              <div class="resource-title">${escapeHtml(displayItem.label)}</div>
              ${displayItem.badge ? `<div class="resource-badge">${escapeHtml(displayItem.badge)}</div>` : ''}
            </button>
            <button class="resource-target ${selected ? 'active' : ''}" data-resource-target="${escapeHtml(displayItem.displayId)}" type="button">${selected ? 'Targeted' : 'Target'}</button>
            <button class="resource-expand" data-resource-expand="${escapeHtml(displayItem.displayId)}" type="button">
              <div class="resource-caret">${expanded ? '&#9662;' : '&#9656;'}</div>
            </button>
          </div>
          ${expanded ? `
            <div class="resource-details">
              <div class="resource-section">
                <div class="resource-section-title">Materials</div>
                <div class="resource-tags">${materialsHtml}</div>
              </div>
              <div class="resource-section">
                <div class="resource-section-title">Textures</div>
                <div class="resource-tags">${texturesHtml}</div>
              </div>
              <div class="resource-section">
                <div class="resource-section-title">Components</div>
                <div class="resource-components">${componentsHtml}</div>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    if (!expandedIds.length) return;

    if (!append) {
    const targetButton = event.target.closest('[data-resource-target]');
    if (targetButton) {
      const displayId = targetButton.getAttribute('data-resource-target');
      const append = event.ctrlKey || event.metaKey;
      this.selectResourceDisplayIds([displayId], { append });
      const allSelected = expandedIds.every((resourceId) => next.has(resourceId));
      for (const resourceId of expandedIds) {
        if (allSelected) next.delete(resourceId);
    const expandButton = event.target.closest('[data-resource-expand]');
    if (!expandButton) return;

    const displayId = expandButton.getAttribute('data-resource-expand');
    this.toggleResourceExpansion(displayId);
  }
      state.selectedIds = [...next];
  handleResourceListChange(event) {
    const visibilityInput = event.target.closest('[data-resource-visibility]');
    if (visibilityInput) {
      const displayId = visibilityInput.getAttribute('data-resource-visibility');
      this.setDisplayItemVisibility(displayId, visibilityInput.checked);
      return;
    }

    const componentInput = event.target.closest('[data-resource-component-visibility]');
    if (!componentInput) return;

    const displayId = componentInput.getAttribute('data-resource-component-visibility');
    const componentId = componentInput.getAttribute('data-component-id');
    this.setDisplayComponentVisibility(displayId, componentId, componentInput.checked);
      this.resourceGizmoMode = 'translate';
      this.updateResourceGizmoButtons(this.resourceGizmoMode);
  toggleResourceExpansion(displayId) {

    this.updateResourceSelectionUi();

    if (state.expandedIds.has(displayId)) state.expandedIds.delete(displayId);
    else state.expandedIds.add(displayId);
    this.renderResourceList();
  }
  }
  selectResourceDisplayIds(displayIds, { append = false } = {}) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const validIds = displayIds.filter((displayId) => state.displayItemMap.has(displayId));
    if (!validIds.length) return;
    const selectedItems = this.getSelectedResourceItems();
    this.renderResourceList();
      state.selectedDisplayIds = validIds;

      const next = new Set(state.selectedDisplayIds);
      const allSelected = validIds.every((displayId) => next.has(displayId));
      for (const displayId of validIds) {
        if (allSelected) next.delete(displayId);
        else next.add(displayId);

      state.selectedDisplayIds = [...next];
    const hiddenCount = selectedItems.filter((item) => !item.object.visible).length;
    let summary = `${selectedItems.length} selected`;
    if (state.selectedDisplayIds.length && this.resourceGizmoMode === 'off') {
    if (hiddenCount > 0) summary += ` • ${hiddenCount} hidden`;
    this.setResourceSelectionSummary(summary, 'good');
    this.syncResourceGizmoToSelection();
  }

  toggleResourceVisibility(resourceId) {
    const state = this.current?.resourceManager;
    const item = state?.itemMap.get(String(resourceId || ''));
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();

    item.object.visible = !item.object.visible;
    this.renderResourceList();
    if (!selectedDisplayItems.length) {
    this.setResourceStatus(`${item.label} ${item.object.visible ? 'shown' : 'hidden'}.`, item.object.visible ? 'good' : 'warn');
  }

  setSelectedResourceVisibility(visible) {
    const selectedItems = this.getSelectedResourceItems();
    const labels = selectedDisplayItems.map((item) => item.label);
    let summary = labels.length === 1 ? labels[0] : `${labels.length} targeted`;

    for (const item of selectedItems) {
      item.object.visible = Boolean(visible);
    }

  setDisplayItemVisibility(displayId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    for (const memberId of displayItem.memberIds) {
      const item = state.itemMap.get(memberId);
      if (!item) continue;
      for (const meshObject of item.meshObjects || []) {
        meshObject.visible = Boolean(visible);
      }
    }

    this.renderResourceList();
    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`${displayItem.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
  }

  setDisplayComponentVisibility(displayId, componentId, visible) {
    const state = this.current?.resourceManager;
    const displayItem = state?.displayItemMap.get(String(displayId || ''));
    if (!displayItem) return;

    const component = (displayItem.components || []).find((entry) => entry.componentId === componentId);
    if (!component) return;

    for (const meshObject of component.meshObjects || []) {
      meshObject.visible = Boolean(visible);
    }

    this.renderResourceList();
    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`${component.label} ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
  }

  createResourceSelectionHelper(meshObject) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd54a,
      wireframe: true,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });

    let helper;
    if (meshObject.isSkinnedMesh) {
      helper = new THREE.SkinnedMesh(meshObject.geometry, material);
      helper.bind(meshObject.skeleton, meshObject.bindMatrix);
      helper.bindMatrixInverse.copy(meshObject.bindMatrixInverse);
    } else {
      helper = new THREE.Mesh(meshObject.geometry, material);
    }

    helper.name = '__resource_selection_helper__';
    helper.frustumCulled = false;
    helper.renderOrder = 999;
    helper.raycast = () => {};
    helper.position.set(0, 0, 0);
    helper.quaternion.identity();
    helper.scale.set(1, 1, 1);
    meshObject.add(helper);
    return helper;
  }

  clearResourceSelectionHelpers() {
    for (const helper of this.resourceSelectionHelpers) {
      if (helper.parent) {
        helper.parent.remove(helper);
      }
      helper.material?.dispose?.();
    }
    this.resourceSelectionHelpers = [];
  }

  refreshResourceSelectionHelpers() {
    this.clearResourceSelectionHelpers();

    for (const meshObject of this.getSelectedResourceMeshes()) {
      this.resourceSelectionHelpers.push(this.createResourceSelectionHelper(meshObject));
    }
  }

  updateResourceGizmoButtons(mode) {
    this.dom.resourceGizmoTranslate.className = `${mode === 'translate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoRotate.className = `${mode === 'rotate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoOff.className = `${mode === 'off' ? 'primary' : 'secondary'} button-grow`;
  }

  setResourceGizmoMode(mode) {
    this.resourceGizmoMode = mode === 'rotate' || mode === 'translate' ? mode : 'off';
    this.updateResourceGizmoButtons(this.resourceGizmoMode);

    if (this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.syncResourceGizmoToSelection();
  }

  ensureResourceGizmo() {
    if (!this.resourceTransformControls) {
      this.resourceTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.resourceTransformControls.setSpace('world');
      this.resourceTransformControls.setMode(this.resourceGizmoMode);
      this.scene.add(this.resourceTransformControls.getHelper());

      this.resourceTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (event.value) {
          this.snapshotResourceSelectionTransforms();
        }
      });

      this.resourceTransformControls.addEventListener('objectChange', () => {
        if (this.resourceSelectionSyncing) return;
        this.applyResourceSelectionDelta();
      });
    }

    if (!this.resourceSelectionPivot) {
      this.resourceSelectionPivot = new THREE.Object3D();
      this.resourceSelectionPivot.name = '__resource_manager_pivot__';
      this.scene.add(this.resourceSelectionPivot);
    }
  }

  removeResourceGizmo() {
    this.controls.enabled = true;

    if (this.resourceTransformControls) {
      this.resourceTransformControls.detach();
      this.scene.remove(this.resourceTransformControls.getHelper());
      this.resourceTransformControls.dispose();
      this.resourceTransformControls = null;
    }

    if (this.resourceSelectionPivot?.parent) {
      this.resourceSelectionPivot.parent.remove(this.resourceSelectionPivot);
    }

    this.resourceSelectionPivot = null;
    this.resourceSelectionBaseStates = [];
  }

  snapshotResourceSelectionTransforms() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || !this.resourceSelectionPivot) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourcePivotStartMatrix.copy(this.resourceSelectionPivot.matrix);
    this.resourcePivotStartInverse.copy(this.resourcePivotStartMatrix).invert();

    this.resourceSelectionBaseStates = selectedMeshes.map((meshObject) => ({
      meshObject,
      worldMatrix: meshObject.matrixWorld.clone(),
      parentInverse: meshObject.parent
        ? meshObject.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4(),
    }));
  }

  applyResourceSelectionDelta() {
    if (!this.resourceSelectionPivot || !this.resourceSelectionBaseStates.length) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceSelectionDeltaMatrix.multiplyMatrices(this.resourceSelectionPivot.matrix, this.resourcePivotStartInverse);

    for (const state of this.resourceSelectionBaseStates) {
      this.resourceSelectionWorldMatrix.multiplyMatrices(this.resourceSelectionDeltaMatrix, state.worldMatrix);
      this.resourceSelectionLocalMatrix.multiplyMatrices(state.parentInverse, this.resourceSelectionWorldMatrix);
      this.resourceSelectionLocalMatrix.decompose(
        state.meshObject.position,
        state.meshObject.quaternion,
        state.meshObject.scale,
      );
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    this.setResourceStatus(`Moving ${this.resourceSelectionBaseStates.length} mesh piece(s).`, 'good');
  }

  syncResourceGizmoToSelection() {
    const selectedMeshes = this.getSelectedResourceMeshes();
    if (!selectedMeshes.length || this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.ensureResourceGizmo();

    const box = new THREE.Box3();
    const itemBox = new THREE.Box3();
    const center = new THREE.Vector3();
    let hasBox = false;

    for (const meshObject of selectedMeshes) {
      itemBox.setFromObject(meshObject);
      if (itemBox.isEmpty()) continue;
      if (!hasBox) box.copy(itemBox);
      else box.union(itemBox);
      hasBox = true;
    }

    if (!hasBox) {
      selectedMeshes[0].getWorldPosition(center);
    } else {
      box.getCenter(center);
    }

    this.resourceSelectionSyncing = true;
    this.resourceSelectionPivot.position.copy(center);
    this.resourceSelectionPivot.quaternion.identity();
    this.resourceSelectionPivot.scale.set(1, 1, 1);
    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceTransformControls.attach(this.resourceSelectionPivot);
    this.resourceTransformControls.setSpace('world');
    this.resourceTransformControls.setMode(this.resourceGizmoMode);
    this.resourceSelectionSyncing = false;

    this.snapshotResourceSelectionTransforms();
  }

  async toggleSelectedResourceGrouping() {
    const state = this.current?.resourceManager;
    const selectedDisplayItems = this.getSelectedResourceDisplayItems();
    if (!state || !selectedDisplayItems.length) {
      this.setResourceStatus('Target one or more rows first.', 'warn');
      return;
    }

    if (selectedDisplayItems.length === 1 && selectedDisplayItems[0].type === 'group') {
      await this.ungroupResourceByGroupId(String(selectedDisplayItems[0].displayId || '').replace(/^group:/, ''));
      return;
    }

    const memberIds = [...new Set(selectedDisplayItems.flatMap((displayItem) => displayItem.memberIds))];
    if (memberIds.length < 2) {
      this.setResourceStatus('Target at least two rows to create a group.', 'warn');
      return;
    }

    await this.groupSelectedResources(memberIds);
  }

  async groupSelectedResources(memberIds) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const selectedSet = new Set(memberIds);
    const nextGroups = [];
    for (const group of state.groups) {
      const members = group.members.filter((member) => !selectedSet.has(member));
      if (members.length >= 2) {
        nextGroups.push({ ...group, members });
      }
    }

    const nextNumber = nextGroups.reduce((maxValue, group) => {
      const match = /^Group\s+(\d+)$/i.exec(group.name || '');
      return Math.max(maxValue, match ? Number(match[1]) : 0);
    }, 0) + 1;

    const groupId = `group-${Date.now()}`;
    nextGroups.push({
      id: groupId,
      name: `Group ${nextNumber}`,
      members: [...selectedSet],
    });

    state.groups = nextGroups;
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Saved Group ${nextNumber}.`, 'good');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = [`group:${groupId}`];
    this.updateResourceSelectionUi();
  }

  async ungroupResourceByGroupId(groupId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    state.groups = state.groups.filter((entry) => entry.id !== groupId);
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Ungrouped ${group.name}.`, 'warn');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedDisplayIds = group.members.filter((memberId) => state.displayItemMap.has(memberId));
    this.updateResourceSelectionUi();
  }
    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`${selectedItems.length} selected piece(s) ${visible ? 'shown' : 'hidden'}.`, visible ? 'good' : 'warn');
    this.updateResourceSelectionUi();
  }

  clearResourceSelectionHelpers() {
    for (const helper of this.resourceSelectionHelpers) {
      this.scene.remove(helper);
      helper.geometry?.dispose?.();
      helper.material?.dispose?.();
    }
    this.resourceSelectionHelpers = [];
  }

  refreshResourceSelectionHelpers() {
    this.clearResourceSelectionHelpers();

    for (const item of this.getSelectedResourceItems()) {
      const helper = new THREE.BoxHelper(item.object, 0xffd54a);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.material.opacity = 0.96;
      helper.renderOrder = 999;
      this.scene.add(helper);
      this.resourceSelectionHelpers.push(helper);
    }
  }

  updateResourceGizmoButtons(mode) {
    this.dom.resourceGizmoTranslate.className = `${mode === 'translate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoRotate.className = `${mode === 'rotate' ? 'primary' : 'secondary'} button-grow`;
    this.dom.resourceGizmoOff.className = `${mode === 'off' ? 'primary' : 'secondary'} button-grow`;
  }

  setResourceGizmoMode(mode) {
    this.resourceGizmoMode = mode === 'rotate' || mode === 'translate' ? mode : 'off';
    this.updateResourceGizmoButtons(this.resourceGizmoMode);

    if (this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.syncResourceGizmoToSelection();
  }

  ensureResourceGizmo() {
    if (!this.resourceTransformControls) {
      this.resourceTransformControls = new TransformControls(this.camera, this.dom.canvas);
      this.resourceTransformControls.setSpace('world');
      this.resourceTransformControls.setMode(this.resourceGizmoMode);
      this.scene.add(this.resourceTransformControls.getHelper());

      this.resourceTransformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (event.value) {
          this.snapshotResourceSelectionTransforms();
        }
      });

      this.resourceTransformControls.addEventListener('objectChange', () => {
        if (this.resourceSelectionSyncing) return;
        this.applyResourceSelectionDelta();
      });
    }

    if (!this.resourceSelectionPivot) {
      this.resourceSelectionPivot = new THREE.Object3D();
      this.resourceSelectionPivot.name = '__resource_manager_pivot__';
      this.scene.add(this.resourceSelectionPivot);
    }
  }

  removeResourceGizmo() {
    this.controls.enabled = true;

    if (this.resourceTransformControls) {
      this.resourceTransformControls.detach();
      this.scene.remove(this.resourceTransformControls.getHelper());
      this.resourceTransformControls.dispose();
      this.resourceTransformControls = null;
    }

    if (this.resourceSelectionPivot?.parent) {
      this.resourceSelectionPivot.parent.remove(this.resourceSelectionPivot);
    }

    this.resourceSelectionPivot = null;
    this.resourceSelectionBaseStates = [];
  }

  snapshotResourceSelectionTransforms() {
    const selectedItems = this.getSelectedResourceItems();
    if (!selectedItems.length || !this.resourceSelectionPivot) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourcePivotStartMatrix.copy(this.resourceSelectionPivot.matrix);
    this.resourcePivotStartInverse.copy(this.resourcePivotStartMatrix).invert();

    this.resourceSelectionBaseStates = selectedItems.map((item) => ({
      item,
      worldMatrix: item.object.matrixWorld.clone(),
      parentInverse: item.object.parent
        ? item.object.parent.matrixWorld.clone().invert()
        : new THREE.Matrix4(),
    }));
  }

  applyResourceSelectionDelta() {
    if (!this.resourceSelectionPivot || !this.resourceSelectionBaseStates.length) return;

    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceSelectionDeltaMatrix.multiplyMatrices(this.resourceSelectionPivot.matrix, this.resourcePivotStartInverse);

    for (const state of this.resourceSelectionBaseStates) {
      this.resourceSelectionWorldMatrix.multiplyMatrices(this.resourceSelectionDeltaMatrix, state.worldMatrix);
      this.resourceSelectionLocalMatrix.multiplyMatrices(state.parentInverse, this.resourceSelectionWorldMatrix);
      this.resourceSelectionLocalMatrix.decompose(
        state.item.object.position,
        state.item.object.quaternion,
        state.item.object.scale,
      );
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    this.refreshResourceSelectionHelpers();
    this.setResourceStatus(`Moving ${this.resourceSelectionBaseStates.length} selected piece(s).`, 'good');
  }

  syncResourceGizmoToSelection() {
    const selectedItems = this.getSelectedResourceItems();
    if (!selectedItems.length || this.resourceGizmoMode === 'off') {
      this.removeResourceGizmo();
      return;
    }

    this.ensureResourceGizmo();

    const box = new THREE.Box3();
    const itemBox = new THREE.Box3();
    const center = new THREE.Vector3();
    let hasBox = false;

    for (const item of selectedItems) {
      itemBox.setFromObject(item.object);
      if (itemBox.isEmpty()) continue;
      if (!hasBox) box.copy(itemBox);
      else box.union(itemBox);
      hasBox = true;
    }

    if (!hasBox) {
      selectedItems[0].object.getWorldPosition(center);
    } else {
      box.getCenter(center);
    }

    this.resourceSelectionSyncing = true;
    this.resourceSelectionPivot.position.copy(center);
    this.resourceSelectionPivot.quaternion.identity();
    this.resourceSelectionPivot.scale.set(1, 1, 1);
    this.resourceSelectionPivot.updateMatrix();
    this.resourceSelectionPivot.updateMatrixWorld(true);
    this.resourceTransformControls.attach(this.resourceSelectionPivot);
    this.resourceTransformControls.setSpace('world');
    this.resourceTransformControls.setMode(this.resourceGizmoMode);
    this.resourceSelectionSyncing = false;

    this.snapshotResourceSelectionTransforms();
  }

  async toggleSelectedResourceGrouping() {
    const state = this.current?.resourceManager;
    if (!state?.selectedIds?.length) {
      this.setResourceStatus('Select resource pieces first.', 'warn');
      return;
    }

    const selectedGroupIds = [...new Set(state.selectedIds
      .map((resourceId) => state.groupByMember.get(resourceId)?.id)
      .filter(Boolean))];

    const allSelectedBelongToSameGroup = selectedGroupIds.length === 1
      && state.selectedIds.every((resourceId) => state.groupByMember.get(resourceId)?.id === selectedGroupIds[0]);

    if (allSelectedBelongToSameGroup) {
      await this.ungroupResourceByGroupId(selectedGroupIds[0]);
      return;
    }

    if (state.selectedIds.length < 2) {
      this.setResourceStatus('Select at least two pieces to create a group.', 'warn');
      return;
    }

    await this.groupSelectedResources();
  }

  async groupSelectedResources() {
    const state = this.current?.resourceManager;
    if (!state) return;

    const selectedSet = new Set(state.selectedIds);
    const nextGroups = [];
    for (const group of state.groups) {
      const members = group.members.filter((member) => !selectedSet.has(member));
      if (members.length >= 2) {
        nextGroups.push({ ...group, members });
      }
    }

    const nextNumber = nextGroups.reduce((maxValue, group) => {
      const match = /^Group\s+(\d+)$/i.exec(group.name || '');
      return Math.max(maxValue, match ? Number(match[1]) : 0);
    }, 0) + 1;

    nextGroups.push({
      id: `group-${Date.now()}`,
      name: `Group ${nextNumber}`,
      members: [...selectedSet],
    });

    state.groups = nextGroups;
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Saved ${nextGroups[nextGroups.length - 1].name}.`, 'good');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedIds = this.expandResourceIdsByGroup([...selectedSet]);
    this.updateResourceSelectionUi();
  }

  async ungroupResourceByGroupId(groupId) {
    const state = this.current?.resourceManager;
    if (!state) return;

    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    state.groups = state.groups.filter((entry) => entry.id !== groupId);
    this.rebuildResourceGroupIndex();

    try {
      await this.persistResourceGroups();
      this.setResourceStatus(`Ungrouped ${group.name}.`, 'warn');
    } catch (err) {
      this.setResourceStatus(`Could not save group file: ${err?.message || err}`, 'warn');
    }

    state.selectedIds = [...group.members].filter((member) => state.itemMap.has(member));
    this.updateResourceSelectionUi();
  }

*/
  buildPartItems(exportInfo) {
    const actorParts = exportInfo?.sourceActor?.parts;
    if (Array.isArray(actorParts) && actorParts.length) {
      return actorParts.map((part) => ({
        slot: `Part ${part.slot}`,
        label: basenameFromPath(part.mesh) || part.section,
        path: part.mesh || part.material || '-',
      }));
    }

    return (exportInfo?.exportListEntries || []).map((item, index) => ({
      slot: `Mesh ${index + 1}`,
      label: basenameFromPath(item) || `Export ${index + 1}`,
      path: item,
    }));
  }

  setFacts(exportInfo, stats) {
    const rows = exportInfo ? [
      ['Export', exportInfo.name],
      ['FBX', exportInfo.fbxFileName || 'missing'],
      ['Body type', formatBodyType(exportInfo?.sourceActor?.bodyType)],
      ['FaceDefIni', exportInfo?.sourceActor?.faceDefinition || 'blank'],
      ['MetaFaceDef', exportInfo?.sourceActor?.metaFaceDefinition || 'blank'],
      ['Face mode', this.current?.partVisibility?.mode === 'animated-head'
        ? 'body-skinned head; detached legacy face hidden'
        : (this.current?.partVisibility?.mode === 'detached-face-overlay'
          ? 'detached legacy face export'
          : 'exported face overlay')],
      ['Actor parts', formatCount(exportInfo?.sourceActor?.partCount)],
      ['Exported meshes', formatCount(exportInfo?.exportListEntries?.length)],
      ['Textures', formatCount(exportInfo?.textureCount)],
      ['Export sounds', formatCount(exportInfo?.soundCount)],
      ['Bones', formatCount(stats?.bones)],
      ['Skinned meshes', formatCount(stats?.skinnedMeshes)],
      ['All meshes', formatCount(stats?.meshes)],
      ['Materials', formatCount(stats?.materials)],
      ['Textured mats', formatCount(stats?.texturedMaterials)],
      ['FBX clips', formatCount(stats?.animationCount)],
      ['Actions folder', exportInfo?.playerSupport?.actionsDir || 'not found'],
      ['Player .ani files', formatCount(exportInfo?.playerSupport?.actionFileCount)],
      ['Actor file', exportInfo?.sourceActorFilePath || 'not found'],
    ] : [
      ['Export', 'No actor loaded yet'],
      ['Body type', '-'],
      ['Bones', '-'],
      ['FBX clips', '-'],
    ];

    this.dom.facts.innerHTML = rows.map(([key, value]) => `
      <div class="key">${escapeHtml(key)}</div>
      <div class="val">${escapeHtml(value)}</div>
    `).join('');
  }

  setPartList(items) {
    if (!items.length) {
      this.dom.partList.innerHTML = '<div class="part-item"><span class="label">No actor parts loaded yet.</span></div>';
      return;
    }

    this.dom.partList.innerHTML = items.map((item) => `
      <div class="part-item">
        <div><span class="slot">${escapeHtml(item.slot)}</span><span class="label">${escapeHtml(item.label)}</span></div>
        <div class="path">${escapeHtml(item.path)}</div>
      </div>
    `).join('');
  }

  clearCurrentActor() {
    if (!this.current) return;

    this.removeAttachmentGizmo();
    this.removeResourceGizmo();
    this.clearResourceSelectionHelpers();

    if (this.current.activeAction) {
      this.current.activeAction.stop();
    }

    if (this.current.mixer && this.current.root) {
      this.current.mixer.stopAllAction();
      this.current.mixer.uncacheRoot(this.current.root);
    }

    if (this.current.skeletonHelper) {
      this.scene.remove(this.current.skeletonHelper);
    }

    if (this.current.presentation?.placementRoot) {
      this.stage.remove(this.current.presentation.placementRoot);
    } else if (this.current.root) {
      this.stage.remove(this.current.root);
    }

    this.current = null;
    this.currentStats = null;
    this.currentAnimationIndex = -1;
    this.resetAttachmentTestPanel();
    this.resetResourceManagerPanel();
  }

  setStatus(message, tone = '') {
    this.dom.status.textContent = message;
    this.dom.status.className = `status-chip ${tone}`.trim();
  }

  showLoading(message, progress = null) {
    this.dom.loading.style.display = 'flex';
    this.dom.loadingText.textContent = message;
    const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    this.dom.loadingFill.style.width = `${Math.round(safeProgress * 100)}%`;
  }

  hideLoading() {
    this.dom.loading.style.display = 'none';
    this.dom.loadingFill.style.width = '0%';
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();
    if (this.current?.mixer && this.isPlaying) {
      this.current.mixer.update(delta * this.playbackRate);
      this.updateHeadAttachments();
    }

    if (this.current?.root) {
      this.current.root.updateMatrixWorld(true);
    }

    for (const helper of this.resourceSelectionHelpers) {
      helper.update();
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const app = new ActorViewerApp();
app.init();