# JX3 Web Map Viewer - Unified Instructions

This is the single internal instruction file for the repository.

## 1. Current Product State

## 1.1 Round 2 Actor Goal

- Replace placeholder avatar swaps with the actual game-authored actor pipeline.
- Use MovieEditor actor exports as the validation path for assembled body parts, real skeleton binding, and usable animation playback.
- Target future runtime support for avatar movement, walking, jumping, and animation-state selection on top of that actor data instead of static mesh replacement.

The project is now focused on these active pages:
- Editor: public/index.html
- Export Reader (main runtime validation page): public/export-reader.html
- Actor Viewer (MovieEditor actor export validator): public/actor-viewer.html
- Resource Manager (MovieEditor effect catalog and socket trace): public/resource-manager.html
- Special Effects Preview (live cache-backed viewer with synthetic fallback for uncached rows): public/special-effects.html
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
- GET /api/actor-exports
- GET /api/special-effects
- GET /api/special-effects-preview
- `/api/special-effects-preview` searches the full SFX catalog, marks real cache hits, and provides metadata-driven synthetic fallback info for uncached rows.
- GET /api/cache-entry/preview
- GET /api/cache-entry/raw
- POST /api/export-full
- POST /api/export-full-with-collision
- POST /api/export-regional-with-collision
- GET/HEAD /full-exports/<package>/...
- GET/HEAD /movie-editor-assets/<path>

Note: export-full-with-collision and export-regional-with-collision are sidecar-only export routes.

## 5. Repository Layout (important paths)

- public/
  - index.html
  - export-reader.html
  - actor-viewer.html
  - resource-manager.html
  - special-effects.html
  - mesh-inspector.html
  - collision-test-mode.html
  - full-viewer.html
  - js/
    - app.js
    - actor-viewer.js
    - special-effects.js
    - sfx-preview.js
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
- README.md (user-facing overview + startup commands)
- INSTRUCTIONS.md (this file: internal policies, APIs, reporting rules)
- EXPERIENCES.md (lessons learned: mistakes, findings, what worked)
- EXTERNAL_EXPORT_READER_GUIDE.md (external integration guide)
- cache-extraction/.instructions.md (folder-scoped cache-extraction phase notes)

If any other guide is reintroduced, it must not conflict with these files.

## 8. Change Discipline

Before shipping major changes:
0. Before editing any file, read the current on-disk file content first so edits are based on the newest version, not stale cached context.
1. Before telling the user a fix is done or giving a final result, check errors for the affected files and any visible runtime/browser errors for the affected page. Fix relevant errors first, or explicitly report that they still exist.
2. Confirm sidecar-only collision behavior is still enforced.
3. Confirm page header navigation still links all active pages.
4. Confirm local startup command still works.
5. Keep docs synchronized with actual behavior.

## 9. Reporting Format Requirement

For this repository's task reports and final user-facing summaries:
- When the user asks multiple numbered questions or points, answer each one separately.
- Always include a chart/table in debugging and fix reports with exactly these columns:
  - What is wrong
  - What is fixed
  - What to test
- Prefer chart/table style over long paragraphs whenever the task includes multiple findings or debugging results.
- For each major point, include three parts when applicable:
  - Answer
  - What was done
  - What to test
- Do not collapse multiple user questions into one blended explanation.
- Final reports should be easy to scan quickly and should favor structured comparison tables when there are multiple findings, hypotheses, or fixes.

## 10. PSS Debug Ownership Rule

For PSS and runtime debug-log tasks:
- The assistant must read debug logs directly, identify issues, and apply fixes.
- Do not ask the user to inspect logs manually.
- After each fix iteration, rerun and re-read logs to confirm the result before reporting completion.

## 11. Git Tracking Policy (standalone runtime, no large assets)

Track these:
- App/server source: `public/*.html`, `public/js/**`, `server.js`, `serve.py`, `tools/**`
- Small map metadata and terrain essentials: `public/map-data/*.json`, `public/map-data/entities/**`, `public/map-data/heightmap/**`, `public/map-data/terrain-textures/index.json`
- Operational docs and startup scripts: `INSTRUCTIONS.md`, `EXPERIENCES.md`, `EXTERNAL_EXPORT_READER_GUIDE.md`, `PIPELINE.md`, `start-localhost.cmd`

Do not track these:
- Large generated assets: `public/map-data/meshes/*.glb`, `public/map-data/textures/**`, `source-meshes/**`
- Generated runtime libs and dependency folders: `public/lib/**`, `node_modules/**`
