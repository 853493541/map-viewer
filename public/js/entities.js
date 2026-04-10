/**
 * Entity System - Loads scene objects using InstancedMesh for GPU performance.
 * Supports distance-based culling, verdicts-based visibility, and mesh selection.
 */
import * as THREE from 'three';
import { GLTFLoader } from '../lib/GLTFLoader.js';

export class EntitySystem {
  constructor(scene, dataPath = 'map-data', options = {}) {
    this.scene = scene;
    this.dataPath = dataPath;
    this.entityIndexFile = options.entityIndexFile || 'entity-index.json';
    this.matrixFormat = options.matrixFormat || 'source-lh-row-major';
    this.entityGroup = new THREE.Group();
    this.entityGroup.name = 'entities';
    scene.add(this.entityGroup);

    this.loadedCount = 0;
    this.visibleCount = 0;
    this.visibleGroups = 0;
    this.invalidGeometryCount = 0;
    this.invalidTransformCount = 0;
    this.gltfLoader = new GLTFLoader();

    // Mesh tracking for UI
    this.loadedMeshes = new Map();   // glbPath -> { count, positions[] }
    this.missingMeshes = new Map();  // meshPath -> count
    this.allEntities = [];           // flat list
    this.instancedMeshes = [];       // { mesh, subMeshes, center, radius, totalCount, glbName }
    this.geometryCache = new Map();  // glbPath -> Promise<{ geometry, material }>
    this.officialSet = new Set();    // GLB filenames that have companion files
    this.textureMap = null;          // GLB name -> { albedo, mre, normal }
    this.textureLoader = new THREE.TextureLoader();
    this.textureCache = new Map();   // png filename -> THREE.Texture
    this.drawDistance = 80000;       // render distance in world units
    this.maxVisibleInstances = 2500;  // show at least half the map
    this.chunkSize = 12000;          // spatial chunk size for instancing groups

    // Verdicts system
    this.verdicts = null;            // { approved: [], denied: [] }
    this.deniedSet = new Set();      // GLB names that are denied
    this.hiddenMeshes = new Set();   // GLB names currently hidden by user
    this.regionFilter = null;        // { minX, maxX, minZ, maxZ } or null for full map
  }

