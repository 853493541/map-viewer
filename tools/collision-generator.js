import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, join } from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const GAME_WORLD_SIZE = 2000;
const SCALE_MULTIPLIER = 0.125;
const NATURAL_MESH_RE = /rock|cliff|mount|hill|stone|rubble|deadwood|tree/i;
const SHELL_THICKNESS = 0.06;

function readJsonUtf8(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonUtf8(filePath, obj) {
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function buildMeshCollisionSidecarFileName(meshName, suffix = '.collision.json') {
  return `${meshName}${suffix}`;
}

function normalizeMeshName(raw) {
  let name = basename(String(raw || '').replace(/\\/g, '/')).trim();
  if (!name) return '';
  if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
  return name;
}

function buildLocalShellPayload(localTriangles) {
  if (!Array.isArray(localTriangles) || localTriangles.length === 0) return null;

  const triangles = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const tri of localTriangles) {
    if (!tri) continue;
    const vals = [tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz];
    if (!vals.every(Number.isFinite)) continue;

    triangles.push([
      round3(tri.ax), round3(tri.ay), round3(tri.az),
      round3(tri.bx), round3(tri.by), round3(tri.bz),
      round3(tri.cx), round3(tri.cy), round3(tri.cz),
    ]);

    if (tri.ax < minX) minX = tri.ax;
    if (tri.bx < minX) minX = tri.bx;
    if (tri.cx < minX) minX = tri.cx;
    if (tri.ax > maxX) maxX = tri.ax;
    if (tri.bx > maxX) maxX = tri.bx;
    if (tri.cx > maxX) maxX = tri.cx;

    if (tri.ay < minY) minY = tri.ay;
    if (tri.by < minY) minY = tri.by;
    if (tri.cy < minY) minY = tri.cy;
    if (tri.ay > maxY) maxY = tri.ay;
    if (tri.by > maxY) maxY = tri.by;
    if (tri.cy > maxY) maxY = tri.cy;

    if (tri.az < minZ) minZ = tri.az;
    if (tri.bz < minZ) minZ = tri.bz;
    if (tri.cz < minZ) minZ = tri.cz;
    if (tri.az > maxZ) maxZ = tri.az;
    if (tri.bz > maxZ) maxZ = tri.bz;
    if (tri.cz > maxZ) maxZ = tri.cz;
  }

  if (triangles.length === 0) return null;

  return {
    type: 'surface-shell',
    thickness: round3(SHELL_THICKNESS),
    triangleCount: triangles.length,
    triangleFormat: 'packed-triangle-xyz9',
    bounds: {
      minX: round3(minX),
      maxX: round3(maxX),
      minY: round3(minY),
      maxY: round3(maxY),
      minZ: round3(minZ),
      maxZ: round3(maxZ),
    },
    triangles,
  };
}

function toSimpleTriangles(rawTriangles) {
  if (!Array.isArray(rawTriangles)) return [];

  const out = [];
  for (const tri of rawTriangles) {
    if (!tri) continue;
    const vals = [tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz];
    if (!vals.every(Number.isFinite)) continue;
    out.push({
      ax: tri.ax,
      ay: tri.ay,
      az: tri.az,
      bx: tri.bx,
      by: tri.by,
      bz: tri.bz,
      cx: tri.cx,
      cy: tri.cy,
      cz: tri.cz,
    });
  }

  return out;
}

function buildLocalMeshCollisionAttachment(meshName, localParts, localShellTriangles) {
  const parts = Array.isArray(localParts)
    ? localParts.map((part, i) => ({
      id: `part_${i}`,
      localCx: round3(part.localCx),
      localCz: round3(part.localCz),
      localW: round3(part.localW),
      localD: round3(part.localD),
      localBaseY: round3(part.localBaseY),
      localTopY: round3(part.localTopY),
    }))
    : [];

  const shell = buildLocalShellPayload(localShellTriangles);

  return {
    version: 1,
    formatRevision: 2,
    generator: 'collision-generator-v3-shell',
    generatedAt: Date.now(),
    mesh: meshName,
    models: {
      broadPhase: 'box-prisms',
      narrowPhase: 'surface-shell-triangles',
      shellThickness: round3(SHELL_THICKNESS),
      shellTriangleFormat: 'packed-triangle-xyz9',
      attachment: 'per-glb-sidecar-json',
    },
    parts,
    shells: shell ? [shell] : [],
  };
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

function readEntitiesFromMapData(mapDataRoot) {
  const entitiesDir = join(mapDataRoot, 'entities');
  if (!existsSync(entitiesDir) || !statSync(entitiesDir).isDirectory()) {
    throw new Error(`Entities directory not found: ${entitiesDir}`);
  }

  const indexPath = join(mapDataRoot, 'entity-index.json');
  const indexFiles = readJsonUtf8(indexPath, null);

  let files = [];
  if (Array.isArray(indexFiles) && indexFiles.length > 0) {
    files = indexFiles.filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.json'));
  }

  if (files.length === 0) {
    files = readdirSync(entitiesDir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  }

  const entities = [];
  for (const file of files) {
    const arr = readJsonUtf8(join(entitiesDir, file), []);
    if (!Array.isArray(arr)) continue;
    for (const e of arr) entities.push(e);
  }

  return entities;
}

function getEntityWorldPos(entity) {
  if (entity?.worldPos && Number.isFinite(entity.worldPos.x) && Number.isFinite(entity.worldPos.y) && Number.isFinite(entity.worldPos.z)) {
    return {
      x: Number(entity.worldPos.x),
      y: Number(entity.worldPos.y),
      z: Number(entity.worldPos.z),
    };
  }

  if (Array.isArray(entity?.matrix) && entity.matrix.length === 16) {
    return {
      x: Number(entity.matrix[12]) || 0,
      y: Number(entity.matrix[13]) || 0,
      z: -(Number(entity.matrix[14]) || 0),
    };
  }

  return { x: 0, y: 0, z: 0 };
}

function resolveRegion(region, entities) {
  if (
    region &&
    Number.isFinite(region.minX) &&
    Number.isFinite(region.maxX) &&
    Number.isFinite(region.minZ) &&
    Number.isFinite(region.maxZ)
  ) {
    return {
      minX: Number(region.minX),
      maxX: Number(region.maxX),
      minZ: Number(region.minZ),
      maxZ: Number(region.maxZ),
      polygon: Array.isArray(region.polygon) ? region.polygon : undefined,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const e of entities) {
    const p = getEntityWorldPos(e);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
  }

  if (Math.abs(maxX - minX) < 1) {
    minX -= 500;
    maxX += 500;
  }
  if (Math.abs(maxZ - minZ) < 1) {
    minZ -= 500;
    maxZ += 500;
  }

  return { minX, maxX, minZ, maxZ };
}

function computeProjection(region) {
  const regionWidth = Math.max(1, region.maxX - region.minX);
  const regionDepth = Math.max(1, Math.abs(region.maxZ - region.minZ));
  const maxDim = Math.max(regionWidth, regionDepth);

  const scaleFactor = (GAME_WORLD_SIZE / maxDim) * SCALE_MULTIPLIER;
  const regionCenterX = (region.minX + region.maxX) / 2;
  const regionCenterZ = (region.minZ + region.maxZ) / 2;
  const offsetX = GAME_WORLD_SIZE / 2 - regionCenterX * scaleFactor;
  const offsetY = GAME_WORLD_SIZE / 2 + regionCenterZ * scaleFactor;

  return { scaleFactor, offsetX, offsetY };
}

function convertEntityMatrix(matrixArray) {
  const matrix = new THREE.Matrix4();
  matrix.fromArray(matrixArray);
  const el = matrix.elements;
  el[2] = -el[2];
  el[6] = -el[6];
  el[8] = -el[8];
  el[9] = -el[9];
  el[11] = -el[11];
  el[14] = -el[14];
  return matrix;
}

function projectPointToGameSpace(point, scaleFactor, offsetX, offsetY) {
  return {
    x: point.x * scaleFactor + offsetX,
    y: -point.z * scaleFactor + offsetY,
    z: point.y * scaleFactor,
  };
}

function convexHull2D(points) {
  if (points.length <= 1) return points.slice();

  const sorted = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function computeMinAreaOBB(points) {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return { cx: points[0].x, cy: points[0].y, hw: 0, hd: 0, angle: 0 };
  }

  const hull = convexHull2D(points);
  if (hull.length === 2) {
    const dx = hull[1].x - hull[0].x;
    const dy = hull[1].y - hull[0].y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      cx: (hull[0].x + hull[1].x) / 2,
      cy: (hull[0].y + hull[1].y) / 2,
      hw: len / 2,
      hd: 0,
      angle: Math.atan2(dy, dx),
    };
  }

  let best = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const edgeLen = Math.hypot(edgeX, edgeY);
    if (edgeLen < 1e-9) continue;

    const axisX = edgeX / edgeLen;
    const axisY = edgeY / edgeLen;
    const perpX = -axisY;
    const perpY = axisX;

    let minAxis = Infinity;
    let maxAxis = -Infinity;
    let minPerp = Infinity;
    let maxPerp = -Infinity;

    for (const p of hull) {
      const axisProj = p.x * axisX + p.y * axisY;
      const perpProj = p.x * perpX + p.y * perpY;
      if (axisProj < minAxis) minAxis = axisProj;
      if (axisProj > maxAxis) maxAxis = axisProj;
      if (perpProj < minPerp) minPerp = perpProj;
      if (perpProj > maxPerp) maxPerp = perpProj;
    }

    const width = maxAxis - minAxis;
    const depth = maxPerp - minPerp;
    const area = width * depth;

    if (!best || area < best.area) {
      const centerAxis = (minAxis + maxAxis) / 2;
      const centerPerp = (minPerp + maxPerp) / 2;
      best = {
        area,
        cx: centerAxis * axisX + centerPerp * perpX,
        cy: centerAxis * axisY + centerPerp * perpY,
        hw: width / 2,
        hd: depth / 2,
        angle: Math.atan2(axisY, axisX),
      };
    }
  }

  return best;
}

function buildCollisionPartFromPrism(part, entityMatrix, scaleFactor, offsetX, offsetY) {
  const halfW = part.localW / 2;
  const halfD = part.localD / 2;

  const localCorners = [
    [-halfW, part.localBaseY, -halfD],
    [halfW, part.localBaseY, -halfD],
    [-halfW, part.localBaseY, halfD],
    [halfW, part.localBaseY, halfD],
    [-halfW, part.localTopY, -halfD],
    [halfW, part.localTopY, -halfD],
    [-halfW, part.localTopY, halfD],
    [halfW, part.localTopY, halfD],
  ];

  const transformed = localCorners.map(([dx, localY, dz]) => {
    const world = new THREE.Vector3(part.localCx + dx, localY, part.localCz + dz).applyMatrix4(entityMatrix);
    return projectPointToGameSpace(world, scaleFactor, offsetX, offsetY);
  });

  const projected = transformed.slice(0, 4).map((p) => ({ x: p.x, y: p.y }));
  const obb = computeMinAreaOBB(projected);
  if (!obb) return null;

  const baseH = Math.min(...transformed.map((p) => p.z));
  const objH = Math.max(...transformed.map((p) => p.z));

  return {
    partCx: obb.cx,
    partCy: obb.cy,
    hw: obb.hw,
    hd: obb.hd,
    baseH,
    objH,
    angle: obb.angle,
  };
}

function extractMeshTriangles(gltf) {
  const triangles = [];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  gltf.scene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    const tmpGeom = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry;
    const pos = tmpGeom.attributes.position;
    if (!pos) {
      if (tmpGeom !== child.geometry) tmpGeom.dispose();
      return;
    }

    for (let i = 0; i < pos.count; i += 3) {
      vA.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
      vB.fromBufferAttribute(pos, i + 1).applyMatrix4(child.matrixWorld);
      vC.fromBufferAttribute(pos, i + 2).applyMatrix4(child.matrixWorld);

      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      normal.crossVectors(ab, ac);
      const area2 = normal.length();
      if (area2 < 1e-9) continue;

      normal.multiplyScalar(1 / area2);

      triangles.push({
        ax: vA.x,
        ay: vA.y,
        az: vA.z,
        bx: vB.x,
        by: vB.y,
        bz: vB.z,
        cx: vC.x,
        cy: vC.y,
        cz: vC.z,
        minY: Math.min(vA.y, vB.y, vC.y),
        maxY: Math.max(vA.y, vB.y, vC.y),
        area: area2 * 0.5,
        nx: normal.x,
        ny: normal.y,
        nz: normal.z,
        centerX: (vA.x + vB.x + vC.x) / 3,
        centerY: (vA.y + vB.y + vC.y) / 3,
        centerZ: (vA.z + vB.z + vC.z) / 3,
      });
    }

    if (tmpGeom !== child.geometry) tmpGeom.dispose();
  });

  return triangles;
}

