import * as THREE from 'three';
import { TerrainSystem } from './terrain.js';
import { EntitySystem } from './entities.js';
import { MeshBVH } from '../lib/three-mesh-bvh/src/index.js';

function normalizeMeshName(raw) {
  let name = String(raw || '').trim().replace(/\\/g, '/');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  if (!name) return '';
  if (!name.toLowerCase().endsWith('.glb')) name += '.glb';
  return name;
}

function encodePathSegments(pathLike) {
  return String(pathLike || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function sourceEntityMatrixToWorldMatrix(sourceMatrix) {
  const m = sourceMatrix;
  const out = new THREE.Matrix4();
  out.set(
    m[0], m[4], -m[8], m[12],
    m[1], m[5], -m[9], m[13],
    -m[2], -m[6], m[10], -m[14],
    m[3], m[7], -m[11], m[15],
  );
  return out;
}

function worldMatrixToSourceEntityMatrix(worldMatrix) {
  const e = worldMatrix.elements;
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

function entityMatrixToWorldMatrix(matrix, matrixFormat) {
  if (matrixFormat === 'three-matrix4-column-major') {
    return new THREE.Matrix4().fromArray(matrix);
  }
  return sourceEntityMatrixToWorldMatrix(matrix);
}

function worldMatrixToEntityMatrix(worldMatrix, matrixFormat) {
  if (matrixFormat === 'three-matrix4-column-major') {
    return [...worldMatrix.elements];
  }
  return worldMatrixToSourceEntityMatrix(worldMatrix);
}

class ExportSidecarCollisionSystem {
  constructor(terrainSystem, scene) {
    this.terrainSystem = terrainSystem;
    this.scene = scene;

    this.shellGeometry = null;
    this.shellBVH = null;
    this.shellLines = null;
    this.partBoxesLines = null;

    this.objectsCount = 0;
    this.shellCount = 0;
    this.shellTriangleCount = 0;
    this.partBoxesCount = 0;
    this.sidecarsExpected = 0;
    this.sidecarsLoaded = 0;
    this.sidecarsMissing = 0;
    this.entitiesWithCollision = 0;

    this._hitTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
    this._ray = new THREE.Ray();
    this._push = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._edgeA = new THREE.Vector3();
    this._edgeB = new THREE.Vector3();

    this._triA = new THREE.Vector3();
    this._triB = new THREE.Vector3();
    this._triC = new THREE.Vector3();
    this._boxCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
  }

  dispose() {
    if (this.shellLines) {
      this.scene.remove(this.shellLines);
      this.shellLines.geometry?.dispose();
      if (this.shellLines.material && typeof this.shellLines.material.dispose === 'function') {
        this.shellLines.material.dispose();
      }
      this.shellLines = null;
    }

    if (this.shellGeometry) {
      this.shellGeometry.dispose();
      this.shellGeometry = null;
    }

    if (this.partBoxesLines) {
      this.scene.remove(this.partBoxesLines);
      this.partBoxesLines.geometry?.dispose();
      if (this.partBoxesLines.material && typeof this.partBoxesLines.material.dispose === 'function') {
        this.partBoxesLines.material.dispose();
      }
      this.partBoxesLines = null;
    }

    this.shellBVH = null;
    this.objectsCount = 0;
    this.shellCount = 0;
    this.shellTriangleCount = 0;
    this.partBoxesCount = 0;
    this.sidecarsExpected = 0;
    this.sidecarsLoaded = 0;
    this.sidecarsMissing = 0;
    this.entitiesWithCollision = 0;
  }

  async _fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  _extractTrianglesFromSidecar(sidecarJson) {
    const out = [];
    const shells = Array.isArray(sidecarJson?.shells) ? sidecarJson.shells : [];
    const rawParts = Array.isArray(sidecarJson?.parts) ? sidecarJson.parts : [];
    const partBoxes = [];
    let shellCount = 0;

    for (const shell of shells) {
      const tris = Array.isArray(shell?.triangles) ? shell.triangles : [];
      if (tris.length > 0) shellCount++;

      for (const tri of tris) {
        if (!Array.isArray(tri) || tri.length < 9) continue;
        const v0 = Number(tri[0]);
        const v1 = Number(tri[1]);
        const v2 = Number(tri[2]);
        const v3 = Number(tri[3]);
        const v4 = Number(tri[4]);
        const v5 = Number(tri[5]);
        const v6 = Number(tri[6]);
        const v7 = Number(tri[7]);
        const v8 = Number(tri[8]);
        if (![v0, v1, v2, v3, v4, v5, v6, v7, v8].every(Number.isFinite)) continue;

        out.push(v0, v1, v2, v3, v4, v5, v6, v7, v8);
      }
    }

    for (const part of rawParts) {
      const cx = Number(part?.localCx);
      const cz = Number(part?.localCz);
      const w = Number(part?.localW);
      const d = Number(part?.localD);
      const baseY = Number(part?.localBaseY);
      const topY = Number(part?.localTopY);
      if (![cx, cz, w, d, baseY, topY].every(Number.isFinite)) continue;
      if (w <= 0 || d <= 0 || topY < baseY) continue;

      partBoxes.push({
        cx,
        cz,
        w,
        d,
        baseY,
        topY,
      });
    }

    return {
      trianglesFlat: out,
      shells: shellCount,
      parts: partBoxes.length,
      partBoxes,
    };
  }

  _appendPartBoxEdges(flatOut, partBox, worldMatrix) {
    const halfW = partBox.w * 0.5;
    const halfD = partBox.d * 0.5;

    const minX = partBox.cx - halfW;
    const maxX = partBox.cx + halfW;
    const minZ = partBox.cz - halfD;
    const maxZ = partBox.cz + halfD;
    const minY = partBox.baseY;
    const maxY = partBox.topY;

    const c = this._boxCorners;
    c[0].set(minX, minY, minZ).applyMatrix4(worldMatrix);
    c[1].set(maxX, minY, minZ).applyMatrix4(worldMatrix);
    c[2].set(maxX, minY, maxZ).applyMatrix4(worldMatrix);
    c[3].set(minX, minY, maxZ).applyMatrix4(worldMatrix);
    c[4].set(minX, maxY, minZ).applyMatrix4(worldMatrix);
    c[5].set(maxX, maxY, minZ).applyMatrix4(worldMatrix);
    c[6].set(maxX, maxY, maxZ).applyMatrix4(worldMatrix);
    c[7].set(minX, maxY, maxZ).applyMatrix4(worldMatrix);

    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    for (const [a, b] of edges) {
      flatOut.push(
        c[a].x, c[a].y, c[a].z,
        c[b].x, c[b].y, c[b].z,
      );
    }
  }

  async loadFromExportData(dataPath, entitySystem, onProgress = null) {
    this.dispose();

    const entities = Array.isArray(entitySystem?.allEntities) ? entitySystem.allEntities : [];
    const matrixFormat = entitySystem?.matrixFormat || 'source-lh-row-major';
    if (entities.length === 0) return;

    const entityByMesh = new Map();
    for (const entity of entities) {
      if (!Array.isArray(entity?.matrix) || entity.matrix.length !== 16) continue;
      const meshName = normalizeMeshName(entity?.mesh);
      if (!meshName) continue;
      const key = meshName.toLowerCase();
      if (!entityByMesh.has(key)) entityByMesh.set(key, []);
      entityByMesh.get(key).push(entity);
    }

    const meshKeys = [...entityByMesh.keys()];
    this.sidecarsExpected = meshKeys.length;
    if (this.sidecarsExpected === 0) return;

    let sidecarIndex = null;
    try {
      sidecarIndex = await this._fetchJson(`${dataPath}/mesh-collision-index.json`);
    } catch {
      sidecarIndex = null;
    }

    const sidecarPathByMeshKey = new Map();
    if (Array.isArray(sidecarIndex?.entries)) {
      for (const entry of sidecarIndex.entries) {
        const meshName = normalizeMeshName(entry?.mesh);
        const sidecarRel = String(entry?.sidecar || '').trim();
        if (!meshName || !sidecarRel) continue;
        sidecarPathByMeshKey.set(meshName.toLowerCase(), sidecarRel);
      }
    }

    const sidecarDataByMeshKey = new Map();
    let meshLoadDone = 0;

    for (const meshKey of meshKeys) {
      meshLoadDone++;
      onProgress?.(`Loading sidecars ${meshLoadDone}/${this.sidecarsExpected}`, meshLoadDone / this.sidecarsExpected);

      const entitiesForMesh = entityByMesh.get(meshKey);
      if (!entitiesForMesh || entitiesForMesh.length === 0) continue;

      const meshName = normalizeMeshName(entitiesForMesh[0].mesh);
      const fromIndex = sidecarPathByMeshKey.get(meshKey);
      const sidecarRel = fromIndex || `meshes/${meshName}.collision.json`;
      const sidecarUrl = `${dataPath}/${encodePathSegments(sidecarRel)}`;

      try {
        const sidecarJson = await this._fetchJson(sidecarUrl);
        const parsed = this._extractTrianglesFromSidecar(sidecarJson);
        this.objectsCount += parsed.parts;
        this.shellCount += parsed.shells;
        this.sidecarsLoaded++;

        if (parsed.trianglesFlat.length > 0 || parsed.partBoxes.length > 0) {
          sidecarDataByMeshKey.set(meshKey, parsed);
        }
      } catch {
        this.sidecarsMissing++;
      }
    }

    const worldFlat = [];
    const partBoxLineFlat = [];
    let entityDone = 0;
    const entityTotal = entities.length;

    for (const entity of entities) {
      entityDone++;
      if (entityDone % 120 === 0) {
        onProgress?.(
          `Applying entity transforms ${entityDone}/${entityTotal}`,
          entityDone / Math.max(1, entityTotal),
        );
      }

      if (!Array.isArray(entity?.matrix) || entity.matrix.length !== 16) continue;

      const meshName = normalizeMeshName(entity?.mesh);
      const meshKey = meshName.toLowerCase();
      const sidecarData = sidecarDataByMeshKey.get(meshKey);
      if (!sidecarData) continue;

      const localTriangles = sidecarData.trianglesFlat;
      const localPartBoxes = sidecarData.partBoxes;

      const worldMatrix = entityMatrixToWorldMatrix(entity.matrix, matrixFormat);

      if (localTriangles.length > 0) {
        for (let i = 0; i < localTriangles.length; i += 9) {
          this._triA.set(localTriangles[i], localTriangles[i + 1], localTriangles[i + 2]).applyMatrix4(worldMatrix);
          this._triB.set(localTriangles[i + 3], localTriangles[i + 4], localTriangles[i + 5]).applyMatrix4(worldMatrix);
          this._triC.set(localTriangles[i + 6], localTriangles[i + 7], localTriangles[i + 8]).applyMatrix4(worldMatrix);

          worldFlat.push(
            this._triA.x, this._triA.y, this._triA.z,
            this._triB.x, this._triB.y, this._triB.z,
            this._triC.x, this._triC.y, this._triC.z,
          );
        }
      }

      if (localPartBoxes.length > 0) {
        for (const partBox of localPartBoxes) {
          this._appendPartBoxEdges(partBoxLineFlat, partBox, worldMatrix);
          this.partBoxesCount++;
        }
      }

      this.entitiesWithCollision++;
    }

    this.shellTriangleCount = Math.floor(worldFlat.length / 9);

    if (worldFlat.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(worldFlat, 3));
      geometry.computeBoundingBox();

      this.shellGeometry = geometry;
      this.shellBVH = new MeshBVH(geometry, { maxLeafSize: 24 });

      const edges = new THREE.EdgesGeometry(geometry, 20);
      const lines = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: 0x3fd56d,
          transparent: true,
          opacity: 0.65,
          depthTest: true,
        }),
      );
      lines.visible = false;
      lines.renderOrder = 2;

      this.shellLines = lines;
      this.scene.add(lines);
    }

    if (partBoxLineFlat.length > 0) {
      const boxGeometry = new THREE.BufferGeometry();
      boxGeometry.setAttribute('position', new THREE.Float32BufferAttribute(partBoxLineFlat, 3));

      const boxLines = new THREE.LineSegments(
        boxGeometry,
        new THREE.LineBasicMaterial({
          color: 0xff8c3a,
          transparent: true,
          opacity: 0.92,
          depthTest: true,
        }),
      );
      boxLines.visible = false;
      boxLines.renderOrder = 4;

      this.partBoxesLines = boxLines;
      this.scene.add(boxLines);
    }
  }

  setDebugVisible(visible) {
    if (this.shellLines) this.shellLines.visible = !!visible;
  }

  setPartBoxesVisible(visible) {
    if (this.partBoxesLines) this.partBoxesLines.visible = !!visible;
  }

  clipCameraPosition(target, desired, minDistance = 60) {
    if (!this.shellBVH) return desired;

    this._push.subVectors(desired, target);
    const dist = this._push.length();
    if (dist < 1e-6) return desired;

    this._push.multiplyScalar(1 / dist);
    this._ray.origin.copy(target);
    this._ray.direction.copy(this._push);

    const hit = this.shellBVH.raycastFirst(this._ray, THREE.DoubleSide, 0, dist);
    if (!hit || !Number.isFinite(hit.distance)) return desired;
    const safeDist = Math.max(minDistance, hit.distance - 14);
    if (safeDist >= dist) return desired;
    return new THREE.Vector3().copy(target).addScaledVector(this._push, safeDist);
  }

  _getFaceNormal(faceIndex, out) {
    const pos = this.shellGeometry?.getAttribute('position');
    if (!pos || !Number.isInteger(faceIndex) || faceIndex < 0) return null;

    const i0 = faceIndex * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    if (i2 >= pos.count) return null;

    this._triA.fromBufferAttribute(pos, i0);
    this._triB.fromBufferAttribute(pos, i1);
    this._triC.fromBufferAttribute(pos, i2);

    this._edgeA.subVectors(this._triB, this._triA);
    this._edgeB.subVectors(this._triC, this._triA);
    out.crossVectors(this._edgeA, this._edgeB);

    const lenSq = out.lengthSq();
    if (lenSq < 1e-10) return null;
    out.multiplyScalar(1 / Math.sqrt(lenSq));
    return out;
  }

  resolveSphereCollision(center, radius, velocity) {
    if (!this.shellBVH) return { onGround: false, hitDistance: Infinity };

    let onGround = false;
    let hitDistance = Infinity;

    for (let i = 0; i < 5; i++) {
      this._hitTarget.point.set(0, 0, 0);
      this._hitTarget.distance = Infinity;
      this._hitTarget.faceIndex = -1;

      const hit = this.shellBVH.closestPointToPoint(center, this._hitTarget, 0, radius + 220);
      if (!hit) break;

      hitDistance = Math.min(hitDistance, hit.distance);
      if (hit.distance >= radius) break;

      this._push.subVectors(center, hit.point);
      let len = this._push.length();
      const normal = this._getFaceNormal(hit.faceIndex, this._normal);
      const isHorizontalSurface = !!normal && Math.abs(normal.y) >= 0.58;
      const verticalRatio = len > 1e-6 ? (this._push.y / len) : 0;
      const isFloorContact = isHorizontalSurface && verticalRatio > 0.2;
      const isCeilingContact = isHorizontalSurface && verticalRatio < -0.2;

      if (!isFloorContact) {
        this._push.y = 0;
        len = this._push.length();

        if (len < 1e-6 && normal) {
          this._push.set(normal.x, 0, normal.z);
          len = this._push.length();
        }
        if (len < 1e-6) {
          this._push.set(center.x - hit.point.x, 0, center.z - hit.point.z);
          len = this._push.length();
        }

        if (isCeilingContact && velocity.y > 0) velocity.y = 0;
      }

      if (len < 1e-6) {
        if (!isFloorContact) continue;
        this._push.set(0, 1, 0);
        len = 1;
      }

      const penetration = radius - hit.distance + 0.6;
      this._push.multiplyScalar(penetration / len);
      center.add(this._push);

      if (isFloorContact && this._push.y > 0) {
        onGround = true;
        if (velocity.y < 0) velocity.y = 0;
      }
    }

    return { onGround, hitDistance };
  }

  _sampleShellGroundY(center) {
    if (!this.shellBVH) return null;

    const maxRise = 72;
    const maxDrop = 12000;

    this._ray.origin.set(center.x, center.y + maxRise, center.z);
    this._ray.direction.set(0, -1, 0);

    let hit = this.shellBVH.raycastFirst(this._ray, THREE.DoubleSide, 0, maxDrop + maxRise);
    if (hit && hit.point && Number.isFinite(hit.point.y)) {
      return hit.point.y;
    }

    // Recovery ray when the player body is already below expected support.
    this._ray.origin.set(center.x, center.y + 2600, center.z);
    hit = this.shellBVH.raycastFirst(this._ray, THREE.DoubleSide, 0, 16000);
    if (!hit || !hit.point || !Number.isFinite(hit.point.y)) return null;
    if (hit.point.y > center.y + maxRise) return null;
    return hit.point.y;
  }

  getSupportGroundY(center) {
    const shellY = this._sampleShellGroundY(center);
    const terrainY = this.terrainSystem ? this.terrainSystem.getHeightAt(center.x, center.z) : null;

    if (shellY === null && terrainY === null) return null;
    if (shellY === null) return terrainY;
    if (terrainY === null) return shellY;
    return Math.max(shellY, terrainY);
  }
}

