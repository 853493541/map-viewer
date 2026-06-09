# External Export Reader Guide

This guide is for external users integrating the export package format and building a compatible Export Reader.

## 1. Goal

Build a reader that:
- loads Desktop export packages,
- renders terrain and entities,
- uses sidecar collision only,
- supports third-person walk validation.

## 2. Package Location

By default exports are written to:
- Desktop/JX3FullExports/<packageName>/

Packages are served by:
- /full-exports/<packageName>/...

## 3. Required Files In Export Package

Under package root:
- manifest.json

Under map-data:
- map-config.json
- transform-conventions.json
- visual-settings.json
- entity-index-rh.json
- entities/full.rh.json
- mesh-map.json
- mesh-list.json
- texture-map.json
- meshes/*.glb
- mesh-collision-index.json (recommended index)
- meshes/<mesh>.collision.json (sidecar per mesh)

Optional:
- environment.json
- terrain-textures/index.json and atlas textures

## 4. Export APIs

- POST /api/export-full
- POST /api/export-full-with-collision
- POST /api/export-regional-with-collision

Current behavior:
- Collision export is sidecar-only.
- Legacy combined collision.json output is disabled.

## 5. Sidecar Collision Contract

## 5.1 sidecar index
mesh-collision-index.json contains:
- summary expected/written/missing/failedWrites
- entries[] with mesh name and sidecar path

## 5.2 sidecar file
meshes/<mesh>.collision.json contains:
- parts: broad-phase local boxes
- shells: triangle shells
- status/hasCollision/collisionStats

## 5.3 load order
1. Load mesh-collision-index.json when present.
2. Resolve mesh -> sidecar path.
3. Fallback path when missing index entry: meshes/<mesh>.collision.json.
4. Parse sidecar shells and parts.
5. Transform local collision by entity world matrix.
6. Build world BVH from transformed shell triangles.

## 6. Transform And Matrix Requirements

Reader expects RH normalized matrix contract:
- entities.normalizedRhMatrixFormat = three-matrix4-column-major
- entities.normalizedRhRequiresImporterZFlip = false

If matrix contract is missing or incompatible, fail fast.

## 7. Export Reader Runtime Configurations (current)

These are the key configuration values used by public/js/export-reader.js:

## 7.1 world scale and rendering
- mapWorldScale: 1.5
- renderer toneMapping: ACESFilmic
- toneMappingExposure: 1.25
- camera fov: 60
- camera near/far: 20 / 500000

## 7.2 character and movement
- modelRadius: 120
- modelEyeHeight: 240
- modelScale: 0.5
- collision radius: modelRadius * 0.95 * modelScale
- baseSpeed: 2200
- speedLevel default: 6
- runMultiplier: 1.8
- jumpSpeed: 1400
- gravity: 3800

## 7.3 camera follow
- cameraDistanceMin: 220
- cameraDistanceMax: 1800
- cameraDistance default: cameraDistanceMax
- minCameraDistance (collision-safe): 260
- cameraHeight: 120
- pitch limits: -0.55 to 0.6
- mouseSensitivity: 0.002

## 7.4 controls
- Left mouse drag: rotate camera
- Mouse wheel: camera distance
- W/A/S/D or arrows: move
- Shift: sprint
- Space: continuous jump while held
- G: gravity toggle
- 1/2/3: speed presets (slow/normal/fast)

## 7.5 UI debug toggles
- Show collision shells
- Show GLB collision boxes

## 8. Integration Blueprint

1. Fetch package list from /api/full-exports.
2. Select package and load manifest + map-data metadata.
3. Load terrain from map-config and heightmap resources.
4. Load entities from RH index/files.
5. Load GLBs and textures lazily by visibility.
6. Build sidecar world collision system.
7. Run walk controller with collision resolution and terrain support.
8. Expose status line for sidecar loaded/missing counts.

## 9. Validation Checklist

1. Package loads successfully.
2. Sidecar loaded/missing counts are visible.
3. Character cannot pass through walls.
4. Character can move through interiors when valid sidecar geometry allows.
5. Camera clips safely around geometry.
6. Missing sidecars are reported clearly.

## 10. Common Failure Cases

- Wrong path encoding when loading sidecars.
- Missing RH transform contract files.
- Treating render mesh geometry as collision fallback.
- Assuming collision.json exists in new exports.

If compatibility with older exports is needed, add a separate legacy adapter module and keep sidecar-only behavior as default.
