# JX3 Unified Full Guide

This is the single merged guide that consolidates previous usage, export, validator,
collision, and reader adaptation docs.

Use this file as the canonical reference for:

- local run and debug
- full/regional export workflows
- package data contract
- full viewer and export reader behavior
- collision sidecar runtime
- sky and lighting configuration
- porting to another repository

## 1. Project Purpose

The project is a web map editor/viewer pipeline for JX3 map data.

Core capabilities:

- render terrain, entities, textures
- inspect/approve/deny meshes
- export self-contained map packages to Desktop
- validate package completeness
- run third-person walk collision verification with sidecar collision

## 2. Run and Entry Points

Start server:

```powershell
cd "c:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\jx3-web-map-viewer"
node server.js
```

Main pages:

- `/index.html` main editor/viewer
- `/mesh-inspector.html` mesh verdict workflow
- `/full-viewer.html` load Desktop export package
- `/full-validator.html` package completeness checker
- `/export-reader.html` third-person walk and collision validation

Important:

- `export-reader.html` now targets the new export contract only.
- Old packages without RH transform and visual settings files are rejected.

## 3. Server APIs and Routes

Export package root:

- `Desktop/JX3FullExports`

Primary APIs:

- `GET /api/full-exports` list export packages
- `POST /api/export-full` full export package
- `POST /api/export-full-with-collision` full export + sidecars
- `POST /api/export-regional-with-collision` region-required export + sidecars

Static package serving:

- `GET|HEAD /full-exports/<package>/...`

### Export payload fields

Common fields:

- `name` package name prefix
- `sourceMapPath` usually `map-data`
- `entities` runtime entity array (`mesh`, `matrix`, optional `worldPos`)

Regional collision export requires:

- `region`: `{ minX, maxX, minZ, maxZ, polygon? }`
- optional `regionCorners`

Important:

- Keep JSON UTF-8 with original Unicode mesh names.
- Region filter is enforced server-side.

## 4. Export Package Contract

Typical package files:

- `manifest.json`
- `map-data/map-config.json`
- `map-data/environment.json` (if present in source)
- `map-data/entity-index.json`
- `map-data/entities/full.json`
- `map-data/entity-index-rh.json`
- `map-data/entities/full.rh.json`
- `map-data/transform-conventions.json`
- `map-data/visual-settings.json`
- `map-data/mesh-map.json`
- `map-data/mesh-list.json`
- `map-data/official-meshes.json`
- `map-data/verdicts.json`
- `map-data/texture-map.json`
- `map-data/meshes/*.glb`
- `map-data/textures/*`
- `map-data/heightmap/*`
- `map-data/terrain-textures/index.json` (subset)
- `map-data/terrain-textures/*`

Collision-enabled package adds:

- `map-data/collision.json`
- `map-data/mesh-collision-index.json`
- `map-data/meshes/*.glb.collision.json`

Reader-required files (new contract):

- `manifest.json`
- `map-data/map-config.json`
- `map-data/transform-conventions.json`
- `map-data/visual-settings.json`
- `map-data/entity-index-rh.json`
- `map-data/entities/full.rh.json`
- `map-data/mesh-map.json`
- `map-data/mesh-list.json`
- `map-data/collision.json` or sidecar collision set (recommended: sidecar set)

## 5. Collision Data and Runtime

Collision files:

- `collision.json` map-level fallback
- `mesh-collision-index.json` sidecar completeness/status index
- `<mesh>.glb.collision.json` local per-mesh collision (parts + shells)

Reader collision runtime model:

1. load sidecar index
2. load sidecars for referenced meshes
3. transform local shell triangles by each entity matrix into world space
4. build one world `BufferGeometry` and `MeshBVH`
5. run broad/narrow collision tests per frame
6. fallback to map-level behavior when sidecars are unavailable

### Collision debug display contract (must match reader)

Reader debug toggles and rendering are part of the contract:

- `Show collision shells`:
  - built from world shell triangles
  - rendered as edge lines (`EdgesGeometry`) for narrow-phase surfaces
- `Show GLB collision boxes`:
  - built from sidecar `parts` (`localCx`, `localCz`, `localW`, `localD`, `localBaseY`, `localTopY`)
  - transformed per-entity to world space
  - rendered as world line boxes (`LineSegments`)

Importer/readers that claim parity should expose both toggles and both displays.

Indoor/wall behavior constraints:

- wall contact must stop/slide, not pop player upward
- floor-like contacts can ground the actor
- roof/ceiling contact should not become support floor
- support ray origin stays near player to avoid selecting roof-above as ground
- limited step-up threshold avoids snapping to building tops

## 6. Export Reader Controls and Character Config

Current reader controls:

- left mouse drag rotate camera
- vertical drag inverted:
  - drag down => look down
  - drag up => look up
- mouse wheel changes camera distance
- `W/A/S/D` move
- `Shift` sprint
- hold `Space` continuous upward jump
- `G` toggle gravity
- `1` slow speed preset
- `2` normal speed preset
- `3` fast speed preset

### Current movement and camera constants

- `baseSpeed`: `2200`
- `runMultiplier`: `1.8`
- `jumpSpeed`: `1400`
- `gravity`: `3800`
- `cameraDistance`: `1800` (starts at max by default)
- `cameraDistanceMin`: `220`
- `cameraDistanceMax`: `1800`
- `minCameraDistance`: `260`
- `cameraHeight`: `120`

### Character visual and collision sizing

- visual model base radius: `120`
- visual model base eye height: `240`
- visual model scale: `0.5`
- collision radius: `modelRadius * 0.95 * modelScale` => `57`
- controller eye height: `modelEyeHeight * modelScale` => `120`

