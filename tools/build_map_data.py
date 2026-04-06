#!/usr/bin/env python3
"""
JX3 Map Data Builder (Python version)
Converts the 龙门寻宝 map into web-friendly format:
 - Heightmap tiles -> binary float32 arrays  
 - Scene entities -> JSON with transforms + mesh references
 - Mesh files -> .glb (glTF binary)
 - Map metadata -> JSON config
"""

import os
import sys
import json
import math
import struct
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
# Game files are one level up from our project folder
GAME_BASE = PROJECT_DIR.parent if (PROJECT_DIR / '..' / 'seasun').resolve().exists() else PROJECT_DIR
GAME_ROOT = (PROJECT_DIR / '..' / 'seasun' / 'client').resolve()
MAP_DIR = GAME_ROOT / 'data' / 'UGC' / 'binkp1' / '龙门寻宝'
SOURCE_DIR = GAME_ROOT / 'data' / 'UGC' / 'binkp1' / 'source'
BACKUP_ALL_DIR = GAME_ROOT / 'data' / 'UGC' / 'binkp1' / 'backup_all'
BACKUP_EXTRA_DIR = GAME_ROOT / 'data' / 'UGC' / 'binkp1' / 'backup_extra'
OUTPUT_DIR = PROJECT_DIR / 'public' / 'map-data'


def _recompute_smooth_normals(positions, indices, vertex_count, triangle_count):
    """Compute area-weighted smooth vertex normals from geometry.

    Returns normals pointing OPPOSITE to cross(e1, e2) to match the game
    engine's outward-facing convention (CW winding order).
    """
    # Accumulate area-weighted face normals per vertex
    acc = [[0.0, 0.0, 0.0] for _ in range(vertex_count)]
    for fi in range(triangle_count):
        i0 = indices[fi * 3]
        i1 = indices[fi * 3 + 1]
        i2 = indices[fi * 3 + 2]
        ax, ay, az = positions[i0]
        bx, by, bz = positions[i1]
        cx, cy, cz = positions[i2]
        e1x, e1y, e1z = bx - ax, by - ay, bz - az
        e2x, e2y, e2z = cx - ax, cy - ay, cz - az
        # cross(e1, e2) — area-weighted, not normalized
        fnx = e1y * e2z - e1z * e2y
        fny = e1z * e2x - e1x * e2z
        fnz = e1x * e2y - e1y * e2x
        acc[i0][0] += fnx; acc[i0][1] += fny; acc[i0][2] += fnz
        acc[i1][0] += fnx; acc[i1][1] += fny; acc[i1][2] += fnz
        acc[i2][0] += fnx; acc[i2][1] += fny; acc[i2][2] += fnz

    # Normalize and negate (outward = opposite of cross product for CW winding)
    result = []
    for vi in range(vertex_count):
        nx, ny, nz = acc[vi]
        mag = math.sqrt(nx * nx + ny * ny + nz * nz)
        if mag > 1e-12:
            result.append((-nx / mag, -ny / mag, -nz / mag))
        else:
            result.append((0.0, 0.0, -1.0))
    return result


def _fix_compressed_normals(positions, normals, indices, vertex_count, triangle_count):
    """Fix compressed UNorm8 normals by flipping those that point inward.

    Preserves the original per-vertex normal DIRECTION (including hard edges)
    while fixing the ~10-17% of normals that point the wrong way due to the
    position quantisation (int16) vs original normal (from full-precision
    positions) mismatch.

    For each vertex we accumulate the area-weighted CW cross-product face
    normals which point inward.  An original normal that has a positive dot
    product with this accumulation is pointing inward too → flip it.
    """
    # Accumulate CW cross products (inward-pointing) per vertex
    acc = [[0.0, 0.0, 0.0] for _ in range(vertex_count)]
    for fi in range(triangle_count):
        i0 = indices[fi * 3]
        i1 = indices[fi * 3 + 1]
        i2 = indices[fi * 3 + 2]
        ax, ay, az = positions[i0]
        bx, by, bz = positions[i1]
        cx, cy, cz = positions[i2]
        e1x, e1y, e1z = bx - ax, by - ay, bz - az
        e2x, e2y, e2z = cx - ax, cy - ay, cz - az
        fnx = e1y * e2z - e1z * e2y
        fny = e1z * e2x - e1x * e2z
        fnz = e1x * e2y - e1y * e2x
        acc[i0][0] += fnx; acc[i0][1] += fny; acc[i0][2] += fnz
        acc[i1][0] += fnx; acc[i1][1] += fny; acc[i1][2] += fnz
        acc[i2][0] += fnx; acc[i2][1] += fny; acc[i2][2] += fnz

    result = []
    for vi in range(vertex_count):
        nx, ny, nz = normals[vi]
        fx, fy, fz = acc[vi]
        dot = nx * fx + ny * fy + nz * fz
        if dot > 0:
            # Normal aligns with inward-pointing cross product → flip it
            result.append((-nx, -ny, -nz))
        else:
            result.append((nx, ny, nz))
    return result


