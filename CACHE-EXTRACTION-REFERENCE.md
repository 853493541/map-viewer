# Cache Extraction Reference

This file contains the cache extraction pipeline details, extracted from the main README for reference when needed. This is NOT part of the active plan — only consult when cache-related work is required.

---

## Cache Locations

| Cache | Path | Size | Use |
|---|---|---|---|
| Client | `zsCache/dat/` | ~0.1MB per FN file | Downloader meta only, NOT useful for assets |
| Editor | `seasun/zscache/dat/` | 11 GB (8 × ~1.38GB .dat) | Main asset cache (161,677 index entries) |

## Cache Index Format (`0.idx`)

- 36-byte header: magic(0x00123459) + version(0x00001006) + file_size(4) + entry_count(4) + padding(20)
- Entries: 36 bytes each, format `<QQIIIII>` = hash(u64), offset(u64), orig_size(u32), comp_size(u32), seq(u32), blocks(u32), meta(u32)
  - `compress_type = meta & 0xFF` (must be 10 = LZHAM)
  - `dat_file_index = (meta >> 12) & 0xF`

## Compression: LZHAM

- **DLL**: `seasun/editortool/qseasuneditor/seasunapp/httppacking/lzham_x64.dll`
- **Function**: `lzham_z_uncompress(dst, &dst_len, src, src_len)` → returns 0 on success
- Skip first 20 bytes of each entry (header), rest is LZHAM payload
- 99.6% success rate: 558 failures out of 159,003 entries

## Hash Functions (CRACKED)

### h2 Hash (FN files): composite 64-bit
```
h2 = (dir_hash << 40) | file_hash
dir_hash = djb2(lower(parent_dir).encode('gbk'), init=5381) & 0x3FFFFF  (22-bit)
file_hash = xxHash64(lower(full_path).encode('gbk'), seed=0) & 0xFFFFFFFFFF  (40-bit)
```

### h1 Hash (IDX files): UNKNOWN
- 60-bit effective range, bypassed via h2→h1 reverse lookup through FN entries

### Encoding
- **GBK** for all paths
- Extension swap: materials reference `.tga`, cache stores `.dds` — try both

## Extraction Results

| Type | Count | Size |
|---|---|---|
| DDS textures | 5,371 | 2.93 GB |
| TGA textures | 180 | 201 MB |
| PNG textures | 2,147 | 28 MB |
| JSON files | ~75K | — |
| PE binaries | ~3K | — |

## Scripts
- `cache-extraction/extract_mapped_textures.py` — Extract specific textures by hash
- `cache-extraction/build_texture_atlas.py` — Build texture atlas from extracted data
- `cache-extraction/rebuild_texture_map.py` — Rebuild texture-map.json

## Python Path
```
$py311 = "C:\SeasunGame\...\seasun\editortool\qmodeleditor\tools\blender\4.2\python\bin\python.exe"
```

---

*This is a reference document. The active plan is in INSTRUCTIONS.md.*
