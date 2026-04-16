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

## 2. Mistakes We Made

## 2.1 Technical mistakes
- Used wrong normal decode assumptions in earlier phases.
- Tried aggressive normal recompute paths that damaged hard edges.
- Mixed fallback collision paths, causing inconsistent movement and validation results.
- Relied on stale assumptions in docs after code moved to sidecar-only policy.

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

## 4. Current Best Practices

1. Treat sidecar collision as mandatory runtime truth.
2. Keep docs synced with code changes in the same PR.
3. Prefer removing unstable fallback paths over hiding them.
4. Keep startup flow simple: one command from repo root.
5. If behavior is paused, say so explicitly in UI and docs.

## 5. Known Remaining Risks

- Some assets still depend on upstream source quality limits.
- External consumers may still assume old collision.json fallback flows.
- Any future feature revival should be done behind clear flags and updated docs.
