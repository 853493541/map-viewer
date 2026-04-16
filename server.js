/**
 * Static + export API server for the map viewer.
 *
 * Adds:
 * 1) POST /api/export-full -> build self-contained full export on Desktop (sidecar collision only)
 * 2) POST /api/export-full-with-collision -> alias of sidecar-only full export
 * 3) POST /api/export-regional-with-collision -> region-required sidecar-only export
 * 4) GET  /api/full-exports -> list exported packages
 * 5) GET  /full-exports/* -> serve exported package files
 */

import { createServer } from 'http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from 'fs';
import { spawn } from 'child_process';
import { join, extname, dirname, resolve, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { generateCollisionDataForExport } from './tools/collision-generator.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(join(__dirname, 'public'));
const PORT = Number(process.env.PORT) || 3015;
const DESKTOP_EXPORT_ROOT = resolve(join(os.homedir(), 'Desktop', 'JX3FullExports'));
const MOVIE_EDITOR_ROOT = resolve('C:/SeasunGame/MovieEditor');
const MOVIE_EDITOR_SOURCE_ROOT = join(MOVIE_EDITOR_ROOT, 'source');
const MOVIE_EDITOR_EXPORT_ROOT = join(MOVIE_EDITOR_SOURCE_ROOT, 'fbx');
const REPO_CLIPS_ROOT = resolve(join(PUBLIC_DIR, 'repo-clips'));
const RESOURCE_GROUPS_FILE = resolve(join(__dirname, 'tools', 'actor-resource-groups.json'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.dds': 'application/octet-stream',
  '.ani': 'application/octet-stream',
  '.actor': 'text/plain; charset=utf-8',
  '.actmtl': 'application/octet-stream',
  '.ico': 'image/x-icon',
  '.lua': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function safePathUnder(root, relPath) {
  const decoded = decodeURIComponent(relPath || '');
  const abs = resolve(join(root, decoded));
  if (!abs.startsWith(root)) return null;
  return abs;
}

function encodeUrlPathSegments(pathLike) {
  return String(pathLike || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function readTextUtf8(filePath, fallback = '') {
  if (!existsSync(filePath)) return fallback;
  return readFileSync(filePath, 'utf8');
}

function listDirectoryFileNames(dirPath) {
  if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function listFilesRecursive(dirPath, allowedExtensions = null, prefix = '') {
  if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];

  const out = [];
  const normalizedAllowed = allowedExtensions instanceof Set
    ? new Set([...allowedExtensions].map((ext) => String(ext).toLowerCase()))
    : null;

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(absPath, normalizedAllowed, relPath));
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (normalizedAllowed && !normalizedAllowed.has(ext)) continue;
    out.push(relPath.replace(/\\/g, '/'));
  }

  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function parseIniSections(text) {
  const sections = new Map();
  let currentSection = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, {});
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    const targetSection = currentSection || 'ROOT';
    if (!sections.has(targetSection)) sections.set(targetSection, {});
    sections.get(targetSection)[key] = value;
  }

  return sections;
}

function inferPlayerBodyType(dependModel) {
  const match = /source[\\/]+player[\\/]+(f1|f2|m1|m2)[\\/]/i.exec(String(dependModel || ''));
  return match ? match[1].toUpperCase() : null;
}

function parseActorFileSummary(actorText) {
  const sections = parseIniSections(actorText);
  const root = sections.get('ROOT') || {};
  const parts = [];

  for (const [sectionName, values] of sections.entries()) {
    if (!/^Part\d+$/i.test(sectionName)) continue;
    if (String(values.Have || '0') !== '1') continue;

    parts.push({
      slot: Number(sectionName.replace(/\D+/g, '')) || 0,
      section: sectionName,
      mesh: values.Mesh || '',
      material: values.Mtl || '',
      detail: values.Detail || '',
    });
  }

  parts.sort((a, b) => a.slot - b.slot);

  return {
    dependModel: root.DependModel || '',
    faceDefinition: root.FaceDefIni || '',
    metaFaceDefinition: root.MetaFaceDefJson || '',
    reDress: String(root.bReDress || '0') === '1',
    declaredPartSlots: Number(root.PartNum) || parts.length,
    declaredBindSlots: Number(root.BindNum) || 0,
    bodyType: inferPlayerBodyType(root.DependModel),
    partCount: parts.length,
    parts,
  };
}

function findMovieEditorActorFile(exportName) {
  const candidates = [
    join(MOVIE_EDITOR_SOURCE_ROOT, `${exportName}.actor`),
    join(MOVIE_EDITOR_SOURCE_ROOT, 'Actor', `${exportName}.actor`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }

  return null;
}

function buildMovieEditorPlayerSupport(bodyType) {
  const normalized = String(bodyType || '').trim().toUpperCase();
  if (!/^[FM][12]$/.test(normalized)) return null;

  const lower = normalized.toLowerCase();
  const playerDir = join(MOVIE_EDITOR_SOURCE_ROOT, 'player', normalized);
  const actionsDir = join(playerDir, '动作');

  return {
    bodyType: normalized,
    playerDir,
    exportSkeletonPath: existsSync(join(playerDir, `${lower}.fbx`))
      ? join(playerDir, `${lower}.fbx`)
      : null,
    standardSkeletonPath: existsSync(join(playerDir, `${normalized}-标准骨骼.FBX`))
      ? join(playerDir, `${normalized}-标准骨骼.FBX`)
      : null,
    importTestPath: existsSync(join(playerDir, `${normalized}动作导入测试.FBX`))
      ? join(playerDir, `${normalized}动作导入测试.FBX`)
      : null,
    actionsDir: existsSync(actionsDir) ? actionsDir : null,
    actionFileCount: listDirectoryFileNames(actionsDir)
      .filter((name) => name.toLowerCase().endsWith('.ani'))
      .length,
  };
}

function buildMovieEditorAssetUrl(absPath) {
  return `/movie-editor-assets/${encodeUrlPathSegments(relative(MOVIE_EDITOR_ROOT, absPath))}`;
}

function listMovieEditorActorExports() {
  if (!existsSync(MOVIE_EDITOR_EXPORT_ROOT) || !statSync(MOVIE_EDITOR_EXPORT_ROOT).isDirectory()) {
    return [];
  }

  const exportDirs = readdirSync(MOVIE_EDITOR_EXPORT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return exportDirs.map((folderName) => {
    const exportDir = join(MOVIE_EDITOR_EXPORT_ROOT, folderName);
    const files = listDirectoryFileNames(exportDir);
    const fbxFileName = files.find((name) => name.toLowerCase().endsWith('.fbx')) || null;
    const exportListPath = join(exportDir, 'export_list.txt');
    const exportListEntries = readTextUtf8(exportListPath, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const textureDir = join(exportDir, 'tex');
    const textureFiles = listDirectoryFileNames(textureDir);
    const soundFiles = listFilesRecursive(exportDir, new Set(['.wav', '.mp3', '.ogg', '.wem', '.bnk', '.fsb', '.cue']));
    const actorFilePath = findMovieEditorActorFile(folderName);
    const actMtlPath = join(MOVIE_EDITOR_SOURCE_ROOT, `${folderName}.ActMtl`);
    const sourceActor = actorFilePath
      ? parseActorFileSummary(readTextUtf8(actorFilePath, ''))
      : null;

    return {
      name: folderName,
      exportDir,
      fbxFileName,
      fbxUrl: fbxFileName ? buildMovieEditorAssetUrl(join(exportDir, fbxFileName)) : null,
      exportListPath: existsSync(exportListPath) ? exportListPath : null,
      exportListUrl: existsSync(exportListPath) ? buildMovieEditorAssetUrl(exportListPath) : null,
      exportListEntries,
      textureDir: existsSync(textureDir) ? textureDir : null,
      textureBaseUrl: existsSync(textureDir) ? buildMovieEditorAssetUrl(textureDir) : null,
      textureCount: textureFiles.length,
      textureFiles,
      soundCount: soundFiles.length,
      soundFiles,
      sourceActorFilePath: actorFilePath,
      sourceActor,
      hasActMtl: existsSync(actMtlPath),
      actMtlPath: existsSync(actMtlPath) ? actMtlPath : null,
      playerSupport: sourceActor ? buildMovieEditorPlayerSupport(sourceActor.bodyType) : null,
    };
  });
}

function listRepoClipSources() {
  if (!existsSync(REPO_CLIPS_ROOT) || !statSync(REPO_CLIPS_ROOT).isDirectory()) {
    return [];
  }

  return listFilesRecursive(REPO_CLIPS_ROOT, new Set(['.fbx']))
    .map((relativePath) => {
      const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
      return {
        name: normalizedPath.replace(/\.fbx$/i, ''),
        relativePath: normalizedPath,
        fbxFileName: basename(normalizedPath),
        fbxUrl: `/repo-clips/${encodeUrlPathSegments(normalizedPath)}`,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function readJsonUtf8(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function readResourceGroupStore() {
  const store = readJsonUtf8(RESOURCE_GROUPS_FILE, { actors: {} });
  if (!store || typeof store !== 'object') return { actors: {} };
  if (!store.actors || typeof store.actors !== 'object') return { actors: {} };
  return store;
}

function sanitizeResourceGroupsPayload(payload) {
  return (Array.isArray(payload?.groups) ? payload.groups : [])
    .map((group, index) => {
      const members = [...new Set((Array.isArray(group?.members) ? group.members : [])
        .map((member) => String(member || '').trim())
        .filter(Boolean))];

      return {
        id: String(group?.id || `group-${index + 1}`),
        name: String(group?.name || `Group ${index + 1}`),
        members,
      };
    })
    .filter((group) => group.members.length >= 2);
}

function readActorResourceGroups(actorName) {
  const actor = String(actorName || '').trim();
  if (!actor) return [];
  const store = readResourceGroupStore();
  return Array.isArray(store.actors?.[actor]) ? store.actors[actor] : [];
}

function writeActorResourceGroups(actorName, payload) {
  const actor = String(actorName || '').trim();
  if (!actor) {
    throw new Error('Actor name is required');
  }

  const store = readResourceGroupStore();
  if (!store.actors || typeof store.actors !== 'object') {
    store.actors = {};
  }

  store.actors[actor] = sanitizeResourceGroupsPayload(payload);
  writeJson(RESOURCE_GROUPS_FILE, store);

  return {
    actor,
    groups: store.actors[actor],
    filePath: RESOURCE_GROUPS_FILE,
  };
}

function sanitizeName(name, fallback = 'full-map') {
  const raw = String(name || '').trim() || fallback;
  const cleaned = raw.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/-+/g, '-');
  return cleaned || fallback;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function getOverlappingTiles(region, cfg) {
  const regionWorldSize = cfg.regionSize * cfg.unitScaleX;
  const gridX = cfg.regionGridX;
  const gridY = cfg.regionGridY;

  if (!region) {
    const all = [];
    for (let rx = 0; rx < gridX; rx++) {
      for (let ry = 0; ry < gridY; ry++) all.push({ rx, ry });
    }
    return all;
  }

  const localMinX = region.minX - cfg.worldOriginX;
  const localMaxX = region.maxX - cfg.worldOriginX;
  const localMinY = (-region.maxZ) - cfg.worldOriginY;
  const localMaxY = (-region.minZ) - cfg.worldOriginY;

  const rxMin = Math.max(0, Math.floor(localMinX / regionWorldSize));
  const rxMax = Math.min(gridX - 1, Math.floor(localMaxX / regionWorldSize));
  const ryMin = Math.max(0, Math.floor(localMinY / regionWorldSize));
  const ryMax = Math.min(gridY - 1, Math.floor(localMaxY / regionWorldSize));

  const tiles = [];
  for (let rx = Math.max(0, rxMin - 1); rx <= Math.min(gridX - 1, rxMax + 1); rx++) {
    for (let ry = Math.max(0, ryMin - 1); ry <= Math.min(gridY - 1, ryMax + 1); ry++) {
      tiles.push({ rx, ry });
    }
  }
  return tiles;
}

function pointInPolygon2D(x, z, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return true;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] || {};
    const pj = polygon[j] || {};
    const xi = Number(pi.x);
    const zi = Number(pi.z);
    const xj = Number(pj.x);
    const zj = Number(pj.z);
    if (!Number.isFinite(xi) || !Number.isFinite(zi) || !Number.isFinite(xj) || !Number.isFinite(zj)) {
      continue;
    }

    const intersects = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function extractEntityWorldPos(ent) {
  if (
    ent?.worldPos
    && Number.isFinite(ent.worldPos.x)
    && Number.isFinite(ent.worldPos.y)
    && Number.isFinite(ent.worldPos.z)
  ) {
    return {
      x: Number(ent.worldPos.x),
      y: Number(ent.worldPos.y),
      z: Number(ent.worldPos.z),
    };
  }

  if (Array.isArray(ent?.matrix) && ent.matrix.length === 16) {
    return {
      x: Number(ent.matrix[12]) || 0,
      y: Number(ent.matrix[13]) || 0,
      z: Number(ent.matrix[14]) || 0,
    };
  }

  return { x: 0, y: 0, z: 0 };
}

function isEntityInsideRegion(ent, region) {
  if (!region) return true;

  const pos = extractEntityWorldPos(ent);
  if (pos.x < region.minX || pos.x > region.maxX || pos.z < region.minZ || pos.z > region.maxZ) {
    return false;
  }

  if (Array.isArray(region.polygon) && region.polygon.length >= 3) {
    return pointInPolygon2D(pos.x, pos.z, region.polygon);
  }

  return true;
}

function toSourceEntityMatrixFromThreeElements(e) {
  // Inverse of entities.js LH->RH matrix conversion.
  return [
    e[0],
    e[1],
    -e[2],
    e[3],
    e[4],
    e[5],
    -e[6],
    e[7],
    -e[8],
    -e[9],
    e[10],
    -e[11],
    e[12],
    e[13],
    -e[14],
    e[15],
  ];
}

function collectTextureNames(texInfo) {
  const names = new Set();
  if (!texInfo || typeof texInfo !== 'object') return names;

  const addOne = (v) => {
    if (typeof v === 'string' && v.trim()) names.add(v.trim());
  };

  addOne(texInfo.albedo);
  addOne(texInfo.mre);
  addOne(texInfo.normal);

  if (Array.isArray(texInfo.subsets)) {
    for (const s of texInfo.subsets) {
      addOne(s?.albedo);
      addOne(s?.mre);
      addOne(s?.normal);
    }
  }

  return names;
}

function buildVisualSettingsExport() {
  return {
    kind: 'jx3-visual-settings',
    version: 1,
    coordinateSystem: 'three-rh',
    sky: {
      type: 'gradient-sphere',
      topColor: '#4488cc',
      bottomColor: '#d4c5a0',
      horizonColor: '#c8b888',
      exponent: 0.5,
      radius: 200000,
    },
    fog: {
      type: 'exp2',
      color: '#c8b888',
      density: 0.0000035,
    },
    lighting: {
      directional: {
        intensity: 3.0,
        castShadow: true,
        shadow: {
          mapSize: [2048, 2048],
          near: 100,
          far: 200000,
          left: -50000,
          right: 50000,
          top: 50000,
          bottom: -50000,
          bias: -0.001,
          normalBias: 200,
        },
      },
      ambient: {
        intensity: 0.8,
        fallbackColor: '#666655',
      },
      hemisphere: {
        intensity: 1.0,
        skyColorMultiplier: [0.8, 0.9, 1.2],
        fallbackSkyColor: '#88aacc',
        groundColor: '#8b7355',
      },
      fallbackWhenNoEnvironment: {
        ambientColor: '#888888',
        ambientIntensity: 0.6,
        hemisphereSkyColor: '#87ceeb',
        hemisphereGroundColor: '#8b7355',
        hemisphereIntensity: 0.4,
      },
    },
    environmentBinding: {
      file: 'environment.json',
      sunlightPath: 'sunlight',
      notes: 'Use environment sunlight colors/direction if available; otherwise use fallback colors above.',
    },
  };
}

function copyIfExists(src, dst) {
  if (!existsSync(src) || !statSync(src).isFile()) return false;
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
  return true;
}

function buildFlatFileLookup(dirPath) {
  const map = new Map();
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return map;
  for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    map.set(ent.name.toLowerCase(), ent.name);
  }
  return map;
}

async function buildFullExportPackage(payload) {
  const exportName = sanitizeName(payload?.name, 'full-map');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const packageName = `${exportName}-${stamp}`;

  ensureDir(DESKTOP_EXPORT_ROOT);
  const packageRoot = resolve(join(DESKTOP_EXPORT_ROOT, packageName));
  const outMapData = join(packageRoot, 'map-data');

  ensureDir(outMapData);
  ensureDir(join(outMapData, 'entities'));
  ensureDir(join(outMapData, 'meshes'));
  ensureDir(join(outMapData, 'textures'));
  ensureDir(join(outMapData, 'heightmap'));
  ensureDir(join(outMapData, 'terrain-textures'));

  const sourceMapPath = String(payload?.sourceMapPath || 'map-data').replace(/\\/g, '/');
  const sourceRoot = safePathUnder(PUBLIC_DIR, sourceMapPath);
  if (!sourceRoot || !existsSync(sourceRoot)) {
    throw new Error(`Source map path not found: ${sourceMapPath}`);
  }

  const mapConfig = readJsonUtf8(join(sourceRoot, 'map-config.json'));
  if (!mapConfig?.landscape) {
    throw new Error('map-config.json missing or invalid in source map path');
  }

  const environment = readJsonUtf8(join(sourceRoot, 'environment.json'), null);
  const sourceMeshMap = readJsonUtf8(join(sourceRoot, 'mesh-map.json'), {});
  const textureMapSrc = readJsonUtf8(join(sourceRoot, 'texture-map.json'), {});
  const terrainTextureIndexSrc = readJsonUtf8(join(sourceRoot, 'terrain-textures', 'index.json'), null);

  const meshDirLookup = buildFlatFileLookup(join(sourceRoot, 'meshes'));
  const textureDirLookup = buildFlatFileLookup(join(sourceRoot, 'textures'));

  const regionRaw = payload?.region && typeof payload.region === 'object' ? payload.region : null;
  const region = (
    regionRaw
    && Number.isFinite(regionRaw.minX)
    && Number.isFinite(regionRaw.maxX)
    && Number.isFinite(regionRaw.minZ)
    && Number.isFinite(regionRaw.maxZ)
  )
    ? {
      minX: Number(regionRaw.minX),
      maxX: Number(regionRaw.maxX),
      minZ: Number(regionRaw.minZ),
      maxZ: Number(regionRaw.maxZ),
      polygon: Array.isArray(regionRaw.polygon) ? regionRaw.polygon : undefined,
    }
    : null;
  const regionCorners = Array.isArray(payload?.regionCorners) ? payload.regionCorners : null;
  // Sidecar collision is the only supported export format.
  const attachMeshCollision = true;

  const entitiesIn = Array.isArray(payload?.entities) ? payload.entities : [];
  if (entitiesIn.length === 0) {
    throw new Error('No entities provided for export');
  }

  const entityOut = [];
  const entityOutRh = [];
  const usedGlb = new Set();
  let entitiesFilteredOut = 0;

  for (const ent of entitiesIn) {
    if (!Array.isArray(ent?.matrix) || ent.matrix.length !== 16) continue;

    const runtimeMat = ent.matrix.map((v) => Number(v));
    if (!runtimeMat.every(Number.isFinite)) continue;

    if (region && !isEntityInsideRegion(ent, region)) {
      entitiesFilteredOut++;
      continue;
    }

    const srcMat = toSourceEntityMatrixFromThreeElements(runtimeMat);
    let glbName = String(ent?.mesh || '').trim();
    if (!glbName) continue;
    if (!glbName.toLowerCase().endsWith('.glb')) glbName += '.glb';

    const worldPos = extractEntityWorldPos({ worldPos: ent?.worldPos, matrix: runtimeMat });

    entityOut.push({
      mesh: glbName,
      matrix: srcMat,
      worldPos,
    });
    entityOutRh.push({
      mesh: glbName,
      matrix: runtimeMat,
      worldPos,
    });
    usedGlb.add(glbName);
  }

  if (entityOut.length === 0) {
    throw new Error('No valid entity transforms to export');
  }

  const meshMap = {};
  for (const glb of usedGlb) {
    meshMap[glb] = `meshes/${glb}`;
  }
  const meshList = [...usedGlb].sort();

  const sourceGlbByName = new Map();
  for (const v of Object.values(sourceMeshMap || {})) {
    if (typeof v !== 'string') continue;
    const b = basename(v).toLowerCase();
    if (!b.endsWith('.glb')) continue;
    if (!sourceGlbByName.has(b)) sourceGlbByName.set(b, v.replace(/\\/g, '/'));
  }

  // Copy GLBs
  let copiedGlbCount = 0;
  for (const glb of usedGlb) {
    const dst = join(outMapData, 'meshes', glb);
    const lower = glb.toLowerCase();

    let copied = false;

    // 1) Preferred: source mesh-map exact relative path (handles odd names/subdirs).
    const srcRel = sourceGlbByName.get(lower);
    if (srcRel) {
      copied = copyIfExists(join(sourceRoot, srcRel), dst);
    }

    // 2) Direct path under meshes.
    if (!copied) {
      copied = copyIfExists(join(sourceRoot, 'meshes', glb), dst);
    }

    // 3) Case-insensitive fallback from on-disk file listing.
    if (!copied) {
      const actual = meshDirLookup.get(lower);
      if (actual) copied = copyIfExists(join(sourceRoot, 'meshes', actual), dst);
    }

    if (copied) copiedGlbCount++;
  }

  // Subset texture-map + copy used texture files
  const textureMapOut = {};
  const usedTextures = new Set();
  const srcTextureMapKeys = new Map(Object.keys(textureMapSrc || {}).map((k) => [k.toLowerCase(), k]));

  for (const glb of usedGlb) {
    const srcKey = srcTextureMapKeys.get(glb.toLowerCase());
    if (!srcKey) continue;
    const info = textureMapSrc[srcKey];
    textureMapOut[glb] = info;
    for (const tex of collectTextureNames(info)) usedTextures.add(tex);
  }

  let copiedTextureCount = 0;
  for (const tex of usedTextures) {
    const dst = join(outMapData, 'textures', tex);
    let copied = copyIfExists(join(sourceRoot, 'textures', tex), dst);
    if (!copied) {
      const actual = textureDirLookup.get(tex.toLowerCase());
      if (actual) copied = copyIfExists(join(sourceRoot, 'textures', actual), dst);
    }
    if (copied) copiedTextureCount++;
  }

  // Heightmap + terrain textures subset
  const cfg = mapConfig.landscape;
  const tiles = getOverlappingTiles(region, cfg);
  const mapName = mapConfig.name || 'map';
  const terrainIndexOut = terrainTextureIndexSrc
    ? { textureDir: terrainTextureIndexSrc.textureDir || 'terrain-textures', regions: {}, textureSize: terrainTextureIndexSrc.textureSize || 1024 }
    : null;

  let copiedHeightmapCount = 0;
  let copiedTerrainTextureCount = 0;
  const terrainTexCopied = new Set();

  for (const { rx, ry } of tiles) {
    const key = `${pad3(rx)}_${pad3(ry)}`;
    const fileName = `${mapName}_${key}.bin`;
    const srcHm = join(sourceRoot, 'heightmap', fileName);
    const dstHm = join(outMapData, 'heightmap', fileName);
    if (copyIfExists(srcHm, dstHm)) copiedHeightmapCount++;

    if (terrainTextureIndexSrc?.regions) {
      const rKey = `${rx}_${ry}`;
      const texInfo = terrainTextureIndexSrc.regions[rKey];
      if (texInfo) {
        terrainIndexOut.regions[rKey] = texInfo;
        for (const f of [texInfo.color, texInfo.detail]) {
          if (!f || terrainTexCopied.has(f)) continue;
          const srcTex = join(sourceRoot, 'terrain-textures', f);
          const dstTex = join(outMapData, 'terrain-textures', f);
          if (copyIfExists(srcTex, dstTex)) {
            terrainTexCopied.add(f);
            copiedTerrainTextureCount++;
          }
        }
      }
    }
  }

  // Copy optional minimap files
  copyIfExists(join(sourceRoot, 'minimap.png'), join(outMapData, 'minimap.png'));
  copyIfExists(join(sourceRoot, 'regioninfo.png'), join(outMapData, 'regioninfo.png'));
  copyIfExists(join(sourceRoot, 'editor-minimap.png'), join(outMapData, 'editor-minimap.png'));

  // Write package data
  writeJson(join(outMapData, 'map-config.json'), mapConfig);
  if (environment) writeJson(join(outMapData, 'environment.json'), environment);
  writeJson(join(outMapData, 'mesh-map.json'), meshMap);
  writeJson(join(outMapData, 'mesh-list.json'), meshList);
  writeJson(join(outMapData, 'entity-index.json'), ['full.json']);
  writeJson(join(outMapData, 'entities', 'full.json'), entityOut);
  writeJson(join(outMapData, 'entity-index-rh.json'), ['full.rh.json']);
  writeJson(join(outMapData, 'entities', 'full.rh.json'), entityOutRh);
  writeJson(join(outMapData, 'transform-conventions.json'), {
    kind: 'jx3-transform-conventions',
    version: 1,
    coordinateSystem: 'three-rh',
    entities: {
      defaultFile: 'entities/full.json',
      defaultMatrixFormat: 'source-lh-row-major',
      normalizedRhIndexFile: 'entity-index-rh.json',
      normalizedRhFile: 'entities/full.rh.json',
      normalizedRhMatrixFormat: 'three-matrix4-column-major',
      normalizedRhRequiresImporterZFlip: false,
      worldPosFormat: 'three-rh',
    },
    notes: [
      'Use entity-index-rh.json + entities/full.rh.json to avoid importer-side LH/RH Z-flip conversion.',
      'entity-index.json + entities/full.json remain for backward compatibility with existing loaders.',
    ],
  });
  writeJson(join(outMapData, 'visual-settings.json'), buildVisualSettingsExport());
  writeJson(join(outMapData, 'texture-map.json'), textureMapOut);
  writeJson(join(outMapData, 'official-meshes.json'), meshList);
  writeJson(join(outMapData, 'verdicts.json'), { approved: meshList, denied: [] });
  if (terrainIndexOut) writeJson(join(outMapData, 'terrain-textures', 'index.json'), terrainIndexOut);

  let collision = {
    generated: false,
    file: '',
    objects: 0,
    shells: 0,
    shellTriangles: 0,
    meshSidecarsExpected: 0,
    meshSidecarsWritten: 0,
    meshSidecarsFailed: 0,
    meshSidecarsMissing: 0,
    meshSidecarIndexFile: '',
    meshesLoaded: 0,
    meshesFailed: 0,
    skippedEntities: entityOut.length,
    error: null,
  };

  try {
    const generated = await generateCollisionDataForExport({
      mapDataRoot: outMapData,
      packageName,
      region,
      outputFileName: '',
      attachToMeshes: attachMeshCollision,
      meshSidecarSuffix: '.collision.json',
    });

    collision = {
      generated: true,
      file: '',
      objects: generated.objects,
      shells: generated.shells || 0,
      shellTriangles: generated.shellTriangles || 0,
      meshSidecarsExpected: generated.meshSidecarsExpected || 0,
      meshSidecarsWritten: generated.meshSidecarsWritten || 0,
      meshSidecarsFailed: generated.meshSidecarsFailed || 0,
      meshSidecarsMissing: generated.meshSidecarsMissing || 0,
      meshSidecarIndexFile: generated.meshSidecarIndexFile || '',
      meshesLoaded: generated.meshesLoaded,
      meshesFailed: generated.meshesFailed,
      skippedEntities: generated.skippedEntities,
      error: null,
    };
  } catch (err) {
    collision.error = err?.message || String(err);
    console.warn(`[export-full] collision generation skipped for ${packageName}: ${collision.error}`);
  }

  const manifest = {
    kind: 'jx3-full-map-export',
    version: 1,
    name: exportName,
    packageName,
    createdAt: Date.now(),
    sourceMapPath,
    region,
    regionCorners,
    stats: {
      entitiesInput: entitiesIn.length,
      entities: entityOut.length,
      entitiesRh: entityOutRh.length,
      entityRhIndexWritten: true,
      transformConventionsWritten: true,
      visualSettingsWritten: true,
      entitiesFilteredOut,
      meshesRequested: usedGlb.size,
      meshesCopied: copiedGlbCount,
      texturesRequested: usedTextures.size,
      texturesCopied: copiedTextureCount,
      heightmapsCopied: copiedHeightmapCount,
      terrainTexturesCopied: copiedTerrainTextureCount,
      tilesSelected: tiles.length,
      collisionGenerated: collision.generated,
      collisionObjects: collision.objects,
      collisionShells: collision.shells,
      collisionShellTriangles: collision.shellTriangles,
      meshCollisionExpected: collision.meshSidecarsExpected,
      meshCollisionAttached: collision.meshSidecarsWritten,
      meshCollisionAttachFailures: collision.meshSidecarsFailed,
      meshCollisionMissing: collision.meshSidecarsMissing,
      meshCollisionComplete: collision.meshSidecarsMissing === 0,
      collisionMeshesLoaded: collision.meshesLoaded,
      collisionMeshesFailed: collision.meshesFailed,
      collisionSkippedEntities: collision.skippedEntities,
    },
    collision,
    coordinateContract: {
      world: 'three-rh',
      entityMatrixStoredAs: 'source-lh-row-major',
      entityRhMatrixFile: 'map-data/entities/full.rh.json',
      entityRhIndexFile: 'map-data/entity-index-rh.json',
      transformConventionsFile: 'map-data/transform-conventions.json',
      visualSettingsFile: 'map-data/visual-settings.json',
      terrain: 'heightmap + map-config (same as source viewer)',
    },
  };
  writeJson(join(packageRoot, 'manifest.json'), manifest);

  return {
    packageName,
    packageRoot,
    stats: manifest.stats,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveFile(res, filePath, headOnly = false) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = headOnly ? null : readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': headOnly ? statSync(filePath).size : data.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(headOnly ? undefined : data);
}

async function readBodyJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 50 * 1024 * 1024) {
        rejectBody(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function listFullExports() {
  ensureDir(DESKTOP_EXPORT_ROOT);
  const dirs = readdirSync(DESKTOP_EXPORT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));

  const out = [];
  for (const d of dirs) {
    const root = join(DESKTOP_EXPORT_ROOT, d);
    const manifestPath = join(root, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readJsonUtf8(manifestPath, null);
      if (!manifest) continue;
      out.push({
        packageName: d,
        name: manifest.name || d,
        createdAt: manifest.createdAt || 0,
        stats: manifest.stats || {},
      });
    } catch {
      // ignore bad manifest
    }
  }
  return out;
}

function normalizeInspectorDataPath(rawValue) {
  const raw = String(rawValue || '').trim();
  const clean = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return clean || 'map-data';
}

function resolveInspectorDataRoot(rawDataPath) {
  const dataPath = normalizeInspectorDataPath(rawDataPath);

  if (dataPath.startsWith('/full-exports/') || dataPath.startsWith('full-exports/')) {
    const rel = dataPath
      .replace(/^\/+/, '')
      .replace(/^full-exports\//, '');
    return safePathUnder(DESKTOP_EXPORT_ROOT, rel);
  }

  const rel = dataPath.replace(/^\/+/, '');
  return safePathUnder(PUBLIC_DIR, rel);
}

function extractGlbListFromDataRoot(dataRoot) {
  const out = [];
  const seen = new Set();
  const meshDir = join(dataRoot, 'meshes');

  if (existsSync(meshDir) && statSync(meshDir).isDirectory()) {
    for (const ent of readdirSync(meshDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith('.glb')) continue;
      const n = ent.name;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }

  // Fallback for unusual layouts: derive names from mesh-map values.
  if (out.length === 0) {
    const meshMap = readJsonUtf8(join(dataRoot, 'mesh-map.json'), {});
    for (const v of Object.values(meshMap || {})) {
      if (typeof v !== 'string') continue;
      const n = basename(v);
      if (!n.toLowerCase().endsWith('.glb')) continue;
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

function normalizeVerdictList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    let name = basename(String(raw || '').trim());
    if (!name) continue;
    if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

function readInspectorVerdicts(dataRoot) {
  const verdictPath = join(dataRoot, 'verdicts.json');
  const raw = readJsonUtf8(verdictPath, { approved: [], denied: [] });
  return {
    approved: normalizeVerdictList(raw?.approved),
    denied: normalizeVerdictList(raw?.denied),
  };
}

function writeInspectorVerdicts(dataRoot, payload) {
  const verdictPath = join(dataRoot, 'verdicts.json');
  const approved = normalizeVerdictList(payload?.approved);
  const deniedRaw = normalizeVerdictList(payload?.denied);
  const approvedSet = new Set(approved.map((x) => x.toLowerCase()));
  const denied = deniedRaw.filter((x) => !approvedSet.has(x.toLowerCase()));
  writeJson(verdictPath, { approved, denied });
  return { approved, denied };
}

function setSingleInspectorVerdict(dataRoot, meshNameRaw, verdictRaw) {
  let meshName = basename(String(meshNameRaw || '').trim());
  if (!meshName) throw new Error('mesh is required');
  if (!meshName.toLowerCase().endsWith('.glb')) meshName += '.glb';

  const rawVerdict = String(verdictRaw || '').trim().toLowerCase();
  const verdict = rawVerdict === 'none' ? 'clear' : rawVerdict;
  if (!['approved', 'denied', 'clear'].includes(verdict)) {
    throw new Error('Invalid verdict. Use approved, denied, or clear.');
  }

  const meshList = extractGlbListFromDataRoot(dataRoot);
  const meshByLower = new Map(meshList.map((n) => [n.toLowerCase(), n]));
  const targetKey = meshName.toLowerCase();
  const targetName = meshByLower.get(targetKey) || meshName;

  const current = readInspectorVerdicts(dataRoot);
  const approvedMap = new Map(current.approved.map((n) => [n.toLowerCase(), n]));
  const deniedMap = new Map(current.denied.map((n) => [n.toLowerCase(), n]));

  approvedMap.delete(targetKey);
  deniedMap.delete(targetKey);

  if (verdict === 'approved') approvedMap.set(targetKey, targetName);
  if (verdict === 'denied') deniedMap.set(targetKey, targetName);

  for (const key of approvedMap.keys()) deniedMap.delete(key);

  const approved = [...approvedMap.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const denied = [...deniedMap.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  writeJson(join(dataRoot, 'verdicts.json'), { approved, denied });
  return { approved, denied, mesh: targetName, verdict };
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const urlPath = decodeURIComponent(rawUrl.split('?')[0]);
  const reqUrl = new URL(rawUrl, 'http://localhost');

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API: list full exports
  if (method === 'GET' && urlPath === '/api/full-exports') {
    try {
      const exportsList = listFullExports();
      sendJson(res, 200, { exports: exportsList, root: DESKTOP_EXPORT_ROOT });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: enumerate MovieEditor actor exports.
  if (method === 'GET' && urlPath === '/api/actor-exports') {
    try {
      sendJson(res, 200, {
        available: existsSync(MOVIE_EDITOR_EXPORT_ROOT) && statSync(MOVIE_EDITOR_EXPORT_ROOT).isDirectory(),
        root: MOVIE_EDITOR_EXPORT_ROOT,
        exports: listMovieEditorActorExports(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/repo-clips') {
    try {
      sendJson(res, 200, {
        available: existsSync(REPO_CLIPS_ROOT) && statSync(REPO_CLIPS_ROOT).isDirectory(),
        root: REPO_CLIPS_ROOT,
        clips: listRepoClipSources(),
      });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/open-actor-export-folder') {
    try {
      const exportName = String(reqUrl.searchParams.get('name') || '').trim();
      const exportInfo = exportName
        ? listMovieEditorActorExports().find((entry) => entry.name === exportName)
        : null;
      const folderPath = exportInfo?.exportDir || MOVIE_EDITOR_EXPORT_ROOT;

      if (!folderPath || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
        sendJson(res, 404, { ok: false, error: 'Actor export folder not found' });
        return;
      }

      const child = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' });
      child.unref();
      sendJson(res, 200, { ok: true, opened: folderPath, exportName: exportInfo?.name || '' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'GET' && urlPath === '/api/resource-groups') {
    try {
      const actor = String(reqUrl.searchParams.get('actor') || '').trim();
      if (!actor) {
        sendJson(res, 400, { ok: false, error: 'actor is required' });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        actor,
        filePath: RESOURCE_GROUPS_FILE,
        groups: readActorResourceGroups(actor),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (method === 'POST' && urlPath === '/api/resource-groups') {
    try {
      const actor = String(reqUrl.searchParams.get('actor') || '').trim();
      if (!actor) {
        sendJson(res, 400, { ok: false, error: 'actor is required' });
        return;
      }

      const payload = await readBodyJson(req);
      const saved = writeActorResourceGroups(actor, payload);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector list meshes for a selected data root.
  if (method === 'GET' && urlPath === '/api/meshes') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      sendJson(res, 200, extractGlbListFromDataRoot(dataRoot));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector verdicts read.
  if (method === 'GET' && urlPath === '/api/verdicts') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      sendJson(res, 200, readInspectorVerdicts(dataRoot));
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  // API: mesh inspector verdicts write.
  if (method === 'POST' && urlPath === '/api/verdicts') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      const payload = await readBodyJson(req);
      const saved = writeInspectorVerdicts(dataRoot, payload);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: set one verdict atomically for one mesh.
  if (method === 'POST' && urlPath === '/api/verdicts/set') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      if (!dataRoot || !existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
        sendJson(res, 404, { error: 'Data root not found' });
        return;
      }
      const payload = await readBodyJson(req);
      const saved = setSingleInspectorVerdict(dataRoot, payload?.mesh, payload?.verdict);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: open meshes folder in Explorer for the selected data root.
  if (method === 'GET' && urlPath === '/api/open-meshes-folder') {
    try {
      const dataRoot = resolveInspectorDataRoot(reqUrl.searchParams.get('dataPath'));
      const meshDir = dataRoot ? join(dataRoot, 'meshes') : null;
      if (!meshDir || !existsSync(meshDir) || !statSync(meshDir).isDirectory()) {
        sendJson(res, 404, { ok: false, error: 'Meshes folder not found' });
        return;
      }
      const child = spawn('explorer.exe', [meshDir], { detached: true, stdio: 'ignore' });
      child.unref();
      sendJson(res, 200, { ok: true, opened: meshDir });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build full export package on Desktop
  if (method === 'POST' && urlPath === '/api/export-full') {
    try {
      const payload = await readBodyJson(req);
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build full export package on Desktop and attach per-GLB collision sidecars.
  if (method === 'POST' && urlPath === '/api/export-full-with-collision') {
    try {
      const payload = await readBodyJson(req);
      payload.attachMeshCollision = true;
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // API: build regional export package on Desktop and attach per-GLB collision sidecars.
  if (method === 'POST' && urlPath === '/api/export-regional-with-collision') {
    try {
      const payload = await readBodyJson(req);
      const region = payload?.region;
      const hasRegion = (
        region
        && Number.isFinite(region.minX)
        && Number.isFinite(region.maxX)
        && Number.isFinite(region.minZ)
        && Number.isFinite(region.maxZ)
      );
      if (!hasRegion) {
        throw new Error('Region is required for /api/export-regional-with-collision');
      }

      payload.attachMeshCollision = true;
      const result = await buildFullExportPackage(payload);
      sendJson(res, 200, {
        ok: true,
        packageName: result.packageName,
        desktopRoot: DESKTOP_EXPORT_ROOT,
        packagePath: result.packageRoot,
        viewerUrl: `/full-viewer.html?pkg=${encodeURIComponent(result.packageName)}`,
        stats: result.stats,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return;
  }

  // Serve Desktop full export files under /full-exports/<package>/...
  if ((method === 'GET' || method === 'HEAD') && urlPath.startsWith('/full-exports/')) {
    const rel = urlPath.replace('/full-exports/', '');
    const abs = safePathUnder(DESKTOP_EXPORT_ROOT, rel);
    if (!abs) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, abs, method === 'HEAD');
    return;
  }

  if (urlPath.startsWith('/full-exports/')) {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Serve external MovieEditor assets under /movie-editor-assets/...
  if ((method === 'GET' || method === 'HEAD') && urlPath.startsWith('/movie-editor-assets/')) {
    const rel = urlPath.replace('/movie-editor-assets/', '');
    const abs = safePathUnder(MOVIE_EDITOR_ROOT, rel);
    if (!abs) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    serveFile(res, abs, method === 'HEAD');
    return;
  }

  if (urlPath.startsWith('/movie-editor-assets/')) {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Default static files from public
  let staticUrl = urlPath;
  if (staticUrl === '/') staticUrl = '/index.html';
  const staticPath = safePathUnder(PUBLIC_DIR, staticUrl.replace(/^\//, ''));
  if (!staticPath) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    serveFile(res, staticPath, method === 'HEAD');
    return;
  }

  sendText(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  ensureDir(DESKTOP_EXPORT_ROOT);
  console.log(`JX3 Map Viewer running at http://localhost:${PORT}`);
  console.log(`Full exports Desktop root: ${DESKTOP_EXPORT_ROOT}`);
});
