#!/usr/bin/env python3
"""Convert one extracted PSS .mesh asset into a .glb file."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from build_map_data import mesh_to_glb, parse_jsoninspack, parse_mesh_file, parse_ani_vertex_animation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert one PSS mesh to GLB")
    parser.add_argument("--input", required=True, help="Input .mesh file path")
    parser.add_argument("--output", required=True, help="Output .glb file path")
    parser.add_argument(
        "--jsoninspack",
        default="",
        help="Optional JsonInspack companion file path",
    )
    parser.add_argument(
        "--ani",
        default="",
        help="Optional .ani vertex animation file path",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    mesh_path = Path(args.input)
    out_path = Path(args.output)

    if not mesh_path.exists():
        raise FileNotFoundError(f"Input mesh not found: {mesh_path}")

    subset_materials = None
    if args.jsoninspack:
        jip_path = Path(args.jsoninspack)
    else:
        jip_path = mesh_path.with_suffix(".JsonInspack")

    if jip_path.exists():
        try:
            subset_materials = parse_jsoninspack(str(jip_path))
        except Exception as exc:  # best effort
            print(f"WARN: Failed to parse JsonInspack ({jip_path}): {exc}", file=sys.stderr)

    mesh_data = parse_mesh_file(str(mesh_path))

    ani_data = None
    ani_path = Path(args.ani) if args.ani else mesh_path.with_suffix(".ani")
    if ani_path.exists():
        try:
            ani_data = parse_ani_vertex_animation(str(ani_path))
            if ani_data:
                print(
                    f"ANI: {ani_path.name} "
                    f"(vtx={ani_data['vertex_count']}, frames={ani_data['frame_count']}, fps={ani_data['fps']:.0f})",
                    file=sys.stderr,
                )
        except Exception as exc:
            print(f"WARN: Failed to parse ANI ({ani_path}): {exc}", file=sys.stderr)

    glb = mesh_to_glb(mesh_data, subset_materials, ani_data=ani_data)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(glb)

    print(
        f"Converted {mesh_path.name} -> {out_path.name} "
        f"({len(glb)} bytes, vtx={mesh_data.get('vertex_count', 0)}, tri={mesh_data.get('triangle_count', 0)})"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
