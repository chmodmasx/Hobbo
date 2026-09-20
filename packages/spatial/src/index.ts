import type { ActionDefinition } from "@hobbo/actions";
import { asActionId } from "@hobbo/domain";

export const SPATIAL_MOVE_ACTION_ID = asActionId("spatial.move");

export const SPATIAL_DIRECTIONS = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
] as const;

export type SpatialDirection = (typeof SPATIAL_DIRECTIONS)[number];

export interface SpatialActorState {
  readonly personId: string;
  readonly roomId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: SpatialDirection;
}

export interface RoomBounds {
  readonly roomId: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly z: number;
}

export interface MoveActionInput {
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  return value;
}

function assertBounds(bounds: RoomBounds): void {
  if (bounds.roomId.trim().length === 0) {
    throw new RangeError("roomId cannot be blank");
  }
  safeInteger(bounds.minX, "minX");
  safeInteger(bounds.maxX, "maxX");
  safeInteger(bounds.minY, "minY");
  safeInteger(bounds.maxY, "maxY");
  safeInteger(bounds.z, "z");
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
    throw new RangeError("room bounds minimum cannot exceed maximum");
  }
}

export function isSpatialDirection(value: unknown): value is SpatialDirection {
  return (
    typeof value === "string" &&
    SPATIAL_DIRECTIONS.includes(value as SpatialDirection)
  );
}

export function isMoveActionInput(input: unknown): input is MoveActionInput {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("dx" in input) ||
    !("dy" in input)
  ) {
    return false;
  }

  const dx = input.dx;
  const dy = input.dy;
  return (
    typeof dx === "number" &&
    typeof dy === "number" &&
    Number.isSafeInteger(dx) &&
    Number.isSafeInteger(dy) &&
    dx >= -1 &&
    dx <= 1 &&
    dy >= -1 &&
    dy <= 1 &&
    (dx !== 0 || dy !== 0)
  );
}

export function directionForMove(input: MoveActionInput): SpatialDirection {
  const key = `${input.dx},${input.dy}`;
  const directions: Record<string, SpatialDirection> = {
    "0,-1": "N",
    "1,-1": "NE",
    "1,0": "E",
    "1,1": "SE",
    "0,1": "S",
    "-1,1": "SW",
    "-1,0": "W",
    "-1,-1": "NW",
  };
  const direction = directions[key];
  if (direction === undefined) {
    throw new RangeError(`Invalid spatial move delta: ${key}`);
  }
  return direction;
}

export function targetForMove(
  state: SpatialActorState,
  input: MoveActionInput,
): SpatialActorState {
  return {
    ...state,
    x: state.x + input.dx,
    y: state.y + input.dy,
    facing: directionForMove(input),
  };
}

export function createMoveActionDefinition(
  bounds: RoomBounds,
): ActionDefinition<SpatialActorState> {
  assertBounds(bounds);

  return {
    id: SPATIAL_MOVE_ACTION_ID,
    label: "Move in room",
    description:
      "Move one logical tile inside the actor's current bounded room.",
    validate(context, input) {
      if (!isMoveActionInput(input)) {
        return {
          ok: false,
          code: "invalid_input",
          message:
            "spatial.move requires integer dx/dy in [-1, 1] and a non-zero delta",
        };
      }

      const current = context.worldState;
      if (current.roomId !== bounds.roomId || current.z !== bounds.z) {
        return {
          ok: false,
          code: "room_mismatch",
          message: "Actor is not inside the validated room bounds",
        };
      }

      const targetX = current.x + input.dx;
      const targetY = current.y + input.dy;
      if (
        targetX < bounds.minX ||
        targetX > bounds.maxX ||
        targetY < bounds.minY ||
        targetY > bounds.maxY
      ) {
        return {
          ok: false,
          code: "out_of_bounds",
          message: "Move would leave the current room",
        };
      }

      return { ok: true };
    },
  };
}

export * from "./topology.ts";
export * from "./local-path.ts";