function pointInTri2D(px, pz, ax, az, bx, bz, cx, cz) {
  const v0x = cx - ax;
  const v0z = cz - az;
  const v1x = bx - ax;
  const v1z = bz - az;
  const v2x = px - ax;
  const v2z = pz - az;

  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;

  const invDen = 1 / ((dot00 * dot11 - dot01 * dot01) || 1e-9);
  const u = (dot11 * dot02 - dot01 * dot12) * invDen;
  const v = (dot00 * dot12 - dot01 * dot02) * invDen;
  return u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6;
}

function segDistSq2D(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / ((abx * abx + abz * abz) || 1e-9)));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = px - qx;
  const dz = pz - qz;
  return dx * dx + dz * dz;
}

function getGLBCollisionParts(gltf, scaleFactor, meshName = '') {
  gltf.scene.updateMatrixWorld(true);

  const sceneBox = new THREE.Box3().setFromObject(gltf.scene);
  if (sceneBox.isEmpty()) return [];

  const sceneSize = sceneBox.getSize(new THREE.Vector3());
  const naturalMesh = NATURAL_MESH_RE.test(meshName);
  const maxHorizontalDim = Math.max(sceneSize.x, sceneSize.z);
  const largeStructure = maxHorizontalDim > 1000 || sceneSize.y > 800;

  const targetGameCell = naturalMesh
    ? maxHorizontalDim > 9000
      ? 0.5
      : maxHorizontalDim > 5000
        ? 0.4
        : 0.3
    : maxHorizontalDim > 9000
      ? 1.2
      : maxHorizontalDim > 5000
        ? 0.9
        : largeStructure
          ? 0.38
          : 0.32;

  const targetCellsAcross = naturalMesh
    ? maxHorizontalDim > 9000
      ? 180
      : maxHorizontalDim > 5000
        ? 140
        : 110
    : maxHorizontalDim > 9000
      ? 110
      : maxHorizontalDim > 5000
        ? 128
        : 160;

  const adaptiveLocalCell = maxHorizontalDim / targetCellsAcross;
  const cellSize = Math.max(
    naturalMesh ? 5 : 6,
    Math.min(
      naturalMesh ? 160 : 180,
      Math.max(targetGameCell / scaleFactor, adaptiveLocalCell),
    ),
  );

  const edgeRadiusSq = Math.pow(cellSize * (naturalMesh ? 0.28 : 0.3), 2);
  const mergeHeightTolerance = (naturalMesh ? 0.35 : largeStructure ? 0.8 : 0.6) / scaleFactor;
  const maxMergeCols = naturalMesh ? 4 : largeStructure ? 6 : 8;
  const maxMergeRows = naturalMesh ? 4 : largeStructure ? 6 : 8;

  const triangles = extractMeshTriangles(gltf);

  if (triangles.length === 0) return [];

  const minX = sceneBox.min.x;
  const maxX = sceneBox.max.x;
  const minZ = sceneBox.min.z;
  const maxZ = sceneBox.max.z;

  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));

  const occupied = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cellBottomY = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
  const cellTopY = Array.from({ length: rows }, () => Array(cols).fill(-Infinity));

  for (const tri of triangles) {
    const triMinX = Math.min(tri.ax, tri.bx, tri.cx);
    const triMaxX = Math.max(tri.ax, tri.bx, tri.cx);
    const triMinZ = Math.min(tri.az, tri.bz, tri.cz);
    const triMaxZ = Math.max(tri.az, tri.bz, tri.cz);

    const c0 = Math.max(0, Math.floor((triMinX - minX) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((triMaxX - minX) / cellSize));
    const r0 = Math.max(0, Math.floor((triMinZ - minZ) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((triMaxZ - minZ) / cellSize));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = minX + c * cellSize + cellSize / 2;
        const pz = minZ + r * cellSize + cellSize / 2;

        const overlaps =
          pointInTri2D(px, pz, tri.ax, tri.az, tri.bx, tri.bz, tri.cx, tri.cz) ||
          segDistSq2D(px, pz, tri.ax, tri.az, tri.bx, tri.bz) <= edgeRadiusSq ||
          segDistSq2D(px, pz, tri.bx, tri.bz, tri.cx, tri.cz) <= edgeRadiusSq ||
          segDistSq2D(px, pz, tri.cx, tri.cz, tri.ax, tri.az) <= edgeRadiusSq;

        if (!overlaps) continue;

        occupied[r][c] = true;
        if (tri.minY < cellBottomY[r][c]) cellBottomY[r][c] = tri.minY;
        if (tri.maxY > cellTopY[r][c]) cellTopY[r][c] = tri.maxY;
      }
    }
  }

  const used = Array.from({ length: rows }, () => Array(cols).fill(false));
  const parts = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!occupied[r][c] || used[r][c]) continue;

      const seedBottomY = cellBottomY[r][c];
      const seedTopY = cellTopY[r][c];

      const matchesHeightBand = (rr, cc) => (
        occupied[rr][cc] &&
        !used[rr][cc] &&
        Math.abs(cellBottomY[rr][cc] - seedBottomY) <= mergeHeightTolerance &&
        Math.abs(cellTopY[rr][cc] - seedTopY) <= mergeHeightTolerance
      );

      let c2 = c;
      while (c2 + 1 < cols && c2 - c + 1 < maxMergeCols && matchesHeightBand(r, c2 + 1)) c2++;

      let r2 = r;
      outer: while (r2 + 1 < rows) {
        if (r2 - r + 1 >= maxMergeRows) break;
        for (let cc = c; cc <= c2; cc++) {
          if (!matchesHeightBand(r2 + 1, cc)) break outer;
        }
        r2++;
      }

      let bottomY = Infinity;
      let topY = -Infinity;

      for (let rr = r; rr <= r2; rr++) {
        for (let cc = c; cc <= c2; cc++) {
          used[rr][cc] = true;
          if (cellBottomY[rr][cc] < bottomY) bottomY = cellBottomY[rr][cc];
          if (cellTopY[rr][cc] > topY) topY = cellTopY[rr][cc];
        }
      }

      const localW = (c2 - c + 1) * cellSize;
      const localD = (r2 - r + 1) * cellSize;
      if (localW < cellSize * 0.45 || localD < cellSize * 0.45) continue;

      parts.push({
        localCx: minX + (c + c2 + 1) * cellSize / 2,
        localCz: minZ + (r + r2 + 1) * cellSize / 2,
        localW,
        localD,
        localBaseY: bottomY,
        localTopY: topY,
      });
    }
  }

  if (parts.length > 0) return parts;

  return [{
    localCx: (sceneBox.min.x + sceneBox.max.x) / 2,
    localCz: (sceneBox.min.z + sceneBox.max.z) / 2,
    localW: sceneSize.x,
    localD: sceneSize.z,
    localBaseY: sceneBox.min.y,
    localTopY: sceneBox.max.y,
  }];
}

