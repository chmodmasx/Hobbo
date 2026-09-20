import type { ActionDefinition } from "@hobbo/actions";
import { asActionId } from "@hobbo/domain";
import {
  findShortestSpatialRoute,
  type SpatialTopologyConnection,
  type SpatialTopologyNode,
} from "./topology.ts";
import type { SpatialActorState } from "./index.ts";

export const SPATIAL_TRAVEL_ACTION_ID = asActionId("spatial.travel");

export interface TravelActionInput {
  readonly destinationRoomId: string;
}

export interface TravelActionWorldState {
  readonly actor: SpatialActorState;
  readonly nodes: readonly SpatialTopologyNode[];
  readonly connections: readonly SpatialTopologyConnection[];
  readonly activeTravelId?: string;
}

export function isTravelActionInput(
  input: unknown,
): input is TravelActionInput {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "destinationRoomId" in input &&
    typeof input.destinationRoomId === "string" &&
    input.destinationRoomId.trim().length > 0
  );
}

export function createTravelActionDefinition(): ActionDefinition<TravelActionWorldState> {
  return {
    id: SPATIAL_TRAVEL_ACTION_ID,
    label: "Travel to room",
    description:
      "Plan hierarchical travel from the actor's current room to another enabled room.",
    validate(context, input) {
      if (!isTravelActionInput(input)) {
        return {
          ok: false,
          code: "invalid_input",
          message: "spatial.travel requires a non-empty destinationRoomId",
        };
      }

      const current = context.worldState.actor;
      if (context.worldState.activeTravelId !== undefined) {
        return {
          ok: false,
          code: "active_travel_exists",
          message: `Actor already has active travel ${context.worldState.activeTravelId}`,
        };
      }
      if (current.roomId.startsWith("__transit__:")) {
        return {
          ok: false,
          code: "already_in_transit",
          message: "Actor is already in transit",
        };
      }
      if (current.roomId === input.destinationRoomId) {
        return {
          ok: false,
          code: "already_there",
          message: "Actor is already in the destination room",
        };
      }

      const destination = context.worldState.nodes.find(
        (node) => node.id === input.destinationRoomId,
      );
      if (
        destination === undefined ||
        destination.kind !== "room" ||
        destination.enabled === false
      ) {
        return {
          ok: false,
          code: "invalid_destination",
          message: "Destination must be an enabled room",
        };
      }

      const route = findShortestSpatialRoute(
        context.worldState.nodes,
        context.worldState.connections,
        current.roomId,
        input.destinationRoomId,
      );
      if (route === undefined) {
        return {
          ok: false,
          code: "unreachable_destination",
          message: "No enabled spatial route reaches the destination room",
        };
      }

      return { ok: true };
    },
  };
}
