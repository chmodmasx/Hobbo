import { describe, expect, it } from "vitest";
import {
  CANONICAL_DIRECTIONS,
  applyGroundAnchor,
  frameFor,
  projectIsometric,
  sortIsometricRenderables,
  validateSpriteForgeManifest,
} from "../src/index.ts";

function rawFixture(): unknown {
  const directions = [...CANONICAL_DIRECTIONS];
  const frameDirections = [
    ...directions,
    "N",
    "E",
    "S",
    "W",
  ];
  const frames = frameDirections.map((direction, index) => ({
    assetId: index < 8 ? "mannequin_idle" : "chair",
    direction,
    file:
      index < 8
        ? `mannequin_idle_${direction}.png`
        : `chair_${direction}.png`,
    width: 96,
    height: 128,
    anchor: [48, 100],
    atlas: {
      x: (index % 4) * 96,
      y: Math.floor(index / 4) * 128,
      width: 96,
      height: 128,
    },
  }));

  return {
    schemaVersion: 1,
    fixture: "minimal-blender-v1",
    blenderVersion: "4.0.2",
    render: {
      engine: "BLENDER_WORKBENCH",
      width: 96,
      height: 128,
      transparent: true,
      colorManagement: "Standard",
    },
    directions,
    assets: {
      mannequin: {
        id: "mannequin_idle",
      },
      furniture: {
        id: "chair",
      },
    },
    atlas: {
      file: "fixture_atlas.png",
      width: 384,
      height: 384,
      columns: 4,
      rows: 3,
    },
    frames,
  };
}

describe("Sprite Forge rendering contract", () => {
  it("accepts the generated fixture shape and finds all eight mannequin directions", () => {
    const manifest = validateSpriteForgeManifest(rawFixture());

    expect(manifest.atlas).toMatchObject({
      x: 0,
      y: 0,
      width: 384,
      height: 384,
      columns: 4,
      rows: 3,
    });
    expect(
      CANONICAL_DIRECTIONS.map(
        (direction) =>
          frameFor(manifest, "mannequin_idle", direction).direction,
      ),
    ).toEqual(CANONICAL_DIRECTIONS);
  });

  it("projects orthogonal logical coordinates into isometric screen space", () => {
    expect(
      projectIsometric(
        { x: 2, y: 1, z: 0 },
        {
          tileWidth: 64,
          tileHeight: 32,
          elevationHeight: 32,
        },
      ),
    ).toEqual({ x: 32, y: 48 });

    expect(
      projectIsometric(
        { x: 2, y: 1, z: 1 },
        {
          tileWidth: 64,
          tileHeight: 32,
          elevationHeight: 32,
          originX: 400,
          originY: 100,
        },
      ),
    ).toEqual({ x: 432, y: 116 });
  });

  it("applies the generated ground anchor to sprite top-left placement", () => {
    expect(
      applyGroundAnchor(
        { x: 432, y: 180 },
        { anchor: [48, 100] },
      ),
    ).toEqual({ x: 384, y: 80 });
  });

  it("uses deterministic isometric depth ordering instead of insertion order", () => {
    const sorted = sortIsometricRenderables([
      { id: "high", position: { x: 0, y: 1, z: 1 } },
      { id: "far-y", position: { x: 0, y: 1, z: 0 } },
      { id: "origin", position: { x: 0, y: 0, z: 0 } },
      { id: "far-x", position: { x: 1, y: 0, z: 0 } },
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual([
      "origin",
      "far-x",
      "far-y",
      "high",
    ]);
  });

  it("rejects duplicate frame identities", () => {
    const raw = rawFixture() as {
      frames: Record<string, unknown>[];
    };
    raw.frames[1] = { ...raw.frames[0] };

    expect(() => validateSpriteForgeManifest(raw)).toThrow(/duplicate/i);
  });

  it("rejects anchors or atlas rectangles outside their bounds", () => {
    const badAnchor = rawFixture() as {
      frames: Record<string, unknown>[];
    };
    badAnchor.frames[0] = {
      ...badAnchor.frames[0],
      anchor: [96, 127],
    };
    expect(() => validateSpriteForgeManifest(badAnchor)).toThrow(
      /anchor.*inside/i,
    );

    const badAtlas = rawFixture() as {
      frames: Record<string, unknown>[];
    };
    badAtlas.frames[0] = {
      ...badAtlas.frames[0],
      atlas: {
        x: 350,
        y: 0,
        width: 96,
        height: 128,
      },
    };
    expect(() => validateSpriteForgeManifest(badAtlas)).toThrow(
      /outside the atlas/i,
    );
  });
});
