# Full Ivwerwe Guide

## Goal
Build and run a fully self-contained map package flow:
1. Export one regional map into one full package on Desktop.
2. Open Full Viewer and load only that package.
3. Validate package completeness before integrating into gameplay systems.

## What Is Already Implemented

### 1) Full export API (Desktop package output)
- Server endpoint: POST /api/export-full
- Output root: Desktop/JX3FullExports
- Package content:
  - manifest.json
  - map-data/map-config.json
  - map-data/environment.json (if source has it)
  - map-data/entity-index.json
  - map-data/entities/full.json
  - map-data/mesh-map.json
  - map-data/mesh-list.json
  - map-data/official-meshes.json
  - map-data/verdicts.json
  - map-data/meshes/*.glb (used meshes)
  - map-data/texture-map.json (subset)
  - map-data/textures/* (used textures)
  - map-data/heightmap/* (selected tiles)
  - map-data/terrain-textures/index.json (subset)
  - map-data/terrain-textures/* (used terrain textures)

### 2) Full Viewer
- URL: /full-viewer.html
- Loads package list from GET /api/full-exports
- Loads selected package from /full-exports/<package>/map-data
- Uses existing TerrainSystem + EntitySystem + CollisionSystem + PlayerController

### 3) Full Validator
- URL: /full-validator.html
- Checks package completeness:
  - required core files
  - optional core files
  - mesh existence
  - texture existence
  - heightmap and terrain texture existence
  - mesh-map and entity consistency warnings
- Supports report export as JSON

## No-External-Resource Contract

### Required behavior
Full Viewer and Full Validator must not require CDN or external host.

### Confirmed implementation details
- full-viewer.html imports local three module only.
- full-viewer.js fetches only:
  - /api/full-exports
  - /full-exports/<package>/...
- terrain.js and entities.js read assets from this.dataPath only.
- this.dataPath in Full Viewer is set to /full-exports/<package>/map-data.

### Notes
- GLTFLoader.js contains many https links in comments/spec references.
- These are comments only and not runtime fetch targets.

## How To Run Locally
1. Start server from jx3-web-map-viewer.
2. Open main viewer and export a region with Full Export.
3. Open Full Viewer and load exported package.
4. Open Full Validator and validate same package.

## Build/Port Checklist For Another Repo
Use this exact order.

1. Add server APIs and static route
- GET /api/full-exports
- POST /api/export-full
- static route /full-exports/*
- HEAD support for fast validator checks

2. Add export button wiring in map editor/viewer
- Collect current instanced runtime matrices
- Send payload to /api/export-full
- Open returned full-viewer URL

3. Add Full Viewer page
- package dropdown
- load selected package
- set dataPath = /full-exports/<package>/map-data
- no external imports

4. Add Full Validator page
- validate required files and referenced assets
- export report JSON

5. Gate integration by validator status
- Block gameplay integration for FAIL reports
- Only allow PASS package promotion

## Package Data Contract (v1)

### Entity transform contract
- Package stores source-lh-row-major matrix for entities.
- Viewer runtime converts using existing entities.js conversion path.

### Terrain contract
- map-config.json and heightmap bins drive terrain reconstruction.
- terrain-textures/index.json maps tiles to texture files.

### Manifest contract
- manifest.stats should reflect copied assets.
- Include region and regionCorners if regional export.

## How To Merge With Full Play System

### Recommended architecture
Create a map provider abstraction with two backends:
1. LiveSourceProvider (existing source file pipeline).
2. FullPackageProvider (new exported package pipeline).

Gameplay systems should consume only provider outputs, never raw file paths.

### Integration stages

#### Stage A: Read-only runtime swap
- Keep full play logic unchanged.
- Replace map data input with FullPackageProvider.
- Verify collisions, spawn, and LOS against package assets.

#### Stage B: Feature parity
- Minimap, fog, lighting, and region restrictions from manifest + map-data.
- Ensure package and live mode produce same in-game coordinates.

#### Stage C: Production guardrails
- On session/map start, run validator policy checks:
  - required files present
  - mesh/texture missing count = 0
  - heightmaps complete for selected region
- Reject package when checks fail.

### High-value merge insights
1. Keep one coordinate contract and centralize conversion helpers.
2. Keep visual and collision data from same package snapshot.
3. Keep package versioned and immutable once promoted.
4. Never let gameplay code resolve source cache paths directly.
5. Add deterministic package hash to client/server handshake to prevent desync.

## Immediate Next Improvements
1. Add server-side package hash generation in manifest.
2. Add validator threshold profiles (strict vs debug).
3. Add one-click Promote Package action after PASS.
4. Add package pinning in full play match config.
