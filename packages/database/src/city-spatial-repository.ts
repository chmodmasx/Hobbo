import {
  ActionRegistry,
  type ActionOrigin,
} from "@hobbo/actions";
import {
  DomainInvariantError,
  asCorrelationId,
  asEntityId,
  asEventId,
  asScheduledEventId,
  simTime,
  type PersonId,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  entityAffinityKey,
  type ScheduledEvent,
} from "@hobbo/simulation";
import {
  SPATIAL_TRAVEL_ACTION_ID,
  createTravelActionDefinition,
  findShortestSpatialRoute,
  validateSpatialTopology,
  type RoomBounds,
  type SpatialDirection,
  type SpatialRoute,
  type SpatialTile,
  type SpatialTopologyConnection,
  type SpatialTopologyNode,
  type TravelActionWorldState,
} from "@hobbo/spatial";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { appendDomainEventsInTransaction } from "./event-repository.ts";
import {
  completeScheduledEventInTransaction,
  scheduleEventsInTransaction,
} from "./scheduler-repository.ts";
import { withTransaction } from "./transaction.ts";
import {
  advanceWorldTimeInTransaction,
  lockWorld,
} from "./world-repository.ts";

export const SPATIAL_TRAVEL_DEPART_EVENT_TYPE = "spatial.travel_depart";
export const SPATIAL_TRAVEL_ARRIVE_EVENT_TYPE = "spatial.travel_arrive";

interface NodeRow extends QueryResultRow {
  id: string;
  kind: "room" | "building" | "street";
  parent_id: string | null;
  label: string;
  enabled: boolean;
}

interface ConnectionRow extends QueryResultRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  travel_seconds: number;
  bidirectional: boolean;
  enabled: boolean;
}

interface GridRow extends QueryResultRow {
  room_id: string;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  z: number;
}

interface TileRow extends QueryResultRow {
  x: number;
  y: number;
  z: number;
}

interface ResourceRow extends QueryResultRow {
  id: string;
  room_id: string;
  kind: string;
  capacity: number;
  x: number;
  y: number;
  z: number;
  enabled: boolean;
}

interface ReservationRow extends QueryResultRow {
  world_id: string;
  resource_id: string;
  reservation_id: string;
  person_id: string;
  status: "active" | "released" | "consumed" | "cancelled";
  created_at_sim: string;
  closed_at_sim: string | null;
}

interface TravelRow extends QueryResultRow {
  world_id: string;
  id: string;
  person_id: string;
  origin_room_id: string;
  destination_room_id: string;
  route_node_ids: string[];
  route_connection_ids: string[];
  total_travel_seconds: number;
  depart_at_sim: string;
  arrive_at_sim: string;
  status: "planned" | "travelling" | "arrived" | "cancelled";
  version: string;
}

interface SpatialStateRow extends QueryResultRow {
  room_id: string;
  x: number;
  y: number;
  z: number;
  facing: SpatialDirection;
  updated_at_sim: string;
  version: string;
}

interface ClaimedTravelRow extends QueryResultRow {
  due_at: string;
  type: string;
  payload: unknown;
  correlation_id: string;
}

export interface CityTopologySeed {
  readonly worldId: WorldId;
  readonly nodes: readonly (SpatialTopologyNode & { readonly label: string })[];
  readonly connections: readonly SpatialTopologyConnection[];
  readonly rooms?: readonly {
    readonly bounds: RoomBounds;
    readonly blockedTiles?: readonly SpatialTile[];
  }[];
  readonly resources?: readonly {
    readonly id: string;
    readonly roomId: string;
    readonly kind: string;
    readonly capacity: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly enabled?: boolean;
  }[];
}

export interface PersistedCityTopology {
  readonly nodes: readonly (SpatialTopologyNode & { readonly label: string })[];
  readonly connections: readonly SpatialTopologyConnection[];
}

export interface PersistedRoomGrid {
  readonly bounds: RoomBounds;
  readonly blockedTiles: readonly SpatialTile[];
}

export interface PersistedSpatialResource {
  readonly id: string;
  readonly roomId: string;
  readonly kind: string;
  readonly capacity: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly enabled: boolean;
}

