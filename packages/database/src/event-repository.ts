import {
  DomainInvariantError,
  asCorrelationId,
  asEntityId,
  asEventId,
  asWorldId,
  eventSequence,
  simTime,
  type DomainEvent,
  type DomainEventDraft,
  type EventSequence,
  type WorldId,
} from "@hobbo/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";
import { lockWorld } from "./world-repository.ts";

interface EventRow extends QueryResultRow {
  sequence: string;
  id: string;
  world_id: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  target_ids: string[] | null;
  payload: unknown;
  causation_id: string | null;
  correlation_id: string;
}

function mapEvent(row: EventRow): DomainEvent {
  const required = {
    sequence: eventSequence(row.sequence),
    id: asEventId(row.id),
    worldId: asWorldId(row.world_id),
    simTime: simTime(row.sim_time),
    type: row.type,
    payload: row.payload,
    correlationId: asCorrelationId(row.correlation_id),
  };

  return {
    ...required,
    ...(row.actor_id === null ? {} : { actorId: asEntityId(row.actor_id) }),
    ...(row.target_ids === null
      ? {}
      : { targetIds: row.target_ids.map(asEntityId) }),
    ...(row.causation_id === null
      ? {}
      : { causationId: asEventId(row.causation_id) }),
  };
}

export async function appendDomainEventsInTransaction(
  client: PoolClient,
  worldId: WorldId,
  drafts: readonly DomainEventDraft[],
): Promise<readonly DomainEvent[]> {
  if (drafts.length === 0) return [];

  const world = await lockWorld(client, worldId);
  let nextSequence = BigInt(world.nextEventSequence);
  let previousTime = BigInt(world.currentSimTime);
  const inserted: DomainEvent[] = [];

  for (const draft of drafts) {
    if (draft.worldId !== worldId) {
      throw new DomainInvariantError(
        `Event ${draft.id} belongs to world ${draft.worldId}, expected ${worldId}`,
      );
    }
    if (BigInt(draft.simTime) < previousTime) {
      throw new DomainInvariantError(
        `Event time cannot move backwards (${draft.simTime} < ${previousTime})`,
      );
    }

    const result = await client.query<EventRow>(
      `INSERT INTO domain_events (
         world_id, sequence, id, sim_time, type, actor_id, target_ids,
         payload, causation_id, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING sequence, id, world_id, sim_time, type, actor_id,
                 target_ids, payload, causation_id, correlation_id`,
      [
        worldId,
        nextSequence.toString(),
        draft.id,
        draft.simTime.toString(),
        draft.type,
        draft.actorId ?? null,
        draft.targetIds === undefined ? null : [...draft.targetIds],
        toJsonParameter(draft.payload, `event ${draft.id} payload`),
        draft.causationId ?? null,
        draft.correlationId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(`Event insert returned no row: ${draft.id}`);
    }
    inserted.push(mapEvent(row));
    previousTime = BigInt(draft.simTime);
    nextSequence += 1n;
  }

  await client.query(
    `UPDATE worlds
        SET current_sim_time = $2,
            next_event_sequence = $3,
            updated_at = now()
      WHERE id = $1`,
    [worldId, previousTime.toString(), nextSequence.toString()],
  );

  return inserted;
}

export class PostgresDomainEventRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append<TType extends string, TPayload>(
    draft: DomainEventDraft<TType, TPayload>,
  ): Promise<DomainEvent<TType, TPayload>> {
    const events = await withTransaction(
      this.#pool,
      (client) => appendDomainEventsInTransaction(client, draft.worldId, [draft]),
      "read committed",
    );
    const event = events[0];
    if (event === undefined) {
      throw new DomainInvariantError("Single event append produced no event");
    }
    return event as DomainEvent<TType, TPayload>;
  }

  async appendMany(
    worldId: WorldId,
    drafts: readonly DomainEventDraft[],
  ): Promise<readonly DomainEvent[]> {
    return withTransaction(
      this.#pool,
      (client) => appendDomainEventsInTransaction(client, worldId, drafts),
      "read committed",
    );
  }

  async list(
    worldId: WorldId,
    afterSequence?: EventSequence,
  ): Promise<readonly DomainEvent[]> {
    const result = await this.#pool.query<EventRow>(
      `SELECT sequence, id, world_id, sim_time, type, actor_id,
              target_ids, payload, causation_id, correlation_id
         FROM domain_events
        WHERE world_id = $1
          AND sequence > $2
        ORDER BY sequence ASC`,
      [worldId, (afterSequence === undefined ? 0n : BigInt(afterSequence)).toString()],
    );
    return result.rows.map(mapEvent);
  }
}
