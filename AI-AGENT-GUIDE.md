# JX3 Map System — AI Agent Integration Guide

> This document is for an AI agent working on the **zhenchuan** game project (R3F branch).
> It explains how to integrate JX3 map data into the game's arena system.

---

## What This System Is

A complete pipeline that converts a Chinese MMO game's (JX3/剑网3) 3D map into web-renderable format:
- **Terrain**: heightmap-based ground with real-world scale (8×8 grid of 513×513 float32 tiles)
- **Entities**: ~5000 placed 3D objects (buildings, walls, props) as instanced meshes
- **Textures**: PBR materials (albedo + MRE metallic-roughness-emissive + normal maps)
- **Export format**: Self-contained JSON with everything needed to load a sub-region

The editor lets you select a rectangular region of the large map, place/move/delete objects, then export it as a single JSON file with all terrain + entity data.

---

## The Export Format (v2)

When we export from the editor, we get a JSON like `玉门关竞技场-full-export.json`:

```typescript
interface MapExport {
  version: 2;
  name: string;
  sourceMap: string;
  created: number;
  region: { minX: number; maxX: number; minZ: number; maxZ: number };
  regionCorners: Array<{ x: number; z: number }>; // 4 corner positions
  entityCount: number;
  glbList: string[];      // unique GLB filenames needed
  glbBasePath: string;    // relative path to GLB folder
  entities: Array<{
    mesh: string;         // GLB filename, e.g. "cq_玉门关城墙001_001_hd.glb"
    matrix: number[];     // 16-element column-major 4x4 transform matrix (RIGHT-HANDED)
    worldPos: { x: number; y: number; z: number }; // for quick spatial queries
  }>;
  terrainConfig: {
    worldOriginX: number; // e.g. -102400
    worldOriginY: number;
    regionSize: number;   // e.g. 512 (world units per heightmap tile)
    unitScaleX: number;   // e.g. 100 (multiply by this to get world coords)
    heightmapResolution: number; // e.g. 513 (513×513 samples per tile)
    regionGridX: number;  // e.g. 8
    regionGridY: number;  // e.g. 8
  };
  terrainTiles: {
    [key: string]: string; // "rx_ry" => base64-encoded Float32Array (513×513 floats)
  };
}
```

### Coordinate System

**CRITICAL**: The exported data is in **THREE.js right-handed** coordinates.
- X = right, Y = up, Z = towards camera (forward in JX3 is -Z)
- Entity matrices are already converted from the game's left-handed system
- The `worldPos.z` in export is **negated** from the original game Z (LH→RH conversion: `Z_rh = -Z_lh`)

### Scale

JX3 world coordinates are large numbers (e.g. X: 4000–35000, Z: -140000 to -111000, Y: 0–3500). A typical arena region is about 30,000 units wide. You need to decide your game's scale mapping. For a 200×200 arena:

```
scaleFactor = 200 / regionWidth;  // e.g. 200 / 30189 ≈ 0.00662
```

---

## How To Build The Map Viewer Components

### Step 1: Asset Setup

Copy into your project (e.g. `frontend/public/maps/`):
```
maps/
├── 玉门关竞技场-full-export.json   # the export file
└── glb/                             # GLB mesh files referenced by glbList
    ├── cq_玉门关城墙001_001_hd.glb
    ├── cq_玉门关城墙001_002_hd.glb
    └── ...
```

The GLB files come from the map editor's `public/map-data/meshes/` folder.

### Step 2: Terrain Component

Create a React Three Fiber component that renders the heightmap terrain.

