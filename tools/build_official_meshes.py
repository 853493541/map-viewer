#!/usr/bin/env python3
"""
build_official_meshes.py  —  Convert ONLY meshes that have a .JsonInspack companion file.
Uses cache-extracted meshes as the sole source.
"""

import os
import sys
import json
from pathlib import Path

SCRIPT_DIR   = Path(__file__).parent
PROJECT_DIR  = SCRIPT_DIR.parent
CACHE_DIR    = (PROJECT_DIR / 'source-meshes').resolve()
OUTPUT_DIR   = PROJECT_DIR / 'public' / 'map-data' / 'meshes'
MAPDATA_OUT  = PROJECT_DIR / 'public' / 'map-data'

sys.path.insert(0, str(SCRIPT_DIR))
from build_map_data import parse_mesh_file, parse_jsoninspack, mesh_to_glb


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if not CACHE_DIR.exists():
        print(f'ERROR: source folder not found: {CACHE_DIR}')
        sys.exit(1)

    # Collect mesh+JsonInspack pairs from cache-extracted meshes
    candidates = []
    for mesh_path in sorted(CACHE_DIR.glob('*.mesh')):
        companion = mesh_path.with_suffix('.JsonInspack')
        if companion.exists():
            candidates.append((mesh_path, companion))

    print(f'=== build_official_meshes ===')
    print(f'  Source dir : {CACHE_DIR}')
    print(f'  Output     : {OUTPUT_DIR}')
    print(f'  Candidates : {len(candidates)} .mesh files with .JsonInspack companion')

    converted = 0
    failed    = 0
    skipped   = 0
    recomputed_normals = 0
    official_meshes = []
    mesh_map = {}

    # Load existing mesh-map.json so we can merge without wiping other entries
    mesh_map_path = MAPDATA_OUT / 'mesh-map.json'
    if mesh_map_path.exists():
        try:
            mesh_map = json.loads(mesh_map_path.read_text(encoding='utf-8'))
        except Exception:
            pass

    for mesh_path, companion_path in candidates:
        try:
            mesh_data = parse_mesh_file(str(mesh_path))
        except Exception as e:
            print(f'  FAIL parse  : {mesh_path.name}: {e}')
            failed += 1
            continue

        try:
            subset_materials = parse_jsoninspack(str(companion_path))
        except Exception:
            subset_materials = None

        try:
            glb = mesh_to_glb(mesh_data, subset_materials)
        except Exception as e:
            print(f'  FAIL convert: {mesh_path.name}: {e}')
            failed += 1
            continue

        out_name = mesh_path.stem + '.glb'
        out_path = OUTPUT_DIR / out_name
        out_path.write_bytes(glb)

        official_meshes.append(out_name)
        mesh_map[mesh_path.name.lower()] = f'meshes/{out_name}'
        converted += 1
        if converted % 10 == 0:
            print(f'  Converted {converted}...')

    print(f'\n  Converted : {converted} ({recomputed_normals} normals recomputed)')
    print(f'  Failed    : {failed}')
    print(f'  Skipped   : {skipped}  (no companion)')

    # Write outputs
    (MAPDATA_OUT / 'official-meshes.json').write_text(
        json.dumps(sorted(official_meshes), indent=2), encoding='utf-8'
    )
    mesh_map_path.write_text(
        json.dumps(mesh_map, indent=2, ensure_ascii=False), encoding='utf-8'
    )

    print(f'  official-meshes.json : {len(official_meshes)} entries')
    print(f'  mesh-map.json updated')
    print('=== Done ===')


if __name__ == '__main__':
    main()
