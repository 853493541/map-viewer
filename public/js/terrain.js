/**
 * Terrain System - Loads and renders JX3 heightmap terrain
 * 8x8 grid of regions, each 513x513 float32 heightmap.
 * Data is pre-flipped: row 0 = south (smallest worldZ), row 512 = north.
 * Supports procedural terrain textures converted from DDS.
 */
import * as THREE from 'three';

export class TerrainSystem {
  constructor(scene, config, dataPath = 'map-data') {
    this.scene = scene;
    this.config = config.landscape;
    this.mapName = config.name || '';
    this.dataPath = dataPath;
    this.heightmaps = new Map();
    this.terrainMeshes = [];
    this.terrainGroup = new THREE.Group();
    this.terrainGroup.name = 'terrain';
    scene.add(this.terrainGroup);

    this.hmRes = this.config.heightmapResolution; // 513
    this.regionWorldSize = this.config.regionSize * this.config.unitScaleX; // 51200
    // For minimap generation
    this.minimapData = null;
    // Terrain textures
    this.terrainTextureIndex = null;
    this.terrainTextures = new Map(); // regionKey -> THREE.Texture
    this.textureLoader = new THREE.TextureLoader();
  }

  async load(onProgress) {
    const gx = this.config.regionGridX;
    const gy = this.config.regionGridY;
    const total = gx * gy;
    let loaded = 0;

    // Try to load terrain texture index
    try {
      const res = await fetch(`${this.dataPath}/terrain-textures/index.json`);
      if (res.ok) {
        this.terrainTextureIndex = await res.json();
        console.log(`Terrain textures available for ${Object.keys(this.terrainTextureIndex.regions).length} regions`);
      }
    } catch { /* no terrain textures */ }

    // Load all regions
    for (let ry = 0; ry < gy; ry++) {
      for (let rx = 0; rx < gx; rx++) {
        const key = `${String(rx).padStart(3, '0')}_${String(ry).padStart(3, '0')}`;
        try {
          const res = await fetch(`${this.dataPath}/heightmap/${encodeURIComponent(this.mapName + '_' + key + '.bin')}`);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const hd = new Float32Array(buf);
            this.heightmaps.set(`${rx}_${ry}`, hd);
            this.createRegionMesh(rx, ry, hd);
          }
        } catch (e) { /* skip */ }
        loaded++;
        if (onProgress) onProgress(loaded / total);
      }
    }
    this.buildMinimap();
  }

  createRegionMesh(rx, ry, heightData) {
    const cfg = this.config;
    const regionOriginX = cfg.worldOriginX + rx * this.regionWorldSize;
    const regionOriginZ = cfg.worldOriginY + ry * this.regionWorldSize;

    // Downsample: use every 4th sample → 129x129 per region
    const step = 4;
    const gridSize = Math.floor((this.hmRes - 1) / step) + 1; // 129

    const positions = new Float32Array(gridSize * gridSize * 3);
    const uvs = new Float32Array(gridSize * gridSize * 2);

    let vi = 0;
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const hmX = Math.min(gx * step, this.hmRes - 1);
        const hmY = Math.min(gy * step, this.hmRes - 1);
        const heightNorm = heightData[hmY * this.hmRes + hmX];
        const height = heightNorm * (cfg.heightMax - cfg.heightMin) + cfg.heightMin;

        const worldX = regionOriginX + hmX * cfg.unitScaleX;
        const worldZ = regionOriginZ + hmY * cfg.unitScaleY;

        positions[vi * 3] = worldX;
        positions[vi * 3 + 1] = height;
        positions[vi * 3 + 2] = -worldZ; // LH→RH: negate Z
        uvs[vi * 2] = (rx * (this.hmRes - 1) + hmX) / ((cfg.regionGridX * (this.hmRes - 1)));
        uvs[vi * 2 + 1] = (ry * (this.hmRes - 1) + hmY) / ((cfg.regionGridY * (this.hmRes - 1)));
        vi++;
      }
    }

    const indices = [];
    for (let gy = 0; gy < gridSize - 1; gy++) {
      for (let gx = 0; gx < gridSize - 1; gx++) {
        const a = gy * gridSize + gx;
        const b = a + 1;
        const c = (gy + 1) * gridSize + gx;
        const d = c + 1;
        // Reverse winding for RH coordinate system (Z negated)
        indices.push(a, b, c);
        indices.push(b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Height-based vertex colors (desert palette)
    const colors = new Float32Array(gridSize * gridSize * 3);
    for (let i = 0; i < gridSize * gridSize; i++) {
      const h = positions[i * 3 + 1];
      let r, g, b;
      if (h < -500) {
        r = 0.45; g = 0.42; b = 0.35;
      } else if (h < 200) {
        const t = (h + 500) / 700;
        r = 0.45 + t * 0.30; g = 0.42 + t * 0.20; b = 0.35 + t * 0.05;
      } else if (h < 1000) {
        const t = (h - 200) / 800;
        r = 0.75 + t * 0.08; g = 0.62 + t * 0.05; b = 0.40 - t * 0.02;
      } else if (h < 3000) {
        const t = (h - 1000) / 2000;
        r = 0.83 - t * 0.20; g = 0.67 - t * 0.15; b = 0.38 - t * 0.03;
      } else {
        r = 0.55; g = 0.50; b = 0.45;
      }
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = this.createTerrainMaterial(rx, ry, geometry, gridSize, positions);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData = { regionX: rx, regionY: ry };
    this.terrainGroup.add(mesh);
    this.terrainMeshes.push(mesh);
  }

  createTerrainMaterial(rx, ry, geometry, gridSize, positions) {
    const regionKey = `${rx}_${ry}`;
    const texInfo = this.terrainTextureIndex?.regions?.[regionKey];

    if (texInfo?.color) {
      // Use pre-baked terrain texture
      const texPath = `${this.dataPath}/terrain-textures/${encodeURIComponent(texInfo.color)}`;
      const texture = this.textureLoader.load(texPath);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;

      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide,
        flatShading: false,
      });

      // Region clip + edge feathering via onBeforeCompile
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.regionClipEnabled = { value: 0.0 };
        shader.uniforms.regionClipMin = { value: new THREE.Vector2(0, 0) };
        shader.uniforms.regionClipMax = { value: new THREE.Vector2(0, 0) };
        // Store reference for live updates
        mat.userData.clipUniforms = shader.uniforms;
        // Apply any clip that was set before the shader compiled
        if (mat.userData.pendingClip) {
          const b = mat.userData.pendingClip;
          shader.uniforms.regionClipEnabled.value = 1.0;
          shader.uniforms.regionClipMin.value.set(b.minX, b.minZ);
          shader.uniforms.regionClipMax.value.set(b.maxX, b.maxZ);
          mat.userData.pendingClip = null;
        }

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWorldPos;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
          uniform float regionClipEnabled;
          uniform vec2 regionClipMin;
          uniform vec2 regionClipMax;
          varying vec3 vWorldPos;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `
          #include <map_fragment>
          // Region clipping: discard fragments outside bounds
          if (regionClipEnabled > 0.5) {
            if (vWorldPos.x < regionClipMin.x || vWorldPos.x > regionClipMax.x ||
                vWorldPos.z < regionClipMin.y || vWorldPos.z > regionClipMax.y) {
              discard;
            }
          }
          // Edge feathering: soften color at region tile borders
          float featherWidth = 0.04;
          float edgeDistU = min(vMapUv.x, 1.0 - vMapUv.x);
          float edgeDistV = min(vMapUv.y, 1.0 - vMapUv.y);
          float edgeDist = min(edgeDistU, edgeDistV);
          float featherFactor = smoothstep(0.0, featherWidth, edgeDist);
          vec3 neutralTone = vec3(0.55, 0.50, 0.42);
          diffuseColor.rgb = mix(mix(diffuseColor.rgb, neutralTone, 0.3), diffuseColor.rgb, featherFactor);
          `
        );
      };

      return mat;
    }

    // Fallback: height-based vertex colors
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
    });

    // Region clip for fallback material too
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.regionClipEnabled = { value: 0.0 };
      shader.uniforms.regionClipMin = { value: new THREE.Vector2(0, 0) };
      shader.uniforms.regionClipMax = { value: new THREE.Vector2(0, 0) };
      mat.userData.clipUniforms = shader.uniforms;
      // Apply any clip that was set before the shader compiled
      if (mat.userData.pendingClip) {
        const b = mat.userData.pendingClip;
        shader.uniforms.regionClipEnabled.value = 1.0;
        shader.uniforms.regionClipMin.value.set(b.minX, b.minZ);
        shader.uniforms.regionClipMax.value.set(b.maxX, b.maxZ);
        mat.userData.pendingClip = null;
      }

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float regionClipEnabled;
        uniform vec2 regionClipMin;
        uniform vec2 regionClipMax;
        varying vec3 vWorldPos;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        // Region clipping for vertex-color terrain
        if (regionClipEnabled > 0.5) {
          if (vWorldPos.x < regionClipMin.x || vWorldPos.x > regionClipMax.x ||
              vWorldPos.z < regionClipMin.y || vWorldPos.z > regionClipMax.y) {
            discard;
          }
        }
        #include <dithering_fragment>`
      );
    };

    return mat;
  }

  /** Set or clear region clipping on all terrain meshes */
  setRegionClip(bounds) {
    const cfg = this.config;
    for (const mesh of this.terrainMeshes) {
      const mat = mesh.material;
      const rx = mesh.userData.regionX;
      const ry = mesh.userData.regionY;

      if (bounds) {
        // Compute this tile's world-space AABB (Three.js coordinate space, Z negated)
        const tileMinX = cfg.worldOriginX + rx * this.regionWorldSize;
        const tileMaxX = tileMinX + this.regionWorldSize;
        const tileMaxZ = -(cfg.worldOriginY + ry * this.regionWorldSize);
        const tileMinZ = -(cfg.worldOriginY + (ry + 1) * this.regionWorldSize);

        // Completely outside — hide the entire mesh (fast GPU culling)
        if (tileMaxX < bounds.minX || tileMinX > bounds.maxX ||
            tileMaxZ < bounds.minZ || tileMinZ > bounds.maxZ) {
          mesh.visible = false;
          mesh.userData.regionClipped = true;
          continue;
        }
        mesh.visible = true;
        mesh.userData.regionClipped = false;

        if (mat.userData.clipUniforms) {
          // Shader already compiled — update uniforms directly
          mat.userData.clipUniforms.regionClipEnabled.value = 1.0;
          mat.userData.clipUniforms.regionClipMin.value.set(bounds.minX, bounds.minZ);
          mat.userData.clipUniforms.regionClipMax.value.set(bounds.maxX, bounds.maxZ);
        } else {
          // Shader not compiled yet — store for onBeforeCompile
          mat.userData.pendingClip = { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ };
          mat.needsUpdate = true;
        }
      } else {
        // Clear clip — show all tiles
        mesh.visible = true;
        mesh.userData.regionClipped = false;
        mat.userData.pendingClip = null;
        if (mat.userData.clipUniforms) {
          mat.userData.clipUniforms.regionClipEnabled.value = 0.0;
        }
      }
    }
  }

  getHeightAt(worldX, worldZ) {
    const cfg = this.config;
    const localX = worldX - cfg.worldOriginX;
    const localZ = (-worldZ) - cfg.worldOriginY; // RH→LH: negate Z back for heightmap lookup
    const rx = Math.floor(localX / this.regionWorldSize);
    const ry = Math.floor(localZ / this.regionWorldSize);

    if (rx < 0 || rx >= cfg.regionGridX || ry < 0 || ry >= cfg.regionGridY) return null;

    const hd = this.heightmaps.get(`${rx}_${ry}`);
    if (!hd) return null;

    const inX = localX - rx * this.regionWorldSize;
    const inZ = localZ - ry * this.regionWorldSize;
    const hmX = inX / cfg.unitScaleX;
    const hmY = inZ / cfg.unitScaleY;

    const x0 = Math.max(0, Math.min(Math.floor(hmX), this.hmRes - 2));
    const y0 = Math.max(0, Math.min(Math.floor(hmY), this.hmRes - 2));
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = hmX - x0;
    const fy = hmY - y0;

    const h00 = hd[y0 * this.hmRes + x0];
    const h10 = hd[y0 * this.hmRes + x1];
    const h01 = hd[y1 * this.hmRes + x0];
    const h11 = hd[y1 * this.hmRes + x1];

    const hInterp = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
                  + h01 * (1 - fx) * fy + h11 * fx * fy;
    return hInterp * (cfg.heightMax - cfg.heightMin) + cfg.heightMin;
  }

  /** Build a low-res minimap from heightmap data */
  buildMinimap() {
    const gx = this.config.regionGridX;
    const gy = this.config.regionGridY;
    const samplesPerRegion = 25; // 25x25 per region
    const w = gx * samplesPerRegion;
    const h = gy * samplesPerRegion;
    const data = new Float32Array(w * h);

    for (let ry = 0; ry < gy; ry++) {
      for (let rx = 0; rx < gx; rx++) {
        const hd = this.heightmaps.get(`${rx}_${ry}`);
        for (let sy = 0; sy < samplesPerRegion; sy++) {
          for (let sx = 0; sx < samplesPerRegion; sx++) {
            const hmX = Math.round(sx / (samplesPerRegion - 1) * (this.hmRes - 1));
            const hmY = Math.round(sy / (samplesPerRegion - 1) * (this.hmRes - 1));
            const val = hd ? hd[hmY * this.hmRes + hmX] : 0.5;
            data[(ry * samplesPerRegion + sy) * w + rx * samplesPerRegion + sx] = val;
          }
        }
      }
    }
    this.minimapData = { data, width: w, height: h };
  }

  getWorldBounds() {
    const cfg = this.config;
    const rawMinZ = cfg.worldOriginY;
    const rawMaxZ = cfg.worldOriginY + cfg.regionGridY * this.regionWorldSize;
    return {
      minX: cfg.worldOriginX,
      minZ: -rawMaxZ,  // LH→RH: negate and swap min/max Z
      maxX: cfg.worldOriginX + cfg.regionGridX * this.regionWorldSize,
      maxZ: -rawMinZ,
    };
  }

  updateLOD(cameraPosition) {
    for (const mesh of this.terrainMeshes) {
      // Don't override region clip — clipped tiles stay hidden
      if (mesh.userData.regionClipped) continue;
      const rd = mesh.userData;
      const cx = this.config.worldOriginX + (rd.regionX + 0.5) * this.regionWorldSize;
      const cz = -(this.config.worldOriginY + (rd.regionY + 0.5) * this.regionWorldSize); // LH→RH
      const dist = Math.sqrt((cameraPosition.x - cx) ** 2 + (cameraPosition.z - cz) ** 2);
      mesh.visible = dist < 150000;
    }
  }
}