```tsx
// JX3Terrain.tsx — Heightmap terrain from export data
import { useMemo } from 'react';
import * as THREE from 'three';

interface Props {
  config: MapExport['terrainConfig'];
  tiles: MapExport['terrainTiles'];
  region: MapExport['region'];
  scale?: number;
}

export function JX3Terrain({ config, tiles, region, scale = 1 }: Props) {
  const meshes = useMemo(() => {
    const result: JSX.Element[] = [];
    
    for (const [key, b64] of Object.entries(tiles)) {
      const [rx, ry] = key.split('_').map(Number);
      
      // Decode base64 Float32Array
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const heights = new Float32Array(bytes.buffer);
      
      const res = config.heightmapResolution; // 513
      const worldX = config.worldOriginX + rx * config.regionSize * config.unitScaleX;
      const worldZ = config.worldOriginY + ry * config.regionSize * config.unitScaleX;
      const tileWorldSize = config.regionSize * config.unitScaleX;
      
      // Build PlaneGeometry and set Y from heightmap
      const geo = new THREE.PlaneGeometry(
        tileWorldSize * scale,
        tileWorldSize * scale,
        res - 1, res - 1
      );
      geo.rotateX(-Math.PI / 2);
      
      const pos = geo.attributes.position;
      for (let iy = 0; iy < res; iy++) {
        for (let ix = 0; ix < res; ix++) {
          const vi = iy * res + ix;
          pos.setY(vi, heights[vi] * scale);
        }
      }
      geo.computeVertexNormals();
      
      result.push(
        <mesh
          key={key}
          geometry={geo}
          position={[
            (worldX + tileWorldSize / 2) * scale,
            0,
            -(worldZ + tileWorldSize / 2) * scale // negate Z for RH
          ]}
        >
          <meshStandardMaterial color="#8B7355" roughness={0.9} />
        </mesh>
      );
    }
    
    return result;
  }, [config, tiles, scale]);

  return <group>{meshes}</group>;
}
```

### Step 3: Entity Component

Load GLBs and place them using InstancedMesh:

```tsx
// JX3Entities.tsx — Instanced mesh entities from export
import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  entities: MapExport['entities'];
  glbBasePath: string;
  scale?: number;
}

export function JX3Entities({ entities, glbBasePath, scale = 1 }: Props) {
  // Group entities by mesh name
  const grouped = useMemo(() => {
    const map = new Map<string, MapExport['entities']>();
    for (const e of entities) {
      const list = map.get(e.mesh) || [];
      list.push(e);
      map.set(e.mesh, list);
    }
    return map;
  }, [entities]);

  return (
    <group>
      {Array.from(grouped.entries()).map(([meshName, instances]) => (
        <MeshInstances
          key={meshName}
          meshName={meshName}
          instances={instances}
          basePath={glbBasePath}
          scale={scale}
        />
      ))}
    </group>
  );
}

function MeshInstances({ meshName, instances, basePath, scale }) {
  const { scene } = useGLTF(`${basePath}/${meshName}`);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!groupRef.current) return;
    
    // Clone the loaded model for each instance
    // For better performance with many instances, use InstancedMesh
    groupRef.current.clear();
    
    for (const inst of instances) {
      const clone = scene.clone(true);
      const mat = new THREE.Matrix4().fromArray(inst.matrix);
      
      // Apply scale factor
      if (scale !== 1) {
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        mat.decompose(pos, rot, scl);
        pos.multiplyScalar(scale);
        mat.compose(pos, rot, scl.multiplyScalar(scale));
      }
      
      clone.applyMatrix4(mat);
      groupRef.current.add(clone);
    }
  }, [scene, instances, scale]);

  return <group ref={groupRef} />;
}
```

### Step 4: Replace ArenaScene Components

In `components/BattleArena/scene/ArenaScene.tsx`:

```tsx
// REMOVE old Ground and MapObjects
// ADD:
import { JX3Terrain } from './JX3Terrain';
import { JX3Entities } from './JX3Entities';

// In the scene:
<JX3Terrain
  config={mapData.terrainConfig}
  tiles={mapData.terrainTiles}
  region={mapData.region}
  scale={arenaScale}
/>
<JX3Entities
  entities={mapData.entities}
  glbBasePath="/maps/glb"
  scale={arenaScale}
/>
```

### Step 5: Ground-Following Collision

Replace the flat-ground collision with heightmap sampling:

