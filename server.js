/**
 * Static + export API server for the map viewer.
 *
 * Adds:
 * 1) POST /api/export-full  -> build self-contained full export on Desktop
 * 2) GET  /api/full-exports -> list exported packages
 * 3) GET  /full-exports/*   -> serve exported package files
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
import { join, extname, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(join(__dirname, 'public'));
const PORT = Number(process.env.PORT) || 3000;
const DESKTOP_EXPORT_ROOT = resolve(join(os.homedir(), 'Desktop', 'JX3FullExports'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.dds': 'application/octet-stream',
  '.ico': 'image/x-icon',
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

function readJsonUtf8(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
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

function buildFullExportPackage(payload) {
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

  const region = payload?.region && typeof payload.region === 'object' ? payload.region : null;
  const regionCorners = Array.isArray(payload?.regionCorners) ? payload.regionCorners : null;

  const entitiesIn = Array.isArray(payload?.entities) ? payload.entities : [];
  if (entitiesIn.length === 0) {
    throw new Error('No entities provided for export');
  }

  const entityOut = [];
  const usedGlb = new Set();

  for (const ent of entitiesIn) {
    if (!Array.isArray(ent?.matrix) || ent.matrix.length !== 16) continue;

    const srcMat = toSourceEntityMatrixFromThreeElements(ent.matrix);
    let glbName = String(ent?.mesh || '').trim();
    if (!glbName) continue;
    if (!glbName.toLowerCase().endsWith('.glb')) glbName += '.glb';

    const worldPos = {
      x: Number(ent.matrix[12]) || 0,
      y: Number(ent.matrix[13]) || 0,
      z: Number(ent.matrix[14]) || 0,
    };

    entityOut.push({
      mesh: glbName,
      matrix: srcMat,
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
  writeJson(join(outMapData, 'texture-map.json'), textureMapOut);
  writeJson(join(outMapData, 'official-meshes.json'), meshList);
  writeJson(join(outMapData, 'verdicts.json'), { approved: meshList, denied: [] });
  if (terrainIndexOut) writeJson(join(outMapData, 'terrain-textures', 'index.json'), terrainIndexOut);

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
      entities: entityOut.length,
      meshesRequested: usedGlb.size,
      meshesCopied: copiedGlbCount,
      texturesRequested: usedTextures.size,
      texturesCopied: copiedTextureCount,
      heightmapsCopied: copiedHeightmapCount,
      terrainTexturesCopied: copiedTerrainTextureCount,
      tilesSelected: tiles.length,
    },
    coordinateContract: {
      world: 'three-rh',
      entityMatrixStoredAs: 'source-lh-row-major',
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

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

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

  // API: build full export package on Desktop
  if (method === 'POST' && urlPath === '/api/export-full') {
    try {
      const payload = await readBodyJson(req);
      const result = buildFullExportPackage(payload);
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
