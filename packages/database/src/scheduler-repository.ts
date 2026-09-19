import {
  DomainInvariantError,
  asCorrelationId,
  asEventId,
  asScheduledEventId,
  simTime,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { ScheduledEvent } from "@hobbo/simulation";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";
import { lockWorld } from "./world-repository.ts";

export type ScheduledEventStatus =
  | "pending"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed";

interface ScheduledEventRow extends QueryResultRow {
  world_id: string;
  id: string;
  due_at: string;
  ordinal: string;
  type: string;
  payload: unknown;
  correlation_id: string;
  causation_id: string | null;
  status: ScheduledEventStatus;
  attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
}

export interface PersistedScheduledEvent {
  readonly worldId: WorldId;
  readonly event: ScheduledEvent;
  readonly ordinal: bigint;
  readonly status: ScheduledEventStatus;
  readonly attempts: number;
  readonly lockedBy?: string;
  readonly lockedAt?: Date;
}

function mapScheduledEvent(row: ScheduledEventRow): PersistedScheduledEvent {
  const event: ScheduledEvent = {
    id: asScheduledEventId(row.id),
    dueAt: simTime(row.due_at),
    type: row.type,
    payload: row.payload,
    correlationId: asCorrelationId(row.correlation_id),
    ...(row.causation_id === null
      ? {}
      : { causationId: asEventId(row.causation_id) }),
  };

  return {
    worldId: row.world_id as WorldId,
    event,
    ordinal: BigInt(row.ordinal),
    status: row.status,
    attempts: row.attempts,
    ...(row.locked_by === null ? {} : { lockedBy: row.locked_by }),
    ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
  };
}

const SCHEDULED_COLUMNS = `
  world_id, id, due_at, ordinal, type, payload, correlation_id,
  causation_id, status, attempts, locked_by, locked_at
`;

export async function scheduleEventsInTransaction(
  client: PoolClient,
  worldId: WorldId,
  events: readonly ScheduledEvent[],
): Promise<readonly PersistedScheduledEvent[]> {
  if (events.length === 0) return [];

  const world = await lockWorld(client, worldId);
  let nextOrdinal = world.nextScheduleOrdinal;
  const inserted: PersistedScheduledEvent[] = [];

  for (const event of events) {
    if (event.dueAt < world.currentSimTime) {
      throw new DomainInvariantError(
        `Cannot persist scheduled event ${event.id} in the past (${event.dueAt} < ${world.currentSimTime})`,
      );
    }

    const result = await client.query<ScheduledEventRow>(
      `INSERT INTO scheduled_events (
         world_id, id, due_at, ordinal, type, payload,
         correlation_id, causation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${SCHEDULED_COLUMNS}`,
      [
        worldId,
        event.id,
        event.dueAt.toString(),
        nextOrdinal.toString(),
        event.type,
        toJsonParameter(event.payload, `scheduled event ${event.id} payload`),
        event.correlationId,
        event.causationId ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(
        `Scheduled event insert returned no row: ${event.id}`,
      );
    }
    inserted.push(mapScheduledEvent(row));
    nextOrdinal += 1n;
  }

  await client.query(
    `UPDATE worlds
        SET next_schedule_ordinal = $2,
            updated_at = now()
      WHERE id = $1`,
    [worldId, nextOrdinal.toString()],
  );

  return inserted;
}

export async function completeScheduledEventInTransaction(
  client: PoolClient,
  worldId: WorldId,
  eventId: ScheduledEventId,
  workerId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE scheduled_events
        SET status = 'completed',
            completed_at = now(),
            locked_by = NULL,
            locked_at = NULL
      WHERE world_id = $1
        AND id = $2
        AND status = 'processing'
        AND locked_by = $3`,
    [worldId, eventId, workerId],
  );
  if (result.rowCount !== 1) {
    throw new DomainInvariantError(
      `Scheduled event ${eventId} is not owned by worker ${workerId}`,
    );
  }
}

export class PostgresScheduledEventRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async schedule(
    worldId: WorldId,
    event: ScheduledEvent,
  ): Promise<PersistedScheduledEvent> {
    const inserted = await withTransaction(this.#pool, (client) =>
      scheduleEventsInTransaction(client, worldId, [event]),
    );
    const scheduled = inserted[0];
    if (scheduled === undefined) {
      throw new DomainInvariantError("Single schedule produced no persisted event");
    }
    return scheduled;
  }

  async scheduleMany(
    worldId: WorldId,
    events: readonly ScheduledEvent[],
  ): Promise<readonly PersistedScheduledEvent[]> {
    return withTransaction(this.#pool, (client) =>
      scheduleEventsInTransaction(client, worldId, events),
    );
  }

  async loadPending(
    worldId: WorldId,
  ): Promise<readonly PersistedScheduledEvent[]> {
    const result = await this.#pool.query<ScheduledEventRow>(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM scheduled_events
        WHERE world_id = $1
          AND status = 'pending'
        ORDER BY due_at ASC, ordinal ASC`,
      [worldId],
    );
    return result.rows.map(mapScheduledEvent);
  }

  async loadOutstanding(
    worldId: WorldId,
  ): Promise<readonly PersistedScheduledEvent[]> {
    const result = await this.#pool.query<ScheduledEventRow>(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM scheduled_events
        WHERE world_id = $1
          AND status IN ('pending','processing')
        ORDER BY due_at ASC, ordinal ASC`,
      [worldId],
    );
    return result.rows.map(mapScheduledEvent);
  }

  async claimDue(
    worldId: WorldId,
    through: SimTime,
    workerId: string,
    limit = 100,
  ): Promise<readonly PersistedScheduledEvent[]> {
    if (workerId.length === 0) {
      throw new DomainInvariantError("workerId cannot be empty");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new DomainInvariantError("claim limit must be a positive safe integer");
    }

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<ScheduledEventRow>(
        `WITH frontier AS (
           SELECT min(due_at) AS due_at
             FROM scheduled_events
            WHERE world_id = $1
              AND status IN ('pending', 'processing')
              AND due_at <= $2
         ), due AS (
           SELECT scheduled.world_id,
                  scheduled.id,
                  scheduled.due_at,
                  scheduled.ordinal
             FROM scheduled_events AS scheduled
             CROSS JOIN frontier
            WHERE scheduled.world_id = $1
              AND scheduled.status = 'pending'
              AND scheduled.due_at = frontier.due_at
            ORDER BY scheduled.ordinal ASC
            FOR UPDATE OF scheduled SKIP LOCKED
            LIMIT $4
         ), updated AS (
           UPDATE scheduled_events AS scheduled
              SET status = 'processing',
                  attempts = scheduled.attempts + 1,
                  locked_by = $3,
                  locked_at = now()
             FROM due
            WHERE scheduled.world_id = due.world_id
              AND scheduled.id = due.id
           RETURNING scheduled.*
         )
         SELECT updated.world_id, updated.id, updated.due_at, updated.ordinal,
                updated.type, updated.payload, updated.correlation_id,
                updated.causation_id, updated.status, updated.attempts,
                updated.locked_by, updated.locked_at
           FROM updated
           JOIN due
             ON due.world_id = updated.world_id
            AND due.id = updated.id
          ORDER BY due.ordinal ASC`,
        [worldId, through.toString(), workerId, limit],
      );
      return result.rows.map(mapScheduledEvent);
    }, "read committed");
  }

  async requeueStale(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    if (Number.isNaN(staleBefore.getTime())) {
      throw new DomainInvariantError("staleBefore must be a valid Date");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new DomainInvariantError("requeue limit must be a positive safe integer");
    }

    const result = await this.#pool.query(
      `WITH stale AS (
         SELECT world_id, id
           FROM scheduled_events
          WHERE world_id = $1
            AND status = 'processing'
            AND locked_at <= $2
          ORDER BY locked_at ASC, ordinal ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE scheduled_events AS scheduled
          SET status = 'pending',
              locked_by = NULL,
              locked_at = NULL
         FROM stale
        WHERE scheduled.world_id = stale.world_id
          AND scheduled.id = stale.id`,
      [worldId, staleBefore, limit],
    );

    return result.rowCount ?? 0;
  }

  async complete(
    worldId: WorldId,
    eventId: ScheduledEventId,
    workerId: string,
  ): Promise<void> {
    await withTransaction(this.#pool, (client) =>
      completeScheduledEventInTransaction(client, worldId, eventId, workerId),
    );
  }

  async fail(
    worldId: WorldId,
    eventId: ScheduledEventId,
    workerId: string,
  ): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE scheduled_events
          SET status = 'failed',
              locked_by = NULL,
              locked_at = NULL
        WHERE world_id = $1
          AND id = $2
          AND status = 'processing'
          AND locked_by = $3`,
      [worldId, eventId, workerId],
    );
    if (result.rowCount !== 1) {
      throw new DomainInvariantError(
        `Scheduled event ${eventId} is not owned by worker ${workerId}`,
      );
    }
  }

  async cancel(worldId: WorldId, eventId: ScheduledEventId): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE scheduled_events
          SET status = 'cancelled'
        WHERE world_id = $1
          AND id = $2
          AND status = 'pending'`,
      [worldId, eventId],
    );
    return result.rowCount === 1;
  }
}