This keeps the same visible avatar appearance while shrinking hitbox width to match the rendered body size.

### Map scale in export-reader

- export-reader applies `mapWorldScale = 1.5`
- terrain config is scaled on load (`worldOrigin`, `unitScale`, `heightMin`, `heightMax`)
- entity transforms are scaled before collision build
- result: character appears smaller relative to map space without changing external package files

### New-export-only load behavior

Reader load pipeline now requires and enforces:

1. `manifest.json`
2. `transform-conventions.json`
3. `visual-settings.json`
4. RH entity index/file path from transform/manifest contract

Reader then loads entities using:

- `matrixFormat = three-matrix4-column-major`
- `entity-index-rh.json`

This removes importer-side entity Z-flip/matrix reflection logic in the reader path.

## 7. Sky and Lighting Configuration

Sky and lighting come from two layers:

1. shader sky/fog defaults in viewer code
2. directional/ambient/hemi lighting from `environment.json` when available

### Current aligned sky/fog defaults

Used by full-viewer and export-reader:

- sky top color: `0x4488cc`
- sky bottom color: `0xd4c5a0`
- horizon color: `0xc8b888`
- exponent: `0.5`
- fog: `FogExp2(0xc8b888, 0.0000035)`

### Sunlight path (`environment.json`)

Fields currently applied:

- `sunlight.dir`
- `sunlight.diffuse`
- `sunlight.ambientColor`
- `sunlight.skyLightColor`

Fields typically present but not fully consumed for dynamic behavior:

- `moonlight.*`
- `enableDayNightCycle`
- intensity multipliers like `ambientIntensity`, `skyLightIntensity`, `commonLightIntensity`

### Exported visual settings (`visual-settings.json`)

To simplify external importers, export now also includes `map-data/visual-settings.json` containing:

- gradient sky colors and exponent
- fog model and density
- directional light and shadow defaults
- ambient and hemisphere defaults/fallbacks
- environment binding notes for `environment.json`

Reader uses this file as the primary visual contract for sky/fog/light defaults.

## 8. Validator and Quality Gates

`/full-validator.html` checks:

- required and optional core files
- mesh and texture existence
- heightmap and terrain texture references
- consistency warnings between entities and mesh maps

Recommended promotion rule:

- only promote packages with PASS-level validator output

## 9. Coordinate and Transform Notes

- Render runtime uses right-handed world space.
- Entity matrices are exported in two forms:
  - `entities/full.json`: source-lh-row-major (backward-compatible)
  - `entities/full.rh.json`: three-matrix4-column-major (import-ready for RH engines)
- `transform-conventions.json` describes these contracts and explicitly marks RH file as no Z-flip-required.
- Sidecar collision is local mesh-space and must be transformed by entity matrix before world BVH build.

External importer recommendation:

- Prefer RH files only: `entity-index-rh.json` + `entities/full.rh.json`.
- Do not apply additional Z-flip to those RH transforms.

## 10. Porting to Another Repo

Minimum files to port together:

- `public/export-reader.html`
- `public/js/export-reader.js`
- `public/full-viewer.html`
- `public/js/full-viewer.js`

Feature parity rule (strict):

- Any new reader built from this guide must include every control and every display/debug feature present in this repo's export-reader.
- Do not omit controls, toggles, HUD stats, collision debug lines, or GLB collision box displays.

Minimum backend support:

- full export APIs
- full export static route under `/full-exports/`
- package listing API

### Copy/paste handoff instruction

Use this instruction in the target repo:

```text
Implement the export-reader walk validator exactly like this project:
- third-person controller
- sidecar collision loading from map-data/mesh-collision-index.json and meshes/*.glb.collision.json
- BVH world collision
- wall-stop behavior (no wall pop-up)
- indoor walkability fix (do not snap to roof when under building)
- left-drag camera rotate with inverted vertical drag
- mouse wheel camera distance zoom
- speed presets on 1/2/3
- continuous Space jump while held
- avatar visual scale 0.5x with collision width matched to visible body
- include every control, toggle, HUD display, collision shell line display, and GLB collision box display that exists in this repo reader (no omissions)
Also wire a Walk Reader launcher from full-viewer and preserve package query loading.
Validate with syntax check plus in-browser house-interior walk test.
```

## 11. Operational Checklist

1. Start server and verify routes respond.
2. Export package (regional or full collision mode).
3. Verify package includes RH and visual contract files:
  - `entity-index-rh.json`
  - `entities/full.rh.json`
  - `transform-conventions.json`
  - `visual-settings.json`
4. Open full viewer and load package.
5. Open export reader and verify walk/collision behavior.
6. Run full validator and inspect missing asset counts.
7. Keep package immutable once promoted.

## 12. Build And Read Flow (Simplified)

Build correctly:

1. Export using full/regional collision endpoint.
2. Ensure manifest includes RH/visual contract references.
3. Ensure package contains RH entities + transform + visual settings files.

Read correctly:

1. Load manifest.
2. Load transform conventions.
3. Load visual settings.
4. Load RH entities only.
5. Load terrain, textures, meshes.
6. Load collision sidecars and build world collision.
7. Render with visual settings defaults + environment overrides.
8. Run validation before promotion.

## 13. Troubleshooting

If collision feels blocked indoors:

- inspect sidecar shell geometry for closed solids around interior
- verify floor/ceiling classification and support-ray origin logic

If player snaps to roof:

- verify support ray does not originate far above character
- verify step-up threshold is active

If collision appears missing:

- check `mesh-collision-index.json` summary and entry statuses
- verify sidecar file path encoding for Unicode mesh names

If lighting still differs:

- confirm `environment.json` is present in package
- compare environment sunlight values with live source
- align or extend environment field consumption for day/night and intensity multipliers