def _recompute_normals_angle_weighted(positions, indices, hard_edge_angle_deg=80):
    """Recompute vertex normals from geometry using angle-weighted face normal
    averaging with hard-edge preservation.

    The compressed normal encoding in KG3D .mesh files uses an unknown 3-byte
    format that we cannot correctly decode (only ~55-60% of normals match the
    expected face-normal direction).  This function bypasses the stored normals
    entirely by computing them from the mesh geometry.

    Hard edges (where adjacent faces meet at angles > hard_edge_angle_deg) are
    preserved by only averaging normals within each smooth group.
    """
    vc = len(positions)
    tc = len(indices) // 3
    hard_cos = math.cos(math.radians(hard_edge_angle_deg))

    # Compute face normals (unnormalized cross product)
    face_normals = []
    face_angles = []  # (angle_at_v0, angle_at_v1, angle_at_v2) per face
    for fi in range(tc):
        i0 = indices[fi * 3]
        i1 = indices[fi * 3 + 1]
        i2 = indices[fi * 3 + 2]
        p0 = positions[i0]; p1 = positions[i1]; p2 = positions[i2]
        e1 = (p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2])
        e2 = (p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2])
        # Cross product
        nx = e1[1]*e2[2] - e1[2]*e2[1]
        ny = e1[2]*e2[0] - e1[0]*e2[2]
        nz = e1[0]*e2[1] - e1[1]*e2[0]
        mag = (nx*nx + ny*ny + nz*nz) ** 0.5
        if mag > 1e-10:
            nx /= mag; ny /= mag; nz /= mag
        face_normals.append((nx, ny, nz))

        # Compute angle at each vertex of this triangle
        def _vec_angle(ax, ay, az, bx, by, bz):
            la = (ax*ax + ay*ay + az*az) ** 0.5
            lb = (bx*bx + by*by + bz*bz) ** 0.5
            if la < 1e-10 or lb < 1e-10:
                return 0.0
            cos_a = (ax*bx + ay*by + az*bz) / (la * lb)
            cos_a = max(-1.0, min(1.0, cos_a))
            return math.acos(cos_a)

        ea = (p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2])
        eb = (p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2])
        a0 = _vec_angle(*ea, *eb)
        ea = (p0[0]-p1[0], p0[1]-p1[1], p0[2]-p1[2])
        eb = (p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2])
        a1 = _vec_angle(*ea, *eb)
        a2 = math.pi - a0 - a1
        if a2 < 0: a2 = 0
        face_angles.append((a0, a1, a2))

    # Build adjacency: vertex -> list of (face_index, angle_at_vertex)
    adj = [[] for _ in range(vc)]
    for fi in range(tc):
        i0 = indices[fi * 3]
        i1 = indices[fi * 3 + 1]
        i2 = indices[fi * 3 + 2]
        a0, a1, a2 = face_angles[fi]
        adj[i0].append((fi, a0))
        adj[i1].append((fi, a1))
        adj[i2].append((fi, a2))

    # Compute vertex normals with hard-edge grouping
    result = []
    for vi in range(vc):
        faces = adj[vi]
        if not faces:
            result.append((0.0, 0.0, 1.0))
            continue

        # Group faces by normal similarity (simple greedy)
        used = [False] * len(faces)
        best_group = None
        best_count = 0
        for i in range(len(faces)):
            if used[i]:
                continue
            fi_ref = faces[i][0]
            fn_ref = face_normals[fi_ref]
            group = [i]
            used[i] = True
            for j in range(i + 1, len(faces)):
                if used[j]:
                    continue
                fj = faces[j][0]
                fn_j = face_normals[fj]
                dot = fn_ref[0]*fn_j[0] + fn_ref[1]*fn_j[1] + fn_ref[2]*fn_j[2]
                if dot > hard_cos:
                    group.append(j)
                    used[j] = True
            if len(group) > best_count:
                best_count = len(group)
                best_group = group

        # Angle-weighted average of face normals in the best group
        sx, sy, sz = 0.0, 0.0, 0.0
        for gi in best_group:
            fi, ang = faces[gi]
            fn = face_normals[fi]
            sx += fn[0] * ang
            sy += fn[1] * ang
            sz += fn[2] * ang

        mag = (sx*sx + sy*sy + sz*sz) ** 0.5
        if mag > 1e-10:
            result.append((sx / mag, sy / mag, sz / mag))
        else:
            # All adjacent faces are degenerate — use fallback up vector
            result.append((0.0, 0.0, 1.0))

    return result