class ExportWalkController {
  constructor(camera, canvas, collision, scene) {
    this.camera = camera;
    this.canvas = canvas;
    this.collision = collision;
    this.scene = scene;

    this.position = new THREE.Vector3(0, 360, 0);
    this.bodyCenter = new THREE.Vector3(0, 220, 0);
    this.velocity = new THREE.Vector3();

    this.modelRadius = 120;
    this.modelEyeHeight = 240;
    this.modelScale = 0.5;

    // Match collision to the rendered avatar body width.
    this.radius = this.modelRadius * 0.95 * this.modelScale;
    this.eyeHeight = this.modelEyeHeight * this.modelScale;
    this.bodyOffset = this.eyeHeight - this.radius;

    this.baseSpeed = 2200;
    this.speedLevel = 6;
    this.runMultiplier = 1.8;
    this.jumpSpeed = 1400;
    this.gravity = 3800;

    this.cameraDistanceMin = 220;
    this.cameraDistanceMax = 1800;
    this.cameraDistance = this.cameraDistanceMax;
    this.minCameraDistance = 260;
    this.cameraHeight = 120;

    this.gravityEnabled = true;
    this.isOnGround = false;

    this.yaw = 0;
    this.pitch = 0.18;
    this.minPitch = -0.55;
    this.maxPitch = 0.6;
    this.mouseSensitivity = 0.002;
    this.cameraDragActive = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.avatarYaw = 0;

    this.keys = {};
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._cameraTarget = new THREE.Vector3();
    this._cameraDesired = new THREE.Vector3();
    this._cameraBack = new THREE.Vector3();

    this.avatar = null;
    this.avatarBody = null;
    this.avatarHead = null;

    this._setupInput();
    this._createAvatar();
    this._syncCamera();
  }

