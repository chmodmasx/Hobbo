# Hobbo Sprite Forge

Build-time pipeline that converts reproducible parametric 3D/metadata sources into deterministic 2D isometric pixel-art layers and atlases.

This directory will eventually contain:

```text
sprite-forge/
├── blender/       # headless Blender scripts
├── compiler/      # crop/palette/mask/anchor processing
├── atlas/         # packing + Pixi metadata
├── schemas/       # JSON schemas for source/generated metadata
└── fixtures/      # tiny deterministic CI fixtures
```

The first implementation target is intentionally narrow: render one mannequin in eight directions plus one piece of furniture, validate dimensions/anchors, and generate a small atlas. See `docs/ASSET_PIPELINE.md`.