def parse_mesh_file(filepath):
    """Parse a KSword3D .mesh file and return vertex/index data.
    
    Binary layout (276 bytes header = 0x114):
      0x00-0x53: TFileHeader (84 bytes) - "KSword3D" or zeros for compressed
      0x54:      dw32FileMask = 0x4D455348 ("MESH")
      0x58:      dw32BlockLength (file size)
      0x5C:      dw32MaterialBlock (0xE0000000 = compressed flag)
      0x60:      dw32AniBlock
      0x64-0x8B: 10 extend ints (zeros)
      0x8C:      dw32MeshCount (always 1)
      --- MeshHead ---
      0x90:      dw32NumVertices
      0x94:      dw32NumFaces
      0x98:      dw32NumSubset
      0x9C:      dw32PositionBlock
      0xA0:      dw32NormalBlock
      0xA4:      dw32DiffuseBlock (vertex colors, ARGB uint32)
      0xA8:      dw32TextureUVW1Block
      0xAC:      dw32TextureUVW2Block
      0xB0:      dw32TextureUVW3Block
      0xB4:      dw32FacesIndexBlock
      0xB8:      dw32SubsetIndexBlock (per-face material IDs)
      0xBC:      dw32SkinInfoBlock
      0xC0:      dw32LODInfoBlock
      0xC4:      dw32FlexibleBodyBlock
      0xC8:      dw32BBoxBlock
      0xCC:      dw32BlendMeshBlock
      0xD0:      dw32TangentBlock
      0xD4-0x113: 16 extend ints (zeros)
    
    Compressed blocks (HD/bin format, flag 0xE0000000 at 0x5C):
      Position: 24-byte BBox (6×f32) + N×6 (SNorm16×3)
      Normal:   N×3 (UNorm8×3), no header
      Tangent:  N×4 (UNorm8×4), no header
      UV:       12-byte scale (3×f32) + N×6 (SNorm16×3)
      Faces:    F×3×4 (uint32)
      Subsets:  F×2 (uint16)
    
    Uncompressed blocks (float32, each ends with 0xFFFFFFFF sentinel):
      Position: N×12 (f32×3) + 4
      Normal:   N×12 (f32×3) + 4
      Diffuse:  N×4  (uint32 ARGB) + 4
      UV:       N×12 (f32×3, UVW) + 4
      Faces:    F×12 (uint32×3) + 4
      Subsets:  F×4  (uint32) + 4
    """
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 0x114:
        raise ValueError(f"File too small: {len(data)} bytes")

    # Validate MESH magic at 0x54
    mesh_magic = struct.unpack_from('<I', data, 0x54)[0]
    if mesh_magic != 0x4D455348:
        raise ValueError(f"Invalid mesh magic: 0x{mesh_magic:08X}")

    # Read header fields
    material_block_flag = struct.unpack_from('<I', data, 0x5C)[0]
    vertex_count = struct.unpack_from('<I', data, 0x90)[0]
    triangle_count = struct.unpack_from('<I', data, 0x94)[0]

    # Read all named block offsets
    off_position  = struct.unpack_from('<I', data, 0x9C)[0]
    off_normal    = struct.unpack_from('<I', data, 0xA0)[0]
    off_diffuse   = struct.unpack_from('<I', data, 0xA4)[0]
    off_uv1       = struct.unpack_from('<I', data, 0xA8)[0]
    off_uv2       = struct.unpack_from('<I', data, 0xAC)[0]
    off_uv3       = struct.unpack_from('<I', data, 0xB0)[0]
    off_faces     = struct.unpack_from('<I', data, 0xB4)[0]
    off_subsets   = struct.unpack_from('<I', data, 0xB8)[0]
    off_skin      = struct.unpack_from('<I', data, 0xBC)[0]
    off_tangent   = struct.unpack_from('<I', data, 0xD0)[0]

    # Collect all non-zero offsets for boundary calculation
    all_block_offsets = sorted(set(
        v for v in [off_position, off_normal, off_diffuse, off_uv1, off_uv2, off_uv3,
                    off_faces, off_subsets, off_skin, off_tangent]
        if v != 0
    ))
    # Add file end as final boundary
    all_block_offsets.append(len(data))

    def block_size(offset):
        if offset == 0:
            return 0
        idx = all_block_offsets.index(offset)
        return all_block_offsets[idx + 1] - offset if idx + 1 < len(all_block_offsets) else 0

    num_subsets = struct.unpack_from('<I', data, 0x98)[0]

    # Per-block compression detection based on actual block sizes.
    # Some meshes are HYBRID: uncompressed positions but compressed normals/tangents.
    # Using block_size / vertex_count ratio to detect each block independently.
    pos_block_sz = block_size(off_position) if off_position else 0
    norm_block_sz = block_size(off_normal) if off_normal else 0
    uv1_block_sz = block_size(off_uv1) if off_uv1 else 0
    tan_block_sz = block_size(off_tangent) if off_tangent else 0
    sub_block_sz = block_size(off_subsets) if off_subsets else 0

    pos_bpv = pos_block_sz / vertex_count if vertex_count > 0 else 0
    norm_bpv = norm_block_sz / vertex_count if vertex_count > 0 else 0
    uv1_bpv = uv1_block_sz / vertex_count if vertex_count > 0 else 0
    tan_bpv = tan_block_sz / vertex_count if vertex_count > 0 else 0
    sub_bpf = sub_block_sz / triangle_count if triangle_count > 0 else 0

    # Position: compressed = ~6 bpv + 24B header; uncompressed = 12 bpv + 4B sentinel
    pos_compressed = (abs(pos_block_sz - (24 + vertex_count * 6)) <= 4) if off_position else False
    if not pos_compressed and off_position:
        pos_compressed = pos_bpv < 8.0 and pos_bpv > 4.0

    # Normal: compressed ≈ 3 bpv or ≈ 7 bpv (QTangent); uncompressed = 12 bpv
    norm_compressed = norm_bpv < 5.0 if off_normal else False
    norm_qtangent = norm_bpv >= 6.5 and norm_bpv < 9.0 if off_normal else False

    # UV: compressed = ~6 bpv + 12B header; uncompressed = 12 bpv + 4B sentinel
    uv1_compressed = uv1_bpv < 8.0 if off_uv1 else False

    # Tangent: compressed = 4 bpv (UNorm8×4); uncompressed = 16 bpv (f32×4)
    tan_compressed = tan_bpv < 8.0 if off_tangent else False

    # Subset: uint16 = ~2 bpf; uint32 = ~4 bpf (both may have sentinel)
    sub_is_u16 = sub_bpf < 3.0 if off_subsets else False

    positions = None
    normals = None
    tangents = None
    uvs = None
    colors = None
    indices = []
    subset_ids = None

    # === POSITIONS ===
    if off_position:
        if pos_compressed:
            bbox = struct.unpack_from('<6f', data, off_position)
            mn = tuple(min(bbox[i], bbox[i + 3]) for i in range(3))
            mx = tuple(max(bbox[i], bbox[i + 3]) for i in range(3))
            center = tuple((mn[i] + mx[i]) / 2.0 for i in range(3))
            half = tuple((mx[i] - mn[i]) / 2.0 for i in range(3))
            vdata = off_position + 24
            verts = []
            for vi in range(vertex_count):
                o = vdata + vi * 6
                sx, sy, sz = struct.unpack_from('<3h', data, o)
                verts.append((
                    center[0] + (sx / 32767.0) * half[0],
                    center[1] + (sy / 32767.0) * half[1],
                    center[2] + (sz / 32767.0) * half[2],
                ))
            positions = verts
        else:
            verts = []
            for vi in range(vertex_count):
                o = off_position + vi * 12
                x, y, z = struct.unpack_from('<3f', data, o)
                verts.append((x, y, z))
            positions = verts

    # === NORMALS ===
    if off_normal and vertex_count > 0:
        norms = []
        if norm_qtangent:
            stride = round(norm_bpv)
            for vi in range(vertex_count):
                o = off_normal + vi * stride
                qx, qy, qz, qw = struct.unpack_from('<4b', data, o)
                fqx, fqy, fqz, fqw = qx / 127.0, qy / 127.0, qz / 127.0, qw / 127.0
                mag_q = (fqx*fqx + fqy*fqy + fqz*fqz + fqw*fqw) ** 0.5
                if mag_q > 0.0001:
                    fqx /= mag_q; fqy /= mag_q; fqz /= mag_q; fqw /= mag_q
                nx = 2.0 * (fqx * fqz + fqw * fqy)
                ny = 2.0 * (fqy * fqz - fqw * fqx)
                nz = 1.0 - 2.0 * (fqx * fqx + fqy * fqy)
                norms.append((nx, ny, nz))
        elif norm_compressed:
            # SNorm8×3 encoding: signed int8, divide by 127, then normalize
            for vi in range(vertex_count):
                o = off_normal + vi * 3
                sx, sy, sz = struct.unpack_from('<3b', data, o)
                nx = sx / 127.0
                ny = sy / 127.0
                nz = sz / 127.0
                mag = (nx*nx + ny*ny + nz*nz) ** 0.5
                if mag > 0.0001:
                    norms.append((nx / mag, ny / mag, nz / mag))
                else:
                    norms.append((0.0, 0.0, 1.0))
        else:
            # Uncompressed float32×3
            for vi in range(vertex_count):
                o = off_normal + vi * 12
                nx, ny, nz = struct.unpack_from('<3f', data, o)
                # Sanitize NaN/Inf/degenerate
                if not (math.isfinite(nx) and math.isfinite(ny) and math.isfinite(nz)):
                    norms.append((0.0, 0.0, 1.0))
                    continue
                mag = (nx*nx + ny*ny + nz*nz) ** 0.5
                if mag > 0.0001:
                    norms.append((nx / mag, ny / mag, nz / mag))
                else:
                    norms.append((0.0, 0.0, 1.0))
        normals = norms

    # === TANGENTS ===
    if off_tangent and vertex_count > 0:
        tans = []
        if tan_compressed:
            # SNorm8×4: xyz = tangent direction (signed int8), w = bitangent sign
            for vi in range(vertex_count):
                o = off_tangent + vi * 4
                sx, sy, sz = struct.unpack_from('<3b', data, o)
                b3 = data[o + 3]
                tx = sx / 127.0
                ty = sy / 127.0
                tz = sz / 127.0
                mag = (tx*tx + ty*ty + tz*tz) ** 0.5
                if mag > 0.0001:
                    tx /= mag; ty /= mag; tz /= mag
                else:
                    tx, ty, tz = 1.0, 0.0, 0.0
                # W byte: 0 or 1 → handedness +1 or -1
                tw = 1.0 if b3 < 128 else -1.0
                tans.append((tx, ty, tz, tw))
        else:
            # Uncompressed float32×4
            for vi in range(vertex_count):
                o = off_tangent + vi * 16
                tx, ty, tz, tw = struct.unpack_from('<4f', data, o)
                if not (math.isfinite(tx) and math.isfinite(ty) and math.isfinite(tz)):
                    tans.append((1.0, 0.0, 0.0, 1.0))
                    continue
                mag = (tx*tx + ty*ty + tz*tz) ** 0.5
                if mag > 0.0001:
                    tx /= mag; ty /= mag; tz /= mag
                else:
                    tx, ty, tz = 1.0, 0.0, 0.0
                tw = 1.0 if tw >= 0.0 else -1.0
                tans.append((tx, ty, tz, tw))
        tangents = tans

    # === DIFFUSE / VERTEX COLORS ===
    if off_diffuse:
        diff_block_sz = block_size(off_diffuse) if off_diffuse else 0
        diff_stride = round(diff_block_sz / vertex_count) if vertex_count > 0 else 4
        if diff_stride < 4:
            diff_stride = 4
        cols = []
        for vi in range(vertex_count):
            o = off_diffuse + vi * diff_stride
            argb = struct.unpack_from('<I', data, o)[0]
            a = ((argb >> 24) & 0xFF) / 255.0
            r = ((argb >> 16) & 0xFF) / 255.0
            g = ((argb >> 8) & 0xFF) / 255.0
            b_val = (argb & 0xFF) / 255.0
            cols.append((r, g, b_val, a))
        colors = cols

    # === UV1 ===
    if off_uv1:
        if uv1_compressed:
            u_scale, v_scale, w_scale = struct.unpack_from('<3f', data, off_uv1)
            uv_data_start = off_uv1 + 12
            uv_list = []
            for vi in range(vertex_count):
                o = uv_data_start + vi * 6
                u_raw, v_raw, w_raw = struct.unpack_from('<3h', data, o)
                uv_list.append((
                    (u_raw / 32767.0) * u_scale,
                    (v_raw / 32767.0) * v_scale,
                ))
            uvs = uv_list
        else:
            uv_list = []
            for vi in range(vertex_count):
                o = off_uv1 + vi * 12
                u, v, w = struct.unpack_from('<3f', data, o)
                uv_list.append((u, v))
            uvs = uv_list

    # === FACES (always uint32×3) ===
    if off_faces:
        total_idx = triangle_count * 3
        indices = list(struct.unpack_from(f'<{total_idx}I', data, off_faces))

    # === SUBSETS ===
    if off_subsets and num_subsets > 0:
        if sub_is_u16:
            subset_ids = list(struct.unpack_from(f'<{triangle_count}H', data, off_subsets))
        else:
            subset_ids = list(struct.unpack_from(f'<{triangle_count}I', data, off_subsets))
        # Clamp to valid range
        subset_ids = [min(s, num_subsets - 1) for s in subset_ids]

    # Compressed normals use an unknown 3-byte encoding that produces incorrect
    # results (only ~55-60% face-normal agreement).  Recompute from geometry
    # using angle-weighted averaging with hard-edge preservation.
    if norm_compressed and positions and indices:
        normals = _recompute_normals_angle_weighted(positions, indices)

    return {
        'vertex_count': vertex_count,
        'triangle_count': triangle_count,
        'positions': positions,
        'normals': normals,
        'tangents': tangents,
        'uvs': uvs,
        'colors': colors,
        'indices': indices,
        'subset_ids': subset_ids,
        'num_subsets': num_subsets,
        'pos_compressed': pos_compressed,
        'norm_compressed': norm_compressed,
    }


