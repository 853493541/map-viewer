# JX3 Map Editor

## Project Summary

A web-based 3D map **editor** for the JiangXiong3 (JX3) game. Started as a viewer, now upgraded to a full map editor under **Plan "Game Changer"**.

**Current Phase:** Plan "Game Changer" — converting viewer to editor

---

## Plan "Game Changer"

Since broken meshes cannot be fixed through the rendering pipeline alone, the strategy is to **replace broken meshes with good ones** by editing the map directly.

### Editor Features (in progress)
1. **Mesh visibility control** — Disable/enable meshes using verdicts (approved/denied) list with checkboxes
2. **Mesh selection & transform** — Click to select, move (X/Y/Z), place anywhere, delete
3. **Partial map mode** — Extract rectangular regions to create custom sub-maps
4. **Full editor UI** — No longer just a viewer

### Viewer Phase (completed)
- **597 GLB meshes** converted from game `.mesh` binary format
- **586 meshes fully textured** (albedo + optional MRE, normal map) via `texture-map.json`
- **4,964 map entities** placed correctly using `entity-index.json` + `mesh-map.json`
- **Verdicts system** — approve/deny each mesh, stored in `verdicts.json`
- Correct LH→RH coordinate system conversion (Z-negate + winding reversal)
- Alpha transparency, normal map Y-flip, PBR rendering with MRE channel swap
- GBK-first encoding for all JX3 JsonInspack files

### What Was Not Solved (motivates Plan "Game Changer")
- **91 denied meshes** with broken normals — cannot fix without replacing them
- **11 GLBs without textures** — SRT trees + 1 missing texture set

---

## Architecture

```
jx3-web-map-viewer/
├── INSTRUCTIONS.md                 # Session instructions (read every time)
├── KNOWN-ISSUES.md                 # All known bugs, errors, findings
├── CACHE-EXTRACTION-REFERENCE.md   # Cache extraction details (reference only)
├── serve.py                        # HTTP server (port 3000)
├── source-meshes/                  # 587 .mesh + 587 .JsonInspack (source files)
├── public/
│   ├── index.html                  # Map editor UI (THREE.js)
│   ├── mesh-inspector.html         # Per-mesh approve/deny inspector
│   ├── js/
│   │   ├── app.js                  # Editor core (terrain, camera, UI, editing)
│   │   ├── entities.js             # Entity instanced mesh rendering
│   │   ├── terrain.js              # Terrain heightmap rendering
│   │   ├── collision.js            # Ray-cast entity picking
│   │   └── player-controller.js   # First-person camera
│   └── map-data/
│       ├── meshes/                 # 597 converted .glb files
│       ├── textures/               # 1,470 PNG textures
│       ├── entities/               # 25 region entity JSON files
│       ├── verdicts.json           # Approve/deny decisions per mesh (506/91)
│       └── ...                     # Config, heightmap, texture-map, etc.
└── tools/                          # Python build scripts
```

---

## Usage

### Run the editor
```powershell
cd jx3-web-map-viewer
python serve.py
# Open http://localhost:3000
```

### Inspect/approve individual meshes
```
http://localhost:3000/mesh-inspector.html
```

---

## Related Documents
- [INSTRUCTIONS.md](INSTRUCTIONS.md) — Session instructions and communication rules
- [KNOWN-ISSUES.md](KNOWN-ISSUES.md) — All known bugs, errors, and findings
- [CACHE-EXTRACTION-REFERENCE.md](CACHE-EXTRACTION-REFERENCE.md) — Cache extraction pipeline details

---

*Plan "Game Changer" — in progress*
