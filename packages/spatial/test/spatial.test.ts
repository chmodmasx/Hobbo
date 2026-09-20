import { describe, expect, it } from "vitest";
import { ActionRegistry } from "@hobbo/actions";
import {
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import {
  SPATIAL_MOVE_ACTION_ID,
  createMoveActionDefinition,
  directionForMove,
  targetForMove,
  type RoomBounds,
  type SpatialActorState,
} from "../src/index.ts";

const bounds: RoomBounds = {
  roomId: "room-a",
  minX: 0,
  maxX: 4,
  minY: 0,
  maxY: 4,
  z: 0,
};

const state: SpatialActorState = {
  personId: "alice",
  roomId: "room-a",
  x: 2,
  y: 2,
  z: 0,
  facing: "S",
};

function validate(input: unknown, worldState = state) {
  const registry = new ActionRegistry<SpatialActorState>();
  registry.register(createMoveActionDefinition(bounds));
  return registry.validate(
    {
      actionId: SPATIAL_MOVE_ACTION_ID,
      actorId: asEntityId("alice"),
      origin: "player",
      requestedAt: simTime(0),
      correlationId: asCorrelationId("move-test"),
      input,
    },
    {
      actorId: asEntityId("alice"),
      simTime: simTime(0),
      worldState,
    },
  );
}

describe("spatial movement action", () => {
  it("accepts every one-tile compass move and derives facing", () => {
    const cases = [
      [{ dx: 0, dy: -1 }, "N"],
      [{ dx: 1, dy: -1 }, "NE"],
      [{ dx: 1, dy: 0 }, "E"],
      [{ dx: 1, dy: 1 }, "SE"],
      [{ dx: 0, dy: 1 }, "S"],
      [{ dx: -1, dy: 1 }, "SW"],
      [{ dx: -1, dy: 0 }, "W"],
      [{ dx: -1, dy: -1 }, "NW"],
    ] as const;

    for (const [input, facing] of cases) {
      expect(validate(input).ok).toBe(true);
      expect(directionForMove(input)).toBe(facing);
      expect(targetForMove(state, input).facing).toBe(facing);
    }
  });

  it("rejects malformed, zero-length and multi-tile moves", () => {
    for (const input of [
      {},
      { dx: 0, dy: 0 },
      { dx: 2, dy: 0 },
      { dx: 0.5, dy: 0 },
      { dx: "1", dy: 0 },
    ]) {
      expect(validate(input)).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    }
  });

  it("rejects movement outside room bounds", () => {
    expect(
      validate(
        { dx: -1, dy: 0 },
        { ...state, x: 0 },
      ),
    ).toMatchObject({
      ok: false,
      code: "out_of_bounds",
    });
  });

  it("rejects a stale room/bounds pairing", () => {
    expect(
      validate(
        { dx: 1, dy: 0 },
        { ...state, roomId: "room-b" },
      ),
    ).toMatchObject({
      ok: false,
      code: "room_mismatch",
    });
  });
});
