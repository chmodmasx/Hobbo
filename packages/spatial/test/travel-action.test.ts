import { ActionRegistry } from "@hobbo/actions";
import {
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import { describe, expect, it } from "vitest";
import {
  SPATIAL_TRAVEL_ACTION_ID,
  createTravelActionDefinition,
  type TravelActionWorldState,
} from "../src/travel-action.ts";

const worldState: TravelActionWorldState = {
  actor: {
    personId: "alice",
    roomId: "room-home",
    x: 1,
    y: 1,
    z: 0,
    facing: "E",
  },
  nodes: [
    { id: "room-home", kind: "room" },
    { id: "street-main", kind: "street" },
    { id: "room-work", kind: "room" },
  ],
  connections: [
    {
      id: "home-street",
      fromNodeId: "room-home",
      toNodeId: "street-main",
      travelSeconds: 10,
      bidirectional: true,
    },
    {
      id: "street-work",
      fromNodeId: "street-main",
      toNodeId: "room-work",
      travelSeconds: 20,
      bidirectional: true,
    },
  ],
};

function validate(
  input: unknown,
  state: TravelActionWorldState = worldState,
) {
  const registry = new ActionRegistry<TravelActionWorldState>();
  registry.register(createTravelActionDefinition());
  return registry.validate(
    {
      actionId: SPATIAL_TRAVEL_ACTION_ID,
      actorId: asEntityId("alice"),
      origin: "player",
      requestedAt: simTime(0),
      correlationId: asCorrelationId("travel-test"),
      input,
    },
    {
      actorId: asEntityId("alice"),
      simTime: simTime(0),
      worldState: state,
    },
  );
}

describe("spatial travel action", () => {
  it("accepts a reachable enabled room", () => {
    expect(validate({ destinationRoomId: "room-work" })).toMatchObject({
      ok: true,
    });
  });

  it("rejects malformed, same-room, disabled and unreachable destinations", () => {
    expect(validate({})).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(validate({ destinationRoomId: "room-home" })).toMatchObject({
      ok: false,
      code: "already_there",
    });
    expect(
      validate(
        { destinationRoomId: "room-work" },
        {
          ...worldState,
          nodes: worldState.nodes.map((node) =>
            node.id === "room-work" ? { ...node, enabled: false } : node,
          ),
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "invalid_destination",
    });
    expect(
      validate(
        { destinationRoomId: "room-work" },
        { ...worldState, connections: [] },
      ),
    ).toMatchObject({
      ok: false,
      code: "unreachable_destination",
    });
  });

  it("rejects a second travel while the actor is already in transit", () => {
    expect(
      validate(
        { destinationRoomId: "room-work" },
        {
          ...worldState,
          actor: {
            ...worldState.actor,
            roomId: "__transit__:existing-trip",
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "already_in_transit",
    });
  });
});