  get currentSpeed() {
    return this.baseSpeed * Math.pow(1.32, this.speedLevel - 6);
  }

  get speedPresetLabel() {
    if (this.speedLevel <= 4) return 'Slow';
    if (this.speedLevel >= 9) return 'Fast';
    return 'Normal';
  }

  _setupInput() {
    document.addEventListener('keydown', (event) => {
      this.keys[event.code] = true;
      if (event.code === 'KeyG') this.gravityEnabled = !this.gravityEnabled;
      if (event.code === 'Digit1') this.speedLevel = 4;
      if (event.code === 'Digit2') this.speedLevel = 6;
      if (event.code === 'Digit3') this.speedLevel = 9;
      if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    });

    document.addEventListener('keyup', (event) => {
      this.keys[event.code] = false;
    });

    this.canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      this.cameraDragActive = true;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
      event.preventDefault();
    });

    document.addEventListener('mouseup', (event) => {
      if (event.button === 0) this.cameraDragActive = false;
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.cameraDragActive = false;
    });

    document.addEventListener('mousemove', (event) => {
      if (!this.cameraDragActive) return;

      const dx = event.clientX - this.lastMouseX;
      const dy = event.clientY - this.lastMouseY;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;

      this.yaw -= dx * this.mouseSensitivity;
      this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch + dy * this.mouseSensitivity));
    });

    document.addEventListener('wheel', (event) => {
      this.cameraDistance += event.deltaY * 0.45;
      this.cameraDistance = Math.max(this.cameraDistanceMin, Math.min(this.cameraDistanceMax, this.cameraDistance));
    }, { passive: true });
  }

  _createAvatar() {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffbf73,
      roughness: 0.62,
      metalness: 0.04,
      emissive: 0x2b1700,
    });

    const bodyHeight = Math.max(this.modelEyeHeight * 0.74, this.modelRadius * 2.3);
    const headRadius = this.modelRadius * 0.65;

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(this.modelRadius * 0.82, this.modelRadius * 0.95, bodyHeight, 18),
      bodyMat,
    );
    body.position.y = bodyHeight * 0.5;

    const head = new THREE.Mesh(new THREE.SphereGeometry(headRadius, 16, 14), bodyMat);
    head.position.y = bodyHeight + headRadius * 1.06;

    const group = new THREE.Group();
    group.add(body, head);
    group.scale.setScalar(this.modelScale);
    this.scene.add(group);

    this.avatar = group;
    this.avatarBody = body;
    this.avatarHead = head;
  }

  dispose() {
    if (this.avatar) {
      this.avatar.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
      if (this.avatar.parent) this.avatar.parent.remove(this.avatar);
      this.avatar = null;
      this.avatarBody = null;
      this.avatarHead = null;
    }
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
    this.bodyCenter.set(x, y - this.bodyOffset, z);
    this.velocity.set(0, 0, 0);
    this._syncCamera();
  }

  _syncAvatar() {
    if (!this.avatar) return;
    this.avatar.position.set(
      this.bodyCenter.x,
      this.bodyCenter.y - this.radius,
      this.bodyCenter.z,
    );
    this.avatar.rotation.set(0, this.avatarYaw, 0);
  }

  _syncCamera() {
    this.position.set(this.bodyCenter.x, this.bodyCenter.y + this.bodyOffset, this.bodyCenter.z);
    this._cameraTarget.set(this.bodyCenter.x, this.bodyCenter.y + this.eyeHeight * 0.76, this.bodyCenter.z);

    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    this._cameraBack.set(
      Math.sin(this.yaw) * cosPitch,
      sinPitch,
      Math.cos(this.yaw) * cosPitch,
    ).normalize();

    this._cameraDesired.copy(this._cameraTarget)
      .addScaledVector(this._cameraBack, this.cameraDistance)
      .addScaledVector(new THREE.Vector3(0, 1, 0), this.cameraHeight);

    const clipped = this.collision.clipCameraPosition(this._cameraTarget, this._cameraDesired, this.minCameraDistance);
    this.camera.position.copy(clipped);
    this.camera.lookAt(this._cameraTarget);
    this._syncAvatar();
  }

  update(delta) {
    const dt = Math.min(0.05, delta);
    const speed = (this.keys.ShiftLeft || this.keys.ShiftRight)
      ? this.currentSpeed * this.runMultiplier
      : this.currentSpeed;

    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.crossVectors(this._forward, new THREE.Vector3(0, 1, 0)).normalize();

    this._move.set(0, 0, 0);
    if (this.keys.KeyW || this.keys.ArrowUp) this._move.add(this._forward);
    if (this.keys.KeyS || this.keys.ArrowDown) this._move.sub(this._forward);
    if (this.keys.KeyD || this.keys.ArrowRight) this._move.add(this._right);
    if (this.keys.KeyA || this.keys.ArrowLeft) this._move.sub(this._right);

    if (this._move.lengthSq() > 1e-8) this._move.normalize();

    if (this._move.lengthSq() > 1e-8) {
      this.avatarYaw = Math.atan2(this._move.x, this._move.z);
    }

    if (this.gravityEnabled) {
      const horizontalDistance = speed * dt;
      const stepLength = Math.max(50, this.radius * 0.35);
      const steps = this._move.lengthSq() > 1e-8
        ? Math.max(1, Math.min(14, Math.ceil(horizontalDistance / stepLength)))
        : 1;

      const stepDistance = horizontalDistance / steps;
      for (let i = 0; i < steps; i++) {
        this.bodyCenter.addScaledVector(this._move, stepDistance);
        this.collision.resolveSphereCollision(this.bodyCenter, this.radius, this.velocity);
      }

      if (this.keys.Space) {
        this.velocity.y = this.jumpSpeed;
        this.isOnGround = false;
      }

      this.velocity.y -= this.gravity * dt;
      this.bodyCenter.y += this.velocity.y * dt;

      const collisionResult = this.collision.resolveSphereCollision(this.bodyCenter, this.radius, this.velocity);
      this.isOnGround = collisionResult.onGround;

      const supportY = this.collision.getSupportGroundY(this.bodyCenter);
      if (supportY !== null) {
        const desiredBodyY = supportY + this.radius + 2;
        const stepUpLimit = 56;
        if (
          desiredBodyY <= this.bodyCenter.y + stepUpLimit
          && this.bodyCenter.y <= desiredBodyY + 10
          && this.velocity.y <= 0
        ) {
          this.bodyCenter.y = desiredBodyY;
          this.velocity.y = 0;
          this.isOnGround = true;
        }
      }

      const floorY = supportY !== null ? supportY : 0;
      if (this.bodyCenter.y < floorY - 3500) {
        this.bodyCenter.y = floorY + this.radius + 120;
        this.velocity.set(0, 0, 0);
      }
    } else {
      // Free fly mode for debugging
      if (this._move.lengthSq() > 1e-8) {
        this.bodyCenter.addScaledVector(this._move, speed * dt);
      }

      if (this.keys.Space) this.bodyCenter.y += speed * dt;
      if (this.keys.ControlLeft || this.keys.ControlRight) this.bodyCenter.y -= speed * dt;
      this.velocity.set(0, 0, 0);
      this.isOnGround = false;
    }

    this._syncCamera();
  }
}

