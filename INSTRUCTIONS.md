# JX3 Web Map Viewer - Unified Instructions

This is the single internal instruction file for the repository.

## 1. Current Product State

The project is now focused on these active pages:
- Editor: public/index.html
- Export Reader (main runtime validation page): public/export-reader.html
- Mesh Inspector: public/mesh-inspector.html
- Collision Test (single-mesh validator): public/collision-test-mode.html
- Full Viewer is intentionally paused: public/full-viewer.html

All active pages now include a shared top header for cross-navigation.

## 2. Source Of Truth Policies

### 2.1 Collision policy (hard rule)
- Sidecar collision is the only supported collision source for export-reader and collision-test runtime behavior.
- Use mesh-collision-index.json and per-mesh sidecars (*.collision.json).
- Do not reintroduce runtime fallback to generated render-geometry collision.
- Do not rely on map-level collision.json as a required runtime dependency.

### 2.2 Export policy
- Export package generation is sidecar-only for collision outputs.
- Export contract must include RH entity data and visual settings.

### 2.3 Reader contract policy
- Export Reader expects:
  - transform-conventions.json
  - visual-settings.json
  - entity-index-rh.json + entities/full.rh.json
- Unsupported matrix contracts should fail fast.

## 3. Operational Commands

## 3.1 Start local server (recommended)
From repository root:

```powershell
npm run local
```

First-time setup:

```powershell
npm install
```

Notes:
- `npm run local` automatically prepares browser runtime libs in `public/lib` from `node_modules`.
- `public/lib` is generated and should stay untracked.

Or on Windows CMD/PowerShell:

```powershell
start-localhost
```

Default URL:
- http://localhost:3015

## 3.2 Alternative start

```powershell
node server.js
```

## 4. Main APIs

- GET /api/full-exports
- POST /api/export-full
- POST /api/export-full-with-collision
- POST /api/export-regional-with-collision
- GET/HEAD /full-exports/<package>/...

Note: export-full-with-collision and export-regional-with-collision are sidecar-only export routes.

## 5. Repository Layout (important paths)

- public/
  - index.html
  - export-reader.html
  - mesh-inspector.html
  - collision-test-mode.html
  - full-viewer.html
  - js/
    - app.js
    - export-reader.js
    - collision-test-mode.js
    - full-viewer.js
- tools/
  - collision-generator.js
- server.js
- package.json
- start-localhost.cmd

## 6. Removed Or Paused Features

The following are intentionally removed or paused unless explicitly requested:
- Full Viewer runtime UI (paused page placeholder only)
- Legacy map-level collision runtime reliance
- Old validator page flow
- Legacy editor features previously removed in simplification passes

## 7. Documentation Map

Only keep these core docs as canonical:
- INSTRUCTIONS.md (this file)
- EXPERIENCES.md (lessons learned: mistakes, findings, what worked)
- EXTERNAL_EXPORT_READER_GUIDE.md (external integration guide)
- PIPELINE.md (quick startup pipeline commands)

If any other guide is reintroduced, it must not conflict with these files.

## 8. Change Discipline

Before shipping major changes:
1. Confirm sidecar-only collision behavior is still enforced.
2. Confirm page header navigation still links all active pages.
3. Confirm local startup command still works.
4. Keep docs synchronized with actual behavior.

## 9. Git Tracking Policy (standalone runtime, no large assets)

Track these:
- App/server source: `public/*.html`, `public/js/**`, `server.js`, `serve.py`, `tools/**`
- Small map metadata and terrain essentials: `public/map-data/*.json`, `public/map-data/entities/**`, `public/map-data/heightmap/**`, `public/map-data/terrain-textures/index.json`
- Operational docs and startup scripts: `INSTRUCTIONS.md`, `EXPERIENCES.md`, `EXTERNAL_EXPORT_READER_GUIDE.md`, `PIPELINE.md`, `start-localhost.cmd`

Do not track these:
- Large generated assets: `public/map-data/meshes/*.glb`, `public/map-data/textures/**`, `source-meshes/**`
- Generated runtime libs and dependency folders: `public/lib/**`, `node_modules/**`
