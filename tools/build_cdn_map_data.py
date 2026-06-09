#!/usr/bin/env python3
"""Build editor map-data from a materialized CDN map source tree."""

import argparse
import hashlib
import json
import os
import shutil
import struct
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from build_map_data import load_json_file, mesh_to_glb, parse_jsoninspack, parse_mesh_file


def parse_args():
    parser = argparse.ArgumentParser(description='Build web map-data from materialized CDN map files.')
    parser.add_argument('--map-name', required=True)
    parser.add_argument('--source-root', required=True, help='Root containing data/source/...')
    parser.add_argument('--output', default=str(PROJECT_DIR / 'public' / 'map-data-bailong'))
    parser.add_argument('--clean', action='store_true')
    parser.add_argument('--max-meshes', type=int, default=0, help='Debug limit; 0 means no limit')
    parser.add_argument('--include-baked', action='store_true', help='Add baked map meshes as identity entities')
    return parser.parse_args()


def read_text_loose(path):
    raw = Path(path).read_bytes()
    try:
        return raw.decode('gbk')
    except (UnicodeDecodeError, ValueError):
        return raw.decode('utf-8', errors='replace')


def load_json_loose(path):
    text = read_text_loose(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        trimmed = extract_json_document(text)
        return json.loads(trimmed)


def extract_json_document(text):
    start = next((idx for idx, char in enumerate(text) if not char.isspace() and char != '\ufeff'), -1)
    if start < 0:
        raise ValueError('Empty JSON document')
    if text[start] == '"':
        text = '{' + text[start:]
        start = 0
    elif text[start] not in '{[':
        brace = text.find('{', start)
        bracket = text.find('[', start)
        starts = [pos for pos in (brace, bracket) if pos >= 0]
        if not starts:
            raise ValueError('Could not find JSON document start')
        start = min(starts)

    stack = []
    in_string = False
    escaped = False
    for idx in range(start, len(text)):
        char = text[idx]
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in '{[':
            stack.append('}' if char == '{' else ']')
        elif char in '}]':
            if not stack or char != stack[-1]:
                raise ValueError('Mismatched JSON document delimiters')
            stack.pop()
            if not stack:
                return text[start:idx + 1]
    raise ValueError('Could not find JSON document end')


def ensure_clean_output(output_dir, clean):
    output_dir = Path(output_dir)
    protected = (PROJECT_DIR / 'public' / 'map-data').resolve()
    if clean and output_dir.resolve() == protected:
        raise SystemExit('Refusing to clean public/map-data; choose a side-by-side output folder')
    if clean and output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)


def normalize_logical_path(value):
    return str(value or '').replace('\\', '/').replace('\\\\', '/').lstrip('/').replace('//', '/')


def logical_to_disk(source_root, logical_path):
    normalized = normalize_logical_path(logical_path)
    direct = source_root / Path(normalized.replace('/', os.sep))
    if direct.exists():
        return direct
    parent = direct.parent
    if parent.exists():
        target = direct.name.lower()
        for child in parent.iterdir():
            if child.name.lower() == target:
                return child
    return direct


TEXTURE_EXTENSIONS = {'.dds', '.tga', '.png', '.bmp'}
ALBEDO_KEYS = {'basecolormap', 'basecolor', 'base_albedo', 'map_diffuse'}
MRE_KEYS = {'map(mre)', 'base_mre'}
NORMAL_KEYS = {'normal map', 'basenormalmap', 'base_normal', 'map_bump', 'map_nor'}


def build_source_file_lookup(source_root, suffixes=None):
    suffixes = {suffix.lower() for suffix in suffixes} if suffixes else None
    lookup = {}
    for path in source_root.rglob('*'):
        if not path.is_file():
            continue
        if suffixes and path.suffix.lower() not in suffixes:
            continue
        try:
            rel = path.relative_to(source_root).as_posix().lower()
        except ValueError:
            continue
        lookup.setdefault(rel, path)
    return lookup


def texture_role(param_name):
    key = str(param_name or '').lower().strip()
    if key in ALBEDO_KEYS:
        return 'albedo'
    if key in MRE_KEYS:
        return 'mre'
    if key in NORMAL_KEYS:
        return 'normal'
    return None


def texture_candidates(logical_path):
    normalized = normalize_logical_path(logical_path)
    if not normalized:
        return []
    candidates = [normalized]
    suffix = Path(normalized).suffix.lower()
    if suffix == '.tga':
        candidates.append(normalized[:-len(suffix)] + '.dds')
    return candidates


