import { ActionRegistry } from "@hobbo/actions";
import {
  DomainInvariantError,
  asCorrelationId,
  asEntityId,
  asEventId,
  simTime,
  type ActionId,
  type DomainEvent,
  type PersonId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  SPATIAL_MOVE_ACTION_ID,
  createMoveActionDefinition,
  isMoveActionInput,
  targetForMove,
  type RoomBounds,
  type SpatialActorState,
  type SpatialDirection,
} from "@hobbo/spatial";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { appendDomainEventsInTransaction } from "./event-repository.ts";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";
import { lockWorld } from "./world-repository.ts";

interface SpatialRow extends QueryResultRow {
  world_id: string;
  person_id: string;
  room_id: string;
  x: number;
  y: number;
  z: number;
  facing: SpatialDirection;
  updated_at_sim: string;
  version: string;
}

interface ReceiptRow extends QueryResultRow {
  person_id: string;
  action_id: string;
  request_payload: unknown;
  result_payload: unknown;
  event_id: string;
  applied_at_sim: string;
  payload_matches: boolean;
}

export interface PersistedSpatialState extends SpatialActorState {
  readonly worldId: WorldId;
  readonly updatedAt: SimTime;
  readonly version: bigint;
}

export interface PlacePersonInput {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly roomId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: SpatialDirection;
  readonly at: SimTime;
}

export interface ApplyPlayerActionInput {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly requestId: string;
  readonly actionId: ActionId;
  readonly input: unknown;
  readonly roomBounds: RoomBounds;
}

export type PlayerActionResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly replayed: boolean;
      readonly state: PersistedSpatialState;
      readonly eventId: string;
      readonly simTime: SimTime;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainInvariantError(`${label} must be a safe integer`);
  }
}

function mapSpatial(row: SpatialRow): PersistedSpatialState {
  return {
    worldId: row.world_id as WorldId,
    personId: row.person_id,
    roomId: row.room_id,
    x: row.x,
    y: row.y,
    z: row.z,
    facing: row.facing,
    updatedAt: simTime(row.updated_at_sim),
    version: BigInt(row.version),
  };
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError("Player action receipt result must be an object");
  }
  return value as Record<string, unknown>;
}

function receiptState(
  worldId: WorldId,
  payload: unknown,
): {
  readonly state: PersistedSpatialState;
  readonly eventId: string;
  readonly simTime: SimTime;
} {
  const root = resultRecord(payload);
  const rawState = resultRecord(root.state);
  const facing = rawState.facing;
  if (
    typeof rawState.personId !== "string" ||
    typeof rawState.roomId !== "string" ||
    typeof rawState.x !== "number" ||
    typeof rawState.y !== "number" ||
    typeof rawState.z !== "number" ||
    typeof facing !== "string" ||
    !["N", "NE", "E", "SE", "S", "SW", "W", "NW"].includes(facing) ||
    typeof rawState.updatedAt !== "string" ||
    typeof rawState.version !== "string" ||
    typeof root.eventId !== "string" ||
    typeof root.simTime !== "string"
  ) {
    throw new DomainInvariantError("Player action receipt contains invalid result payload");
  }

  return {
    state: {
      worldId,
      personId: rawState.personId,
      roomId: rawState.roomId,
      x: rawState.x,
      y: rawState.y,
      z: rawState.z,
      facing: facing as SpatialDirection,
      updatedAt: simTime(rawState.updatedAt),
      version: BigInt(rawState.version),
    },
    eventId: root.eventId,
    simTime: simTime(root.simTime),
  };
}

