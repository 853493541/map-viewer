# Collision Export Guide

This guide explains how to export a regional map with collision and how another app can load it in a compatible way.

## What You Get

A collision-enabled export package contains:

- `map-data/collision.json`
- `map-data/mesh-collision-index.json`
- `map-data/meshes/<mesh>.glb.collision.json` (one sidecar per mesh)

Package root is generated under:

- `Desktop/JX3FullExports/<packageName>/`

## Export Modes

## 1. UI mode (recommended)

Open the Region / Arena Tool and use:

- `Export Region + Collision`

This mode requires a selected region and exports only entities inside that region.

## 2. API mode

POST endpoint:

- `/api/export-regional-with-collision`

Required payload fields:

- `name`: export package name
- `sourceMapPath`: usually `map-data`
- `region`: `{ minX, maxX, minZ, maxZ, polygon? }`
- `entities`: array of scene entities (`mesh`, `matrix`, optional `worldPos`)

Example request body:

```json
{
  "name": "my-region-export",
  "sourceMapPath": "map-data",
  "region": {
    "minX": -20000,
    "maxX": -5000,
    "minZ": -120000,
    "maxZ": -90000
  },
  "entities": []
}
```

The server enforces region filtering even if the client sends extra entities.

Important encoding rule:

- Send JSON as UTF-8.
- Keep mesh names in original Unicode (do not down-convert to ANSI/codepage text).
- If names are corrupted (for example, replaced with `?`), sidecar filenames can fail on Windows.

## Collision File Contract

## `collision.json` (map-level)

Contains map-level collision data:

- `objects`: broad-phase prism boxes
- `shells`: narrow-phase shell triangles
- `models.meshAttachment`: `per-glb-sidecar-json` when sidecars are enabled
- `models.meshSidecarSuffix`: usually `.collision.json`
- `models.meshSidecarIndexFile`: `mesh-collision-index.json`

Use this file for:

- quick global intersection queries
- fallback when a mesh sidecar is unavailable

## `<mesh>.glb.collision.json` (per mesh)

Contains local collision attached to a specific GLB:

- `parts`: local broad-phase prisms
- `shells`: local shell triangles
- `status`: sidecar generation state
- `hasCollision`: true or false
- `collisionStats`: `{ parts, shells, shellTriangles }`

Status values include:

- `ok`: sidecar generated with collision
- `empty-collision`: sidecar exists but no collision surfaces found
- `missing-mesh-file`: mesh file missing during extraction
- `mesh-load-failed`: GLB parse/load failed
- `sidecar-write-failed`: sidecar could not be written

## `mesh-collision-index.json` (completeness index)

Lists all expected mesh sidecars and summary counts:

- `summary.expected`
- `summary.written`
- `summary.failedWrites`
- `summary.missing`
- `entries[]` with mesh, sidecar path, status, counts, and error

Use this file as the first validation step in your app.

## Recommended Load Pipeline (External App)

1. Load `mesh-collision-index.json`.
2. For each rendered mesh, locate its sidecar path from index entries.
3. If status is `ok` or `empty-collision`, load `<mesh>.glb.collision.json`.
4. Build narrow-phase BVH from `shells[].triangles`.
5. Build broad-phase from `parts` for quick rejection.
6. If sidecar status is missing/failure, optionally fallback to map-level `collision.json`.

## Validation Checklist

After export, verify:

- `manifest.stats.collisionGenerated` is true
- `manifest.stats.meshCollisionMissing` is 0 for complete sidecar coverage
- `manifest.stats.meshCollisionAttachFailures` is 0 for write reliability
- `map-data/mesh-collision-index.json` exists
- Sidecar count and index summary are consistent

## Notes for Building the Same System

To build exactly the same behavior:

- Keep GLB render data and collision sidecars as separate files
- Use map-level `collision.json` plus per-mesh sidecars
- Keep sidecar format local to mesh space and transform with entity matrix at runtime
- Track sidecar completeness with an index file
- Keep region filtering on both client and server for safety

## How to Use Exported Files in Another App

Use this order in production:

1. Read `manifest.json`.
2. Read `map-data/map-config.json` and `map-data/environment.json`.
3. Read `map-data/entity-index.json`, then load each file under `map-data/entities/`.
4. Read `map-data/mesh-map.json` and `map-data/mesh-list.json`.
5. Read `map-data/texture-map.json`.
6. Read `map-data/collision.json`.
7. Read `map-data/mesh-collision-index.json`.
8. Load GLBs from `map-data/meshes/` lazily as they become visible.
9. Load sidecars from `map-data/meshes/<mesh>.glb.collision.json` using index entries.
10. Use map-level collision as fallback when sidecar status is not usable.

Quick path mapping example:

- GLB: `map-data/meshes/cq_wall_001.glb`
- Sidecar: `map-data/meshes/cq_wall_001.glb.collision.json`
- Global collision: `map-data/collision.json`

## Full Reader Engine Blueprint

