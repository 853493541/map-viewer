# Project Instructions

## Communication Rules

1. **For every point the user makes** — fully understand it, think about what they need, and execute it.
2. **For every question mark typed** — answer in a chart/table format.
3. **At the end of every response** — give a detailed response to every point the user made.
4. **Read `KNOWN-ISSUES.md`** at the start of every session as part of instructions.
5. **AFTER READING, at the start of the next response, REREAD full instructions again** — always re-read this file before responding.

## Project: Plan "Game Changer"

### Vision
The viewer is now an **editor**. We couldn't fix broken meshes through the pipeline, so the new strategy is to **replace broken meshes with good ones** by editing the map directly.

### Goals (in order)
1. **Mesh visibility control** — Disable/enable individual meshes from displaying on the map using the verdicts (approved/denied) list with checkboxes
2. **Mesh selection & editing** — Click a mesh in the panel or on the map to select it. Move it (X, Y, Z), place it anywhere, delete it
3. **Partial map mode** — Select a rectangular region (X1,Y1 → X2,Y2) from the full map. Extract all meshes in that region to create a "custom map" that can be loaded independently
4. **Full editor identity** — The app is no longer a "viewer", it's a map editor

### Files to read each session
- `INSTRUCTIONS.md` (this file)
- `KNOWN-ISSUES.md` (all known bugs, errors, findings)
- `CACHE-EXTRACTION-REFERENCE.md` (only when cache work is needed)

### Architecture notes
- Frontend: `public/index.html` + `public/js/app.js` (main), `entities.js`, `terrain.js`, `collision.js`, `player-controller.js`
- Backend: `serve.py` (HTTP server on port 3000)
- Data: `public/map-data/` — GLBs, textures, entity JSON, verdicts, config
- Tools: `tools/` — Python build scripts
- Verdicts: `public/map-data/verdicts.json` — `{approved: [...], denied: [...]}`
