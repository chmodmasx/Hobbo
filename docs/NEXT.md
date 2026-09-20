# Immediate next step

Build the minimal deterministic Sprite Forge Blender fixture.

The first visual-pipeline gate should:

- create one canonical humanoid mannequin procedurally in a headless Blender script so CI does not depend on an opaque binary `.blend` fixture;
- include one simple wearable/front-facing marker so directional rendering and layer intent are visible;
- render the mannequin in all eight canonical directions: `N, NE, E, SE, S, SW, W, NW`;
- render one furniture object in at least four orientations;
- use fixed orthographic camera, resolution, transparency, workbench shading and color-management settings;
- emit per-frame dimensions, foot/ground anchors and stable asset/direction IDs in generated metadata;
- generate one small fixed-layout atlas plus JSON metadata;
- validate PNG dimensions/alpha, directions, anchors, furniture footprint and atlas bounds without treating generated output as source art;
- render the fixture twice in independent Blender processes in CI and prove byte-for-byte deterministic output for the pinned CI environment;
- upload one generated fixture set as a CI artifact for inspection.

Keep all generated images and atlases under ignored build/cache directories. Source of truth remains reproducible Blender/Python/metadata inputs.

Do not expand into a large asset library, runtime Pixi integration or generative frame production in this slice. The purpose of this gate is to prove the deterministic source-to-sprite build contract first.