If you want to build the same reader engine, keep these runtime modules:

1. PackageLoader
2. EntityStore
3. MeshRegistry
4. TextureRegistry
5. TerrainSystem
6. CollisionSystem
7. VisibilitySystem
8. RenderSystem

## 1) PackageLoader

Responsibilities:

- Resolve package root and file URLs.
- Load manifest and primary map-data metadata files.
- Validate required files exist before runtime starts.

Required outputs:

- `packageRoot`
- `manifest`
- `mapConfig`
- `meshMap`
- `entityFiles`
- `textureMap`

## 2) EntityStore

Responsibilities:

- Merge all JSON arrays listed by `entity-index.json`.
- Normalize entity records to `{ mesh, matrix, worldPos }`.
- Support region and polygon filtering.

Recommended structure:

- Keep raw matrix as source-of-truth.
- Cache derived position/rotation/scale for culling and debug tools.

## 3) MeshRegistry

Responsibilities:

- Load and cache GLB assets by mesh name.
- Reuse one geometry per mesh and instance transforms from entities.
- Handle missing mesh files with a visible placeholder.

Best practice:

- Use instancing for repeated meshes.
- Keep a ref-count cache to release unused meshes cleanly.

## 4) TextureRegistry

Responsibilities:

- Resolve albedo/mre/normal from `texture-map.json`.
- Apply subset texture rules if present.
- Cache textures and share across materials.

## 5) TerrainSystem

Responsibilities:

- Read `map-config.json` for landscape tiling and scale.
- Load required heightmap tiles from `map-data/heightmap/`.
- Optionally load terrain texture atlas from `map-data/terrain-textures/index.json`.

## 6) CollisionSystem

Use a two-layer collision model:

1. Broad phase from map-level `collision.json.objects` and per-sidecar `parts`.
2. Narrow phase from shell triangles (`collision.json.shells` and sidecar `shells`).

Recommended runtime behavior:

- For each moving actor, find candidate colliders via broad phase first.
- Run narrow-phase mesh/sphere/capsule tests against shell triangles.
- Use sidecar-local collision for mesh-accurate interactions.
- Fallback to map-level collision when a sidecar is missing.

## 7) VisibilitySystem

Responsibilities:

- Camera-frustum culling.
- Distance culling and LOD switching.
- Optional grid-chunk streaming for very large regions.

## 8) RenderSystem

Responsibilities:

- Build scene graph from entity transforms.
- Attach materials/textures from registries.
- Keep debug overlays for collision and bounds.

## Boot Sequence (Engine Startup)

1. Initialize renderer and camera.
2. Load package metadata.
3. Load entities and build visibility/culling index.
4. Initialize terrain.
5. Preload high-priority meshes and textures.
6. Initialize collision broad-phase and sidecar index.
7. Start frame loop and stream remaining assets.

## Frame Loop (Runtime)

Each frame:

1. Update camera and input.
2. Resolve visible entities.
3. Stream missing meshes/textures for visible set.
4. Update actor physics and collision.
5. Render scene.

## Coordinate and Transform Notes

The export keeps matrix values in source-friendly form and includes world contract metadata in `manifest.json`.

Practical rule:

- Treat each entity matrix as authoritative transform for render placement.
- Treat sidecar collision as local mesh-space data that is transformed by the same entity matrix at runtime.

## Reader Engine Pseudocode

```js
async function bootReader(packageRoot) {
  const manifest = await loadJson(`${packageRoot}/manifest.json`);
  const dataRoot = `${packageRoot}/map-data`;

  const [mapConfig, meshMap, textureMap, entityIndex, globalCollision, sidecarIndex] = await Promise.all([
    loadJson(`${dataRoot}/map-config.json`),
    loadJson(`${dataRoot}/mesh-map.json`),
    loadJson(`${dataRoot}/texture-map.json`),
    loadJson(`${dataRoot}/entity-index.json`),
    loadJson(`${dataRoot}/collision.json`),
    loadJson(`${dataRoot}/mesh-collision-index.json`),
  ]);

  const entities = await loadAllEntities(dataRoot, entityIndex);
  const systems = createSystems({ manifest, mapConfig, meshMap, textureMap, globalCollision, sidecarIndex });
  systems.entities.set(entities);
  systems.start();
}
```

## Compatibility Checklist for External Apps

- Support UTF-8 mesh names end-to-end.
- Support missing sidecars and fallback logic.
- Validate sidecar index summary before starting gameplay.
- Do not assume all meshes have non-empty collision.
- Log and expose `status` and `error` from sidecar/index for QA.

## Minimal Validation Script Goals

For automated CI or integration smoke tests, verify:

1. `manifest.json` loads and has `stats`.
2. `map-data/collision.json` exists and has `objects` or `shells`.
3. `map-data/mesh-collision-index.json` exists.
4. `summary.expected === number of unique meshes in export`.
5. `summary.missing === 0` for strict complete exports.
6. Sidecar paths in index are readable.
