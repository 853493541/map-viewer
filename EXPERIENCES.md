# JX3 Web Map Viewer - Experiences

This file records what we found, what mistakes we made, and what worked.

## 1. What We Found

## 1.1 Mesh and normals reality
- A subset of meshes has bad shading due to compressed normal artifacts.
- Those meshes are not reliably fixable by naive recompute methods.
- Replacing bad assets or controlling visibility is often safer than forcing normal rebuilds.

## 1.2 Encoding and data pipeline facts
- GBK-first decoding is critical for JX3 asset metadata paths.
- UTF-8-first decoding caused path corruption and missing texture lookups.
- Cache extraction and hash workflows are sensitive to exact encoding and normalization.

## 1.3 Runtime collision architecture
- Sidecar collision is the trustworthy runtime source.
- Sidecar index + per-mesh sidecars gives deterministic mesh collision coverage.
- Runtime fallback to render-derived collision produced unstable behavior and noisy validation.

## 1.4 UX and product direction
- Simplified workflows outperformed feature-heavy flows.
- Cross-page access is important; global header links reduced friction.
- Full Viewer runtime UI is currently paused to reduce maintenance burden.

## 1.5 Actor pipeline facts
- MovieEditor actors are part-based assemblies driven by `.actor` definitions, not single merged avatar meshes.
- The local actor export notes confirm skin export is matched onto a standard body-type skeleton (`F1`, `F2`, `M1`, `M2`).
- Current MovieEditor notes say only the bip skeleton skin data is exported; physical bones and facial bones are not fully exported.
- The inspected local install exposes `.ani` action files under the editor-tool MovieEditor source tree; no `.tani` files were found in the inspected local SeaSun install.

## 1.6 VERY IMPORTANT: detached face and hat follow root cause
- The face and hat follow system in `public/js/actor-viewer.js` already existed, but it stayed inactive until attachment state was initialized during actor load.
- The real fix was to set `this.current.attachments = this.createHeadAttachments(exportInfo, root)` inside `onFbxLoaded()` and run `this.updateHeadAttachments()` once immediately.
- We should not assume a missing external MovieEditor rule first when detached parts look frozen; first verify that runtime attachment initialization is actually wired.
- MovieEditor import/export docs describe body bip-skeleton action import/export, and face has separate face-animation assets/tables, but we did not find a separate hat-follow instruction file.

## 2. Mistakes We Made

## 2.1 Technical mistakes
- Used wrong normal decode assumptions in earlier phases.
- Tried aggressive normal recompute paths that damaged hard edges.
- Mixed fallback collision paths, causing inconsistent movement and validation results.
- Relied on stale assumptions in docs after code moved to sidecar-only policy.
- Spent time searching for an external fix for detached face and hat movement before confirming that the existing viewer attachment system was never initialized on load.

## 2.2 Documentation mistakes
- Kept multiple overlapping guides with conflicting statements.
- Left references to removed pages and old collision.json fallback model.
- Allowed typo/duplicate guides to remain in repo.

## 3. What Worked

## 3.1 Rendering and data handling
- Preserving decoded source data over over-processing gave better visual stability.
- Enforcing contract-based export metadata (RH matrix + visual settings) improved compatibility.

## 3.2 Collision and movement
- Sidecar-only collision in export-reader and collision-test stabilized walk validation.
- Explicitly blocking walk mode when sidecar is missing prevented false confidence.
- Using terrain support + sidecar shell logic improved grounding and camera clipping behavior.

## 3.3 Process improvements
- Running diagnostics after each patch reduced regressions.
- Consolidating docs reduced confusion and maintenance overhead.
- Keeping one canonical instruction file plus one external guide made handoff easier.
- Reading the current on-disk file before editing avoided patching stale or inactive code paths.

## 4. Current Best Practices

1. Treat sidecar collision as mandatory runtime truth.
2. Keep docs synced with code changes in the same PR.
3. Prefer removing unstable fallback paths over hiding them.
4. Keep startup flow simple: one command from repo root.
5. If behavior is paused, say so explicitly in UI and docs.
6. When detached actor parts look frozen, check load-time attachment initialization before hunting for missing asset instructions.

## 5. Known Remaining Risks