```typescript
// heightmapCollision.ts
export function getHeightAtPosition(
  x: number, z: number,
  config: MapExport['terrainConfig'],
  tiles: Map<string, Float32Array>
): number {
  // Convert world position to tile coordinates
  const rx = Math.floor((x / config.unitScaleX - config.worldOriginX / config.unitScaleX) / config.regionSize);
  const ry = Math.floor((-z / config.unitScaleX - config.worldOriginY / config.unitScaleX) / config.regionSize);
  
  const key = `${rx}_${ry}`;
  const heights = tiles.get(key);
  if (!heights) return 0;
  
  // Local position within tile
  const localX = (x / config.unitScaleX - config.worldOriginX / config.unitScaleX) - rx * config.regionSize;
  const localZ = (-z / config.unitScaleX - config.worldOriginY / config.unitScaleX) - ry * config.regionSize;
  
  const res = config.heightmapResolution;
  const fx = (localX / config.regionSize) * (res - 1);
  const fy = (localZ / config.regionSize) * (res - 1);
  
  // Bilinear interpolation
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const fx2 = fx - ix;
  const fy2 = fy - iy;
  
  const ix1 = Math.min(ix + 1, res - 1);
  const iy1 = Math.min(iy + 1, res - 1);
  
  const h00 = heights[iy * res + ix];
  const h10 = heights[iy * res + ix1];
  const h01 = heights[iy1 * res + ix];
  const h11 = heights[iy1 * res + ix1];
  
  return h00 * (1 - fx2) * (1 - fy2)
       + h10 * fx2 * (1 - fy2)
       + h01 * (1 - fx2) * fy2
       + h11 * fx2 * fy2;
}
```

---

## Important Mistakes NOT To Make

### 1. Coordinate System
- JX3 game files are **LEFT-HANDED** (Z goes into the screen)
- The export JSON is **RIGHT-HANDED** (already converted)
- **Do NOT negate Z again** — it's already done in the export
- Entity matrices in the JSON are already in THREE.js convention

### 2. Scale
- JX3 world units are NOT meters. A building might be 3000 units tall.
- You MUST apply a uniform scale factor to map JX3 coords to your game's coordinate space
- The arena in zhenchuan is 200×200. A JX3 region can be 30,000 units wide.
- `scale = 200 / regionWidth` is a starting point. Adjust visually.

### 3. Heightmap Decoding
- `terrainTiles` values are **base64-encoded Float32Arrays**
- Decode: `atob(b64)` → `Uint8Array` → `Float32Array` (via `.buffer`)
- Each tile is 513×513 = 263,169 floats
- Heights are absolute Y values in JX3 world space (can be 0–6000+)
- **If terrainTiles is empty** (`{}`), the export has no terrain — entities only

### 4. GLB Files
- GLB files use **Chinese filenames** (e.g. `cq_玉门关城墙001_001_hd.glb`)
- Ensure your web server handles UTF-8 filenames correctly
- The GLBs have PBR materials baked in (albedo + optional metalness/roughness + normals)
- Some GLBs have multiple subsets (sub-meshes with different materials)
- `flipY = false` for all textures (glTF convention)

### 5. Performance
- The original editor uses **InstancedMesh** to batch hundreds of identical meshes
- If you clone the scene for each instance, performance will suffer
- Group entities by `mesh` name and use R3F `<Instances>` or `<InstancedMesh>`
- For 100+ entities, instancing is critical

### 6. Normal Maps
- JX3 uses DirectX normal map convention (Y-down)
- THREE.js / glTF uses OpenGL convention (Y-up)
- The GLBs have `normalScale = Vector2(1, -1)` already set — don't change it
- If normals look inverted (light from wrong side), the issue is likely the normal map Y flip

### 7. Missing Meshes
- ~91 meshes have broken normals and are "denied" in the verdicts system
- These render but may look wrong (inside-out faces, dark patches)
- ~11 meshes have no textures (render as default beige)
- 21 SpeedTree (.srt) references have no mesh data — they simply won't render

---

## What Should Be In The Game After Integration

1. **Arena Mode** — players enter a 3D arena built from JX3 map data
2. **Real terrain** — heightmap-based ground with hills, slopes, elevation changes
3. **Architectural meshes** — city walls, buildings, watchtowers, props placed accurately
4. **Ground following** — characters walk on the terrain surface, not a flat plane
5. **Multiple maps** — a `maps/` folder with different export JSONs, selectable by players

### Adding More Maps Later

1. Open this local editor (map editor repo)
2. Load the full JX3 map
3. Use Region tool to select a new area
4. Edit as needed (add/move/delete meshes)
5. Full Export → get a new JSON
6. Copy JSON + any new GLBs to zhenchuan's `maps/` folder
7. Add the map name to the map selection list

---

## File Reference

| File | Size | What It Contains |
|------|------|-----------------|
| `*-full-export.json` | 50–500 KB | Entities + terrain + config for one arena region |
| `*.glb` | 1 KB – 5 MB each | Individual 3D mesh with materials baked in |
| Total GLBs for one arena | ~20–50 files | Depends on how many unique meshes are in the region |

The export JSON is self-contained except for the GLB files it references in `glbList`.
