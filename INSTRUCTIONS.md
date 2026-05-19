# JX3 Web Map Viewer - Unified Instructions

This is the single internal instruction file for the repository.

## Top-Level Copilot Workflow Rules

- Before editing any file, read the current on-disk file content first so changes are based on the newest version.
- Always run and validate the app on http://127.0.0.1:3015. If port 3015 is already in use, stop the current listener and restart on 3015 before reporting a working local URL.
- Before telling the user a fix is done or giving a final result, check errors for the affected files and visible runtime/browser errors for the affected page. Fix relevant issues first, or explicitly report what still fails.
- When the user asks multiple numbered questions or points, answer each one separately.
- For debugging and fix reports, always include a table with exactly these columns: What is wrong | What is fixed | What to test.
- For each major point, include Answer, What was done, and What to test when applicable.
- Prefer structured tables over long paragraphs when reporting multiple findings, hypotheses, or fixes.
- Keep final reports easy to scan and do not collapse distinct user questions into one blended explanation.
- When reading EXPERIENCES.md or any dated historical notes, treat them as prior findings, not current truth. Verify relevant claims against the current on-disk code, docs, and runtime before relying on them.
- If a historical note no longer matches the current repo state, follow the current verified behavior and call out the stale note explicitly instead of repeating it as fact.
- Use the remaining sections in this file and the linked repository docs for product facts and domain-specific rules.

## 1. Current Product State

## 1.1 Round 2 Actor Goal

- Replace placeholder avatar swaps with the actual game-authored actor pipeline.
- Use MovieEditor actor exports as the validation path for assembled body parts, real skeleton binding, and usable animation playback.
- Target future runtime support for avatar movement, walking, jumping, and animation-state selection on top of that actor data instead of static mesh replacement.

The repository currently serves these HTML pages. The index is a front page that links all current pages. The shared topbar must display one category row for the current tool page, plus a top-left home link:
- Front page: public/index.html
- Editor: public/editor.html
- Actor Viewer: public/actor-viewer.html
- Animation Player: public/actor-animation-player.html
- Mesh Inspector: public/mesh-inspector.html
- PSS: public/pss.html
- Collision Test: public/collision-test-mode.html
- Export Reader: public/export-reader.html
- Ability Matcher: public/ability-matcher.html
- TANI-SOUND: public/ability-tani-sound.html
- Client Monitor: public/client-monitor.html
- Soundbanks: public/wwise-soundbanks.html
- CDN Browser: public/cdn-resource-browser.html

Shared topbar rows:
- Resources: CDN Browser, Client Monitor
- Maps: Editor, Export Reader, Actor Viewer, Mesh Inspector, Collision Test
- Animation: Animation Player, PSS
- Sound: Ability Matcher, TANI-SOUND, Soundbanks

Retired pages:
- public/sounds.html
- public/local-pakv5.html
- public/full-viewer.html

Header source of truth:
- server.js injects public/shared-topbar.css and public/shared-topbar.js into every served .html response.
- Update public/shared-topbar.js whenever an HTML page is added, removed, or renamed.

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
- http://127.0.0.1:3015

## 3.2 Alternative start

```powershell
node server.js
```

## 4. Main APIs

- GET /api/full-exports
- GET /api/actor-exports
- GET /api/cache-entry/preview
- GET /api/cache-entry/raw
- POST /api/export-full
- POST /api/export-full-with-collision
- POST /api/export-regional-with-collision
- GET/HEAD /full-exports/<package>/...
- GET/HEAD /movie-editor-assets/<path>
- GET /api/client-monitor/status
- POST /api/client-monitor/pause
- POST /api/client-monitor/resume
- POST /api/ability-matcher/tani-sound-export-package

Note: export-full-with-collision and export-regional-with-collision are sidecar-only export routes.

## 5. Repository Layout (important paths)

- public/
  - index.html
  - editor.html
  - export-reader.html
  - actor-viewer.html
  - mesh-inspector.html
  - collision-test-mode.html
  - shared-topbar.css
  - shared-topbar.js
  - js/
    - app.js
    - actor-viewer.js
    - export-reader.js
    - collision-test-mode.js
- tools/
  - collision-generator.js
- server.js
- package.json
- start-localhost.cmd

## 6. Removed Or Paused Features

The following are intentionally removed or paused unless explicitly requested:
- Full Viewer page and runtime UI
- Legacy map-level collision runtime reliance
- Old validator page flow
- Legacy editor features previously removed in simplification passes

## 7. Documentation Map

Instruction source of truth:
- INSTRUCTIONS.md is the canonical internal instruction file.
- .github/copilot-instructions.md is a Copilot loader bridge for the same rules, not a second policy source.

Tracked Markdown inventory:

| Path | Role | INSTRUCTIONS.md reference status |
| --- | --- | --- |
| .github/copilot-instructions.md | Copilot loader bridge | Referenced |
| INSTRUCTIONS.md | Canonical internal instructions | Self |
| README.md | User-facing overview and startup commands | Referenced |
| EXPERIENCES.md | Lessons learned and pitfalls | Referenced |
| EXTERNAL_EXPORT_READER_GUIDE.md | Export-reader integration contract | Referenced |
| PSS_RENDER_FIX_CHECKLIST.md | Empty legacy checklist placeholder | Referenced |
| tools/bin/ww2ogg/README.md | Third-party ww2ogg README | Referenced as third-party |
| tools/bin/ww2ogg/notes.md | Third-party ww2ogg notes | Referenced as third-party |

If any other guide is reintroduced, it must be added to this table and must not conflict with the canonical rules.

## 8. Additional Change Checks

Before shipping major changes, also:
- Confirm sidecar-only collision behavior is still enforced.
- Confirm page header navigation still links all served HTML pages.
- Confirm local startup command still works.
- Keep docs synchronized with actual behavior.

## 9. PSS Debug Ownership Rule

For PSS and runtime debug-log tasks:
- The assistant must read debug logs directly, identify issues, and apply fixes.
- Do not ask the user to inspect logs manually.
- After each fix iteration, rerun and re-read logs to confirm the result before reporting completion.

## 9.1 PSS Audit Truth Table

- `materialIndex == null` (the launcher authored `nMaterialIndex = 0xFFFFFFFF`) on a Trail-class / ribbon launcher is expected, not a gap. Trail launchers get their texture from the type-3 ParticleTrack block through the procedural ribbon renderer.
- Mesh-binding audit must classify launchers by class first and pick the right success criterion:
  - Material-class launcher: `materialIndex` resolves.
  - Trail-class launcher: track block has a resolvable texture.

## 10. Git Tracking Policy (standalone runtime, no large assets)

Track these:
- App/server source: `public/*.html`, `public/js/**`, `public/shared-topbar.*`, `server.js`, `serve.py`, `tools/**`
- Small map metadata and terrain essentials: `public/map-data/*.json`, `public/map-data/entities/**`, `public/map-data/heightmap/**`, `public/map-data/terrain-textures/index.json`
- Operational docs and startup scripts: `README.md`, `INSTRUCTIONS.md`, `.github/copilot-instructions.md`, `EXPERIENCES.md`, `EXTERNAL_EXPORT_READER_GUIDE.md`, `PSS_RENDER_FIX_CHECKLIST.md`, `start-localhost.cmd`

Do not track these:
- Large generated assets: `public/map-data/meshes/*.glb`, `public/map-data/textures/**`, `source-meshes/**`
- Generated runtime libs and dependency folders: `public/lib/**`, `node_modules/**`
