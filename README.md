# JX3 Web Map Viewer

This repository contains the current web tooling for inspecting, editing, and validating JX3 map data in a browser.

## Active Pages

- `public/index.html` — Front page with navigation to all current pages
- `public/editor.html` — Editor / map manager page
- `public/export-reader.html` — Main export package validation page
- `public/actor-viewer.html` — MovieEditor actor export viewer for skeleton and animation validation
- `public/actor-animation-player.html` — Actor animation playback and validation page
- `public/mesh-inspector.html` — Regional mesh approval and denial workflow
- `public/pss.html` — PSS particle inspection page
- `public/collision-test-mode.html` — Single-mesh sidecar collision walk test
- `public/ability-matcher.html` — Ability/resource matching page
- `public/ability-tani-sound.html` — Final TANI-SOUND review and export page
- `public/wwise-soundbanks.html` — Wwise soundbank browser
- `public/cdn-resource-browser.html` — CDN resource browser
- `public/client-monitor.html` — Live client capture monitor

## Quick Start

From the repository root:

```powershell
npm install
npm run local
```

Default URL:

- `http://localhost:3015`

Windows shortcut:

```powershell
start-localhost
```

Other equivalent start commands:

```powershell
npm run dev
npm start
node server.js
```

## Runtime Notes

- `npm run local` auto-generates browser runtime libs into `public/lib` from `node_modules`.
- `public/lib` is generated output and should remain untracked.
- Large extracted assets such as `public/map-data/meshes`, `public/map-data/textures`, and `source-meshes` are not part of the lightweight runtime setup.
- The UI shell can start without those large assets, but asset-driven pages need local map data or exported packages to do useful work.
- `actor-viewer.html` can also read MovieEditor exports directly from `C:\SeasunGame\MovieEditor\source\fbx` when that local tool install is present.

## Wwise Event Folder Export

The generated Wwise bank tree uses numeric WEM filenames. To recover usable folders, rebuild the Wwise event index and export by original event object path:

```powershell
npm run wwise:index
npm run wwise:event-folders -- --query qicheng_longya --write-wem --decode-ogg --out cache-extraction/wwise-event-folders-qicheng-longya
```

For a large run, omit `--query` and keep the default output folder:

```powershell
npm run wwise:event-folders -- --write-wem --decode-ogg
```

Outputs are written under `cache-extraction/wwise-event-folders`: `manifest.tsv`, `manifest.jsonl`, `summary.json`, and a `by-event` folder tree. Each row includes the Wwise event name, object path, WEM id, source Wwise path, CDN path/package, and materialized WEM/OGG status.

## Current Behavior Rules

- Collision Test and Export Reader use sidecar collision only.
- Runtime collision should come from `*.collision.json` sidecars and `mesh-collision-index.json`.
- Full Viewer has been removed and should not be treated as an active workflow.

## Main Routes And APIs

Pages:

- `/`
- `/index.html`
- `/editor.html`
- `/export-reader.html`
- `/actor-viewer.html`
- `/actor-animation-player.html`
- `/mesh-inspector.html`
- `/pss.html`
- `/collision-test-mode.html`
- `/ability-matcher.html`
- `/ability-tani-sound.html`
- `/wwise-soundbanks.html`
- `/cdn-resource-browser.html`
- `/client-monitor.html`

Key APIs:

- `GET /api/meshes`
- `GET /api/verdicts`
- `GET /api/full-exports`
- `GET /api/actor-exports`
- `POST /api/export-full`
- `POST /api/export-full-with-collision`
- `POST /api/export-regional-with-collision`

## Repository Layout

```text
jx3-web-map-viewer/
├── public/
│   ├── index.html
│   ├── editor.html
│   ├── export-reader.html
│   ├── actor-viewer.html
│   ├── actor-animation-player.html
│   ├── mesh-inspector.html
│   ├── pss.html
│   ├── collision-test-mode.html
│   ├── ability-matcher.html
│   ├── ability-tani-sound.html
│   ├── wwise-soundbanks.html
│   ├── cdn-resource-browser.html
│   ├── client-monitor.html
│   ├── js/
│   └── map-data/
├── tools/
├── server.js
├── package.json
├── start-localhost.cmd
├── INSTRUCTIONS.md
├── EXPERIENCES.md
└── EXTERNAL_EXPORT_READER_GUIDE.md
```

## Canonical Docs

- [INSTRUCTIONS.md](INSTRUCTIONS.md) — current repo behavior, working rules, and reporting format
- [EXPERIENCES.md](EXPERIENCES.md) — lessons learned and pitfalls
- [EXTERNAL_EXPORT_READER_GUIDE.md](EXTERNAL_EXPORT_READER_GUIDE.md) — export-reader integration contract
- [.github/copilot-instructions.md](.github/copilot-instructions.md) — Copilot loader bridge for `INSTRUCTIONS.md`

See [INSTRUCTIONS.md](INSTRUCTIONS.md) for the full tracked Markdown inventory.
