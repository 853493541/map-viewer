# Known Issues, Errors, Mistakes & Findings

This file documents all known bugs, rendering artifacts, pipeline errors, and hard-won discoveries across the entire project history. Read this before any session to avoid repeating past mistakes.

---

## 1. Broken/Denied Meshes (91 GLBs)

| Issue | Detail |
|---|---|
| Count | 91 meshes denied in `verdicts.json` (506 approved) |
| Root cause | Compressed SNorm8 normals have ~24.7% inward-pointing normals due to UNorm8 quantization artifacts |
| Why visible | JX3 engine masks inward normals with thick textures; textureless THREE.js viewer exposes them |
| Attempted fixes | Smooth recompute (destroys hard edges), flat normals (worse), raw unchanged (best achievable) |
| Status | **NOT FIXABLE** without manual mesh editing or replacing with good meshes |

## 2. Untextured Meshes (11 GLBs)

| Mesh | Cause |
|---|---|
| `S_xb多枝枯树003_001` through `_010` (10 trees) | SRT SpeedTree format, no `.JsonInspack` companion found — textures unknown |
| `wj_木堆001_hd` | JsonInspack exists but referenced texture PNGs missing from disk |
| **Status** | Render as beige/default color. Cannot fix without locating original textures |

## 3. Normal Encoding Mistakes (FIXED)

| What went wrong | Impact | Fix |
|---|---|---|
| Used UNorm8 decode `(byte/127.5) - 1.0` | Only 5–25% face-normal agreement | Changed to SNorm8 `signed_int8(byte)/127.0` → 76–96% agreement |
| `_fix_compressed_normals()` from quantized positions | Flipped 31% of normals incorrectly (avg_dot=0.37) | Removed entirely — raw decoded normals are correct |
| `_recompute_smooth_normals()` | Destroyed hard edges, made buildings "melted" | Removed — never recompute normals for comparison |

## 4. texture-map.json Wipeout (FIXED)

| What happened | A run of `build_texture_atlas.py` with wrong `JISP_DIR` wiped `texture-map.json` to 0 entries |
| Fix | Rebuilt via `rebuild_texture_map.py` → 586 entries |
| Lesson | **Always verify JISP_DIR points to correct folder before running texture scripts** |

## 5. GBK Encoding Mistakes (FIXED)

| What went wrong | Impact | Fix |
|---|---|---|
| `parse_jsoninspack` tried UTF-8 first | 5 meshes got garbled Chinese paths → no texture-map entry → white meshes | Changed to GBK-first, UTF-8 fallback |
| Path hashing used UTF-8 | Wrong cache hash lookups for Chinese paths | All hashing now uses GBK encoding |
| **Rule** | **ALWAYS decode GBK first for all JX3 files. Never try UTF-8 first.** |

## 6. Source Priority Mistakes (FIXED)

| What went wrong | Impact | Fix |
|---|---|---|
| `build_map_data.py` chose `backup_all/` before `source/` | All 94 denied meshes rebuilt from stale compressed snapshot | Fixed priority: cache-extraction > source > backup_all |
| `build_official_meshes.py` recomputed smooth normals | Destroyed hard edges on compressed meshes | Removed smooth recomputation path |

## 7. LH→RH Conversion Rules (VERIFIED CORRECT)

| Transform | Formula |
|---|---|
| Positions | Negate Z |
| Normals | Negate Z |
| Tangent XYZ | Negate Z |
| Tangent W | Negate (bitangent handedness) |
| Triangle winding | Reverse: `(i0, i1, i2)` → `(i0, i2, i1)` |
| Entity matrix | `M_rh = S * M_lh * S` where `S = diag(1,1,-1,1)` |

## 8. Texture Rendering Bugs (FIXED)

| Bug | Fix |
|---|---|
| flipY mismatch | Set `tex.flipY = false` — glTF UVs have origin at upper-left |
| MRE channel swap | Game: M(R),R(G),E(B). THREE.js expects different order. Canvas R↔B swap in `loadMRECached()` |
| Normal map Y-flip | JX3=DX convention (Y-down), THREE.js=GL (Y-up). Set `normalScale = new Vector2(1, -1)` |
| Alpha test missing | 271 subsets with BlendMode=1 rendered opaque. Added `alphaTest` for BM=1, `AdditiveBlending` for BM=2 |

## 9. Cache Extraction Findings

| Finding | Detail |
|---|---|
| Compression | LZHAM (NOT zlib), compressType=10, skip 20-byte header |
| Hash format | `h2 = (djb2(dir,GBK) << 40) | xxHash64(path,GBK)` |
| Extension swap | Materials reference `.tga`, cache stores `.dds` — try both |
| Yield | 159,003 records decompressed; 5,371 DDS + 180 TGA + 2,147 PNG textures |
| Success rate | 99.6% (558 failures out of 159,003) |

## 10. Source vs Cache Mesh Differences

| Finding | Detail |
|---|---|
| 6/8 tested pairs | Identical geometry (positions match <0.08 units) |
| 2/8 tested pairs | Completely different meshes (different vertex counts or positions 175–998 units apart) |
| Conclusion | Source and cache may contain **different builds/versions** of same asset |

## 11. Mesh Format Gotchas

| Gotcha | Detail |
|---|---|
| Compression detection | By bytes-per-vertex: 8–12 = compressed, 20–44 = uncompressed |
| Compression flags | 0xE0/E4/E8/EC000000 = compressed, also 0x000186A1 |
| Position block sentinel | Compressed blocks have 4-byte 0xFFFFFFFF terminator |
| Face indices | ALWAYS uint32, never quantized |
| Subset indices | Compressed=uint16, uncompressed=uint32 |
| Tangent offset | At header offset 0xD0, NOT 0xC0 |
| LOD meshes | Always uncompressed (float32) |

## 12. GLB Roundtrip Verified

- Position diff: 0.00006 (effectively zero)
- Normal diff: 0.00000003 (effectively zero)
- **GLB export/import is lossless** — any visual issues are in the source mesh, not the pipeline

## 13. SpeedTree (.srt) Files

| Count | 21 `.srt` files referenced in scene |
| Status | No `.srt` parser exists. These trees are simply not renderable |
| Impact | 16 missing mesh references in entity data |

---

*Last updated: Start of Plan "Game Changer"*
