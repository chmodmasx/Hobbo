# Hobbo client renderer fixture

This is the first browser rendering slice. PixiJS owns world sprites; DOM owns the small fixture toolbar.

The client intentionally does not contain simulation authority. It consumes generated Sprite Forge artifacts from:

```text
apps/client/public/sprite-forge/
```

That directory is ignored build output. Sprite Forge CI regenerates the fixture, validates it through `@hobbo/rendering`, copies it into the client public directory, and builds the client from that exact output.

For local use, first generate/copy the Sprite Forge fixture, then run:

```bash
pnpm --filter @hobbo/client dev
```

The fixture renders one mannequin and one chair at logical orthogonal coordinates. The toolbar cycles the mannequin through all eight generated directions; frame selection, anchors, isometric projection and depth ordering come from `@hobbo/rendering`.
