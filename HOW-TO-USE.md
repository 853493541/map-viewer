# JX3 Map Editor — How To Use

## Quick Start

### 1. Start the Server

```powershell
cd "c:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\jx3-web-map-viewer"
python serve.py
```

Open **http://localhost:3000** in your browser. That's it.

> Alternative (Node.js):
> ```powershell
> node server.js
> ```

---

## Editor Controls

### Modes (top bar)
| Key | Mode | What it does |
|-----|------|-------------|
| `C` | Camera | FPS camera — click canvas to lock pointer, WASD to move |
| `V` | Select | Click meshes to select, drag to box-select |

### Camera (while pointer-locked)
| Input | Action |
|-------|--------|
| WASD | Move horizontally |
| Space | Fly up |
| Shift | Sprint (3x speed) |
| Ctrl | Fly down |
| Mouse wheel | Change speed (15 levels) |
| G | Toggle gravity |
| Escape | Release pointer lock |

### Panels & Shortcuts
| Key | Action |
|-----|--------|
| `R` | Toggle Region dialog |
| `M` | Toggle Mesh browser panel |
| `Ctrl+S` | Save dialog |
| `Ctrl+Z` | Undo |
| `Ctrl+C` | Copy selected meshes |
| `Delete` | Delete selected mesh(es) |
| `Q` | Rotate selection -90° |
| `E` | Rotate selection +90° |
| Arrow keys | Nudge selected mesh(es) |
| PgUp/PgDn | Move selection up/down |

### Selection & Transform
- In **Select mode**: click a mesh to select it → 3D gizmo arrows appear
- Drag the gizmo arrows to translate the mesh
- Use Q/E or the rotation buttons (±90°) in the transform panel
- Box-select: hold left click and drag in Select mode
- Multi-select: green wireframe highlights all selected meshes

---

## Region Tool (Arena Extraction)

1. Press **R** to open the Region dialog
2. Method A — **Number entry**: type min/max X/Z coordinates
3. Method B — **Draw rectangle**: click "Draw" button, drag on the map
4. Method C — **Pen polygon**: click "Pen" button, click points to define corners
5. Adjust individual pillar corners by selecting and dragging them
6. The 3D box follows the 4 pillar corners as a quadrilateral

### Export a Map Region

1. Define your region with the Region tool
2. Click **📦 Full Export** in the Region dialog
3. A `.json` file downloads with entities + terrain + config
4. Share this file or import it into the zhenchuan game

### Import a Map

1. Press **R** to open the Region dialog
2. Click **📥 Import Map**
3. Select a previously exported `.json` file
4. The editor loads the entities and terrain from the file

---

## Saving & Loading Custom Maps

- **Ctrl+S** → Save dialog: name your map, choose overwrite or save-as-new
- Custom maps are stored in browser **localStorage**
- Also downloads a `.json` backup file
- On page load, the last-saved custom map auto-loads

---

## Mesh Inspector (separate page)

```
http://localhost:3000/mesh-inspector.html
```

View individual GLB meshes, approve/deny them (verdicts system).

---

## Pipeline Commands (for re-converting game assets)

> **You only need these if you want to regenerate the map data from scratch.**
> The editor works fine without running these — `public/map-data/` already has all converted assets.

### Prerequisites
- Python 3.10+ (available at `seasun/zscache/dat/python/python.exe` or system Python)
- Game files in `../seasun/client/data/UGC/binkp1/龙门寻宝/`

### Full rebuild (heightmaps + entities + meshes)

```powershell
cd "c:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\jx3-web-map-viewer"
python tools/build_map_data.py
```

This reads from:
- `../seasun/client/data/UGC/binkp1/龙门寻宝/` — heightmaps, scene entities
- `source-meshes/` — cache-extracted mesh + JsonInspack pairs
- `../seasun/client/data/UGC/binkp1/source/` — backup mesh sources

Outputs to:
- `public/map-data/heightmap/` — Float32 heightmap tiles
- `public/map-data/entities/` — per-region entity JSON
- `public/map-data/meshes/` — GLB 3D models
- `public/map-data/mesh-map.json`, `official-meshes.json`, etc.

### Rebuild only meshes (from source-meshes/)

```powershell
cd "c:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\jx3-web-map-viewer"
python tools/build_official_meshes.py
```

Reads `.mesh` + `.JsonInspack` pairs from `source-meshes/` → converts to `.glb` in `public/map-data/meshes/`.

### Rebuild texture-map.json

```powershell
cd "c:\SeasunGame\Game\JX3\bin\zhcn_hd\SeasunDownloaderV2.4\jx3-web-map-viewer"
python tools/rebuild_texture_map.py
```

Re-parses all `.JsonInspack` files in `source-meshes/` and matches them to PNGs in `public/map-data/textures/`. Outputs `texture-map.json`.

---

## Repo Structure

```
jx3-web-map-viewer/
├── serve.py               # HTTP server (port 3000) ← START HERE
├── server.js              # Alternative Node.js server
├── public/
│   ├── index.html         # Editor UI
│   ├── mesh-inspector.html
│   ├── js/
│   │   ├── app.js         # Editor core (~3400 lines)
│   │   ├── entities.js    # InstancedMesh entity rendering
│   │   ├── terrain.js     # Heightmap terrain
│   │   ├── collision.js   # Raycasting for mesh picking
│   │   └── player-controller.js # FPS camera
│   └── map-data/          # All converted game assets (gitignored binaries)
├── source-meshes/         # Raw .mesh + .JsonInspack pairs (gitignored)
└── tools/                 # Python conversion scripts
    ├── build_map_data.py          # Full pipeline (heightmaps + entities + meshes)
    ├── build_official_meshes.py   # Mesh-only pipeline
    └── rebuild_texture_map.py     # Texture map rebuild
```

---

## What's Gitignored (won't be in the online repo)

These are large binary assets that must be regenerated locally or downloaded:
- `source-meshes/` — raw game mesh files (~600 pairs)
- `public/map-data/meshes/*.glb` — 597 converted 3D models
- `public/map-data/heightmap/*.bin` — terrain heightmap tiles
- `public/map-data/entities/*.json` — per-region entity data
- `public/lib/` — three.js local copy (CDN fallback works)
- `public/map-data/minimap.png`, `regioninfo.png`

**What IS committed**: textures (1470 PNGs), terrain textures (129 PNGs), config JSONs, all source code, all tools.

---

## Adding New Maps (for zhenchuan integration)

1. Open the editor → load the full map
2. Use the Region tool to define your arena area
3. Place/move/delete meshes as needed
4. Click **📦 Full Export** → get a `*-full-export.json`
5. Copy the export JSON + required GLB files to the zhenchuan repo
6. The game's R3F components load the JSON and render the map
