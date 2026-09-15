import {
  DomainInvariantError,
  asWorldId,
  eventSequence,
  simTime,
  type EventSequence,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTransaction } from "./transaction.ts";

interface WorldRow extends QueryResultRow {
  id: string;
  current_sim_time: string;
  next_event_sequence: string;
  next_schedule_ordinal: string;
}

export interface PersistedWorld {
  readonly id: WorldId;
  readonly currentSimTime: SimTime;
  readonly nextEventSequence: EventSequence;
  readonly nextScheduleOrdinal: bigint;
}

function mapWorld(row: WorldRow): PersistedWorld {
  return {
    id: asWorldId(row.id),
    currentSimTime: simTime(row.current_sim_time),
    nextEventSequence: eventSequence(row.next_event_sequence),
    nextScheduleOrdinal: BigInt(row.next_schedule_ordinal),
  };
}

export async function lockWorld(
  client: PoolClient,
  worldId: WorldId,
): Promise<PersistedWorld> {
  const result = await client.query<WorldRow>(
    `SELECT id, current_sim_time, next_event_sequence, next_schedule_ordinal
       FROM worlds
      WHERE id = $1
      FOR UPDATE`,
    [worldId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`World does not exist: ${worldId}`);
  }
  return mapWorld(row);
}

export async function advanceWorldTimeInTransaction(
  client: PoolClient,
  worldId: WorldId,
  target: SimTime,
): Promise<PersistedWorld> {
  const current = await lockWorld(client, worldId);
  if (target < current.currentSimTime) {
    throw new DomainInvariantError(
      `World time cannot move backwards (${target} < ${current.currentSimTime})`,
    );
  }

  const result = await client.query<WorldRow>(
    `UPDATE worlds
        SET current_sim_time = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING id, current_sim_time, next_event_sequence, next_schedule_ordinal`,
    [worldId, target.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`World disappeared during update: ${worldId}`);
  }
  return mapWorld(row);
}

export class PostgresWorldRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(
    worldId: WorldId,
    currentSimTime: SimTime = simTime(0),
  ): Promise<PersistedWorld> {
    const result = await this.#pool.query<WorldRow>(
      `INSERT INTO worlds (id, current_sim_time)
       VALUES ($1, $2)
       RETURNING id, current_sim_time, next_event_sequence, next_schedule_ordinal`,
      [worldId, currentSimTime.toString()],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError("World insert returned no row");
    }
    return mapWorld(row);
  }

  async get(worldId: WorldId): Promise<PersistedWorld | undefined> {
    const result = await this.#pool.query<WorldRow>(
      `SELECT id, current_sim_time, next_event_sequence, next_schedule_ordinal
         FROM worlds
        WHERE id = $1`,
      [worldId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapWorld(row);
  }

  async advanceTime(worldId: WorldId, target: SimTime): Promise<PersistedWorld> {
    return withTransaction(this.#pool, (client) =>
      advanceWorldTimeInTransaction(client, worldId, target),
    );
  }
}
