# Next Repo Reader Adaptation Guide

This is the single handoff guide for porting the export reader and walk-collision behavior into another repository.

## Scope

Port these files and behaviors as one unit:

- public/export-reader.html
- public/js/export-reader.js
- public/full-viewer.html
- public/js/full-viewer.js

## Required Runtime Behavior

The reader must load one Desktop export package and allow third-person walk validation with sidecar collision.

### Camera and controls

- Left mouse drag rotates camera.
- Vertical drag is inverted from default mouse look:
  - drag down: camera looks down
  - drag up: camera looks up
- Mouse wheel changes camera distance.
- W/A/S/D moves character.
- Shift enables sprint.
- Space continuously applies upward jump while held.
- G toggles gravity mode.
- Digit 1 sets slow speed.
- Digit 2 sets normal speed.
- Digit 3 sets fast speed.

### Character

- Third-person avatar is visible.
- Avatar visual scale is 0.5x.

## Collision Data Contract

Reader uses exported sidecars, not old global shell-only flow.

Expected files under package map-data:

- map-config.json
- environment.json (optional)
- entities.json
- mesh-collision-index.json (optional but recommended)
- meshes/*.glb.collision.json

## Collision System Requirements

### Sidecar loading

- Read mesh-collision-index.json if present.
- Fallback sidecar path per mesh: meshes/<meshName>.glb.collision.json
- Parse shell triangles from sidecar JSON.
- Transform sidecar local triangles into world space using entity matrix conversion.
- Build one world collision BufferGeometry and MeshBVH.

### Walk collision rules

- Wall contact should stop/slide horizontal movement.
- Wall/ceiling contact must not inject vertical push that launches character upward.
- Grounding should only occur on floor-like contact.
- Support ground ray must start near player height (not very high above), so roofs overhead are not selected as floor.
- Keep a limited recovery ray for below-support recovery.
- Keep a max auto step-up height to avoid snapping to roof tops.

## UI/Integration Requirements

- export-reader page has package select + load + validator/resource shortcuts.
- Show collision debug toggle should display shell line mesh.
- full-viewer includes Walk Reader button that opens:
  - /export-reader.html?pkg=<selected package>

## Acceptance Checklist

Run these checks after porting:

1. Reader page returns HTTP 200.
2. Package loads and status line reports sidecars loaded/missing.
3. Can enter house interiors without being treated as blocked by ceiling/roof collision.
4. Walking into wall stops movement instead of popping onto roof.
5. Under-roof movement does not snap player to top of building.
6. Left-drag vertical camera is inverted as specified.
7. Wheel camera distance zoom works.
8. 1/2/3 speed presets switch movement speed.

## Troubleshooting

- If interiors are blocked, inspect sidecar shell geometry for closed solids around interiors.
- If player snaps upward, verify support ray origin is near player and step-up limit is active.
- If collision appears empty, verify mesh-collision-index.json entries and sidecar URL encoding.
- If camera clips through geometry, verify camera clipping raycast uses world BVH.

## Copy/Paste Instruction For Next Repo Agent

Use this exact request in the next repo:

Implement the export-reader walk validator exactly like this project:
- third-person controller
- sidecar collision loading from map-data/mesh-collision-index.json and meshes/*.glb.collision.json
- BVH world collision
- wall-stop behavior (no wall pop-up)
- indoor walkability fix (do not snap to roof when under building)
- left-drag camera rotate with inverted vertical drag
- mouse wheel camera distance zoom
- speed presets on 1/2/3
- continuous Space jump while held
- avatar visual scale 0.5x
Also wire a Walk Reader launcher from full-viewer and preserve package query loading.
Validate with syntax check plus in-browser house-interior walk test.