  async load(onProgress) {
    let meshMap;
    try {
      meshMap = await (await fetch(`${this.dataPath}/mesh-map.json`)).json();
    } catch { meshMap = {}; }

    let meshList;
    try {
      meshList = await (await fetch(`${this.dataPath}/mesh-list.json`)).json();
    } catch { meshList = []; }

    let entityFiles;
    try {
      entityFiles = await (await fetch(`${this.dataPath}/${encodeURIComponent(this.entityIndexFile)}`)).json();
    } catch {
      entityFiles = [];
      for (let ry = 0; ry < 8; ry++)
        for (let rx = 0; rx < 8; rx++)
          entityFiles.push(`${String(rx).padStart(3, '0')}_${String(ry).padStart(3, '0')}.json`);
    }

    // Load official mesh list
    try {
      const offList = await (await fetch(`${this.dataPath}/official-meshes.json`)).json();
      for (const name of offList) this.officialSet.add(name.toLowerCase());
    } catch { /* no official list */ }

    // Load texture map
    try {
      this.textureMap = await (await fetch(`${this.dataPath}/texture-map.json`)).json();
    } catch { this.textureMap = null; }

    // Load verdicts
    try {
      this.verdicts = await (await fetch(`${this.dataPath}/verdicts.json`)).json();
      if (this.verdicts && this.verdicts.denied) {
        for (const name of this.verdicts.denied) this.deniedSet.add(name.toLowerCase());
        // Initially hide all denied meshes
        for (const name of this.verdicts.denied) this.hiddenMeshes.add(name.toLowerCase());
      }
    } catch { this.verdicts = null; }

    // Phase 1: Collect all entities and group by GLB path + chunk to keep LOD local
    const glbGroups = new Map(); // key -> { glbPath, instances[] }
    let processed = 0;

    for (const file of entityFiles) {
      try {
        const res = await fetch(`${this.dataPath}/entities/${encodeURIComponent(file)}`);
        if (res.ok) {
          const entities = await res.json();
          for (const entity of entities) {
            const m = entity.matrix;
            if (!Array.isArray(m) || m.length !== 16) continue;

            // Convert LH position to RH: negate Z
            const pos = this.matrixFormat === 'three-matrix4-column-major'
              ? { x: m[12], y: m[13], z: m[14] }
              : { x: m[12], y: m[13], z: -m[14] };

            // Skip entities outside the region filter (pre-load culling for custom maps)
            if (this.regionFilter) {
              const r = this.regionFilter;
              if (r.minX !== undefined) {
                if (pos.x < r.minX || pos.x > r.maxX || pos.z < r.minZ || pos.z > r.maxZ) continue;
              }
              if (r.polygon && !this._pointInPolygon(pos.x, pos.z, r.polygon)) continue;
            }

            this.allEntities.push({ ...entity, worldPos: pos });

            const glbPath = meshMap[entity.mesh];
            if (!glbPath) continue;

            const fullPath = `${this.dataPath}/${glbPath}`;
            const chunkX = Math.floor(pos.x / this.chunkSize);
            const chunkZ = Math.floor(pos.z / this.chunkSize);
            const key = `${fullPath}|${chunkX}|${chunkZ}`;

            if (!glbGroups.has(key)) glbGroups.set(key, { glbPath: fullPath, instances: [] });
            glbGroups.get(key).instances.push({ matrix: m, entity, pos });
          }
        }
      } catch { /* skip */ }
      processed++;
      if (onProgress) onProgress(processed / entityFiles.length * 0.3);
    }

    // Track missing meshes
    for (const path of meshList) {
      if (!meshMap[path] && !this.missingMeshes.has(path)) {
        this.missingMeshes.set(path, 0);
      }
    }
    for (const ent of this.allEntities) {
      if (!meshMap[ent.mesh]) {
        this.missingMeshes.set(ent.mesh, (this.missingMeshes.get(ent.mesh) || 0) + 1);
      }
    }

    // Phase 2: Load each unique GLB and create InstancedMesh(es)
    const glbEntries = [...glbGroups.values()];
    let glbDone = 0;

    for (const group of glbEntries) {
      const glbPath = group.glbPath;
      const instances = group.instances;
      try {
        const meshParts = await this.loadGLBCached(glbPath);
        const validParts = meshParts ? meshParts.filter(p => p.geometry) : [];
        if (validParts.length === 0) { glbDone++; continue; }

        // Precompute valid transforms (shared across all subsets)
        const validTransforms = [];
        const validPositions = [];
        for (const inst of instances) {
          const m = inst.matrix;
          if (!this.isValidTransformMatrix(m)) {
            this.invalidTransformCount++;
            continue;
          }
          const mat4 = new THREE.Matrix4();
          if (this.matrixFormat === 'three-matrix4-column-major') {
            mat4.fromArray(m);
          } else {
            // Convert LH (DirectX) row-major transform to RH (glTF/Three.js)
            // Apply reflection S = diag(1,1,-1,1): M_rh = S * M_lh * S
            // Row-major layout: [r0c0,r0c1,r0c2,r0c3, r1c0,..., r3c0,r3c1,r3c2,r3c3]
            mat4.set(
               m[0],  m[4], -m[8],   m[12],
               m[1],  m[5], -m[9],   m[13],
              -m[2], -m[6],  m[10], -m[14],
               m[3],  m[7], -m[11],  m[15]
            );
          }
          validTransforms.push(mat4);
          const pos = this.matrixFormat === 'three-matrix4-column-major'
            ? { x: m[12], y: m[13], z: m[14] }
            : { x: m[12], y: m[13], z: -m[14] };
          validPositions.push(pos);
        }

        if (validTransforms.length === 0) {
          glbDone++;
          if (onProgress) onProgress(0.3 + (glbDone / Math.max(glbEntries.length, 1)) * 0.7);
          continue;
        }

        // Compute center and radius
        let cx = 0, cy = 0, cz = 0;
        for (const mat4 of validTransforms) {
          const e = mat4.elements;
          cx += e[12]; cy += e[13]; cz += e[14];
        }
        cx /= validTransforms.length;
        cy /= validTransforms.length;
        cz /= validTransforms.length;
        let maxR = 0;
        for (const pos of validPositions) {
          const dx = pos.x - cx, dz = pos.z - cz;
          maxR = Math.max(maxR, Math.sqrt(dx * dx + dz * dz));
        }

        // Create one InstancedMesh per subset/primitive
        const subMeshes = [];
        for (const { geometry, material } of validParts) {
          const instMesh = new THREE.InstancedMesh(geometry, material, validTransforms.length);
          instMesh.castShadow = true;
          instMesh.receiveShadow = true;
          for (let i = 0; i < validTransforms.length; i++) {
            instMesh.setMatrixAt(i, validTransforms[i]);
          }
          instMesh.count = validTransforms.length;
          instMesh.instanceMatrix.needsUpdate = true;
          instMesh.frustumCulled = false;
          instMesh.visible = false;
          this.entityGroup.add(instMesh);
          subMeshes.push(instMesh);
        }

        // Track as a group for LOD
        const glbFileName = glbPath.split('/').pop().toLowerCase();
        this.instancedMeshes.push({
          mesh: subMeshes[0], // primary for LOD distance
          subMeshes: subMeshes,
          center: new THREE.Vector3(cx, cy, cz),
          radius: maxR,
          totalCount: validTransforms.length,
          glbName: glbFileName
        });
        this.loadedCount += validTransforms.length;

        // Track for UI
        const shortPath = glbPath.replace(`${this.dataPath}/`, '');
        const glbFile = shortPath.replace('meshes/', '').toLowerCase();
        const isOfficial = this.officialSet.has(glbFile);
        const tracked = this.loadedMeshes.get(shortPath) || { count: 0, positions: [], official: isOfficial };
        tracked.count += validTransforms.length;
        tracked.positions.push(...validPositions);
        this.loadedMeshes.set(shortPath, tracked);
      } catch { /* skip broken GLBs */ }

      glbDone++;
      if (onProgress) onProgress(0.3 + (glbDone / Math.max(glbEntries.length, 1)) * 0.7);
    }
  }