function getGLBShellTriangles(gltf, meshName = '') {
  gltf.scene.updateMatrixWorld(true);

  const sceneBox = new THREE.Box3().setFromObject(gltf.scene);
  if (sceneBox.isEmpty()) return [];

  const sceneSize = sceneBox.getSize(new THREE.Vector3());
  const maxHorizontalDim = Math.max(sceneSize.x, sceneSize.z, 1);
  const naturalMesh = NATURAL_MESH_RE.test(meshName);
  const largeStructure = maxHorizontalDim > 1000 || sceneSize.y > 800;

  const triangles = extractMeshTriangles(gltf);
  if (triangles.length === 0) return [];

  const minTriangleArea = Math.max(0.01, Math.pow(maxHorizontalDim * 0.00015, 2));
  const cellSize = Math.max(
    naturalMesh ? 70 : 35,
    Math.min(
      naturalMesh ? 280 : 160,
      maxHorizontalDim / (naturalMesh ? 24 : largeStructure ? 34 : 42),
    ),
  );
  const normalQuant = naturalMesh ? 3 : 5;
  const maxShellTriangles = naturalMesh
    ? maxHorizontalDim > 7000
      ? 700
      : 950
    : largeStructure
      ? 1500
      : 1800;

  const buckets = new Map();

  for (const tri of triangles) {
    if (tri.area < minTriangleArea) continue;

    const key = [
      Math.round(tri.centerX / cellSize),
      Math.round(tri.centerY / cellSize),
      Math.round(tri.centerZ / cellSize),
      Math.round(tri.nx * normalQuant),
      Math.round(tri.ny * normalQuant),
      Math.round(tri.nz * normalQuant),
    ].join('_');

    const prev = buckets.get(key);
    if (!prev || tri.area > prev.area) buckets.set(key, tri);
  }

  const selected = [...buckets.values()]
    .sort((a, b) => b.area - a.area)
    .slice(0, maxShellTriangles);

  if (selected.length > 0) {
    return selected.map((tri) => ({
      ax: tri.ax,
      ay: tri.ay,
      az: tri.az,
      bx: tri.bx,
      by: tri.by,
      bz: tri.bz,
      cx: tri.cx,
      cy: tri.cy,
      cz: tri.cz,
    }));
  }

  return [...triangles]
    .sort((a, b) => b.area - a.area)
    .slice(0, Math.min(maxShellTriangles, triangles.length))
    .map((tri) => ({
      ax: tri.ax,
      ay: tri.ay,
      az: tri.az,
      bx: tri.bx,
      by: tri.by,
      bz: tri.bz,
      cx: tri.cx,
      cy: tri.cy,
      cz: tri.cz,
    }));
}

