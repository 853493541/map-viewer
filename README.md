# JX3 Web Map Viewer

This repository contains the current web tooling for inspecting, editing, and validating JX3 map data in a browser.

## Active Pages

- `public/index.html` — Editor / map manager landing page
- `public/export-reader.html` — Main export package validation page
- `public/actor-viewer.html` — MovieEditor actor export viewer for skeleton and animation validation
- `public/mesh-inspector.html` — Regional mesh approval and denial workflow
- `public/collision-test-mode.html` — Single-mesh sidecar collision walk test

`public/full-viewer.html` still exists as a paused page, but it is intentionally hidden from the main navigation.

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

## Current Behavior Rules

- Collision Test and Export Reader use sidecar collision only.
- Runtime collision should come from `*.collision.json` sidecars and `mesh-collision-index.json`.
- Full Viewer is paused and should not be treated as an active workflow.

## Main Routes And APIs

Pages:

- `/`
- `/index.html`
- `/export-reader.html`
- `/actor-viewer.html`
- `/mesh-inspector.html`
- `/collision-test-mode.html`

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
│   ├── export-reader.html
│   ├── actor-viewer.html
│   ├── mesh-inspector.html
│   ├── collision-test-mode.html
│   ├── full-viewer.html
│   ├── js/
│   └── map-data/
├── tools/
├── server.js
├── package.json
├── start-localhost.cmd
├── INSTRUCTIONS.md
├── PIPELINE.md
├── EXPERIENCES.md
└── EXTERNAL_EXPORT_READER_GUIDE.md
```

## Canonical Docs

- [INSTRUCTIONS.md](INSTRUCTIONS.md) — current repo behavior and working rules
- [PIPELINE.md](PIPELINE.md) — quick startup commands
- [EXPERIENCES.md](EXPERIENCES.md) — lessons learned and pitfalls
- [EXTERNAL_EXPORT_READER_GUIDE.md](EXTERNAL_EXPORT_READER_GUIDE.md) — export-reader integration contract
