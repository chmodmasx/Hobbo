# Hobbo Sprite Forge

Build-time pipeline that converts reproducible parametric 3D/metadata sources into deterministic 2D isometric pixel-art layers and atlases.

The first executable fixture lives in `blender/render_fixture.py`. It creates all source geometry procedurally so CI does not depend on an opaque `.blend` binary. The fixture contains:

- one canonical mannequin with a simple wearable/front marker;
- eight mannequin directions (`N, NE, E, SE, S, SW, W, NW`);
- one chair rendered in four directions;
- fixed orthographic camera/render settings;
- per-frame ground/foot anchors and stable asset/direction IDs;
- a deterministic 4×3 PNG atlas plus JSON manifest.

`fixtures/validate_fixture.py` validates PNG dimensions/alpha, directions, anchors, furniture footprint and atlas metadata. Sprite Forge CI renders the fixture twice in fresh Blender processes and compares SHA-256 digests for every generated frame, atlas and manifest.

Generated output stays under `.cache/sprite-forge/` or `assets/generated/` and is never source art.

The intended layout remains:

```text
sprite-forge/
├── blender/       # headless Blender scripts
├── compiler/      # crop/palette/mask/anchor processing
├── atlas/         # packing + Pixi metadata
├── schemas/       # JSON schemas for source/generated metadata
└── fixtures/      # tiny deterministic CI fixtures
```

The next pipeline slices should replace fixture-only geometry/metadata with versioned canonical rig sources and declarative definitions while preserving this reproducible build contract. See `docs/ASSET_PIPELINE.md`.