function buildSurfaceShellFromTriangles(localTriangles, entityMatrix, scaleFactor, offsetX, offsetY, entityIndex) {
  if (!Array.isArray(localTriangles) || localTriangles.length === 0) return null;

  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  const worldC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const triangles = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const tri of localTriangles) {
    worldA.set(tri.ax, tri.ay, tri.az).applyMatrix4(entityMatrix);
    worldB.set(tri.bx, tri.by, tri.bz).applyMatrix4(entityMatrix);
    worldC.set(tri.cx, tri.cy, tri.cz).applyMatrix4(entityMatrix);

    const a = projectPointToGameSpace(worldA, scaleFactor, offsetX, offsetY);
    const b = projectPointToGameSpace(worldB, scaleFactor, offsetX, offsetY);
    const c = projectPointToGameSpace(worldC, scaleFactor, offsetX, offsetY);

    ab.set(b.x - a.x, b.y - a.y, b.z - a.z);
    ac.set(c.x - a.x, c.y - a.y, c.z - a.z);
    const area = 0.5 * cross.crossVectors(ab, ac).length();
    if (!Number.isFinite(area) || area < 0.0015) continue;

    triangles.push([
      round3(a.x), round3(a.y), round3(a.z),
      round3(b.x), round3(b.y), round3(b.z),
      round3(c.x), round3(c.y), round3(c.z),
    ]);

    if (a.x < minX) minX = a.x;
    if (b.x < minX) minX = b.x;
    if (c.x < minX) minX = c.x;
    if (a.x > maxX) maxX = a.x;
    if (b.x > maxX) maxX = b.x;
    if (c.x > maxX) maxX = c.x;

    if (a.y < minY) minY = a.y;
    if (b.y < minY) minY = b.y;
    if (c.y < minY) minY = c.y;
    if (a.y > maxY) maxY = a.y;
    if (b.y > maxY) maxY = b.y;
    if (c.y > maxY) maxY = c.y;

    if (a.z < minZ) minZ = a.z;
    if (b.z < minZ) minZ = b.z;
    if (c.z < minZ) minZ = c.z;
    if (a.z > maxZ) maxZ = a.z;
    if (b.z > maxZ) maxZ = b.z;
    if (c.z > maxZ) maxZ = c.z;
  }

  if (triangles.length === 0) return null;

  return {
    id: `entity_${entityIndex}_shell`,
    type: 'surface-shell',
    thickness: round3(SHELL_THICKNESS),
    triangleCount: triangles.length,
    triangleFormat: 'packed-triangle-xyz9',
    bounds: {
      x: round2(minX),
      y: round2(minY),
      w: round2(maxX - minX),
      d: round2(maxY - minY),
      baseH: round2(minZ),
      h: round2(maxZ),
      cx: round2((minX + maxX) / 2),
      cy: round2((minY + maxY) / 2),
    },
    triangles,
  };
}

