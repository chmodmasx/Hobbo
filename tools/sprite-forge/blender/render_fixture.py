#!/usr/bin/env python3
"""Build the minimal deterministic Hobbo Sprite Forge fixture in Blender."""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

WIDTH = 96
HEIGHT = 128
DIRECTIONS = (
    ("N", 0.0),
    ("NE", 45.0),
    ("E", 90.0),
    ("SE", 135.0),
    ("S", 180.0),
    ("SW", 225.0),
    ("W", 270.0),
    ("NW", 315.0),
)
FURNITURE_DIRECTIONS = ("N", "E", "S", "W")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", checksum)
    )


def paeth_predictor(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    distance_left = abs(estimate - left)
    distance_up = abs(estimate - up)
    distance_upper_left = abs(estimate - upper_left)
    if distance_left <= distance_up and distance_left <= distance_upper_left:
        return left
    if distance_up <= distance_upper_left:
        return up
    return upper_left


def canonicalize_png(path: Path) -> None:
    """Rewrite Blender RGBA PNG bytes with deterministic filtering/compression."""

    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise RuntimeError(f"Not a PNG: {path}")

    offset = len(PNG_SIGNATURE)
    ihdr = None
    idat_parts: list[bytes] = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload_start = offset + 8
        payload_end = payload_start + length
        payload = data[payload_start:payload_end]
        offset = payload_end + 4
        if kind == b"IHDR":
            ihdr = payload
        elif kind == b"IDAT":
            idat_parts.append(payload)
        elif kind == b"IEND":
            break

    if ihdr is None or not idat_parts:
        raise RuntimeError(f"PNG lacks IHDR/IDAT: {path}")

    (
        width,
        height,
        bit_depth,
        color_type,
        compression_method,
        filter_method,
        interlace_method,
    ) = struct.unpack(">IIBBBBB", ihdr)
    if (
        bit_depth != 8
        or color_type != 6
        or compression_method != 0
        or filter_method != 0
        or interlace_method != 0
    ):
        raise RuntimeError(
            f"Unsupported fixture PNG encoding for canonicalization: {path}"
        )

    bytes_per_pixel = 4
    stride = width * bytes_per_pixel
    filtered = zlib.decompress(b"".join(idat_parts))
    if len(filtered) != (stride + 1) * height:
        raise RuntimeError(f"Unexpected PNG scanline length: {path}")

    previous = bytearray(stride)
    rows: list[bytes] = []
    cursor = 0
    for _row_index in range(height):
        filter_type = filtered[cursor]
        cursor += 1
        row = bytearray(filtered[cursor : cursor + stride])
        cursor += stride

        for index in range(stride):
            left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            up = previous[index]
            upper_left = (
                previous[index - bytes_per_pixel]
                if index >= bytes_per_pixel
                else 0
            )
            if filter_type == 0:
                value = row[index]
            elif filter_type == 1:
                value = row[index] + left
            elif filter_type == 2:
                value = row[index] + up
            elif filter_type == 3:
                value = row[index] + ((left + up) // 2)
            elif filter_type == 4:
                value = row[index] + paeth_predictor(
                    left,
                    up,
                    upper_left,
                )
            else:
                raise RuntimeError(
                    f"Unsupported PNG filter {filter_type}: {path}"
                )
            row[index] = value & 0xFF

        rows.append(bytes(row))
        previous = row

    canonical_scanlines = b"".join(b"\x00" + row for row in rows)
    canonical_idat = zlib.compress(canonical_scanlines, level=9)
    path.write_bytes(
        PNG_SIGNATURE
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", canonical_idat)
        + png_chunk(b"IEND", b"")
    )


def cli_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args(args)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
    ):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def material(name: str, rgba: tuple[float, float, float, float]):
    mat = bpy.data.materials.new(name=name)
    mat.diffuse_color = rgba
    return mat


def box(name: str, location, scale, mat) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    obj.color = mat.diffuse_color
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def sphere(
    name: str,
    location,
    radius: float,
    mat,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2,
        radius=radius,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    obj.color = mat.diffuse_color
    return obj


def build_mannequin() -> list[bpy.types.Object]:
    skin = material("fixture_skin", (0.72, 0.50, 0.35, 1.0))
    body = material("fixture_body", (0.20, 0.36, 0.62, 1.0))
    wearable = material("fixture_wearable", (0.22, 0.62, 0.34, 1.0))
    marker = material("fixture_front_marker", (0.85, 0.18, 0.12, 1.0))
    shoe = material("fixture_shoe", (0.10, 0.10, 0.12, 1.0))

    return [
        box("body_torso", (0, 0, 1.35), (0.36, 0.22, 0.48), body),
        box(
            "wearable_vest",
            (0, -0.235, 1.43),
            (0.39, 0.035, 0.30),
            wearable,
        ),
        box("arm_l", (-0.49, 0, 1.34), (0.105, 0.13, 0.44), skin),
        box("arm_r", (0.49, 0, 1.34), (0.105, 0.13, 0.44), skin),
        box("leg_l", (-0.18, 0, 0.55), (0.13, 0.16, 0.43), body),
        box("leg_r", (0.18, 0, 0.55), (0.13, 0.16, 0.43), body),
        box("shoe_l", (-0.18, -0.045, 0.12), (0.15, 0.22, 0.10), shoe),
        box("shoe_r", (0.18, -0.045, 0.12), (0.15, 0.22, 0.10), shoe),
        sphere("head", (0, 0, 2.10), 0.31, skin),
        box(
            "face_marker",
            (0, -0.30, 2.10),
            (0.065, 0.035, 0.065),
            marker,
        ),
    ]


def build_chair() -> list[bpy.types.Object]:
    wood = material("fixture_wood", (0.48, 0.25, 0.10, 1.0))
    accent = material("fixture_chair_accent", (0.72, 0.48, 0.18, 1.0))
    return [
        box("chair_seat", (0, 0, 0.65), (0.48, 0.48, 0.10), accent),
        box("chair_back", (0, 0.43, 1.10), (0.48, 0.08, 0.52), wood),
        box(
            "chair_leg_fl",
            (-0.37, -0.36, 0.30),
            (0.075, 0.075, 0.30),
            wood,
        ),
        box(
            "chair_leg_fr",
            (0.37, -0.36, 0.30),
            (0.075, 0.075, 0.30),
            wood,
        ),
        box(
            "chair_leg_bl",
            (-0.37, 0.36, 0.30),
            (0.075, 0.075, 0.30),
            wood,
        ),
        box(
            "chair_leg_br",
            (0.37, 0.36, 0.30),
            (0.075, 0.075, 0.30),
            wood,
        ),
    ]


def configure_scene() -> tuple[bpy.types.Scene, bpy.types.Object]:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = False
    scene.display.shading.show_specular_highlight = False

    bpy.ops.object.camera_add(location=(4.5, -4.5, 3.5))
    camera = bpy.context.object
    camera.name = "fixture_camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.15
    scene.camera = camera
    return scene, camera


def point_camera(
    camera: bpy.types.Object,
    azimuth_degrees: float,
    target: Vector,
) -> None:
    radius = 5.8
    angle = math.radians(azimuth_degrees)
    camera.location = Vector(
        (
            math.sin(angle) * radius,
            -math.cos(angle) * radius,
            target.z + 3.15,
        )
    )
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def anchor_pixels(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    point: Vector,
) -> list[int]:
    projected = world_to_camera_view(scene, camera, point)
    x = int(round(projected.x * WIDTH))
    y = int(round((1.0 - projected.y) * HEIGHT))
    return [x, y]


def set_visible(
    all_assets: list[bpy.types.Object],
    selected: list[bpy.types.Object],
) -> None:
    selected_ids = {id(obj) for obj in selected}
    for obj in all_assets:
        obj.hide_render = id(obj) not in selected_ids


def render_frame(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    output_dir: Path,
    asset_id: str,
    direction: str,
    azimuth: float,
    target: Vector,
    anchor_point: Vector,
) -> dict:
    point_camera(camera, azimuth, target)
    filename = f"{asset_id}_{direction}.png"
    scene.render.filepath = str(output_dir / filename)
    bpy.ops.render.render(write_still=True)
    return {
        "assetId": asset_id,
        "direction": direction,
        "file": filename,
        "width": WIDTH,
        "height": HEIGHT,
        "anchor": anchor_pixels(scene, camera, anchor_point),
    }


def build_atlas(output_dir: Path, frames: list[dict]) -> dict:
    columns = 4
    rows = math.ceil(len(frames) / columns)
    atlas_width = columns * WIDTH
    atlas_height = rows * HEIGHT
    pixels = [0.0] * (atlas_width * atlas_height * 4)

    for index, frame in enumerate(frames):
        source = bpy.data.images.load(
            str(output_dir / frame["file"]),
            check_existing=False,
        )
        source_pixels = list(source.pixels[:])
        col = index % columns
        row = index // columns
        dest_x = col * WIDTH
        # Blender pixel memory starts at the lower-left. Runtime atlas
        # metadata uses top-left coordinates, so row zero is copied to top.
        dest_y_bottom = atlas_height - (row + 1) * HEIGHT
        for source_y in range(HEIGHT):
            src_start = source_y * WIDTH * 4
            dst_start = (
                (dest_y_bottom + source_y) * atlas_width + dest_x
            ) * 4
            pixels[dst_start : dst_start + WIDTH * 4] = source_pixels[
                src_start : src_start + WIDTH * 4
            ]
        frame["atlas"] = {
            "x": dest_x,
            "y": row * HEIGHT,
            "width": WIDTH,
            "height": HEIGHT,
        }
        bpy.data.images.remove(source)

    atlas = bpy.data.images.new(
        "fixture_atlas",
        width=atlas_width,
        height=atlas_height,
        alpha=True,
        float_buffer=False,
    )
    atlas.pixels.foreach_set(pixels)
    atlas.filepath_raw = str(output_dir / "fixture_atlas.png")
    atlas.file_format = "PNG"
    atlas.save()
    bpy.data.images.remove(atlas)
    return {
        "file": "fixture_atlas.png",
        "width": atlas_width,
        "height": atlas_height,
        "columns": columns,
        "rows": rows,
    }


def main() -> None:
    args = cli_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    clear_scene()
    scene, camera = configure_scene()
    mannequin = build_mannequin()
    chair = build_chair()
    all_assets = mannequin + chair
    frames: list[dict] = []

    set_visible(all_assets, mannequin)
    for direction, azimuth in DIRECTIONS:
        frames.append(
            render_frame(
                scene,
                camera,
                output_dir,
                "mannequin_idle",
                direction,
                azimuth,
                Vector((0, 0, 1.15)),
                Vector((0, 0, 0)),
            )
        )

    set_visible(all_assets, chair)
    direction_map = dict(DIRECTIONS)
    for direction in FURNITURE_DIRECTIONS:
        frames.append(
            render_frame(
                scene,
                camera,
                output_dir,
                "chair",
                direction,
                direction_map[direction],
                Vector((0, 0, 0.70)),
                Vector((0, 0, 0)),
            )
        )

    atlas = build_atlas(output_dir, frames)

    # Raw Blender PNGs may carry process-dependent ancillary bytes even when
    # the rendered RGBA pixels are identical. Canonicalize the generated
    # deliverables after atlas composition so final build output is
    # byte-reproducible without changing Blender's input color interpretation.
    for frame in frames:
        canonicalize_png(output_dir / frame["file"])
    canonicalize_png(output_dir / atlas["file"])

    manifest = {
        "schemaVersion": 1,
        "fixture": "minimal-blender-v1",
        "blenderVersion": bpy.app.version_string,
        "render": {
            "engine": "BLENDER_WORKBENCH",
            "width": WIDTH,
            "height": HEIGHT,
            "transparent": True,
            "colorManagement": "Standard",
        },
        "directions": [direction for direction, _ in DIRECTIONS],
        "assets": {
            "mannequin": {
                "id": "mannequin_idle",
                "animation": "idle",
                "wearable": "fixture_vest",
                "directions": [direction for direction, _ in DIRECTIONS],
            },
            "furniture": {
                "id": "chair",
                "directions": list(FURNITURE_DIRECTIONS),
                "footprint": [1, 1],
            },
        },
        "atlas": atlas,
        "frames": frames,
    }
    (output_dir / "fixture_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