export interface PersistedSpatialReservation {
  readonly worldId: WorldId;
  readonly resourceId: string;
  readonly reservationId: string;
  readonly personId: string;
  readonly status: "active" | "released" | "consumed" | "cancelled";
  readonly createdAt: SimTime;
  readonly closedAt?: SimTime;
}

export interface PersistedTravelIntent {
  readonly worldId: WorldId;
  readonly id: string;
  readonly personId: string;
  readonly originRoomId: string;
  readonly destinationRoomId: string;
  readonly route: SpatialRoute;
  readonly departAt: SimTime;
  readonly arriveAt: SimTime;
  readonly status: "planned" | "travelling" | "arrived" | "cancelled";
  readonly version: bigint;
}

export interface PlanTravelInput {
  readonly worldId: WorldId;
  readonly travelId: string;
  readonly personId: PersonId;
  readonly destinationRoomId: string;
  readonly departAt: SimTime;
  readonly origin?: ActionOrigin;
}

export interface ClaimedTravelInput {
  readonly worldId: WorldId;
  readonly travelId: string;
  readonly scheduledEventId: ScheduledEventId;
  readonly workerId: string;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainInvariantError(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainInvariantError(`${label} must be a safe integer`);
  }
  return value;
}

function mapNode(row: NodeRow): SpatialTopologyNode & { readonly label: string } {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    enabled: row.enabled,
    label: row.label,
  };
}

function mapConnection(row: ConnectionRow): SpatialTopologyConnection {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    travelSeconds: row.travel_seconds,
    bidirectional: row.bidirectional,
    enabled: row.enabled,
  };
}

function mapResource(row: ResourceRow): PersistedSpatialResource {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    capacity: row.capacity,
    x: row.x,
    y: row.y,
    z: row.z,
    enabled: row.enabled,
  };
}

function mapReservation(row: ReservationRow): PersistedSpatialReservation {
  return {
    worldId: row.world_id as WorldId,
    resourceId: row.resource_id,
    reservationId: row.reservation_id,
    personId: row.person_id,
    status: row.status,
    createdAt: simTime(row.created_at_sim),
    ...(row.closed_at_sim === null
      ? {}
      : { closedAt: simTime(row.closed_at_sim) }),
  };
}

function mapTravel(row: TravelRow): PersistedTravelIntent {
  return {
    worldId: row.world_id as WorldId,
    id: row.id,
    personId: row.person_id,
    originRoomId: row.origin_room_id,
    destinationRoomId: row.destination_room_id,
    route: {
      nodeIds: row.route_node_ids,
      connectionIds: row.route_connection_ids,
      totalTravelSeconds: row.total_travel_seconds,
    },
    departAt: simTime(row.depart_at_sim),
    arriveAt: simTime(row.arrive_at_sim),
    status: row.status,
    version: BigInt(row.version),
  };
}