def resolve_texture_file(source_root, file_lookup, logical_path):
    for candidate in texture_candidates(logical_path):
        hit = file_lookup.get(candidate.lower())
        if hit and hit.exists():
            return hit
        direct = logical_to_disk(source_root, candidate)
        if direct.exists():
            return direct
    return None


def safe_texture_name(source_path, used_names, normalized_source):
    candidate = source_path.name
    key = candidate.lower()
    if key not in used_names:
        used_names.add(key)
        return candidate
    digest = hashlib.sha1(normalized_source.encode('utf-8')).hexdigest()[:8]
    candidate = f'{source_path.stem}_{digest}{source_path.suffix.lower()}'
    used_names.add(candidate.lower())
    return candidate


def copy_texture_file(source_path, texture_dir, texture_state):
    normalized_source = str(source_path.resolve()).lower()
    cached = texture_state['by_source'].get(normalized_source)
    if cached:
        return cached
    out_name = safe_texture_name(source_path, texture_state['used_names'], normalized_source)
    texture_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, texture_dir / out_name)
    texture_state['by_source'][normalized_source] = out_name
    texture_state['copied'] += 1
    return out_name


def build_mesh_texture_entry(subsets, source_root, file_lookup, texture_dir, texture_state):
    entry = {}
    subset_entries = []
    missing = []
    seen_missing = set()
    mapped = 0
    for subset in subsets or []:
        subset_entry = {}
        for param_name, texture_path in (subset.get('textures') or {}).items():
            role = texture_role(param_name)
            if not role:
                continue
            normalized = normalize_logical_path(texture_path)
            source_path = resolve_texture_file(source_root, file_lookup, normalized)
            if source_path:
                out_name = copy_texture_file(source_path, texture_dir, texture_state)
                subset_entry[role] = out_name
                entry.setdefault(role, out_name)
                mapped += 1
            elif normalized and normalized not in seen_missing:
                seen_missing.add(normalized)
                missing.append(normalized)
        blend_mode = subset.get('blendMode')
        alpha_ref = subset.get('alphaRef')
        if blend_mode is not None:
            subset_entry['blendMode'] = blend_mode
        if alpha_ref is not None:
            subset_entry['alphaRef'] = alpha_ref
        subset_entries.append(subset_entry)
    if any(any(key in subset_entry for key in ('albedo', 'mre', 'normal')) for subset_entry in subset_entries):
        entry['subsets'] = subset_entries
    return entry, missing, mapped


def find_companion(mesh_path, is_srt=False):
    parent = mesh_path.parent
    names = []
    if is_srt:
        names.extend([
            f'{mesh_path.stem}_3dmesh.JsonInspack',
            f'{mesh_path.stem}_3dmesh.jsoninspack',
        ])
    names.extend([
        f'{mesh_path.stem}.JsonInspack',
        f'{mesh_path.stem}.jsoninspack',
    ])
    if parent.exists():
        by_lower = {child.name.lower(): child for child in parent.iterdir() if child.is_file()}
        for name in names:
            hit = by_lower.get(name.lower())
            if hit:
                return hit
    return None


def safe_glb_name(logical_path, used_names):
    normalized = normalize_logical_path(logical_path)
    stem = Path(normalized).stem or 'mesh'
    candidate = f'{stem}.glb'
    if candidate.lower() not in used_names:
        used_names.add(candidate.lower())
        return candidate
    digest = hashlib.sha1(normalized.encode('utf-8')).hexdigest()[:8]
    candidate = f'{stem}_{digest}.glb'
    used_names.add(candidate.lower())
    return candidate


def convert_heightmaps(map_dir, output_dir, map_name):
    print('\n=== Converting Heightmaps ===')
    heightmap_dir = map_dir / 'landscape' / 'heightmap'
    if not heightmap_dir.exists():
        raise FileNotFoundError(f'Heightmap directory not found: {heightmap_dir}')
    out_dir = output_dir / 'heightmap'
    out_dir.mkdir(parents=True, exist_ok=True)

    landscape_path = map_dir / 'landscape' / f'{map_name}_landscapeinfo.json'
    if not landscape_path.exists():
        candidates = sorted((map_dir / 'landscape').glob('*_landscapeinfo.json'))
        if not candidates:
            raise FileNotFoundError(f'Landscape info not found under {map_dir / "landscape"}')
        landscape_path = candidates[0]
    landscape_info = load_json_loose(landscape_path)

    files = sorted(heightmap_dir.glob('*.r32'))
    print(f'  Found {len(files)} heightmap tiles')
    for file_path in files:
        raw = file_path.read_bytes()
        num_floats = len(raw) // 4
        resolution = int(num_floats ** 0.5)
        floats = struct.unpack(f'<{num_floats}f', raw)
        flipped = []
        for row in range(resolution - 1, -1, -1):
            flipped.extend(floats[row * resolution:(row + 1) * resolution])
        (out_dir / f'{file_path.stem}.bin').write_bytes(struct.pack(f'<{num_floats}f', *flipped))

    (output_dir / 'landscape-info.json').write_text(json.dumps(landscape_info, indent=2, ensure_ascii=False), encoding='utf-8')
    return landscape_info, len(files)


