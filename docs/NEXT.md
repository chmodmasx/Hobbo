# Immediate next step

Integrate Sprite Forge output into the first PixiJS isometric renderer slice.

This milestone should prove the generated asset contract is consumable by a real browser renderer without coupling presentation back into simulation authority.

The first renderer gate should:

- add a dedicated rendering package for pure isometric projection, direction/frame lookup and Sprite Forge manifest validation;
- keep logical world coordinates orthogonal `(x, y, z)`; isometric projection exists only in rendering code;
- add a minimal `apps/client` browser app using PixiJS for world sprites and ordinary DOM/React only for UI chrome;
- consume the generated Sprite Forge fixture atlas/manifest rather than hand-maintained spritesheets;
- render one mannequin and one chair at deterministic logical coordinates with correct ground anchors;
- sort sprites by a stable isometric depth key rather than insertion order;
- demonstrate switching the mannequin through all eight generated directions without changing persistent world identity;
- keep atlas/frame selection data-driven from the manifest;
- add unit tests for projection, anchor application, frame lookup, depth ordering and malformed manifest rejection;
- make CI regenerate the Blender fixture, validate it, then run a renderer contract/build check against that exact generated output;
- avoid introducing gameplay/world mutation into the client.

Do not build realtime multiplayer, pathfinding, large maps or character customization in this slice. The gate is only the first deterministic bridge from Sprite Forge artifacts to PixiJS rendering.