def parse_jsoninspack(filepath):
    """Parse a .JsonInspack companion file and return per-subset material info."""
    raw = Path(filepath).read_bytes()
    # JX3 files use GBK encoding — try GBK first because some GBK byte
    # sequences are valid UTF-8 but decode to wrong characters
    try:
        text = raw.decode('gbk')
    except (UnicodeDecodeError, ValueError):
        text = raw.decode('utf-8', errors='replace')
    obj = json.loads(text)

    subsets = []
    for lod in obj.get('LOD', []):
        # Only use first Group (LOD0 highest detail)
        groups = lod.get('Group', [])
        if not groups:
            break
        for subset in groups[0].get('Subset', []):
                info = {'textures': {}}
                for param in subset.get('Param', []):
                    if param.get('Type') == 'Texture':
                        info['textures'][param['Name']] = param['Value']
                rs = subset.get('RenderState', {})
                info['blendMode'] = rs.get('BlendMode', 0)
                info['alphaRef'] = rs.get('AlphaRef', 128)
                subsets.append(info)
        break  # Only use LOD0
    return subsets


# Distinct subset colors for multi-material meshes (used when textures unavailable)
SUBSET_COLORS = [
    [0.82, 0.71, 0.55, 1.0],  # warm stone
    [0.60, 0.65, 0.58, 1.0],  # moss
    [0.75, 0.60, 0.45, 1.0],  # clay
    [0.55, 0.55, 0.65, 1.0],  # slate
    [0.70, 0.55, 0.50, 1.0],  # rust
    [0.65, 0.72, 0.60, 1.0],  # sage
    [0.80, 0.75, 0.65, 1.0],  # sand
    [0.58, 0.50, 0.55, 1.0],  # mauve
]