async function loadGLB(filePath) {
  const data = readFileSync(filePath);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const loader = new GLTFLoader();
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  const slashIdx = normalizedPath.lastIndexOf('/');
  const resourcePath = slashIdx >= 0 ? normalizedPath.slice(0, slashIdx + 1) : '';

  return new Promise((resolve, reject) => {
    loader.parse(ab, resourcePath, resolve, reject);
  });
}

function resolveMeshFile(meshesDir, meshLookup, meshName) {
  const normalized = normalizeMeshName(meshName);
  if (!normalized) return null;

  const direct = join(meshesDir, normalized);
  if (existsSync(direct) && statSync(direct).isFile()) {
    return { meshName: normalized, meshPath: direct };
  }

  const actual = meshLookup.get(normalized.toLowerCase());
  if (!actual) return null;

  const resolved = join(meshesDir, actual);
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    return { meshName: actual, meshPath: resolved };
  }

  return null;
}

export async function generateCollisionDataForExport({
  mapDataRoot,
  packageName = '',
  region = null,
  outputFileName = 'collision.json',
  attachToMeshes = false,
  meshSidecarSuffix = '.collision.json',
} = {}) {
  if (!mapDataRoot) throw new Error('mapDataRoot is required');

  const entities = readEntitiesFromMapData(mapDataRoot).filter(
    (e) => Array.isArray(e?.matrix) && e.matrix.length === 16 && normalizeMeshName(e?.mesh),
  );

  if (entities.length === 0) {
    throw new Error('No valid entities available for collision generation');
  }

  const resolvedRegion = resolveRegion(region, entities);
  const { scaleFactor, offsetX, offsetY } = computeProjection(resolvedRegion);

  const meshesDir = join(mapDataRoot, 'meshes');
  if (!existsSync(meshesDir) || !statSync(meshesDir).isDirectory()) {
    throw new Error(`Meshes directory not found: ${meshesDir}`);
  }

  const meshLookup = buildFlatFileLookup(meshesDir);
  const meshGroups = new Map();

  for (const e of entities) {
    const meshName = normalizeMeshName(e.mesh);
    if (!meshGroups.has(meshName)) meshGroups.set(meshName, []);
    meshGroups.get(meshName).push(e);
  }

  const glbCollisionCache = new Map();
  let meshesLoaded = 0;
  let meshesFailed = 0;
  let meshSidecarsWritten = 0;
  let meshSidecarsFailed = 0;

  for (const meshName of meshGroups.keys()) {
    const resolved = resolveMeshFile(meshesDir, meshLookup, meshName);
    if (!resolved) {
      meshesFailed++;
      continue;
    }

    try {
      const gltf = await loadGLB(resolved.meshPath);
      const parts = getGLBCollisionParts(gltf, scaleFactor, resolved.meshName);
      const shellTriangles = getGLBShellTriangles(gltf, resolved.meshName);
      const exactTriangles = attachToMeshes ? toSimpleTriangles(extractMeshTriangles(gltf)) : [];
      const sidecarTriangles = exactTriangles.length > 0 ? exactTriangles : shellTriangles;

      if (attachToMeshes && (parts.length > 0 || sidecarTriangles.length > 0)) {
        try {
          const sidecar = buildLocalMeshCollisionAttachment(resolved.meshName, parts, sidecarTriangles);
          const sidecarPath = join(
            meshesDir,
            buildMeshCollisionSidecarFileName(resolved.meshName, meshSidecarSuffix),
          );
          writeJsonUtf8(sidecarPath, sidecar);
          meshSidecarsWritten++;
        } catch {
          meshSidecarsFailed++;
        }
      }

      if (parts.length > 0 || shellTriangles.length > 0) {
        glbCollisionCache.set(meshName, {
          parts,
          shellTriangles,
        });
        meshesLoaded++;
      } else {
        meshesFailed++;
      }
    } catch {
      meshesFailed++;
    }
  }

  const objects = [];
  const shells = [];
  let shellTriangles = 0;
  let skippedEntities = 0;

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const meshName = normalizeMeshName(e.mesh);
    const meshCollision = glbCollisionCache.get(meshName);
    const localParts = meshCollision?.parts || [];
    const localShellTriangles = meshCollision?.shellTriangles || [];

    if (localParts.length === 0 && localShellTriangles.length === 0) {
      skippedEntities++;
      continue;
    }

    const entityMatrix = convertEntityMatrix(e.matrix);
    const beforeCount = objects.length;
    let fallbackPart = null;
    let fallbackScore = -Infinity;

    for (let partIndex = 0; partIndex < localParts.length; partIndex++) {
      const transformedPart = buildCollisionPartFromPrism(localParts[partIndex], entityMatrix, scaleFactor, offsetX, offsetY);
      if (!transformedPart) continue;

      const { partCx, partCy, hw, hd, baseH, objH, angle } = transformedPart;
      const heightSpan = objH - baseH;

      const candidate = {
        id: `entity_${i}_part_${partIndex}`,
        type: 'building',
        partCx,
        partCy,
        hw,
        hd,
        baseH,
        objH,
        angle,
      };
      const score = hw * hd * Math.max(heightSpan, 0.1);
      if (score > fallbackScore) {
        fallbackScore = score;
        fallbackPart = candidate;
      }

      if (hw < 0.22 && hd < 0.22) continue;
      if (heightSpan < 0.08) continue;

      const cosA = Math.abs(Math.cos(angle));
      const sinA = Math.abs(Math.sin(angle));
      const aabbHalfW = hw * cosA + hd * sinA;
      const aabbHalfD = hw * sinA + hd * cosA;

      objects.push({
        id: `entity_${i}_part_${partIndex}`,
        type: 'building',
        x: round2(partCx - aabbHalfW),
        y: round2(partCy - aabbHalfD),
        w: round2(aabbHalfW * 2),
        d: round2(aabbHalfD * 2),
        h: round2(objH),
        baseH: round2(baseH),
        cx: round2(partCx),
        cy: round2(partCy),
        hw: round2(hw),
        hd: round2(hd),
        angle: round4(angle),
      });
    }

    if (objects.length === beforeCount && fallbackPart) {
      const { id, type, partCx, partCy, hw, hd, baseH, objH, angle } = fallbackPart;
      const cosA = Math.abs(Math.cos(angle));
      const sinA = Math.abs(Math.sin(angle));
      const aabbHalfW = hw * cosA + hd * sinA;
      const aabbHalfD = hw * sinA + hd * cosA;

      objects.push({
        id,
        type,
        x: round2(partCx - aabbHalfW),
        y: round2(partCy - aabbHalfD),
        w: round2(aabbHalfW * 2),
        d: round2(aabbHalfD * 2),
        h: round2(objH),
        baseH: round2(baseH),
        cx: round2(partCx),
        cy: round2(partCy),
        hw: round2(hw),
        hd: round2(hd),
        angle: round4(angle),
      });
    }

    if (localShellTriangles.length > 0) {
      const shell = buildSurfaceShellFromTriangles(
        localShellTriangles,
        entityMatrix,
        scaleFactor,
        offsetX,
        offsetY,
        i,
      );

      if (shell) {
        shells.push(shell);
        shellTriangles += shell.triangleCount;
      }
    }
  }

  const outputPath = join(mapDataRoot, outputFileName);
  writeJsonUtf8(outputPath, {
    version: 1,
    formatRevision: 2,
    generator: 'collision-generator-v3-shell',
    generatedAt: Date.now(),
    packageName,
    region: resolvedRegion,
    scaleFactor,
    offsetX,
    offsetY,
    models: {
      broadPhase: 'box-prisms',
      narrowPhase: 'surface-shell-triangles',
      shellThickness: round3(SHELL_THICKNESS),
      shellTriangleFormat: 'packed-triangle-xyz9',
      meshAttachment: attachToMeshes ? 'per-glb-sidecar-json' : 'none',
      meshSidecarSuffix: attachToMeshes ? meshSidecarSuffix : '',
    },
    objects,
    shells,
  });

  return {
    outputPath,
    entities: entities.length,
    objects: objects.length,
    shells: shells.length,
    shellTriangles,
    meshesTotal: meshGroups.size,
    meshesLoaded,
    meshesFailed,
    meshSidecarsWritten,
    meshSidecarsFailed,
    skippedEntities,
    scaleFactor,
    offsetX,
    offsetY,
  };
}
