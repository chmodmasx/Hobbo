#!/usr/bin/env python3
"""Validate and compare generated Sprite Forge fixture output."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path

WIDTH = 96
HEIGHT = 128
EXPECTED_MANNEQUIN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
EXPECTED_CHAIR = ["N", "E", "S", "W"]


def png_dimensions(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError(f"Not a PNG: {path}")
    length = struct.unpack(">I", data[8:12])[0]
    if length != 13 or data[12:16] != b"IHDR":
        raise AssertionError(f"Missing PNG IHDR: {path}")
    width, height, bit_depth, color_type = struct.unpack(
        ">IIBB",
        data[16:26],
    )
    if bit_depth != 8:
        raise AssertionError(f"Expected 8-bit PNG: {path}")
    return width, height, color_type


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(root: Path) -> dict[str, str]:
    manifest_path = root / "fixture_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == 1
    assert manifest["fixture"] == "minimal-blender-v1"
    assert manifest["render"]["width"] == WIDTH
    assert manifest["render"]["height"] == HEIGHT
    assert manifest["directions"] == EXPECTED_MANNEQUIN
    assert (
        manifest["assets"]["mannequin"]["directions"]
        == EXPECTED_MANNEQUIN
    )
    assert manifest["assets"]["mannequin"]["wearable"] == "fixture_vest"
    assert manifest["assets"]["furniture"]["directions"] == EXPECTED_CHAIR
    assert manifest["assets"]["furniture"]["footprint"] == [1, 1]

    frames = manifest["frames"]
    assert len(frames) == 12
    expected_names = {
        *(f"mannequin_idle_{direction}.png" for direction in EXPECTED_MANNEQUIN),
        *(f"chair_{direction}.png" for direction in EXPECTED_CHAIR),
    }
    assert {frame["file"] for frame in frames} == expected_names

    hashes: dict[str, str] = {}
    for frame in frames:
        path = root / frame["file"]
        width, height, color_type = png_dimensions(path)
        assert (width, height) == (WIDTH, HEIGHT)
        assert color_type == 6
        assert path.stat().st_size > 100
        anchor_x, anchor_y = frame["anchor"]
        assert isinstance(anchor_x, int) and isinstance(anchor_y, int)
        assert 0 <= anchor_x < WIDTH
        assert 0 <= anchor_y < HEIGHT
        rect = frame["atlas"]
        assert rect["width"] == WIDTH and rect["height"] == HEIGHT
        hashes[frame["file"]] = digest(path)

    # Directional output must not collapse into one symmetric render.
    assert len(set(hashes.values())) >= 6

    atlas = root / manifest["atlas"]["file"]
    atlas_width, atlas_height, atlas_color_type = png_dimensions(atlas)
    assert (atlas_width, atlas_height) == (
        manifest["atlas"]["width"],
        manifest["atlas"]["height"],
    )
    assert (atlas_width, atlas_height) == (WIDTH * 4, HEIGHT * 3)
    assert atlas_color_type == 6
    hashes[atlas.name] = digest(atlas)
    hashes[manifest_path.name] = digest(manifest_path)
    return hashes


def compare(left: Path, right: Path) -> None:
    left_hashes = validate(left)
    right_hashes = validate(right)
    if left_hashes != right_hashes:
        changed = sorted(
            name
            for name in set(left_hashes) | set(right_hashes)
            if left_hashes.get(name) != right_hashes.get(name)
        )
        raise AssertionError(
            "Sprite Forge fixture is not byte-deterministic: "
            + ", ".join(changed)
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--compare", nargs=2, type=Path)
    args = parser.parse_args()
    if args.compare:
        compare(args.compare[0], args.compare[1])
        print(
            "Sprite Forge fixture is byte-deterministic across two renders."
        )
        return
    if args.output_dir:
        hashes = validate(args.output_dir)
        print(
            f"Validated Sprite Forge fixture with {len(hashes)} generated files."
        )
        return
    parser.error("use --output-dir or --compare")


if __name__ == "__main__":
    main()