  async loadGLBCached(glbPath) {
    if (!this.geometryCache.has(glbPath)) {
      this.geometryCache.set(glbPath, this.loadGLB(glbPath));
    }
    return this.geometryCache.get(glbPath);
  }

  isValidTransformMatrix(m) {
    if (!Array.isArray(m) || m.length !== 16) return false;
    for (const v of m) {
      if (!Number.isFinite(v)) return false;
    }

    const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
    const sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);

    if (sx < 0.01 || sy < 0.01 || sz < 0.01) return false;
    if (sx > 20 || sy > 20 || sz > 20) return false;

    if (!Number.isFinite(m[12]) || !Number.isFinite(m[13]) || !Number.isFinite(m[14])) return false;
    return true;
  }

  isValidGeometry(geometry) {
    const posAttr = geometry.getAttribute('position');
    if (!posAttr || !posAttr.array || posAttr.count === 0) return false;

    const arr = posAttr.array;
    let maxAbs = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v)) return false;
      const a = Math.abs(v);
      if (a > maxAbs) maxAbs = a;
    }

    // Corrupted meshes can contain absurd coordinates and produce giant screen shards.
    if (maxAbs > 50000) return false;

    try {
      geometry.computeBoundingSphere();
      const r = geometry.boundingSphere?.radius ?? 0;
      if (!Number.isFinite(r) || r <= 0 || r > 50000) return false;
    } catch {
      return false;
    }

    return true;
  }

  loadTextureCached(pngName) {
    if (!this.textureCache.has(pngName)) {
      const tex = this.textureLoader.load(`${this.dataPath}/textures/` + encodeURIComponent(pngName));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false; // glTF UVs: origin at upper-left, must not flip
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      this.textureCache.set(pngName, tex);
    }
    return this.textureCache.get(pngName);
  }

  loadTextureCachedLinear(pngName) {
    const key = pngName + '_linear';
    if (!this.textureCache.has(key)) {
      const tex = this.textureLoader.load(`${this.dataPath}/textures/` + encodeURIComponent(pngName));
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.flipY = false; // glTF UVs: origin at upper-left, must not flip
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      this.textureCache.set(key, tex);
    }
    return this.textureCache.get(key);
  }

  /** Load MRE texture with channel swizzle: game MRE (M=R,R=G,E=B) → THREE.js (x=R,R=G,M=B) */
  loadMRECached(pngName) {
    const key = pngName + '_mre';
    if (!this.textureCache.has(key)) {
      const tex = this.textureLoader.load(
        `${this.dataPath}/textures/` + encodeURIComponent(pngName),
        (t) => {
          const canvas = document.createElement('canvas');
          const img = t.image;
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const px = d.data;
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i]; px[i] = px[i + 2]; px[i + 2] = r; // swap R↔B
          }
          ctx.putImageData(d, 0, 0);
          t.image = canvas;
          t.needsUpdate = true;
        }
      );
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.flipY = false;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      this.textureCache.set(key, tex);
    }
    return this.textureCache.get(key);
  }

  async loadGLB(glbPath) {
    return new Promise((resolve) => {
      this.gltfLoader.load(glbPath,
        (gltf) => {
          const parts = []; // array of { geometry, material }
          const glbName = glbPath.split('/').pop();
          const texInfo = this.textureMap && this.textureMap[glbName];
          const subsetTextures = texInfo && texInfo.subsets;

          let meshIdx = 0;
          gltf.scene.traverse((c) => {
            if (!c.isMesh) return;
            const geometry = c.geometry;
            if (!this.isValidGeometry(geometry)) {
              this.invalidGeometryCount++;
              meshIdx++;
              return;
            }

            // Determine which texture set to use for this primitive
            const subTex = (subsetTextures && meshIdx < subsetTextures.length)
              ? subsetTextures[meshIdx]
              : texInfo;

            const hasColors = geometry.hasAttribute('color');
            const matOpts = {
              color: hasColors ? 0xffffff : 0xccbbaa,
              vertexColors: hasColors,
              roughness: 0.7,
              metalness: 0.0,
              side: THREE.DoubleSide,
            };

            if (subTex) {
              if (subTex.albedo) {
                matOpts.map = this.loadTextureCached(subTex.albedo);
                matOpts.color = 0xffffff;
                matOpts.vertexColors = false;
              }
              if (subTex.mre) {
                const mreTex = this.loadMRECached(subTex.mre);
                matOpts.roughnessMap = mreTex;
                matOpts.metalnessMap = mreTex;
                matOpts.roughness = 1.0;
                matOpts.metalness = 1.0;
              }
              if (subTex.normal) {
                matOpts.normalMap = this.loadTextureCachedLinear(subTex.normal);
                // JX3 uses DirectX normal map convention (Y-down);
                // THREE.js/glTF expects OpenGL convention (Y-up) — flip Y
                matOpts.normalScale = new THREE.Vector2(1, -1);
              }

              // Apply alpha test for subsets with BlendMode=1 (alpha test/cutout)
              const blendMode = subTex.blendMode || (texInfo && texInfo.blendMode) || 0;
              if (blendMode === 1 && matOpts.map) {
                const alphaRef = subTex.alphaRef != null ? subTex.alphaRef : 128;
                matOpts.alphaTest = alphaRef / 255.0;
                matOpts.transparent = false;
                matOpts.side = THREE.DoubleSide;
              } else if (blendMode === 2 && matOpts.map) {
                // Additive blending
                matOpts.transparent = true;
                matOpts.blending = THREE.AdditiveBlending;
                matOpts.depthWrite = false;
              }
            }

            const material = new THREE.MeshStandardMaterial(matOpts);
            parts.push({ geometry, material });
            meshIdx++;
          });

          if (parts.length === 0) {
            resolve([{ geometry: null, material: null }]);
          } else {
            resolve(parts);
          }
        },
        undefined,
        () => resolve([{ geometry: null, material: null }])
      );
    });
  }

  /** Distance-based culling: show/hide InstancedMeshes based on camera distance */
  updateLOD(cameraPos) {
    const candidates = [];

    for (const entry of this.instancedMeshes) {
      // Skip meshes hidden by verdicts
      if (entry.glbName && this.hiddenMeshes.has(entry.glbName)) {
        const subs = entry.subMeshes || [entry.mesh];
        for (const m of subs) { m.visible = false; m.count = 0; }
        continue;
      }

      // Skip meshes outside region filter
      if (this.regionFilter) {
        const r = this.regionFilter;
        const c = entry.center;
        if (c.x < r.minX - entry.radius || c.x > r.maxX + entry.radius ||
            c.z < r.minZ - entry.radius || c.z > r.maxZ + entry.radius) {
          const subs = entry.subMeshes || [entry.mesh];
          for (const m of subs) { m.visible = false; m.count = 0; }
          continue;
        }
        // Polygon check (pen-draw mode)
        if (r.polygon && !this._pointInPolygon(c.x, c.z, r.polygon)) {
          const subs = entry.subMeshes || [entry.mesh];
          for (const m of subs) { m.visible = false; m.count = 0; }
          continue;
        }
      }

      const dx = cameraPos.x - entry.center.x;
      const dz = cameraPos.z - entry.center.z;
      const distSq = dx * dx + dz * dz;
      const limit = this.drawDistance + entry.radius;
      if (distSq <= limit * limit) {
        candidates.push({ entry, distSq });
      } else {
        // Hide all sub-meshes
        const subs = entry.subMeshes || [entry.mesh];
        for (const m of subs) { m.visible = false; m.count = 0; }
      }
    }

    candidates.sort((a, b) => a.distSq - b.distSq);

    let visible = 0;
    let groups = 0;
    let remaining = this.maxVisibleInstances;

    for (const { entry } of candidates) {
      const subs = entry.subMeshes || [entry.mesh];
      if (remaining <= 0) {
        for (const m of subs) { m.visible = false; m.count = 0; }
        continue;
      }

      const n = Math.min(entry.totalCount, remaining);
      for (const m of subs) {
        m.count = n;
        m.visible = n > 0;
      }

      if (n > 0) {
        visible += n;
        groups++;
        remaining -= n;
      }
    }

    this.visibleCount = visible;
    this.visibleGroups = groups;
  }

  getCollisionMeshes() { return []; }

  /** Toggle visibility of a specific GLB mesh by name */
  setMeshHidden(glbName, hidden) {
    const key = glbName.toLowerCase();
    if (hidden) {
      this.hiddenMeshes.add(key);
    } else {
      this.hiddenMeshes.delete(key);
    }
  }

  /** Check if a GLB mesh is currently hidden */
  isMeshHidden(glbName) {
    return this.hiddenMeshes.has(glbName.toLowerCase());
  }

  /** Hide all denied meshes */
  hideAllDenied() {
    for (const name of this.deniedSet) this.hiddenMeshes.add(name);
  }

  /** Show all denied meshes */
  showAllDenied() {
    for (const name of this.deniedSet) this.hiddenMeshes.delete(name);
  }

  /** Get the number of instances for a specific GLB on the map */
  getInstanceCount(glbName) {
    const key = glbName.toLowerCase();
    let count = 0;
    for (const entry of this.instancedMeshes) {
      if (entry.glbName === key) count += entry.totalCount;
    }
    return count;
  }

  /** Get a set of all loaded unique GLB names */
  getLoadedGLBNames() {
    const names = new Set();
    for (const entry of this.instancedMeshes) {
      if (entry.glbName) names.add(entry.glbName);
    }
    return names;
  }

  /** Ray-casting point-in-polygon (2D: x/z plane) */
  _pointInPolygon(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

  /**
   * Read current instance transforms from GPU buffers.
   * Returns live entity list reflecting any moves/deletes/additions done this session.
   */
  getCurrentEntities() {
    const result = [];
    const mat4 = new THREE.Matrix4();
    for (const entry of this.instancedMeshes) {
      const primary = (entry.subMeshes || [entry.mesh])[0];
      if (!primary) continue;
      for (let i = 0; i < primary.count; i++) {
        primary.getMatrixAt(i, mat4);
        // Skip zero-scale (deleted) instances
        const sx = mat4.elements[0] ** 2 + mat4.elements[1] ** 2 + mat4.elements[2] ** 2;
        if (sx < 0.001) continue;
        const x = mat4.elements[12], y = mat4.elements[13], z = mat4.elements[14];
        if (this.matrixFormat === 'three-matrix4-column-major') {
          result.push({ mesh: entry.glbName, matrix: [...mat4.elements], worldPos: { x, y, z } });
        } else {
          // Convert RH→LH: negate Z back for export
          const lhMat = [...mat4.elements];
          lhMat[14] = -lhMat[14];
          result.push({ mesh: entry.glbName, matrix: lhMat, worldPos: { x, y, z } });
        }
      }
    }
    return result;
  }
}

