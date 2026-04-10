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

class ExportSidecarCollisionSystem {
  constructor(terrainSystem, scene) {
    this.terrainSystem = terrainSystem;
    this.scene = scene;

    this.shellGeometry = null;
    this.shellBVH = null;
    this.shellLines = null;

    this.objectsCount = 0;
    this.shellCount = 0;
    this.shellTriangleCount = 0;
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

    this.shellBVH = null;
    this.objectsCount = 0;
    this.shellCount = 0;
    this.shellTriangleCount = 0;
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

    return {
      trianglesFlat: out,
      shells: shellCount,
      parts: Array.isArray(sidecarJson?.parts) ? sidecarJson.parts.length : 0,
    };
  }

  async loadFromExportData(dataPath, entitySystem, onProgress = null) {
    this.dispose();

    const entities = Array.isArray(entitySystem?.allEntities) ? entitySystem.allEntities : [];
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

    const sidecarByMeshKey = new Map();
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

        if (parsed.trianglesFlat.length > 0) {
          sidecarByMeshKey.set(meshKey, parsed.trianglesFlat);
        }
      } catch {
        this.sidecarsMissing++;
      }
    }

    const worldFlat = [];
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
      const localTriangles = sidecarByMeshKey.get(meshKey);
      if (!localTriangles || localTriangles.length === 0) continue;

      const worldMatrix = sourceEntityMatrixToWorldMatrix(entity.matrix);

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

      this.entitiesWithCollision++;
    }

    this.shellTriangleCount = Math.floor(worldFlat.length / 9);

    if (worldFlat.length === 0) return;

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

  setDebugVisible(visible) {
    if (this.shellLines) this.shellLines.visible = !!visible;
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

    this.radius = 120;
    this.eyeHeight = 240;
    this.bodyOffset = this.eyeHeight - this.radius;

    this.baseSpeed = 2200;
    this.speedLevel = 6;
    this.runMultiplier = 1.8;
    this.jumpSpeed = 1400;
    this.gravity = 3800;

    this.cameraDistance = 560;
    this.cameraDistanceMin = 220;
    this.cameraDistanceMax = 1800;
    this.minCameraDistance = 180;
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

    const bodyHeight = Math.max(this.eyeHeight * 0.74, this.radius * 2.3);
    const headRadius = this.radius * 0.65;

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(this.radius * 0.82, this.radius * 0.95, bodyHeight, 18),
      bodyMat,
    );
    body.position.y = bodyHeight * 0.5;

    const head = new THREE.Mesh(new THREE.SphereGeometry(headRadius, 16, 14), bodyMat);
    head.position.y = bodyHeight + headRadius * 1.06;

    const group = new THREE.Group();
    group.add(body, head);
    group.scale.setScalar(0.5);
    this.scene.add(group);

    this.avatar = group;
    this.avatarBody = body;
    this.avatarHead = head;
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

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.walkController = null;

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
    document.getElementById('open-validator').addEventListener('click', () => this.openValidator());
    this.showCollisionToggle?.addEventListener('change', () => {
      if (this.collisionSystem) this.collisionSystem.setDebugVisible(this.showCollisionToggle.checked);
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
    const win = window.open(url, '_blank');
    if (!win) this.setStatus('Popup blocked. Open mesh inspector manually.');
  }

  openValidator() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const url = `/full-validator.html?pkg=${encodeURIComponent(pkg)}`;
    const win = window.open(url, '_blank');
    if (!win) this.setStatus('Popup blocked. Open full validator manually.');
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

    this.terrainSystem = null;
    this.entitySystem = null;
    this.collisionSystem = null;
    this.walkController = null;

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

  _setupEnvironment(environment) {
    this._clearEnvironment();

    const skyGeo = new THREE.SphereGeometry(200000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x447fbf) },
        bottomColor: { value: new THREE.Color(0xd4c29d) },
        horizonColor: { value: new THREE.Color(0xc6b289) },
        exponent: { value: 0.52 },
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

    this.scene.fog = new THREE.FogExp2(0xc8ba98, 0.0000035);

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
      this._envNodes.push(sun, sun.target);
      this.sunLight = sun;

      const ambientColor = s.ambientColor
        ? new THREE.Color(s.ambientColor[0], s.ambientColor[1], s.ambientColor[2])
        : new THREE.Color(0x666655);
      const ambient = new THREE.AmbientLight(ambientColor, 0.8);
      this.scene.add(ambient);
      this._envNodes.push(ambient);

      const skyColor = s.skyLightColor
        ? new THREE.Color(s.skyLightColor[0] * 0.8, s.skyLightColor[1] * 0.9, s.skyLightColor[2] * 1.2)
        : new THREE.Color(0x88aacc);
      const hemi = new THREE.HemisphereLight(skyColor, 0x8b7355, 1.0);
      this.scene.add(hemi);
      this._envNodes.push(hemi);
    } else {
      const ambient = new THREE.AmbientLight(0x888888, 0.6);
      const hemi = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.45);
      this.scene.add(ambient, hemi);
      this._envNodes.push(ambient, hemi);
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

      this.setLoading('Loading entities...', 62);
      this.entitySystem = new EntitySystem(this.scene, dataPath);
      if (manifest?.region) this.entitySystem.regionFilter = manifest.region;

      await this.entitySystem.load((p) => {
        this.setLoading(`Loading entities: ${Math.round(p * 100)}%`, 62 + p * 30);
      });

      this.setLoading('Loading sidecar collision...', 93);
      this.collisionSystem = new ExportSidecarCollisionSystem(this.terrainSystem, this.scene);
      await this.collisionSystem.loadFromExportData(dataPath, this.entitySystem, (text, progress) => {
        this.setLoading(text, 93 + progress * 6);
      });
      this.collisionSystem.setDebugVisible(this.showCollisionToggle?.checked);

      this.walkController = new ExportWalkController(this.camera, this.canvas, this.collisionSystem, this.scene);
      const start = this._getStartPosition(config);
      this.walkController.setPosition(start.x, start.y, start.z);

      this.entitySystem.updateLOD(this.camera.position);

      this.hideLoading();
      this.setStatus(
        `Loaded ${pkgName} | sidecars ${this.collisionSystem.sidecarsLoaded}/${this.collisionSystem.sidecarsExpected}`
        + `, missing ${this.collisionSystem.sidecarsMissing}, triangles ${this.collisionSystem.shellTriangleCount}`,
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
      rows.push(`Sidecars loaded/missing: ${this.collisionSystem.sidecarsLoaded} / ${this.collisionSystem.sidecarsMissing}`);
      rows.push(`Entities with collision: ${this.collisionSystem.entitiesWithCollision}`);
    } else {
      rows.push('Collision: -');
    }

    if (this.walkController) {
      rows.push(`Walk speed: ${this.walkController.speedPresetLabel} (${Math.round(this.walkController.currentSpeed)})`);
      rows.push(`Gravity: ${this.walkController.gravityEnabled ? 'ON' : 'OFF'} | Grounded: ${this.walkController.isOnGround ? 'YES' : 'NO'}`);
    }

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
