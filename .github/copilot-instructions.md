# Project Rules

Canonical repository instructions live in `INSTRUCTIONS.md`. This file exists so Copilot loads the repo rules automatically; do not add separate policy here without updating `INSTRUCTIONS.md` first.

Bootstrap rules repeated here for safety:

- Re-read every file from disk immediately before editing it.
- Run and validate the app on `http://127.0.0.1:3015`; if port `3015` is occupied, kill the listener and restart on `3015`.
- PSS mesh-binding audits must classify launcher class first: material-class launchers pass when `materialIndex` resolves; trail-class/ribbon launchers pass when the type-3 ParticleTrack block has a resolvable texture.
- `materialIndex == null` / `nMaterialIndex = 0xFFFFFFFF` on Trail-class launchers is expected and is not a gap.