def identity_matrix():
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


def extract_scene_entities(map_dir, output_dir, map_name, include_baked=True):
    print('\n=== Extracting Scene Entities ===')
    scene_dir = map_dir / 'entities' / 'sceneinfo'
    if not scene_dir.exists():
        raise FileNotFoundError(f'Scene info directory not found: {scene_dir}')
    out_dir = output_dir / 'entities'
    out_dir.mkdir(parents=True, exist_ok=True)

    mesh_paths = set()
    total_objects = 0
    baked_objects = 0
    entity_index = []
    files = sorted(scene_dir.glob('*.json'))
    print(f'  Found {len(files)} scene region files')
    for file_path in files:
        try:
            data = load_json_loose(file_path)
        except Exception as exc:
            print(f'  WARN scene parse failed {file_path.name}: {exc}')
            continue
        world_objects = data.get('worldObjects') if isinstance(data, dict) else None
        if not isinstance(world_objects, dict):
            continue
        region_entities = []
        for uuid, obj in world_objects.items():
            com_render = obj.get('comRender', {}) if isinstance(obj, dict) else {}
            actor_model = normalize_logical_path(com_render.get('actorModel'))
            if not actor_model:
                continue
            com_basic = obj.get('comBasic', {})
            matrix = com_basic.get('actorLocalMatrix')
            if not isinstance(matrix, list) or len(matrix) != 16:
                continue
            mesh_paths.add(actor_model)
            entity = {
                'uuid': uuid,
                'mesh': actor_model,
                'matrix': matrix,
                'name': obj.get('_tableName', ''),
            }
            bbox_min = com_basic.get('actorBoundBoxMin')
            bbox_max = com_basic.get('actorBoundBoxMax')
            if bbox_min and bbox_max:
                entity['bbox'] = {'min': bbox_min, 'max': bbox_max}
            region_entities.append(entity)
            total_objects += 1
        if region_entities:
            rel_name = file_path.name
            (out_dir / rel_name).write_text(json.dumps(region_entities, indent=2, ensure_ascii=False), encoding='utf-8')
            entity_index.append(rel_name)

    if include_baked:
        baked_dir = map_dir / 'baked'
        baked_meshes = sorted(baked_dir.glob('*.mesh')) if baked_dir.exists() else []
        baked_entities = []
        for mesh_path in baked_meshes:
            logical_path = f'data/source/maps/{map_name}/baked/{mesh_path.name}'
            mesh_paths.add(logical_path)
            baked_entities.append({
                'uuid': f'baked:{mesh_path.stem}',
                'mesh': logical_path,
                'matrix': identity_matrix(),
                'name': f'baked/{mesh_path.name}',
            })
        if baked_entities:
            rel_name = '__baked.json'
            (out_dir / rel_name).write_text(json.dumps(baked_entities, indent=2, ensure_ascii=False), encoding='utf-8')
            entity_index.append(rel_name)
            baked_objects = len(baked_entities)
            total_objects += baked_objects

    mesh_list = sorted(mesh_paths)
    (output_dir / 'mesh-list.json').write_text(json.dumps(mesh_list, indent=2, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'entity-index.json').write_text(json.dumps(entity_index, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'  Total scene objects: {total_objects}')
    print(f'  Baked map mesh objects: {baked_objects}')
    print(f'  Unique mesh references: {len(mesh_list)}')
    return {
        'mesh_paths': mesh_list,
        'total_objects': total_objects,
        'baked_objects': baked_objects,
        'entity_files': len(entity_index),
        'source_region_files': len(files),
    }


def resolve_mesh_source(source_root, logical_path):
    normalized = normalize_logical_path(logical_path)
    is_srt = normalized.lower().endswith('.srt')
    mesh_logical = normalized[:-4] + '.mesh' if is_srt else normalized
    mesh_path = logical_to_disk(source_root, mesh_logical)
    return mesh_path, is_srt


def classify_subset_textures(subsets):
    missing = []
    seen = set()
    for subset in subsets or []:
        for param_name, texture_path in (subset.get('textures') or {}).items():
            key = str(param_name).lower().strip()
            if key in ALBEDO_KEYS or key in MRE_KEYS or key in NORMAL_KEYS:
                normalized = normalize_logical_path(texture_path)
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    missing.append(normalized)
    return missing


def convert_meshes(source_root, output_dir, mesh_paths, max_meshes=0):
    print('\n=== Converting Mesh Files ===')
    out_dir = output_dir / 'meshes'
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh_map = {}
    official_meshes = []
    texture_map = {}
    texture_missing = {}
    texture_dir = output_dir / 'textures'
    texture_lookup = build_source_file_lookup(source_root, TEXTURE_EXTENSIONS)
    texture_state = {'by_source': {}, 'used_names': set(), 'copied': 0}
    texture_mapped = 0
    converted = 0
    rebuilt = 0
    reused = 0
    failed = 0
    missing = 0
    unsupported = 0
    missing_paths = []
    unsupported_paths = []
    failed_paths = []
    used_names = set()

    for logical_path in mesh_paths:
        if max_meshes and converted >= max_meshes:
            print(f'  Reached debug max meshes: {max_meshes}')
            break
        extension = Path(normalize_logical_path(logical_path)).suffix.lower()
        if extension not in {'.mesh', '.srt'}:
            unsupported += 1
            unsupported_paths.append(logical_path)
            continue
        mesh_path, is_srt = resolve_mesh_source(source_root, logical_path)
        if not mesh_path.exists():
            if is_srt:
                unsupported += 1
                unsupported_paths.append(logical_path)
            else:
                missing += 1
                missing_paths.append(logical_path)
            continue
        companion = find_companion(mesh_path, is_srt=is_srt)
        subset_materials = None
        if companion and companion.exists():
            try:
                subset_materials = parse_jsoninspack(str(companion))
            except Exception as exc:
                print(f'  WARN material parse failed {companion.name}: {exc}')
        try:
            glb_name = safe_glb_name(logical_path, used_names)
            glb_path = out_dir / glb_name
            if glb_path.exists():
                reused += 1
            else:
                mesh_data = parse_mesh_file(str(mesh_path))
                glb = mesh_to_glb(mesh_data, subset_materials)
                glb_path.write_bytes(glb)
                rebuilt += 1
            mesh_map[logical_path] = f'meshes/{glb_name}'
            if subset_materials:
                official_meshes.append(glb_name)
                texture_entry, missing_textures, mapped_textures = build_mesh_texture_entry(
                    subset_materials,
                    source_root,
                    texture_lookup,
                    texture_dir,
                    texture_state,
                )
                texture_mapped += mapped_textures
                if texture_entry:
                    texture_map[glb_name] = texture_entry
                if missing_textures:
                    texture_missing[glb_name] = missing_textures
            converted += 1
            if converted % 25 == 0:
                print(f'  Converted {converted}...')
        except Exception as exc:
            failed += 1
            failed_paths.append({'path': logical_path, 'error': str(exc)})
            if failed <= 40:
                print(f'  FAIL {logical_path}: {exc}')

    (output_dir / 'mesh-map.json').write_text(json.dumps(mesh_map, indent=2, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'official-meshes.json').write_text(json.dumps(sorted(official_meshes), indent=2, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'texture-map.json').write_text(json.dumps(texture_map, indent=2, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'texture-missing-map.json').write_text(json.dumps(texture_missing, indent=2, ensure_ascii=False), encoding='utf-8')
    report = {
        'converted': converted,
        'rebuilt': rebuilt,
        'reused': reused,
        'missing': missing,
        'unsupported': unsupported,
        'failed': failed,
        'missingPaths': missing_paths,
        'unsupportedPaths': unsupported_paths,
        'failedPaths': failed_paths,
        'textureMapEntries': len(texture_map),
        'textureRefsMapped': texture_mapped,
        'textureFilesCopied': texture_state['copied'],
    }
    (output_dir / 'conversion-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'  Converted: {converted}, Rebuilt: {rebuilt}, Reused: {reused}, Missing: {missing}, Unsupported: {unsupported}, Failed: {failed}')
    print(f'  Official with material companion: {len(official_meshes)}')
    print(f'  Texture map entries: {len(texture_map)}, Refs mapped: {texture_mapped}, Files copied: {texture_state["copied"]}')
    return {**report, 'official': len(official_meshes)}


def extract_environment(map_dir, output_dir, map_name):
    print('\n=== Extracting Environment ===')
    env_path = map_dir / 'environment.json'
    env_data = load_json_loose(env_path) if env_path.exists() else {}
    water_info = None
    for water_name in ['waterinfo.json', f'{map_name}_waterinfo.json']:
        water_path = map_dir / 'water' / water_name
        if water_path.exists():
            water_info = load_json_loose(water_path)
            break
    environment = {
        'sunlight': env_data.get('sunlight'),
        'moonlight': env_data.get('moonlight'),
        'enableDayNightCycle': env_data.get('enableDayNightCycle'),
        'waterInfo': water_info,
    }
    (output_dir / 'environment.json').write_text(json.dumps(environment, indent=2, ensure_ascii=False), encoding='utf-8')
    return environment


def build_map_config(output_dir, map_name, landscape_info, entity_info):
    config = {
        'name': map_name,
        'landscape': {
            'regionSize': landscape_info['RegionSize'],
            'leafNodeSize': landscape_info['LeafNodeSize'],
            'worldOriginX': landscape_info['WorldOrigin.x'],
            'worldOriginY': landscape_info['WorldOrigin.y'],
            'unitScaleX': landscape_info['UnitScale.x'],
            'unitScaleY': landscape_info['UnitScale.y'],
            'regionGridX': landscape_info['RegionTableSize.x'],
            'regionGridY': landscape_info['RegionTableSize.y'],
            'heightMax': landscape_info['HeightfieldMaximum'],
            'heightMin': landscape_info['HeightfieldMinimum'],
            'heightmapResolution': 513,
        },
        'totalSceneObjects': entity_info['total_objects'],
        'meshCount': len(entity_info['mesh_paths']),
    }
    (output_dir / 'map-config.json').write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding='utf-8')
    return config


def count_files(root, suffix):
    suffix = suffix.lower()
    if not root.exists():
        return 0
    return sum(1 for path in root.rglob('*') if path.is_file() and path.suffix.lower() == suffix)


def count_files_named(root, predicate):
    if not root.exists():
        return 0
    return sum(1 for path in root.rglob('*') if path.is_file() and predicate(path))


def build_resource_inventory(source_root, map_dir, output_dir, args, landscape_info, heightmap_count, entity_info, mesh_stats, terrain_stats):
    total_regions = int(landscape_info.get('RegionTableSize.x', 0) or 0) * int(landscape_info.get('RegionTableSize.y', 0) or 0)
    texture_missing = json.loads((output_dir / 'texture-missing-map.json').read_text(encoding='utf-8')) if (output_dir / 'texture-missing-map.json').exists() else {}
    mesh_texture_refs = sum(len(value) for value in texture_missing.values() if isinstance(value, list))
    water_dir = map_dir / 'water'
    categories = {
        'meshes': {
            'icon': 'M',
            'label': 'Meshes',
            'items': {
                'scene_references': len(entity_info['mesh_paths']),
                'mapped_to_scene': mesh_stats['converted'],
                'converted_glb': mesh_stats['converted'],
                'official_meshes': mesh_stats['official'],
                'missing_srt': mesh_stats['unsupported'],
            },
            'source_files': {
                'mesh': count_files(source_root, '.mesh'),
                'jsoninspack': count_files(source_root, '.jsoninspack'),
                'mtl': count_files(source_root, '.mtl'),
            },
        },
        'terrain': {
            'icon': 'T',
            'label': 'Terrain',
            'items': {
                'heightmaps': heightmap_count,
                'total_regions': total_regions,
                'terrain_textures_color': terrain_stats.get('color', 0),
                'terrain_textures_detail': terrain_stats.get('detail', 0),
            },
            'source_files': {
                'procedural_dds': count_files(map_dir / 'landscape' / 'procedural', '.dds'),
                'blendmap_dds': count_files(map_dir / 'landscape' / 'blendmap', '.dds'),
            },
        },
        'entities': {
            'icon': 'E',
            'label': 'Scene Objects',
            'items': {
                'total_placements': entity_info['total_objects'],
                'populated_regions': entity_info['entity_files'],
                'region_files': entity_info['source_region_files'],
            },
        },
        'environment': {
            'icon': 'L',
            'label': 'Environment',
            'items': {
                'environment_json': (map_dir / 'environment.json').exists(),
                'map_config': (output_dir / 'map-config.json').exists(),
                'minimap': (output_dir / 'minimap.png').exists(),
            },
            'source_files': {
                'view_probes': count_files_named(map_dir, lambda path: 'viewprobe' in path.name.lower()),
                'env_probes': count_files_named(map_dir, lambda path: 'envprobe' in path.name.lower()),
            },
        },
        'textures': {
            'icon': 'X',
            'label': 'Textures',
            'items': {
                'mesh_texture_refs': mesh_texture_refs,
                'source_dds_available': count_files(source_root, '.dds'),
                'mesh_texture_map_entries': mesh_stats.get('textureMapEntries', 0),
                'mesh_texture_files': mesh_stats.get('textureFilesCopied', 0),
            },
            'note': 'Texture DDS files are copied into the map package and loaded by the runtime DDS loader.',
        },
        'water': {
            'icon': 'W',
            'label': 'Water',
            'items': {
                'water_files': count_files(water_dir, '.json'),
            },
        },
    }
    return {
        'mapName': args.map_name,
        'sourceRoot': str(source_root),
        'output': str(output_dir),
        'heightmaps': heightmap_count,
        'entityFiles': entity_info['entity_files'],
        'sceneObjects': entity_info['total_objects'],
        'bakedObjects': entity_info['baked_objects'],
        'meshReferences': len(entity_info['mesh_paths']),
        'meshStats': mesh_stats,
        'categories': categories,
    }


def write_terrain_textures(map_dir, output_dir, map_name):
    terrain_texture_dir = output_dir / 'terrain-textures'
    terrain_texture_dir.mkdir(parents=True, exist_ok=True)
    procedural_dir = map_dir / 'landscape' / 'procedural'
    regions = {}
    stats = {'color': 0, 'detail': 0, 'copied': 0}
    if procedural_dir.exists():
        for source_path in sorted(procedural_dir.glob(f'{map_name}_*_b*.dds')):
            parts = source_path.stem.split('_')
            if len(parts) < 4:
                continue
            rx = int(parts[-3])
            ry = int(parts[-2])
            channel = parts[-1].lower()
            region = regions.setdefault(f'{rx}_{ry}', {})
            target_name = source_path.name
            shutil.copy2(source_path, terrain_texture_dir / target_name)
            stats['copied'] += 1
            if channel == 'b0':
                region['color'] = target_name
                stats['color'] += 1
            elif channel == 'b1':
                region['detail'] = target_name
                stats['detail'] += 1
    (terrain_texture_dir / 'index.json').write_text(
        json.dumps({'textureDir': f'{output_dir.name}/terrain-textures/', 'regions': regions}, indent=2, ensure_ascii=False),
        encoding='utf-8',
    )
    return stats


def main():
    args = parse_args()
    source_root = Path(args.source_root).resolve()
    output_dir = Path(args.output).resolve()
    map_dir = source_root / 'data' / 'source' / 'maps' / args.map_name
    if not map_dir.exists():
        raise SystemExit(f'Map directory not found: {map_dir}')
    ensure_clean_output(output_dir, args.clean)

    print('JX3 CDN Map Data Builder')
    print(f'  Map       : {args.map_name}')
    print(f'  Source    : {source_root}')
    print(f'  Map dir   : {map_dir}')
    print(f'  Output    : {output_dir}')

    landscape_info, heightmap_count = convert_heightmaps(map_dir, output_dir, args.map_name)
    entity_info = extract_scene_entities(map_dir, output_dir, args.map_name, include_baked=args.include_baked)
    extract_environment(map_dir, output_dir, args.map_name)
    mesh_stats = convert_meshes(source_root, output_dir, entity_info['mesh_paths'], max_meshes=args.max_meshes)
    build_map_config(output_dir, args.map_name, landscape_info, entity_info)
    terrain_stats = write_terrain_textures(map_dir, output_dir, args.map_name)

    inventory = build_resource_inventory(source_root, map_dir, output_dir, args, landscape_info, heightmap_count, entity_info, mesh_stats, terrain_stats)
    (output_dir / 'resource-inventory.json').write_text(json.dumps(inventory, indent=2, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'verdicts.json').write_text('{}', encoding='utf-8')
    print('\n=== Build Complete ===')
    print(json.dumps(inventory, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()