def mesh_to_glb(mesh_data, subset_materials=None):
    """Convert parsed mesh data to a GLB (glTF Binary) file.

    Coordinate system: JX3 uses left-handed (DirectX) conventions.
    glTF uses right-handed.  We negate the Z axis and reverse triangle
    winding to convert between the two.

    Multi-subset meshes are split into separate glTF primitives, each
    referencing its own material, so the viewer can apply per-subset
    textures.
    """
    positions = mesh_data['positions']
    normals = mesh_data.get('normals')
    tangents_data = mesh_data.get('tangents')
    uvs = mesh_data.get('uvs')
    colors = mesh_data.get('colors')
    indices = list(mesh_data['indices'])
    vertex_count = mesh_data['vertex_count']
    triangle_count = mesh_data['triangle_count']

    # ── LH → RH: negate Z for positions, normals, tangents ─────────────────
    positions = [(x, y, -z) for x, y, z in positions]
    if normals:
        normals = [(nx, ny, -nz) for nx, ny, nz in normals]
    if tangents_data:
        # Negate Z for direction AND negate W for handedness change (LH→RH)
        tangents_data = [(tx, ty, -tz, -tw) for tx, ty, tz, tw in tangents_data]

    # Filter degenerate triangles (duplicate vertex indices → zero area)
    # AND reverse winding (i0,i1,i2 → i0,i2,i1) for RH coordinate system
    clean_indices = []
    clean_subset_ids = mesh_data.get('subset_ids')
    new_subset_ids = [] if clean_subset_ids else None
    for fi in range(triangle_count):
        i0 = indices[fi * 3]; i1 = indices[fi * 3 + 1]; i2 = indices[fi * 3 + 2]
        if i0 == i1 or i1 == i2 or i0 == i2:
            continue
        clean_indices.extend([i0, i2, i1])  # reversed winding for RH
        if new_subset_ids is not None and clean_subset_ids:
            new_subset_ids.append(clean_subset_ids[fi])
    if len(clean_indices) < len(indices):
        removed = triangle_count - len(clean_indices) // 3
        indices = clean_indices
        triangle_count = len(indices) // 3
        if new_subset_ids is not None:
            clean_subset_ids = new_subset_ids
    else:
        clean_subset_ids = mesh_data.get('subset_ids')
        # Still need to reverse winding even if no degenerates removed
        reversed_indices = []
        for fi in range(triangle_count):
            i0 = indices[fi * 3]; i1 = indices[fi * 3 + 1]; i2 = indices[fi * 3 + 2]
            reversed_indices.extend([i0, i2, i1])
        indices = reversed_indices

    num_subsets = mesh_data.get('num_subsets', 0)

    # Assign per-vertex colors from subset IDs so different subsets are visually
    # distinct.  We use a single primitive (all indices) because the viewer only
    # loads the first geometry from the GLB; splitting into per-subset primitives
    # causes most faces to be silently dropped.
    num_subsets = mesh_data.get('num_subsets', 0)

    # Build per-subset index lists for multi-primitive GLB
    subset_index_lists = None
    if clean_subset_ids is not None and num_subsets > 1 and len(clean_subset_ids) == triangle_count:
        subset_index_lists = [[] for _ in range(num_subsets)]
        for fi in range(triangle_count):
            sid = clean_subset_ids[fi]
            subset_index_lists[sid].extend(indices[fi*3:fi*3+3])
        # Remove empty subsets
        subset_index_lists = [(sid, idxs) for sid, idxs in enumerate(subset_index_lists) if idxs]
    
    if not positions or not indices:
        raise ValueError("Mesh must have positions and indices")

    # (Triangle outlier filter removed — using clean backup data instead)

    # Build binary data
    bin_parts = []
    byte_offset = 0
    buffer_views = []
    accessors = []
    
    # --- Positions ---
    pos_data = b''
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    for x, y, z in positions:
        pos_data += struct.pack('<fff', x, y, z)
        min_x = min(min_x, x); max_x = max(max_x, x)
        min_y = min(min_y, y); max_y = max(max_y, y)
        min_z = min(min_z, z); max_z = max(max_z, z)
    
    pos_bv_idx = len(buffer_views)
    buffer_views.append({
        'buffer': 0,
        'byteOffset': byte_offset,
        'byteLength': len(pos_data),
        'target': 34962
    })
    pos_acc_idx = len(accessors)
    accessors.append({
        'bufferView': pos_bv_idx,
        'componentType': 5126,
        'count': vertex_count,
        'type': 'VEC3',
        'min': [min_x, min_y, min_z],
        'max': [max_x, max_y, max_z]
    })
    bin_parts.append(pos_data)
    byte_offset += len(pos_data)
    pad = (4 - byte_offset % 4) % 4
    if pad:
        bin_parts.append(b'\x00' * pad)
        byte_offset += pad
    
    # --- Normals ---
    norm_acc_idx = -1
    if normals and len(normals) == vertex_count:
        norm_data = b''
        for nx, ny, nz in normals:
            norm_data += struct.pack('<fff', nx, ny, nz)
        
        norm_bv_idx = len(buffer_views)
        buffer_views.append({
            'buffer': 0,
            'byteOffset': byte_offset,
            'byteLength': len(norm_data),
            'target': 34962
        })
        norm_acc_idx = len(accessors)
        accessors.append({
            'bufferView': norm_bv_idx,
            'componentType': 5126,
            'count': vertex_count,
            'type': 'VEC3'
        })
        bin_parts.append(norm_data)
        byte_offset += len(norm_data)
        pad = (4 - byte_offset % 4) % 4
        if pad:
            bin_parts.append(b'\x00' * pad)
            byte_offset += pad
    
    # --- Tangents ---
    tan_acc_idx = -1
    if tangents_data and len(tangents_data) == vertex_count:
        tan_data = b''
        for tx, ty, tz, tw in tangents_data:
            tan_data += struct.pack('<ffff', tx, ty, tz, tw)

        tan_bv_idx = len(buffer_views)
        buffer_views.append({
            'buffer': 0,
            'byteOffset': byte_offset,
            'byteLength': len(tan_data),
            'target': 34962
        })
        tan_acc_idx = len(accessors)
        accessors.append({
            'bufferView': tan_bv_idx,
            'componentType': 5126,
            'count': vertex_count,
            'type': 'VEC4'
        })
        bin_parts.append(tan_data)
        byte_offset += len(tan_data)
        pad = (4 - byte_offset % 4) % 4
        if pad:
            bin_parts.append(b'\x00' * pad)
            byte_offset += pad

    # --- UVs ---
    uv_acc_idx = -1
    if uvs and len(uvs) == vertex_count:
        uv_data = b''
        for u, v in uvs:
            uv_data += struct.pack('<ff', u, v)
        
        uv_bv_idx = len(buffer_views)
        buffer_views.append({
            'buffer': 0,
            'byteOffset': byte_offset,
            'byteLength': len(uv_data),
            'target': 34962
        })
        uv_acc_idx = len(accessors)
        accessors.append({
            'bufferView': uv_bv_idx,
            'componentType': 5126,
            'count': vertex_count,
            'type': 'VEC2'
        })
        bin_parts.append(uv_data)
        byte_offset += len(uv_data)
        pad = (4 - byte_offset % 4) % 4
        if pad:
            bin_parts.append(b'\x00' * pad)
            byte_offset += pad
    
    # --- Vertex Colors ---
    color_acc_idx = -1
    if colors and len(colors) == vertex_count:
        color_data = b''
        for r, g, b_val, a in colors:
            color_data += struct.pack('<ffff', r, g, b_val, a)
        
        color_bv_idx = len(buffer_views)
        buffer_views.append({
            'buffer': 0,
            'byteOffset': byte_offset,
            'byteLength': len(color_data),
            'target': 34962
        })
        color_acc_idx = len(accessors)
        accessors.append({
            'bufferView': color_bv_idx,
            'componentType': 5126,
            'count': vertex_count,
            'type': 'VEC4'
        })
        bin_parts.append(color_data)
        byte_offset += len(color_data)
        pad = (4 - byte_offset % 4) % 4
        if pad:
            bin_parts.append(b'\x00' * pad)
            byte_offset += pad
    
    # --- Indices (per-subset or single) ---
    # Build attributes (shared across all primitives - vertex data is shared)
    attributes = {'POSITION': pos_acc_idx}
    if norm_acc_idx >= 0:
        attributes['NORMAL'] = norm_acc_idx
    if tan_acc_idx >= 0:
        attributes['TANGENT'] = tan_acc_idx
    if uv_acc_idx >= 0:
        attributes['TEXCOORD_0'] = uv_acc_idx
    if color_acc_idx >= 0:
        attributes['COLOR_0'] = color_acc_idx

    primitives = []
    materials = []

    if subset_index_lists and len(subset_index_lists) > 1:
        # Multi-subset: one primitive per subset, each with its own index buffer
        for mat_idx, (sid, sub_indices) in enumerate(subset_index_lists):
            idx_data = struct.pack(f'<{len(sub_indices)}I', *sub_indices)
            idx_bv_idx = len(buffer_views)
            buffer_views.append({
                'buffer': 0,
                'byteOffset': byte_offset,
                'byteLength': len(idx_data),
                'target': 34963
            })
            idx_acc_idx = len(accessors)
            accessors.append({
                'bufferView': idx_bv_idx,
                'componentType': 5125,
                'count': len(sub_indices),
                'type': 'SCALAR'
            })
            bin_parts.append(idx_data)
            byte_offset += len(idx_data)
            pad = (4 - byte_offset % 4) % 4
            if pad:
                bin_parts.append(b'\x00' * pad)
                byte_offset += pad

            primitives.append({
                'attributes': attributes,
                'indices': idx_acc_idx,
                'material': mat_idx
            })

            # Build material with subset metadata (subset ID stored in extras)
            mat_def = {
                'pbrMetallicRoughness': {
                    'baseColorFactor': [1.0, 1.0, 1.0, 1.0],
                    'metallicFactor': 0.0,
                    'roughnessFactor': 0.7
                },
                'doubleSided': True,
                'extras': {'subsetId': sid}
            }
            materials.append(mat_def)
    else:
        # Single primitive with all indices
        idx_data = struct.pack(f'<{len(indices)}I', *indices)
        idx_bv_idx = len(buffer_views)
        buffer_views.append({
            'buffer': 0,
            'byteOffset': byte_offset,
            'byteLength': len(idx_data),
            'target': 34963
        })
        idx_acc_idx = len(accessors)
        accessors.append({
            'bufferView': idx_bv_idx,
            'componentType': 5125,
            'count': len(indices),
            'type': 'SCALAR'
        })
        bin_parts.append(idx_data)
        byte_offset += len(idx_data)
        pad = (4 - byte_offset % 4) % 4
        if pad:
            bin_parts.append(b'\x00' * pad)
            byte_offset += pad

        primitives.append({
            'attributes': attributes,
            'indices': idx_acc_idx,
            'material': 0
        })
        materials.append({
            'pbrMetallicRoughness': {
                'baseColorFactor': [1.0, 1.0, 1.0, 1.0],
                'metallicFactor': 0.0,
                'roughnessFactor': 0.7
            },
            'doubleSided': True
        })
    gltf_buffers_size = byte_offset
    
    # glTF JSON
    gltf = {
        'asset': {'version': '2.0', 'generator': 'JX3-Mesh-Converter'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': primitives}],
        'materials': materials,
        'accessors': accessors,
        'bufferViews': buffer_views,
        'buffers': [{'byteLength': gltf_buffers_size}]
    }
    
    json_str = json.dumps(gltf, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    # Pad JSON to 4-byte alignment with spaces
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b' ' * json_pad
    
    bin_data = b''.join(bin_parts)
    
    # GLB format
    total_size = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    
    glb = bytearray()
    # Header
    glb += struct.pack('<III', 0x46546C67, 2, total_size)  # glTF, version 2, total size
    # JSON chunk
    glb += struct.pack('<II', len(json_bytes), 0x4E4F534A)  # length, JSON
    glb += json_bytes
    # BIN chunk
    glb += struct.pack('<II', len(bin_data), 0x004E4942)  # length, BIN
    glb += bin_data
    
    return bytes(glb)


def load_json_file(filepath):
    """Load a JSON file with GBK fallback encoding."""
    raw = Path(filepath).read_bytes()
    try:
        text = raw.decode('gbk')
    except (UnicodeDecodeError, ValueError):
        text = raw.decode('utf-8', errors='replace')
    return json.loads(text)


def find_file_recursive(directory, filename):
    """Search for a file in directory tree."""
    try:
        for root, dirs, files in os.walk(directory):
            if filename in files:
                return os.path.join(root, filename)
    except Exception:
        pass
    return None


def convert_heightmaps():
    """Copy heightmap .r32 files to output."""
    print('\n=== Converting Heightmaps ===')
    hm_dir = MAP_DIR / 'landscape' / 'heightmap'
    out_dir = OUTPUT_DIR / 'heightmap'
    out_dir.mkdir(parents=True, exist_ok=True)
    
    landscape_info_path = MAP_DIR / 'landscape' / '龙门寻宝_landscapeinfo.json'
    landscape_info = load_json_file(landscape_info_path)
    
    files = [f for f in os.listdir(hm_dir) if f.endswith('.r32')]
    print(f'  Found {len(files)} heightmap tiles')
    
    for file in files:
        out_name = file.replace('.r32', '.bin')
        # Read .r32 and flip Y (rows) - the source data stores row 0 as north,
        # but our viewer expects row 0 as south (matching world coordinate order)
        raw = (hm_dir / file).read_bytes()
        num_floats = len(raw) // 4
        res = int(num_floats ** 0.5)  # 513
        floats = struct.unpack(f'<{num_floats}f', raw)
        # Flip rows: reverse the order of 513-element rows
        flipped = []
        for row in range(res - 1, -1, -1):
            flipped.extend(floats[row * res:(row + 1) * res])
        out_data = struct.pack(f'<{num_floats}f', *flipped)
        with open(out_dir / out_name, 'wb') as fout:
            fout.write(out_data)
    
    with open(OUTPUT_DIR / 'landscape-info.json', 'w', encoding='utf-8') as f:
        json.dump(landscape_info, f, indent=2)
    
    print(f'  Saved {len(files)} heightmap tiles + metadata')
    return landscape_info


def extract_scene_entities():
    """Extract scene entity placement data."""
    print('\n=== Extracting Scene Entities ===')
    scene_dir = MAP_DIR / 'entities' / 'sceneinfo'
    out_dir = OUTPUT_DIR / 'entities'
    out_dir.mkdir(parents=True, exist_ok=True)
    
    files = [f for f in os.listdir(scene_dir) if f.endswith('.json')]
    print(f'  Found {len(files)} scene region files')
    
    mesh_paths = set()
    total_objects = 0
    entity_files_with_data = []
    
    for file in files:
        data = load_json_file(scene_dir / file)
        
        if 'worldObjects' not in data:
            continue
        
        region_entities = []
        for uuid, obj in data['worldObjects'].items():
            com_render = obj.get('comRender', {})
            actor_model = com_render.get('actorModel')
            if not actor_model:
                continue
            
            com_basic = obj.get('comBasic', {})
            matrix = com_basic.get('actorLocalMatrix')
            if not matrix or len(matrix) != 16:
                continue
            
            mesh_path = actor_model.replace('\\\\', '/').replace('\\', '/')
            mesh_paths.add(mesh_path)
            
            entity = {
                'uuid': uuid,
                'mesh': mesh_path,
                'matrix': matrix,
                'name': obj.get('_tableName', '')
            }
            
            bbox_min = com_basic.get('actorBoundBoxMin')
            bbox_max = com_basic.get('actorBoundBoxMax')
            if bbox_min and bbox_max:
                entity['bbox'] = {'min': bbox_min, 'max': bbox_max}
            
            region_entities.append(entity)
            total_objects += 1
        
        if region_entities:
            with open(out_dir / file, 'w', encoding='utf-8') as f:
                json.dump(region_entities, f, indent=2)
            entity_files_with_data.append(file)
    
    print(f'  Total scene objects: {total_objects}')
    print(f'  Unique mesh references: {len(mesh_paths)}')
    
    mesh_list = sorted(mesh_paths)
    with open(OUTPUT_DIR / 'mesh-list.json', 'w', encoding='utf-8') as f:
        json.dump(mesh_list, f, indent=2)
    
    # Save entity file index
    with open(OUTPUT_DIR / 'entity-index.json', 'w', encoding='utf-8') as f:
        json.dump(entity_files_with_data, f, indent=2)
    
    return {'mesh_paths': mesh_list, 'total_objects': total_objects}


def convert_meshes(mesh_paths):
    """Convert .mesh files to .glb format.
    Meshes with companion files (.JsonInspack) get multi-subset materials.
    """
    print('\n=== Converting Mesh Files ===')
    out_dir = OUTPUT_DIR / 'meshes'
    out_dir.mkdir(parents=True, exist_ok=True)
    
    converted = 0
    failed = 0
    converted_map = {}
    official_meshes = []  # GLB names that had companion files
    
    for mesh_path in mesh_paths:
        normalized = mesh_path.replace('/', os.sep)
        basename_orig = os.path.basename(normalized)
        is_srt = basename_orig.lower().endswith('.srt')

        # SRT (SpeedTree) files: redirect to companion .mesh + _3dmesh.JsonInspack
        if is_srt:
            stem = os.path.splitext(basename_orig)[0]
            basename_mesh = stem + '.mesh'
            normalized_mesh = os.path.splitext(normalized)[0] + '.mesh'
        else:
            basename_mesh = basename_orig
            normalized_mesh = normalized

        # Try to find the mesh file
        # Priority: cache-extracted > backup_all > backup_extra > source
        # Cache-extracted meshes are confirmed correct (identical to official downloads)
        CACHE_EXTRACT_DIR = PROJECT_DIR / 'source-meshes'
        cache_mesh = CACHE_EXTRACT_DIR / basename_mesh
        found_path = None
        if cache_mesh.exists():
            found_path = str(cache_mesh)
        
        if not found_path:
            possible = [
                BACKUP_ALL_DIR / normalized_mesh.replace(f'data{os.sep}source{os.sep}', ''),
                BACKUP_ALL_DIR / normalized_mesh.replace(f'data{os.sep}', ''),
                BACKUP_EXTRA_DIR / normalized_mesh.replace(f'data{os.sep}source{os.sep}', ''),
                BACKUP_EXTRA_DIR / normalized_mesh.replace(f'data{os.sep}', ''),
                GAME_ROOT / normalized_mesh,
                SOURCE_DIR / normalized_mesh.replace(f'data{os.sep}source{os.sep}', ''),
                SOURCE_DIR / normalized_mesh.replace(f'data{os.sep}', ''),
            ]
        
            # Search in backup directories first, then source
            search_dirs = [
                BACKUP_ALL_DIR / 'maps_source',
                BACKUP_ALL_DIR / 'doodad',
                BACKUP_EXTRA_DIR / 'maps_source',
                BACKUP_EXTRA_DIR / 'doodad',
                SOURCE_DIR / 'maps_source',
                SOURCE_DIR / 'doodad',
            ]
        
            for loc in possible:
                if loc.exists():
                    found_path = str(loc)
                    break
        
            if not found_path:
                for sd in search_dirs:
                    if sd.exists():
                        found = find_file_recursive(str(sd), basename_mesh)
                        if found:
                            found_path = found
                            break
        
        if not found_path:
            failed += 1
            continue
        
        try:
            mesh_data = parse_mesh_file(found_path)

            found_p = Path(found_path)
            if is_srt:
                # SRT companion: look for stem_3dmesh.JsonInspack
                jip_name = found_p.stem + '_3dmesh.JsonInspack'
            else:
                jip_name = found_p.stem + '.JsonInspack'

            # Search for JsonInspack companion in multiple locations
            jsoninspack_path = found_p.parent / jip_name  # same dir as mesh
            if not jsoninspack_path.exists():
                # Try other backup/source directories
                for search_root in [BACKUP_ALL_DIR, BACKUP_EXTRA_DIR, SOURCE_DIR]:
                    jip_found = find_file_recursive(str(search_root), jip_name)
                    if jip_found:
                        jsoninspack_path = Path(jip_found)
                        break

            subset_materials = None
            is_official = False
            if jsoninspack_path.exists():
                is_official = True
                try:
                    subset_materials = parse_jsoninspack(jsoninspack_path)
                except Exception:
                    pass

            glb = mesh_to_glb(mesh_data, subset_materials)
            
            safe_name = basename_mesh.replace('.mesh', '.glb').replace('.Mesh', '.glb')
            out_path = out_dir / safe_name
            with open(out_path, 'wb') as f:
                f.write(glb)
            
            # Key in mesh-map uses original path (including .srt) so entities can find it
            converted_map[mesh_path] = f'meshes/{safe_name}'
            if is_official:
                official_meshes.append(safe_name)
            converted += 1
            if converted % 10 == 0:
                print(f'  Converted {converted}...')
        except Exception as e:
            print(f'  Failed: {basename_mesh}: {e}')
            failed += 1
    
    print(f'  Converted: {converted}, Failed/Not found: {failed}')
    print(f'  Official (with companions): {len(official_meshes)}')
    
    with open(OUTPUT_DIR / 'mesh-map.json', 'w', encoding='utf-8') as f:
        json.dump(converted_map, f, indent=2)

    with open(OUTPUT_DIR / 'official-meshes.json', 'w', encoding='utf-8') as f:
        json.dump(official_meshes, f, indent=2)
    
    return converted_map


def extract_environment():
    """Extract environment/lighting settings."""
    print('\n=== Extracting Environment ===')
    
    env_data = load_json_file(MAP_DIR / 'environment.json')
    
    try:
        with open(MAP_DIR / '龙门寻宝_Setting.ini', 'r', encoding='utf-8', errors='replace') as f:
            settings_ini = f.read()
    except Exception:
        settings_ini = ''
    
    water_info = None
    water_path = MAP_DIR / 'water' / 'waterinfo.json'
    if water_path.exists():
        water_info = load_json_file(water_path)
    
    environment = {
        'sunlight': env_data.get('sunlight'),
        'moonlight': env_data.get('moonlight'),
        'enableDayNightCycle': env_data.get('enableDayNightCycle'),
        'waterInfo': water_info,
    }
    
    with open(OUTPUT_DIR / 'environment.json', 'w', encoding='utf-8') as f:
        json.dump(environment, f, indent=2)
    
    print('  Saved environment settings')
    return environment


def build_map_config(landscape_info, entity_info):
    """Build the map configuration file."""
    print('\n=== Building Map Config ===')
    
    config = {
        'name': '龙门寻宝',
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
    
    with open(OUTPUT_DIR / 'map-config.json', 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)
    
    print('  Map config saved')
    return config


def main():
    print('JX3 Map Data Builder')
    print('==' * 20)
    print(f'Map: {MAP_DIR}')
    print(f'Output: {OUTPUT_DIR}')
    
    if not MAP_DIR.exists():
        print(f'ERROR: Map directory not found: {MAP_DIR}')
        sys.exit(1)
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    landscape_info = convert_heightmaps()
    entity_info = extract_scene_entities()
    env = extract_environment()
    mesh_map = convert_meshes(entity_info['mesh_paths'])
    config = build_map_config(landscape_info, entity_info)
    
    print('\n=== Build Complete ===')
    print(f'Heightmap tiles: {8 * 8}')
    print(f'Scene objects: {entity_info["total_objects"]}')
    print(f'Meshes converted: {len(mesh_map)}')


if __name__ == '__main__':
    main()