- Some assets still depend on upstream source quality limits.
- External consumers may still assume old collision.json fallback flows.
- Any future feature revival should be done behind clear flags and updated docs.

## 6. Actor Editor Deep Binary Analysis (2025-01-19 session)

### 6.1 MIN2 Animation Format

**Header layout** (0x42 bytes for bone_count=1):
| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | Magic: `MIN2` |
| 0x04 | 4 | File size (uint32, sometimes 0 for face files) |
| 0x08 | 4 | Version (uint32, always 1) |
| 0x0C | 4 | Bone count (uint32) |
| 0x10 | 30 | Bone name (null-terminated string, GB18030) |
| 0x2E | 4 | Vertex count (uint32) |
| 0x32 | 4 | Vertex count 2 (uint32, meaning TBD) |
| 0x36 | 4 | Frame count (uint32) |
| 0x3A | 4 | FPS (float32, typically 33.08 or 33.33) |
| 0x3E | 4 | Vertex count 3 (uint32, 0=no normals, 1=has normals) |
| 0x42 | vc*8 | Two index tables (vc*4 bytes each) |
| ... | vc*fc*12 | Position data (float32 x,y,z per vertex per frame) |
| ... | vc*fc*12 | Normal data (optional, present when vc3>0) |

**Key findings:**
- **bone_count=1**: Single-bone vertex animation (morph targets). Used by PSS effects. Our existing parser handles these correctly.
- **bone_count>1**: Multi-bone format. Each bone after the first has its own sub-record: `[bone_name(30) | vc(4) | vc2(4) | fc(4) | fps(4) | vc3(4) | indices(vc*8) | positions(vc*fc*12) | normals(optional)]`. This repeats for each bone.
- Data ratio when vc3=0: ~1.0 (positions only). When vc3>0: ~2.0 (positions + normals).

### 6.2 Actor Plot Files

**Location**: `seasun/editortool/movieeditor/source/plot/actor/`
- 86 plot folders (七秀, 万花, 敖龙岛, etc.)
- 1253 `.actor` INI files defining character assemblies
- 404 `.ani` files (ALL in 敖龙岛/决战幽冥壑/动作/)
- 2083 `.kms` files (skeletal keyframe animations)
- Audio in `音频资源/` subdirectories with `.wav` files

**Actor .ani categories** (all 404 files have bone_count=13):
1. **Face animations** (`*_face_*.ani`): 14 files. Bone names are morph target names: "tongue", "smile_r", "smile_l", "ridge_r", "pupil_r", etc.
2. **Body deform animations** (`*_body_hd.ani`): Files with mesh part names: "FBR4_M21008dbody17_01", etc.
3. **Skeletal animations** (remaining): Files with real bone names: "Bip01", "ADD_L101", "ADD_R101", "B_Spine", "Bone_R_ThighTwist", etc.

### 6.3 Audio Pipeline

- Actor Editor uses **Wwise** for runtime audio + `.tani` SoundTag system
- `AniTable.txt`: Maps animation IDs to `.tani` files
- `Tani.rt`: Binary runtime table for SoundTag→Wwise event mapping
- Per-plot `.wav` files in `音频资源/` are the raw audio assets (up to 28.4 MB)
- `ActionMusic.tab` and `ActionWwiseEvent.tab` in PropertyTemplate define action-to-audio mappings

### 6.4 PSS Effect .ani Statistics

From the 17 PSS effect `.ani` files extracted:
- 14 files: bone_count=1, successfully playable as vertex animation
- 3 files: bone_count=13, dropped (q_蜻蜓单只, y_鸭子游泳, h_蝴蝶03a_hd)
- 8/14 playable files have per-frame normals (vc3>0) that are currently ignored
- Missing normals cause flat shading on animated meshes

### 6.5 centerAndScaleMesh Fix

The `centerAndScaleMesh()` function in `pss-renderer-v3.js` had a sign error:
- **Bug**: `position = +scale * meshCenter` (moved mesh further from origin)
- **Fix**: `position = -scale * meshCenter` (correctly centers mesh at origin)
- Root cause: `geo.center()` returns the old center, not a displacement. The mesh position must be set to `-center * scale` to counteract the scaled center offset.
