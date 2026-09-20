import { describe, expect, it } from "vitest";
import { findLocalTilePath } from "../src/local-path.ts";
import type { RoomBounds } from "../src/index.ts";

const room: RoomBounds = {
  roomId: "room-a",
  minX: 0,
  maxX: 4,
  minY: 0,
  maxY: 4,
  z: 0,
};

describe("active-area local pathfinding", () => {
  it("finds a deterministic cardinal path around blocked tiles", () => {
    expect(
      findLocalTilePath(
        room,
        { x: 0, y: 2, z: 0 },
        { x: 4, y: 2, z: 0 },
        [
          { x: 1, y: 2, z: 0 },
          { x: 2, y: 2, z: 0 },
          { x: 3, y: 2, z: 0 },
        ],
      ),
    ).toEqual([
      { x: 0, y: 2, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 3, y: 1, z: 0 },
      { x: 4, y: 1, z: 0 },
      { x: 4, y: 2, z: 0 },
    ]);
  });

  it("returns undefined for a blocked destination or sealed target", () => {
    expect(
      findLocalTilePath(
        room,
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        [{ x: 1, y: 0, z: 0 }],
      ),
    ).toBeUndefined();

    expect(
      findLocalTilePath(
        room,
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 2, z: 0 },
        [
          { x: 2, y: 1, z: 0 },
          { x: 3, y: 2, z: 0 },
          { x: 2, y: 3, z: 0 },
          { x: 1, y: 2, z: 0 },
        ],
      ),
    ).toBeUndefined();
  });

  it("rejects endpoints outside the active room", () => {
    expect(() =>
      findLocalTilePath(
        room,
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
      ),
    ).toThrow(/start lies outside/i);
  });
});