class ExportReaderApp {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.packageSelect = document.getElementById('package-select');
    this.statusEl = document.getElementById('status');
    this.infoEl = document.getElementById('info');
    this.showCollisionToggle = document.getElementById('show-collision');
    this.showColliderBoxToggle = document.getElementById('show-collider-box');

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
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 20, 500000);

    this.currentPackage = null;
    this.currentManifest = null;
    this.transformConventions = null;
    this.visualSettings = null;

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.walkController = null;

    // Increase world size so character is relatively smaller.
    this.mapWorldScale = 1.5;

    this.sky = null;
    this.sunLight = null;
    this._envNodes = [];

    this.clock = new THREE.Clock();
    this.fpsTime = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.lodUpdateAccum = 0;

    this._animStarted = false;

    window.addEventListener('resize', () => this.onResize());
  }

  async init() {
    document.getElementById('refresh-packages').addEventListener('click', () => this.refreshPackages());
    document.getElementById('load-package').addEventListener('click', () => this.loadSelectedPackage());
    document.getElementById('open-resources').addEventListener('click', () => this.openResources());
    this.showCollisionToggle?.addEventListener('change', () => {
      if (this.collisionSystem) this.collisionSystem.setDebugVisible(this.showCollisionToggle.checked);
    });
    this.showColliderBoxToggle?.addEventListener('change', () => {
      if (this.collisionSystem) this.collisionSystem.setPartBoxesVisible(this.showColliderBoxToggle.checked);
    });

    await this.refreshPackages();

    const query = new URLSearchParams(window.location.search);
    const pkg = query.get('pkg');
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

  async fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed ${path} (${res.status})`);
    return await res.json();
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

  async refreshPackages() {
    this.setStatus('Reading Desktop exports...');
    const previous = this.packageSelect.value;
    this.packageSelect.innerHTML = '';

    try {
      const data = await this.fetchJson('/api/full-exports');
      const list = Array.isArray(data?.exports) ? data.exports : [];

      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No Desktop exports found';
        this.packageSelect.appendChild(opt);
        this.setStatus('No exports found');
        return;
      }

      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.packageName;
        const entities = item.stats?.entities ?? '?';
        const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'unknown time';
        opt.textContent = `${item.packageName} | ${entities} entities | ${created}`;
        this.packageSelect.appendChild(opt);
      }

      if (previous && list.some((x) => x.packageName === previous)) {
        this.packageSelect.value = previous;
      }

      this.setStatus(`Found ${list.length} exports`);
    } catch (err) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Failed to read exports';
      this.packageSelect.appendChild(opt);
      this.setStatus(`Export list failed: ${err.message || err}`);
    }
  }

  async loadSelectedPackage() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    await this.loadPackage(pkg);
  }

  openResources() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const url = `/mesh-inspector.html?pkg=${encodeURIComponent(pkg)}`;
    window.location.href = url;
  }

  _disposeObjectTree(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    if (obj.parent) obj.parent.remove(obj);
  }

  _cleanupCurrentMap() {
    if (this.terrainSystem?.terrainGroup) this._disposeObjectTree(this.terrainSystem.terrainGroup);
    if (this.entitySystem?.entityGroup) this._disposeObjectTree(this.entitySystem.entityGroup);

    if (this.collisionSystem) this.collisionSystem.dispose();
    if (this.walkController) this.walkController.dispose();

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.walkController = null;
    this.transformConventions = null;
    this.visualSettings = null;

    this._clearEnvironment();
  }

  _clearEnvironment() {
    for (const node of this._envNodes) {
      if (node.parent) node.parent.remove(node);
    }
    this._envNodes = [];
    this.sky = null;
    this.sunLight = null;
  }

  _setupEnvironment(environment, visualSettings = null) {
    this._clearEnvironment();

    const readColor = (value, fallbackHex) => {
      try {
        if (Array.isArray(value) && value.length >= 3) {
          const r = Number(value[0]);
          const g = Number(value[1]);
          const b = Number(value[2]);
          if ([r, g, b].every(Number.isFinite)) return new THREE.Color(r, g, b);
        }
        if (typeof value === 'string' || typeof value === 'number') {
          return new THREE.Color(value);
        }
      } catch {
        // fallthrough
      }
      return new THREE.Color(fallbackHex);
    };

    const skyCfg = visualSettings?.sky || {};
    const fogCfg = visualSettings?.fog || {};
    const lightCfg = visualSettings?.lighting || {};
    const dirCfg = lightCfg.directional || {};
    const dirShadow = dirCfg.shadow || {};
    const ambCfg = lightCfg.ambient || {};
    const hemiCfg = lightCfg.hemisphere || {};
    const fallbackCfg = lightCfg.fallbackWhenNoEnvironment || {};
    const skyMult = Array.isArray(hemiCfg.skyColorMultiplier) && hemiCfg.skyColorMultiplier.length >= 3
      ? hemiCfg.skyColorMultiplier
      : [0.8, 0.9, 1.2];

    const skyGeo = new THREE.SphereGeometry(Number(skyCfg.radius) || 200000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: readColor(skyCfg.topColor, '#4488cc') },
        bottomColor: { value: readColor(skyCfg.bottomColor, '#d4c5a0') },
        horizonColor: { value: readColor(skyCfg.horizonColor, '#c8b888') },
        exponent: { value: Number(skyCfg.exponent) || 0.5 },
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

    this.scene.fog = new THREE.FogExp2(
      readColor(fogCfg.color, '#c8b888'),
      Number(fogCfg.density) || 0.0000035,
    );

    if (environment?.sunlight) {
      const s = environment.sunlight;
      const dir = new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]).normalize();
      const col = readColor(s.diffuse, '#ffffff');

      const sun = new THREE.DirectionalLight(col, Number(dirCfg.intensity) || 3.0);
      sun.position.copy(dir.clone().multiplyScalar(100000));
      sun.castShadow = dirCfg.castShadow !== false;
      const mapSize = Array.isArray(dirShadow.mapSize) ? dirShadow.mapSize : [2048, 2048];
      sun.shadow.mapSize.width = Number(mapSize[0]) || 2048;
      sun.shadow.mapSize.height = Number(mapSize[1]) || 2048;
      sun.shadow.camera.near = Number(dirShadow.near) || 100;
      sun.shadow.camera.far = Number(dirShadow.far) || 200000;
      sun.shadow.camera.left = Number(dirShadow.left) || -50000;
      sun.shadow.camera.right = Number(dirShadow.right) || 50000;
      sun.shadow.camera.top = Number(dirShadow.top) || 50000;
      sun.shadow.camera.bottom = Number(dirShadow.bottom) || -50000;
      sun.shadow.bias = Number(dirShadow.bias ?? -0.001);
      sun.shadow.normalBias = Number(dirShadow.normalBias ?? 200);
      this.scene.add(sun);
      this._envNodes.push(sun, sun.target);
      this.sunLight = sun;

      const ambCol = s.ambientColor
        ? readColor(s.ambientColor, '#666655')
        : readColor(ambCfg.fallbackColor, '#666655');
      const amb = new THREE.AmbientLight(ambCol, Number(ambCfg.intensity) || 0.8);
      this.scene.add(amb);
      this._envNodes.push(amb);

      const skyCol = s.skyLightColor
        ? new THREE.Color(
          Number(s.skyLightColor[0]) * Number(skyMult[0]),
          Number(s.skyLightColor[1]) * Number(skyMult[1]),
          Number(s.skyLightColor[2]) * Number(skyMult[2]),
        )
        : readColor(hemiCfg.fallbackSkyColor, '#88aacc');
      const hemi = new THREE.HemisphereLight(
        skyCol,
        readColor(hemiCfg.groundColor, '#8b7355'),
        Number(hemiCfg.intensity) || 1.0,
      );
      this.scene.add(hemi);
      this._envNodes.push(hemi);
    } else {
      const amb = new THREE.AmbientLight(
        readColor(fallbackCfg.ambientColor, '#888888'),
        Number(fallbackCfg.ambientIntensity) || 0.6,
      );
      const hemi = new THREE.HemisphereLight(
        readColor(fallbackCfg.hemisphereSkyColor, '#87ceeb'),
        readColor(fallbackCfg.hemisphereGroundColor, '#8b7355'),
        Number(fallbackCfg.hemisphereIntensity) || 0.4,
      );
      this.scene.add(amb);
      this.scene.add(hemi);
      this._envNodes.push(amb, hemi);
    }
  }

  _buildScaledConfig(config, scale) {
    if (!config || !config.landscape || !Number.isFinite(scale) || Math.abs(scale - 1) < 1e-9) {
      return config;
    }

    const scaled = JSON.parse(JSON.stringify(config));
    const l = scaled.landscape;

    if (Number.isFinite(l.worldOriginX)) l.worldOriginX *= scale;
    if (Number.isFinite(l.worldOriginY)) l.worldOriginY *= scale;
    if (Number.isFinite(l.unitScaleX)) l.unitScaleX *= scale;
    if (Number.isFinite(l.unitScaleY)) l.unitScaleY *= scale;
    if (Number.isFinite(l.heightMin)) l.heightMin *= scale;
    if (Number.isFinite(l.heightMax)) l.heightMax *= scale;

    return scaled;
  }

  _applyMapScaleToEntities(scale) {
    if (!this.entitySystem || !Number.isFinite(scale) || Math.abs(scale - 1) < 1e-9) return;

    const scaleMatrix = new THREE.Matrix4().makeScale(scale, scale, scale);
    const tmpMatrix = new THREE.Matrix4();
    const matrixFormat = this.entitySystem.matrixFormat || 'source-lh-row-major';

    for (const group of this.entitySystem.instancedMeshes || []) {
      const subMeshes = group.subMeshes || (group.mesh ? [group.mesh] : []);
      for (const instMesh of subMeshes) {
        if (!instMesh) continue;
        for (let i = 0; i < instMesh.count; i++) {
          instMesh.getMatrixAt(i, tmpMatrix);
          tmpMatrix.premultiply(scaleMatrix);
          instMesh.setMatrixAt(i, tmpMatrix);
        }
        instMesh.instanceMatrix.needsUpdate = true;
        if (typeof instMesh.computeBoundingSphere === 'function') instMesh.computeBoundingSphere();
      }

      if (group.center?.isVector3) group.center.multiplyScalar(scale);
      if (Number.isFinite(group.radius)) group.radius *= scale;
    }

    for (const entity of this.entitySystem.allEntities || []) {
      if (entity.worldPos && Number.isFinite(entity.worldPos.x) && Number.isFinite(entity.worldPos.y) && Number.isFinite(entity.worldPos.z)) {
        entity.worldPos.x *= scale;
        entity.worldPos.y *= scale;
        entity.worldPos.z *= scale;
      }

      if (Array.isArray(entity.matrix) && entity.matrix.length === 16) {
        const wm = entityMatrixToWorldMatrix(entity.matrix, matrixFormat);
        wm.premultiply(scaleMatrix);
        entity.matrix = worldMatrixToEntityMatrix(wm, matrixFormat);
      }
    }

    this.entitySystem.drawDistance *= scale;

    // Entity load uses unscaled region bounds, but post-scale LOD culling must use scaled bounds.
    if (this.entitySystem.regionFilter) {
      const r = this.entitySystem.regionFilter;
      const scaled = { ...r };
      if (Number.isFinite(r.minX)) scaled.minX = r.minX * scale;
      if (Number.isFinite(r.maxX)) scaled.maxX = r.maxX * scale;
      if (Number.isFinite(r.minZ)) scaled.minZ = r.minZ * scale;
      if (Number.isFinite(r.maxZ)) scaled.maxZ = r.maxZ * scale;
      if (Array.isArray(r.polygon)) {
        scaled.polygon = r.polygon.map((p) => ({
          x: Number.isFinite(p?.x) ? p.x * scale : p?.x,
          z: Number.isFinite(p?.z) ? p.z * scale : p?.z,
        }));
      }
      this.entitySystem.regionFilter = scaled;
    }
  }

  _getStartPosition(config) {
    if (this.entitySystem && this.entitySystem.allEntities.length > 0) {
      const ents = this.entitySystem.allEntities;
      const xs = ents.map((e) => e.worldPos.x).sort((a, b) => a - b);
      const zs = ents.map((e) => e.worldPos.z).sort((a, b) => a - b);
      const mid = Math.floor(ents.length / 2);
      const x = xs[mid];
      const z = zs[mid];
      let y = 5000;
      if (this.collisionSystem) {
        const gy = this.collisionSystem.getSupportGroundY(new THREE.Vector3(x, y, z));
        if (gy !== null) y = gy + 600;
      }
      return { x, y, z };
    }

    const l = config.landscape;
    const x = l.worldOriginX + (l.regionGridX * l.regionSize * l.unitScaleX) / 2;
    const z = -(l.worldOriginY + (l.regionGridY * l.regionSize * l.unitScaleY) / 2);
    let y = 5000;
    if (this.collisionSystem) {
      const gy = this.collisionSystem.getSupportGroundY(new THREE.Vector3(x, y, z));
      if (gy !== null) y = gy + 600;
    }
    return { x, y, z };
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

      const manifest = await this.fetchJson(`${packageBase}/manifest.json`);
      const transformConventions = await this.fetchJson(`${dataPath}/transform-conventions.json`);
      const visualSettings = await this.fetchJson(`${dataPath}/visual-settings.json`);

      const matrixFormat = transformConventions?.entities?.normalizedRhMatrixFormat;
      if (matrixFormat !== 'three-matrix4-column-major') {
        throw new Error(`Unsupported normalized RH matrix format: ${matrixFormat || 'missing'}`);
      }
      if (transformConventions?.entities?.normalizedRhRequiresImporterZFlip === true) {
        throw new Error('Export contract requires no importer-side Z flip, but package flags true');
      }

      const rhIndexRelRaw = String(
        transformConventions?.entities?.normalizedRhIndexFile
        || manifest?.coordinateContract?.entityRhIndexFile
        || 'map-data/entity-index-rh.json',
      );
      const rhIndexRel = rhIndexRelRaw.replace(/^map-data\//, '').replace(/^\/+/, '');
      if (!rhIndexRel) {
        throw new Error('Missing RH entity index file in package contract');
      }
      await this.fetchJson(`${dataPath}/${encodePathSegments(rhIndexRel)}`);

      const configSrc = await this.fetchJson(`${dataPath}/map-config.json`);
      const config = this._buildScaledConfig(configSrc, this.mapWorldScale);
      const environment = await this.tryFetchJson(`${dataPath}/environment.json`);
      this.currentManifest = manifest;
      this.transformConventions = transformConventions;
      this.visualSettings = visualSettings;

      this._setupEnvironment(environment, visualSettings);

      this.setLoading('Loading terrain...', 15);
      this.terrainSystem = new TerrainSystem(this.scene, config, dataPath);
      await this.terrainSystem.load((p) => {
        this.setLoading(`Loading terrain: ${Math.round(p * 100)}%`, 15 + p * 45);
      });

      this.setLoading('Loading entities...', 62);
      this.entitySystem = new EntitySystem(this.scene, dataPath, {
        entityIndexFile: rhIndexRel,
        matrixFormat,
      });
      if (manifest?.region) this.entitySystem.regionFilter = manifest.region;

      await this.entitySystem.load((p) => {
        this.setLoading(`Loading entities: ${Math.round(p * 100)}%`, 62 + p * 30);
      });

      this._applyMapScaleToEntities(this.mapWorldScale);

      this.setLoading('Loading sidecar collision...', 93);
      this.collisionSystem = new ExportSidecarCollisionSystem(this.terrainSystem, this.scene);
      await this.collisionSystem.loadFromExportData(dataPath, this.entitySystem, (text, progress) => {
        this.setLoading(text, 93 + progress * 6);
      });
      this.collisionSystem.setDebugVisible(this.showCollisionToggle?.checked);
      this.collisionSystem.setPartBoxesVisible(this.showColliderBoxToggle?.checked);

      this.walkController = new ExportWalkController(this.camera, this.canvas, this.collisionSystem, this.scene);
      const start = this._getStartPosition(config);
      this.walkController.setPosition(start.x, start.y, start.z);

      this.entitySystem.updateLOD(this.camera.position);

      this.hideLoading();
      this.setStatus(
        `Loaded ${pkgName} | sidecars ${this.collisionSystem.sidecarsLoaded}/${this.collisionSystem.sidecarsExpected}`
        + `, missing ${this.collisionSystem.sidecarsMissing}, triangles ${this.collisionSystem.shellTriangleCount}`
        + `, mapScale x${this.mapWorldScale.toFixed(2)}`,
      );
    } catch (err) {
      console.error(err);
      this.hideLoading();
      this.setStatus(`Load failed: ${err.message || err}`);
    }
  }

  updateUI() {
    const pos = this.camera.position;

    const rows = [
      `Package: ${this.currentPackage || '-'}`,
      `Camera: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`,
      `FPS: ${this.fps}`,
    ];

    if (this.entitySystem) {
      rows.push(`Entities visible: ${this.entitySystem.visibleCount} / ${this.entitySystem.loadedCount}`);
    } else {
      rows.push('Entities visible: -');
    }

    if (this.collisionSystem) {
      rows.push(`Collision objects/shells: ${this.collisionSystem.objectsCount} / ${this.collisionSystem.shellCount}`);
      rows.push(`Collision shell triangles: ${this.collisionSystem.shellTriangleCount}`);
      rows.push(`GLB collision boxes: ${this.collisionSystem.partBoxesCount}`);
      rows.push(`Sidecars loaded/missing: ${this.collisionSystem.sidecarsLoaded} / ${this.collisionSystem.sidecarsMissing}`);
      rows.push(`Entities with collision: ${this.collisionSystem.entitiesWithCollision}`);
    } else {
      rows.push('Collision: -');
    }

    if (this.walkController) {
      rows.push(`Walk speed: ${this.walkController.speedPresetLabel} (${Math.round(this.walkController.currentSpeed)})`);
      rows.push(`Gravity: ${this.walkController.gravityEnabled ? 'ON' : 'OFF'} | Grounded: ${this.walkController.isOnGround ? 'YES' : 'NO'}`);
    }

    rows.push(`Map scale: x${this.mapWorldScale.toFixed(2)}`);
    rows.push(`Export contract: RH normalized + visual settings`);

    if (this.terrainSystem) {
      const cfg = this.terrainSystem.config;
      const lx = pos.x - cfg.worldOriginX;
      const lz = (-pos.z) - cfg.worldOriginY;
      const rx = Math.floor(lx / this.terrainSystem.regionWorldSize);
      const rz = Math.floor(lz / this.terrainSystem.regionWorldSize);
      rows.push(`Region: ${rx}, ${rz}`);
    }

    this.infoEl.textContent = rows.join('\n');
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

    if (this.walkController) this.walkController.update(delta);

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

const app = new ExportReaderApp();
app.init().catch((err) => {
  console.error('Export reader init failed:', err);
});
