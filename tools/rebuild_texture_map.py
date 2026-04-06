"""
Rebuild texture-map.json from scratch using JsonInspack files.
Preserves existing texture PNG references, adds blendMode/alphaRef per subset.
"""
import sys, os, json, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_map_data import parse_jsoninspack

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, '..', 'source-meshes')
MAP_DATA = os.path.join(ROOT, '..', 'public', 'map-data')
TEX_DIR = os.path.join(MAP_DATA, 'textures')
TM_PATH = os.path.join(MAP_DATA, 'texture-map.json')
MM_PATH = os.path.join(MAP_DATA, 'mesh-map.json')

# Texture categorization
ALBEDO_KEYS = {'basecolormap', 'basecolor', 'base_albedo', 'map_diffuse'}
MRE_KEYS = {'map(mre)', 'base_mre'}
NORMAL_KEYS = {'normal map', 'basenormalmap', 'base_normal', 'map_bump', 'map_nor'}

# Get set of available PNGs
available_pngs = set(f.lower() for f in os.listdir(TEX_DIR) if f.endswith('.png'))
print(f'Available PNGs: {len(available_pngs)}')

# Load mesh-map to know valid GLBs
mm = json.loads(open(MM_PATH, 'r', encoding='utf-8').read())
valid_glbs = set(v.replace('meshes/', '') for v in mm.values())
print(f'Valid GLBs: {len(valid_glbs)}')

# Parse all JsonInspacks
jips = sorted(glob.glob(os.path.join(CACHE_DIR, '*.JsonInspack')))
print(f'JsonInspack files: {len(jips)}')

texture_map = {}

def find_png(tga_path):
    """Convert a .tga texture path to an available .png filename."""
    basename = os.path.basename(tga_path)
    png_name = os.path.splitext(basename)[0] + '.png'
    if png_name.lower() in available_pngs:
        # Return with correct case from disk
        for f in os.listdir(TEX_DIR):
            if f.lower() == png_name.lower():
                return f
    return None

for jip_path in jips:
    base = os.path.splitext(os.path.basename(jip_path))[0]
    glb_name = base + '.glb'
    
    if glb_name not in valid_glbs:
        continue
    
    subsets = parse_jsoninspack(jip_path)
    if not subsets:
        continue
    
    entry = {}
    subset_entries = []
    
    for si, sub in enumerate(subsets):
        sub_entry = {}
        textures = sub.get('textures', {})
        bm = sub.get('blendMode', 0)
        ar = sub.get('alphaRef', 128)
        
        for param_name, tex_path in textures.items():
            key = param_name.lower().strip()
            if key in ALBEDO_KEYS:
                role = 'albedo'
            elif key in MRE_KEYS:
                role = 'mre'
            elif key in NORMAL_KEYS:
                role = 'normal'
            else:
                continue
            png = find_png(tex_path)
            if png:
                sub_entry[role] = png
        
        # Add material properties
        if bm != 0:
            sub_entry['blendMode'] = bm
        if ar != 128:
            sub_entry['alphaRef'] = ar
        
        subset_entries.append(sub_entry)
    
    # Build default entry from first subset with albedo
    for sub_entry in subset_entries:
        if 'albedo' in sub_entry:
            for role in ('albedo', 'mre', 'normal'):
                if role in sub_entry:
                    entry[role] = sub_entry[role]
            break
    
    # Include per-subset info
    if len(subset_entries) > 1:
        unique_albedos = set(s.get('albedo', '') for s in subset_entries)
        has_alpha_diff = any(s.get('blendMode') for s in subset_entries)
        if len(unique_albedos) > 1 or has_alpha_diff or any(s.get('albedo') != entry.get('albedo') for s in subset_entries if s.get('albedo')):
            entry['subsets'] = subset_entries
    
    # Top-level blendMode if any subset uses alpha
    max_blend = max((s.get('blendMode', 0) for s in subset_entries), default=0)
    if max_blend:
        entry['blendMode'] = max_blend
    
    if entry:
        texture_map[glb_name] = entry

# Save
with open(TM_PATH, 'w', encoding='utf-8') as f:
    json.dump(texture_map, f, ensure_ascii=False)

print(f'\nSaved texture-map.json: {len(texture_map)} entries')

# Stats
has_albedo = sum(1 for v in texture_map.values() if 'albedo' in v)
has_mre = sum(1 for v in texture_map.values() if 'mre' in v)
has_normal = sum(1 for v in texture_map.values() if 'normal' in v)
has_blend = sum(1 for v in texture_map.values() if 'blendMode' in v)
has_subsets = sum(1 for v in texture_map.values() if 'subsets' in v)
has_sub_blend = sum(1 for v in texture_map.values() if 'subsets' in v and any('blendMode' in s for s in v['subsets']))

print(f'  with albedo:  {has_albedo}')
print(f'  with MRE:     {has_mre}')
print(f'  with normal:  {has_normal}')
print(f'  with blend:   {has_blend}')
print(f'  with subsets: {has_subsets}')
print(f'  subsets w/ blendMode: {has_sub_blend}')

# Show sample
for k, v in texture_map.items():
    if 'blendMode' in v:
        print(f'\nSample blend entry: {k}')
        print(json.dumps(v, indent=2, ensure_ascii=False))
        break