function payloadRecord(value: unknown, eventId: ScheduledEventId): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `Scheduled travel event ${eventId} payload must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

async function lockClaimedTravelEvent(
  client: PoolClient,
  input: ClaimedTravelInput,
  expectedType: string,
): Promise<{ readonly dueAt: SimTime; readonly correlationId: ReturnType<typeof asCorrelationId> }> {
  const result = await client.query<ClaimedTravelRow>(
    `SELECT due_at, type, payload, correlation_id
       FROM scheduled_events
      WHERE world_id = $1
        AND id = $2
        AND status = 'processing'
        AND locked_by = $3
      FOR UPDATE`,
    [input.worldId, input.scheduledEventId, input.workerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(
      `Scheduled event ${input.scheduledEventId} is not owned by worker ${input.workerId}`,
    );
  }
  if (row.type !== expectedType) {
    throw new DomainInvariantError(
      `Scheduled event ${input.scheduledEventId} has type ${row.type}, expected ${expectedType}`,
    );
  }
  const payload = payloadRecord(row.payload, input.scheduledEventId);
  if (payload.travelId !== input.travelId) {
    throw new DomainInvariantError(
      `Scheduled event ${input.scheduledEventId} targets travel ${String(payload.travelId)}, expected ${input.travelId}`,
    );
  }
  return {
    dueAt: simTime(row.due_at),
    correlationId: asCorrelationId(row.correlation_id),
  };
}

async function loadTravelForUpdate(
  client: PoolClient,
  worldId: WorldId,
  travelId: string,
): Promise<TravelRow | undefined> {
  const result = await client.query<TravelRow>(
    `SELECT world_id, id, person_id, origin_room_id, destination_room_id,
            route_node_ids, route_connection_ids, total_travel_seconds,
            depart_at_sim, arrive_at_sim, status, version
       FROM spatial_travel_intents
      WHERE world_id = $1 AND id = $2
      FOR UPDATE`,
    [worldId, travelId],
  );
  return result.rows[0];
}

export class PostgresCitySpatialRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async seedTopology(input: CityTopologySeed): Promise<void> {
    validateSpatialTopology(input.nodes, input.connections);

    const nodeKinds = new Map(input.nodes.map((node) => [node.id, node.kind] as const));
    const roomBounds = new Map(
      (input.rooms ?? []).map((room) => [room.bounds.roomId, room.bounds] as const),
    );
    for (const room of input.rooms ?? []) {
      if (nodeKinds.get(room.bounds.roomId) !== "room") {
        throw new DomainInvariantError(
          `Room grid ${room.bounds.roomId} must reference a room node`,
        );
      }
      for (const tile of room.blockedTiles ?? []) {
        safeInteger(tile.x, "blocked tile x");
        safeInteger(tile.y, "blocked tile y");
        safeInteger(tile.z, "blocked tile z");
        if (
          tile.z !== room.bounds.z ||
          tile.x < room.bounds.minX ||
          tile.x > room.bounds.maxX ||
          tile.y < room.bounds.minY ||
          tile.y > room.bounds.maxY
        ) {
          throw new DomainInvariantError(
            `Blocked tile ${tile.x},${tile.y},${tile.z} lies outside room ${room.bounds.roomId}`,
          );
        }
      }
    }

    for (const resource of input.resources ?? []) {
      nonBlank(resource.id, "resource id");
      nonBlank(resource.kind, "resource kind");
      positiveInteger(resource.capacity, `resource ${resource.id} capacity`);
      if (nodeKinds.get(resource.roomId) !== "room") {
        throw new DomainInvariantError(
          `Spatial resource ${resource.id} must reference a room node`,
        );
      }
      const bounds = roomBounds.get(resource.roomId);
      if (bounds === undefined) {
        throw new DomainInvariantError(
          `Spatial resource ${resource.id} requires an active-area room grid`,
        );
      }
      if (
        resource.z !== bounds.z ||
        resource.x < bounds.minX ||
        resource.x > bounds.maxX ||
        resource.y < bounds.minY ||
        resource.y > bounds.maxY
      ) {
        throw new DomainInvariantError(
          `Spatial resource ${resource.id} lies outside room ${resource.roomId}`,
        );
      }
    }

    await withTransaction(this.#pool, async (client) => {
      await lockWorld(client, input.worldId);

      for (const node of input.nodes) {
        await client.query(
          `INSERT INTO spatial_nodes (
             world_id, id, kind, parent_id, label, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.worldId,
            node.id,
            node.kind,
            node.parentId ?? null,
            node.label,
            node.enabled ?? true,
          ],
        );
      }

      for (const connection of input.connections) {
        await client.query(
          `INSERT INTO spatial_connections (
             world_id, id, from_node_id, to_node_id,
             travel_seconds, bidirectional, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.worldId,
            connection.id,
            connection.fromNodeId,
            connection.toNodeId,
            connection.travelSeconds,
            connection.bidirectional ?? false,
            connection.enabled ?? true,
          ],
        );
      }

      for (const room of input.rooms ?? []) {
        const bounds = room.bounds;
        await client.query(
          `INSERT INTO spatial_room_grids (
             world_id, room_id, min_x, max_x, min_y, max_y, z
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.worldId,
            bounds.roomId,
            bounds.minX,
            bounds.maxX,
            bounds.minY,
            bounds.maxY,
            bounds.z,
          ],
        );
        for (const tile of room.blockedTiles ?? []) {
          await client.query(
            `INSERT INTO spatial_blocked_tiles (
               world_id, room_id, x, y, z
             ) VALUES ($1,$2,$3,$4,$5)`,
            [input.worldId, bounds.roomId, tile.x, tile.y, tile.z],
          );
        }
      }

      for (const resource of input.resources ?? []) {
        await client.query(
          `INSERT INTO spatial_resources (
             world_id, id, room_id, kind, capacity, x, y, z, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.worldId,
            resource.id,
            resource.roomId,
            resource.kind,
            resource.capacity,
            resource.x,
            resource.y,
            resource.z,
            resource.enabled ?? true,
          ],
        );
      }
    }, "read committed");
  }

  async loadTopology(worldId: WorldId): Promise<PersistedCityTopology> {
    const [nodes, connections] = await Promise.all([
      this.#pool.query<NodeRow>(
        `SELECT id, kind, parent_id, label, enabled
           FROM spatial_nodes
          WHERE world_id = $1
          ORDER BY id ASC`,
        [worldId],
      ),
      this.#pool.query<ConnectionRow>(
        `SELECT id, from_node_id, to_node_id, travel_seconds,
                bidirectional, enabled
           FROM spatial_connections
          WHERE world_id = $1
          ORDER BY id ASC`,
        [worldId],
      ),
    ]);

    return {
      nodes: nodes.rows.map(mapNode),
      connections: connections.rows.map(mapConnection),
    };
  }

  async getRoomGrid(
    worldId: WorldId,
    roomId: string,
  ): Promise<PersistedRoomGrid | undefined> {
    const [grid, blocked] = await Promise.all([
      this.#pool.query<GridRow>(
        `SELECT room_id, min_x, max_x, min_y, max_y, z
           FROM spatial_room_grids
          WHERE world_id = $1 AND room_id = $2`,
        [worldId, roomId],
      ),
      this.#pool.query<TileRow>(
        `SELECT x, y, z
           FROM spatial_blocked_tiles
          WHERE world_id = $1 AND room_id = $2
          ORDER BY y ASC, x ASC, z ASC`,
        [worldId, roomId],
      ),
    ]);
    const row = grid.rows[0];
    if (row === undefined) return undefined;
    return {
      bounds: {
        roomId: row.room_id,
        minX: row.min_x,
        maxX: row.max_x,
        minY: row.min_y,
        maxY: row.max_y,
        z: row.z,
      },
      blockedTiles: blocked.rows.map((tile) => ({
        x: tile.x,
        y: tile.y,
        z: tile.z,
      })),
    };
  }

  async listResources(
    worldId: WorldId,
    roomId: string,
  ): Promise<readonly PersistedSpatialResource[]> {
    const result = await this.#pool.query<ResourceRow>(
      `SELECT id, room_id, kind, capacity, x, y, z, enabled
         FROM spatial_resources
        WHERE world_id = $1 AND room_id = $2
        ORDER BY id ASC`,
      [worldId, roomId],
    );
    return result.rows.map(mapResource);
  }

  async reserveResource(input: {
    readonly worldId: WorldId;
    readonly resourceId: string;
    readonly reservationId: string;
    readonly personId: PersonId;
    readonly at: SimTime;
  }): Promise<PersistedSpatialReservation> {
    nonBlank(input.reservationId, "reservationId");

    return withTransaction(this.#pool, async (client) => {
      const world = await lockWorld(client, input.worldId);
      const resourceResult = await client.query<ResourceRow>(
        `SELECT id, room_id, kind, capacity, x, y, z, enabled
           FROM spatial_resources
          WHERE world_id = $1 AND id = $2
          FOR UPDATE`,
        [input.worldId, input.resourceId],
      );
      const resource = resourceResult.rows[0];
      if (resource === undefined || !resource.enabled) {
        throw new DomainInvariantError(
          `Spatial resource is unavailable: ${input.resourceId}`,
        );
      }

      const existing = await client.query<ReservationRow>(
        `SELECT world_id, resource_id, reservation_id, person_id,
                status, created_at_sim, closed_at_sim
           FROM spatial_reservations
          WHERE world_id = $1 AND reservation_id = $2
          FOR UPDATE`,
        [input.worldId, input.reservationId],
      );
      const persisted = existing.rows[0];
      if (persisted !== undefined) {
        if (
          persisted.resource_id !== input.resourceId ||
          persisted.person_id !== String(input.personId)
        ) {
          throw new DomainInvariantError(
            `Reservation id ${input.reservationId} was reused with different semantics`,
          );
        }
        return mapReservation(persisted);
      }

      if (input.at !== world.currentSimTime) {
        throw new DomainInvariantError(
          `Reservation time ${input.at} must equal world time ${world.currentSimTime}`,
        );
      }

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM spatial_reservations
          WHERE world_id = $1
            AND resource_id = $2
            AND status = 'active'`,
        [input.worldId, input.resourceId],
      );
      const active = Number(count.rows[0]?.count ?? "0");
      if (active >= resource.capacity) {
        throw new DomainInvariantError(
          `Spatial resource ${input.resourceId} is at capacity`,
        );
      }

      const inserted = await client.query<ReservationRow>(
        `INSERT INTO spatial_reservations (
           world_id, resource_id, reservation_id, person_id, created_at_sim
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING world_id, resource_id, reservation_id, person_id,
                   status, created_at_sim, closed_at_sim`,
        [
          input.worldId,
          input.resourceId,
          input.reservationId,
          input.personId,
          input.at.toString(),
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError("Spatial reservation insert returned no row");
      }
      return mapReservation(row);
    }, "read committed");
  }

  async closeReservation(input: {
    readonly worldId: WorldId;
    readonly reservationId: string;
    readonly at: SimTime;
    readonly status?: "released" | "consumed" | "cancelled";
  }): Promise<PersistedSpatialReservation> {
    return withTransaction(this.#pool, async (client) => {
      const world = await lockWorld(client, input.worldId);
      if (input.at !== world.currentSimTime) {
        throw new DomainInvariantError(
          `Reservation close time ${input.at} must equal world time ${world.currentSimTime}`,
        );
      }
      const result = await client.query<ReservationRow>(
        `UPDATE spatial_reservations
            SET status = $3,
                closed_at_sim = $4,
                updated_at = now()
          WHERE world_id = $1
            AND reservation_id = $2
            AND status = 'active'
          RETURNING world_id, resource_id, reservation_id, person_id,
                    status, created_at_sim, closed_at_sim`,
        [
          input.worldId,
          input.reservationId,
          input.status ?? "released",
          input.at.toString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError(
          `Active spatial reservation does not exist: ${input.reservationId}`,
        );
      }
      return mapReservation(row);
    }, "read committed");
  }

  async getTravel(
    worldId: WorldId,
    travelId: string,
  ): Promise<PersistedTravelIntent | undefined> {
    const result = await this.#pool.query<TravelRow>(
      `SELECT world_id, id, person_id, origin_room_id, destination_room_id,
              route_node_ids, route_connection_ids, total_travel_seconds,
              depart_at_sim, arrive_at_sim, status, version
         FROM spatial_travel_intents
        WHERE world_id = $1 AND id = $2`,
      [worldId, travelId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapTravel(row);
  }

  async planTravel(input: PlanTravelInput): Promise<PersistedTravelIntent> {
    nonBlank(input.travelId, "travelId");
    nonBlank(input.destinationRoomId, "destinationRoomId");

    return withTransaction(this.#pool, async (client) => {
      const world = await lockWorld(client, input.worldId);

      const existing = await loadTravelForUpdate(
        client,
        input.worldId,
        input.travelId,
      );
      if (existing !== undefined) {
        if (
          existing.person_id !== String(input.personId) ||
          existing.destination_room_id !== input.destinationRoomId
        ) {
          throw new DomainInvariantError(
            `Travel id ${input.travelId} was reused with different semantics`,
          );
        }
        return mapTravel(existing);
      }

      if (input.departAt < world.currentSimTime) {
        throw new DomainInvariantError(
          `Travel departure ${input.departAt} cannot precede world time ${world.currentSimTime}`,
        );
      }

      const person = await client.query<SpatialStateRow>(
        `SELECT room_id, x, y, z, facing, updated_at_sim, version
           FROM person_spatial_state
          WHERE world_id = $1 AND person_id = $2
          FOR UPDATE`,
        [input.worldId, input.personId],
      );
      const current = person.rows[0];
      if (current === undefined) {
        throw new DomainInvariantError(
          `Spatial state does not exist for person ${input.personId}`,
        );
      }
      if (current.room_id.startsWith("__transit__:")) {
        throw new DomainInvariantError(
          `Person ${input.personId} is already in transit`,
        );
      }
      if (current.room_id === input.destinationRoomId) {
        throw new DomainInvariantError(
          `Person ${input.personId} is already in room ${input.destinationRoomId}`,
        );
      }

      const [nodeRows, connectionRows] = await Promise.all([
        client.query<NodeRow>(
          `SELECT id, kind, parent_id, label, enabled
             FROM spatial_nodes
            WHERE world_id = $1
            ORDER BY id ASC`,
          [input.worldId],
        ),
        client.query<ConnectionRow>(
          `SELECT id, from_node_id, to_node_id, travel_seconds,
                  bidirectional, enabled
             FROM spatial_connections
            WHERE world_id = $1
            ORDER BY id ASC`,
          [input.worldId],
        ),
      ]);
      const nodes = nodeRows.rows.map(mapNode);
      const connections = connectionRows.rows.map(mapConnection);
      const actionState: TravelActionWorldState = {
        actor: {
          personId: String(input.personId),
          roomId: current.room_id,
          x: current.x,
          y: current.y,
          z: current.z,
          facing: current.facing,
        },
        nodes,
        connections,
      };
      const registry = new ActionRegistry<TravelActionWorldState>();
      registry.register(createTravelActionDefinition());
      const validation = registry.validate(
        {
          actionId: SPATIAL_TRAVEL_ACTION_ID,
          actorId: asEntityId(String(input.personId)),
          origin: input.origin ?? "system",
          requestedAt: world.currentSimTime,
          correlationId: asCorrelationId(`travel:${input.travelId}`),
          input: { destinationRoomId: input.destinationRoomId },
        },
        {
          actorId: asEntityId(String(input.personId)),
          simTime: world.currentSimTime,
          worldState: actionState,
        },
      );
      if (!validation.ok) {
        throw new DomainInvariantError(
          `Travel action rejected (${validation.code}): ${validation.message}`,
        );
      }

      const destinationGrid = await client.query<GridRow>(
        `SELECT room_id, min_x, max_x, min_y, max_y, z
           FROM spatial_room_grids
          WHERE world_id = $1 AND room_id = $2`,
        [input.worldId, input.destinationRoomId],
      );
      if (destinationGrid.rows[0] === undefined) {
        throw new DomainInvariantError(
          `Travel destination has no active-area grid: ${input.destinationRoomId}`,
        );
      }

      const route = findShortestSpatialRoute(
        nodes,
        connections,
        current.room_id,
        input.destinationRoomId,
      );
      if (route === undefined) {
        throw new DomainInvariantError(
          `Travel route disappeared after successful validation: ${current.room_id} -> ${input.destinationRoomId}`,
        );
      }

      const arriveAt = simTime(
        BigInt(input.departAt) + BigInt(route.totalTravelSeconds),
      );
      const inserted = await client.query<TravelRow>(
        `INSERT INTO spatial_travel_intents (
           world_id, id, person_id, origin_room_id, destination_room_id,
           route_node_ids, route_connection_ids, total_travel_seconds,
           depart_at_sim, arrive_at_sim
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING world_id, id, person_id, origin_room_id, destination_room_id,
                   route_node_ids, route_connection_ids, total_travel_seconds,
                   depart_at_sim, arrive_at_sim, status, version`,
        [
          input.worldId,
          input.travelId,
          input.personId,
          current.room_id,
          input.destinationRoomId,
          [...route.nodeIds],
          [...route.connectionIds],
          route.totalTravelSeconds,
          input.departAt.toString(),
          arriveAt.toString(),
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError("Travel intent insert returned no row");
      }

      const departure: ScheduledEvent = {
        id: asScheduledEventId(`travel:${input.travelId}:depart`),
        dueAt: input.departAt,
        type: SPATIAL_TRAVEL_DEPART_EVENT_TYPE,
        payload: {
          travelId: input.travelId,
          personId: String(input.personId),
        },
        correlationId: asCorrelationId(`travel:${input.travelId}`),
        affinityKeys: [entityAffinityKey(String(input.personId))],
      };
      await scheduleEventsInTransaction(client, input.worldId, [departure]);

      return mapTravel(row);
    }, "read committed");
  }

  async departTravelClaimed(
    input: ClaimedTravelInput,
  ): Promise<PersistedTravelIntent> {
    return withTransaction(this.#pool, async (client) => {
      const claim = await lockClaimedTravelEvent(
        client,
        input,
        SPATIAL_TRAVEL_DEPART_EVENT_TYPE,
      );
      await advanceWorldTimeInTransaction(client, input.worldId, claim.dueAt);

      const travelRow = await loadTravelForUpdate(
        client,
        input.worldId,
        input.travelId,
      );
      if (travelRow === undefined) {
        throw new DomainInvariantError(`Travel intent does not exist: ${input.travelId}`);
      }
      if (travelRow.status !== "planned") {
        throw new DomainInvariantError(
          `Travel ${input.travelId} must be planned before departure`,
        );
      }
      if (simTime(travelRow.depart_at_sim) !== claim.dueAt) {
        throw new DomainInvariantError(
          `Travel ${input.travelId} departure time does not match claimed event`,
        );
      }

      const spatial = await client.query<SpatialStateRow>(
        `SELECT room_id, x, y, z, facing, updated_at_sim, version
           FROM person_spatial_state
          WHERE world_id = $1 AND person_id = $2
          FOR UPDATE`,
        [input.worldId, travelRow.person_id],
      );
      const current = spatial.rows[0];
      if (current === undefined || current.room_id !== travelRow.origin_room_id) {
        throw new DomainInvariantError(
          `Travel ${input.travelId} person is not at the planned origin`,
        );
      }

      await client.query(
        `UPDATE person_spatial_state
            SET room_id = $3,
                x = 0,
                y = 0,
                z = 0,
                updated_at_sim = $4,
                version = version + 1,
                updated_at = now()
          WHERE world_id = $1 AND person_id = $2`,
        [
          input.worldId,
          travelRow.person_id,
          `__transit__:${input.travelId}`,
          claim.dueAt.toString(),
        ],
      );

      const updated = await client.query<TravelRow>(
        `UPDATE spatial_travel_intents
            SET status = 'travelling',
                version = version + 1,
                updated_at = now()
          WHERE world_id = $1 AND id = $2
          RETURNING world_id, id, person_id, origin_room_id, destination_room_id,
                    route_node_ids, route_connection_ids, total_travel_seconds,
                    depart_at_sim, arrive_at_sim, status, version`,
        [input.worldId, input.travelId],
      );
      const persisted = updated.rows[0];
      if (persisted === undefined) {
        throw new DomainInvariantError("Travel departure update returned no row");
      }

      await appendDomainEventsInTransaction(client, input.worldId, [
        {
          id: asEventId(`travel:${input.travelId}:departed`),
          worldId: input.worldId,
          simTime: claim.dueAt,
          type: "person.travel_departed",
          actorId: asEntityId(travelRow.person_id),
          payload: {
            travelId: input.travelId,
            originRoomId: travelRow.origin_room_id,
            destinationRoomId: travelRow.destination_room_id,
            routeNodeIds: travelRow.route_node_ids,
          },
          correlationId: claim.correlationId,
        },
      ]);

      const arrival: ScheduledEvent = {
        id: asScheduledEventId(`travel:${input.travelId}:arrive`),
        dueAt: simTime(travelRow.arrive_at_sim),
        type: SPATIAL_TRAVEL_ARRIVE_EVENT_TYPE,
        payload: {
          travelId: input.travelId,
          personId: travelRow.person_id,
        },
        correlationId: claim.correlationId,
        affinityKeys: [entityAffinityKey(travelRow.person_id)],
      };
      await scheduleEventsInTransaction(client, input.worldId, [arrival]);
      await completeScheduledEventInTransaction(
        client,
        input.worldId,
        input.scheduledEventId,
        input.workerId,
      );

      return mapTravel(persisted);
    }, "read committed");
  }

  async arriveTravelClaimed(
    input: ClaimedTravelInput,
  ): Promise<PersistedTravelIntent> {
    return withTransaction(this.#pool, async (client) => {
      const claim = await lockClaimedTravelEvent(
        client,
        input,
        SPATIAL_TRAVEL_ARRIVE_EVENT_TYPE,
      );
      await advanceWorldTimeInTransaction(client, input.worldId, claim.dueAt);

      const travelRow = await loadTravelForUpdate(
        client,
        input.worldId,
        input.travelId,
      );
      if (travelRow === undefined) {
        throw new DomainInvariantError(`Travel intent does not exist: ${input.travelId}`);
      }
      if (travelRow.status !== "travelling") {
        throw new DomainInvariantError(
          `Travel ${input.travelId} must be travelling before arrival`,
        );
      }
      if (simTime(travelRow.arrive_at_sim) !== claim.dueAt) {
        throw new DomainInvariantError(
          `Travel ${input.travelId} arrival time does not match claimed event`,
        );
      }

      const grid = await client.query<GridRow>(
        `SELECT room_id, min_x, max_x, min_y, max_y, z
           FROM spatial_room_grids
          WHERE world_id = $1 AND room_id = $2
          FOR UPDATE`,
        [input.worldId, travelRow.destination_room_id],
      );
      const destination = grid.rows[0];
      if (destination === undefined) {
        throw new DomainInvariantError(
          `Destination room has no active-area grid: ${travelRow.destination_room_id}`,
        );
      }
      const blocked = await client.query<TileRow>(
        `SELECT x, y, z
           FROM spatial_blocked_tiles
          WHERE world_id = $1 AND room_id = $2`,
        [input.worldId, travelRow.destination_room_id],
      );
      const blockedKeys = new Set(
        blocked.rows.map((tile) => `${tile.x},${tile.y},${tile.z}`),
      );
      let arrivalX: number | undefined;
      let arrivalY: number | undefined;
      for (let y = destination.min_y; y <= destination.max_y; y += 1) {
        for (let x = destination.min_x; x <= destination.max_x; x += 1) {
          if (!blockedKeys.has(`${x},${y},${destination.z}`)) {
            arrivalX = x;
            arrivalY = y;
            break;
          }
        }
        if (arrivalX !== undefined) break;
      }
      if (arrivalX === undefined || arrivalY === undefined) {
        throw new DomainInvariantError(
          `Destination room has no free arrival tile: ${travelRow.destination_room_id}`,
        );
      }

      const spatial = await client.query<SpatialStateRow>(
        `SELECT room_id, x, y, z, facing, updated_at_sim, version
           FROM person_spatial_state
          WHERE world_id = $1 AND person_id = $2
          FOR UPDATE`,
        [input.worldId, travelRow.person_id],
      );
      const current = spatial.rows[0];
      if (
        current === undefined ||
        current.room_id !== `__transit__:${input.travelId}`
      ) {
        throw new DomainInvariantError(
          `Travel ${input.travelId} person is not in the expected transit state`,
        );
      }

      await client.query(
        `UPDATE person_spatial_state
            SET room_id = $3,
                x = $4,
                y = $5,
                z = $6,
                updated_at_sim = $7,
                version = version + 1,
                updated_at = now()
          WHERE world_id = $1 AND person_id = $2`,
        [
          input.worldId,
          travelRow.person_id,
          travelRow.destination_room_id,
          arrivalX,
          arrivalY,
          destination.z,
          claim.dueAt.toString(),
        ],
      );

      const updated = await client.query<TravelRow>(
        `UPDATE spatial_travel_intents
            SET status = 'arrived',
                version = version + 1,
                updated_at = now()
          WHERE world_id = $1 AND id = $2
          RETURNING world_id, id, person_id, origin_room_id, destination_room_id,
                    route_node_ids, route_connection_ids, total_travel_seconds,
                    depart_at_sim, arrive_at_sim, status, version`,
        [input.worldId, input.travelId],
      );
      const persisted = updated.rows[0];
      if (persisted === undefined) {
        throw new DomainInvariantError("Travel arrival update returned no row");
      }

      await appendDomainEventsInTransaction(client, input.worldId, [
        {
          id: asEventId(`travel:${input.travelId}:arrived`),
          worldId: input.worldId,
          simTime: claim.dueAt,
          type: "person.travel_arrived",
          actorId: asEntityId(travelRow.person_id),
          payload: {
            travelId: input.travelId,
            originRoomId: travelRow.origin_room_id,
            destinationRoomId: travelRow.destination_room_id,
            x: arrivalX,
            y: arrivalY,
            z: destination.z,
          },
          correlationId: claim.correlationId,
        },
      ]);

      await completeScheduledEventInTransaction(
        client,
        input.worldId,
        input.scheduledEventId,
        input.workerId,
      );

      return mapTravel(persisted);
    }, "read committed");
  }
}