async function loadSpatial(
  client: PoolClient,
  worldId: WorldId,
  personId: PersonId,
  forUpdate: boolean,
): Promise<PersistedSpatialState | undefined> {
  const result = await client.query<SpatialRow>(
    `SELECT world_id, person_id, room_id, x, y, z, facing,
            updated_at_sim, version
       FROM person_spatial_state
      WHERE world_id = $1 AND person_id = $2
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [worldId, personId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapSpatial(row);
}

export class PostgresSpatialRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async place(input: PlacePersonInput): Promise<PersistedSpatialState> {
    assertNonBlank(String(input.personId), "personId");
    assertNonBlank(input.roomId, "roomId");
    assertInteger(input.x, "x");
    assertInteger(input.y, "y");
    assertInteger(input.z, "z");

    return withTransaction(
      this.#pool,
      async (client) => {
        const world = await lockWorld(client, input.worldId);
        if (world.currentSimTime !== input.at) {
          throw new DomainInvariantError(
            `Spatial placement time ${input.at} must equal world time ${world.currentSimTime}`,
          );
        }

        const result = await client.query<SpatialRow>(
          `INSERT INTO person_spatial_state (
             world_id, person_id, room_id, x, y, z, facing, updated_at_sim
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING world_id, person_id, room_id, x, y, z, facing,
                     updated_at_sim, version`,
          [
            input.worldId,
            input.personId,
            input.roomId,
            input.x,
            input.y,
            input.z,
            input.facing,
            input.at.toString(),
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError("Spatial placement returned no row");
        }
        return mapSpatial(row);
      },
      "read committed",
    );
  }

  async get(
    worldId: WorldId,
    personId: PersonId,
  ): Promise<PersistedSpatialState | undefined> {
    const result = await this.#pool.query<SpatialRow>(
      `SELECT world_id, person_id, room_id, x, y, z, facing,
              updated_at_sim, version
         FROM person_spatial_state
        WHERE world_id = $1 AND person_id = $2`,
      [worldId, personId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSpatial(row);
  }

  async listRoom(
    worldId: WorldId,
    roomId: string,
  ): Promise<readonly PersistedSpatialState[]> {
    assertNonBlank(roomId, "roomId");
    const result = await this.#pool.query<SpatialRow>(
      `SELECT world_id, person_id, room_id, x, y, z, facing,
              updated_at_sim, version
         FROM person_spatial_state
        WHERE world_id = $1 AND room_id = $2
        ORDER BY person_id ASC`,
      [worldId, roomId],
    );
    return result.rows.map(mapSpatial);
  }

  async applyPlayerAction(
    input: ApplyPlayerActionInput,
  ): Promise<PlayerActionResult> {
    assertNonBlank(input.requestId, "requestId");
    const requestJson = toJsonParameter(
      input.input,
      `player action ${input.requestId} request`,
    );

    return withTransaction(
      this.#pool,
      async (client) => {
        const world = await lockWorld(client, input.worldId);

        const existing = await client.query<ReceiptRow>(
          `SELECT person_id, action_id, request_payload, result_payload,
                  event_id, applied_at_sim,
                  request_payload = $3::jsonb AS payload_matches
             FROM player_action_receipts
            WHERE world_id = $1 AND request_id = $2
            FOR UPDATE`,
          [input.worldId, input.requestId, requestJson],
        );
        const receipt = existing.rows[0];
        if (receipt !== undefined) {
          if (
            receipt.person_id !== String(input.personId) ||
            receipt.action_id !== String(input.actionId) ||
            !receipt.payload_matches
          ) {
            throw new DomainInvariantError(
              `Player request id ${input.requestId} was reused with different semantics`,
            );
          }
          const replay = receiptState(input.worldId, receipt.result_payload);
          return {
            ok: true,
            requestId: input.requestId,
            replayed: true,
            state: replay.state,
            eventId: replay.eventId,
            simTime: replay.simTime,
          };
        }

        const current = await loadSpatial(
          client,
          input.worldId,
          input.personId,
          true,
        );
        if (current === undefined) {
          throw new DomainInvariantError(
            `Spatial state does not exist for person ${input.personId}`,
          );
        }

        const registry = new ActionRegistry<SpatialActorState>();
        registry.register(createMoveActionDefinition(input.roomBounds));
        const correlationId = asCorrelationId(`player:${input.requestId}`);
        const validation = registry.validate(
          {
            actionId: input.actionId,
            actorId: asEntityId(String(input.personId)),
            origin: "player",
            requestedAt: world.currentSimTime,
            correlationId,
            input: input.input,
          },
          {
            actorId: asEntityId(String(input.personId)),
            simTime: world.currentSimTime,
            worldState: current,
          },
        );

        if (!validation.ok) {
          return {
            ok: false,
            requestId: input.requestId,
            code: validation.code,
            message: validation.message,
          };
        }
        if (
          validation.definition.id !== SPATIAL_MOVE_ACTION_ID ||
          !isMoveActionInput(input.input)
        ) {
          throw new DomainInvariantError(
            `Validated player action is unsupported by spatial repository: ${input.actionId}`,
          );
        }

        const next = targetForMove(current, input.input);
        const updated = await client.query<SpatialRow>(
          `UPDATE person_spatial_state
              SET x = $3,
                  y = $4,
                  facing = $5,
                  updated_at_sim = $6,
                  version = version + 1,
                  updated_at = now()
            WHERE world_id = $1 AND person_id = $2
            RETURNING world_id, person_id, room_id, x, y, z, facing,
                      updated_at_sim, version`,
          [
            input.worldId,
            input.personId,
            next.x,
            next.y,
            next.facing,
            world.currentSimTime.toString(),
          ],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new DomainInvariantError(
            `Spatial state disappeared for person ${input.personId}`,
          );
        }
        const state = mapSpatial(updatedRow);

        const eventId = asEventId(`player:${input.requestId}`);
        const appended = await appendDomainEventsInTransaction(
          client,
          input.worldId,
          [
            {
              id: eventId,
              worldId: input.worldId,
              simTime: world.currentSimTime,
              type: "person.moved",
              actorId: asEntityId(String(input.personId)),
              payload: {
                requestId: input.requestId,
                actionId: String(input.actionId),
                roomId: state.roomId,
                from: {
                  x: current.x,
                  y: current.y,
                  z: current.z,
                  facing: current.facing,
                },
                to: {
                  x: state.x,
                  y: state.y,
                  z: state.z,
                  facing: state.facing,
                },
              },
              correlationId,
            },
          ],
        );
        const event: DomainEvent | undefined = appended[0];
        if (event === undefined) {
          throw new DomainInvariantError("Player move produced no domain event");
        }

        const resultPayload = {
          state: {
            personId: state.personId,
            roomId: state.roomId,
            x: state.x,
            y: state.y,
            z: state.z,
            facing: state.facing,
            updatedAt: state.updatedAt.toString(),
            version: state.version.toString(),
          },
          eventId: String(event.id),
          simTime: event.simTime.toString(),
        };

        await client.query(
          `INSERT INTO player_action_receipts (
             world_id, request_id, person_id, action_id,
             request_payload, result_payload, event_id, applied_at_sim
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.worldId,
            input.requestId,
            input.personId,
            input.actionId,
            requestJson,
            toJsonParameter(
              resultPayload,
              `player action ${input.requestId} result`,
            ),
            event.id,
            event.simTime.toString(),
          ],
        );

        return {
          ok: true,
          requestId: input.requestId,
          replayed: false,
          state,
          eventId: String(event.id),
          simTime: event.simTime,
        };
      },
      "read committed",
    );
  }
}
