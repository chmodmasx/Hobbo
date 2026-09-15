# Hobbo Sprite Forge

Hobbo does not treat manually-authored spritesheets as the primary source of character art.

The source of truth is a parametric asset set (rigs, meshes, materials, palettes, animation clips and declarative metadata). A headless build pipeline renders those sources into deterministic 2D pixel-art layers and runtime atlases.

## Design goals

- consistent identity across frames and viewing directions;
- reusable animation across large populations;
- modular clothing, hair and accessories;
- deterministic regeneration;
- palette-based recoloring rather than duplicated assets;
- isometric anchors, depth and occlusion metadata generated with the image output;
- runtime performance comparable to conventional sprite rendering;
- generated output is replaceable build output, not hand-maintained source art.

## Source layout

```text
assets/
├── source/
│   ├── rigs/
│   ├── bodies/
│   ├── hair/
│   ├── clothes/
│   ├── accessories/
│   ├── furniture/
│   ├── animations/
│   └── palettes/
├── definitions/
│   ├── avatars/
│   ├── wearables/
│   ├── furniture/
│   └── animations/
└── generated/              # ignored by Git
    ├── layers/
    ├── masks/
    ├── atlases/
    └── metadata/
```

## Canonical rig

All humanoid bodies and wearables must target one versioned canonical skeleton. Animation clips are authored once against the canonical rig and reused by compatible bodies/clothing.

The initial animation vocabulary is intentionally small:

```text
idle
walk
sit
lie
sleep
talk
eat
drink
wave
carry
interact
```

Animation vocabulary grows through versioned additions rather than character-specific clips.

## Directional rendering

The initial contract supports eight character directions:

```text
N, NE, E, SE, S, SW, W, NW
```

Static furniture may declare four or eight orientations independently.

A Blender headless stage renders each required `(asset, animation, direction, frame)` tuple using fixed orthographic camera, light, scale and color-management settings. The render must be reproducible on CI and developer machines within the accepted image-diff tolerance.

## Pixel-art compiler

Raw Blender renders are intermediate data. The pixel compiler performs at minimum:

1. fixed-resolution resampling using the selected pixel-art policy;
2. palette quantization;
3. alpha cleanup;
4. frame-bound normalization;
5. anchor extraction/validation;
6. optional shadow mask generation;
7. optional occlusion/depth masks;
8. metadata generation.

No generative image model is allowed to alter individual animation frames in the deterministic runtime pipeline. Generative tools may be used during asset ideation, but accepted source assets must be reproducible without calling an image-generation service.

## Layer contract

An avatar is a recipe, not a unique prerendered sprite set.

Example:

```json
{
  "body": "body_03",
  "skinPalette": "skin_07",
  "hair": { "asset": "hair_048", "palette": "brown_03" },
  "top": { "asset": "hoodie_014", "palette": "green_02" },
  "bottom": { "asset": "pants_008", "palette": "black_01" },
  "shoes": { "asset": "shoe_003", "palette": "white_01" }
}
```

All compatible layers share the same animation/frame/direction coordinate system.

## Palette swaps

Color variants should normally be data rather than new image files. Source layers use indexed semantic colors or masks; the Pixi renderer applies palette lookup/recoloring before caching the composed avatar.

## Occlusion and ordering

Isometric clothing needs direction-dependent ordering. Wearable definitions may split an asset into logical passes such as:

```text
back
body
front
```

Generated metadata identifies which passes are visible and what body regions they occlude for each direction/animation.

## Runtime composition

PixiJS composes the selected layers for the active frame. Repeated work is avoided with a RenderTexture/cache keyed by a normalized avatar recipe plus animation state.

Changing appearance invalidates only affected cache entries.

## Atlases

Atlases remain a runtime optimization, not source art.

```text
parametric sources
      ↓
Sprite Forge
      ↓
generated layers
      ↓
asset compiler
      ↓
atlas + JSON metadata
      ↓
PixiJS
```

The atlas builder may repack generated layers without changing persistent avatar recipes.

## Furniture

Furniture follows the same principle. A source mesh plus definition can generate orientation sprites, shadow/occlusion masks, footprint metadata and anchors. Gameplay affordances (`sit`, `sleep`, `store`, etc.) are defined separately from visual generation.

## CI

The first CI stage for Sprite Forge should be deliberately small: one canonical mannequin, one wearable and one piece of furniture. It verifies that Blender headless can regenerate expected outputs and that metadata validates. Large full-asset builds can move to a self-hosted build runner later without changing the pipeline contract.
