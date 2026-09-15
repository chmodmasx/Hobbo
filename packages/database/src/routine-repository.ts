import {
  DomainInvariantError,
  asCorrelationId,
  asEntityId,
  asEventId,
  asRoutineId,
  asScheduledEventId,
  asWorldId,
  simDuration,
  simTime,
  type CommitmentId,
  type CorrelationId,
  type EntityId,
  type RoutineId,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  createCommitment,
  materializeRoutineCommitment,
  nextPeriodicOccurrence,
  scheduledEventForCommitment,
  type Commitment,
  type PeriodicRoutine,
} from "@hobbo/simulation";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { appendDomainEventsInTransaction } from "./event-repository.ts";
import { toJsonParameter } from "./json.ts";
import {
  completeScheduledEventInTransaction,
  scheduleEventsInTransaction,
} from "./scheduler-repository.ts";
import { withTransaction } from "./transaction.ts";
import { advanceWorldTimeInTransaction } from "./world-repository.ts";

interface RoutineRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  period: string;
  phase: string;
  kind: string;
  payload: unknown;
  enabled: boolean;
}

interface CommitmentRow extends QueryResultRow {
  world_id: string;
  id: string;
  routine_id: string | null;
  owner_id: string;
  due_at: string;
  kind: string;
  payload: unknown;
  correlation_id: string;
  scheduled_event_id: string | null;
  status: "planned" | "fulfilled" | "missed" | "cancelled";
  resolved_at: string | null;
}

export interface PersistedRoutine<TPayload = unknown> {
  readonly worldId: WorldId;
  readonly routine: PeriodicRoutine<TPayload>;
  readonly enabled: boolean;
}

export interface PersistedCommitment<TPayload = unknown> {
  readonly worldId: WorldId;
  readonly commitment: Commitment<TPayload>;
  readonly scheduledEventId?: ScheduledEventId;
}

function mapRoutine(row: RoutineRow): PersistedRoutine {
  return {
    worldId: asWorldId(row.world_id),
    routine: {
      id: asRoutineId(row.id),
      ownerId: asEntityId(row.owner_id),
      period: simDuration(row.period),
      phase: simDuration(row.phase),
      kind: row.kind,
      payload: row.payload,
    },
    enabled: row.enabled,
  };
}

function mapCommitment(row: CommitmentRow): PersistedCommitment {
  return {
    worldId: asWorldId(row.world_id),
    commitment: {
      id: row.id as CommitmentId,
      ownerId: asEntityId(row.owner_id),
      dueAt: simTime(row.due_at),
      kind: row.kind,
      payload: row.payload,
      correlationId: asCorrelationId(row.correlation_id),
      status: row.status,
      ...(row.routine_id === null ? {} : { routineId: asRoutineId(row.routine_id) }),
      ...(row.resolved_at === null ? {} : { resolvedAt: simTime(row.resolved_at) }),
    },
    ...(row.scheduled_event_id === null
      ? {}
      : { scheduledEventId: asScheduledEventId(row.scheduled_event_id) }),
  };
}

const ROUTINE_COLUMNS = `world_id, id, owner_id, period, phase, kind, payload, enabled`;
const COMMITMENT_COLUMNS = `
  world_id, id, routine_id, owner_id, due_at, kind, payload,
  correlation_id, scheduled_event_id, status, resolved_at
`;

async function lockRoutine(
  client: PoolClient,
  worldId: WorldId,
  routineId: RoutineId,
): Promise<PersistedRoutine> {
  const result = await client.query<RoutineRow>(
    `SELECT ${ROUTINE_COLUMNS}
       FROM routines
      WHERE world_id = $1 AND id = $2
      FOR UPDATE`,
    [worldId, routineId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`Routine does not exist: ${routineId}`);
  }
  return mapRoutine(row);
}

async function insertCommitmentAndSchedule<TPayload>(
  client: PoolClient,
  worldId: WorldId,
  commitment: Commitment<TPayload>,
): Promise<PersistedCommitment<TPayload>> {
  const scheduled = scheduledEventForCommitment(commitment);
  await scheduleEventsInTransaction(client, worldId, [scheduled]);

  const result = await client.query<CommitmentRow>(
    `INSERT INTO commitments (
       world_id, id, routine_id, owner_id, due_at, kind, payload,
       correlation_id, scheduled_event_id, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned')
     RETURNING ${COMMITMENT_COLUMNS}`,
    [
      worldId,
      commitment.id,
      commitment.routineId ?? null,
      commitment.ownerId,
      commitment.dueAt.toString(),
      commitment.kind,
      toJsonParameter(commitment.payload, `commitment ${commitment.id} payload`),
      commitment.correlationId,
      scheduled.id,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`Commitment insert returned no row: ${commitment.id}`);
  }
  return mapCommitment(row) as PersistedCommitment<TPayload>;
}

export async function createRoutineInTransaction<TPayload>(
  client: PoolClient,
  worldId: WorldId,
  routine: PeriodicRoutine<TPayload>,
): Promise<PersistedRoutine<TPayload>> {
  // Exercise the pure routine invariant validation before persisting the template.
  nextPeriodicOccurrence(routine, simTime(0), true);

  const result = await client.query<RoutineRow>(
    `INSERT INTO routines (
       world_id, id, owner_id, period, phase, kind, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${ROUTINE_COLUMNS}`,
    [
      worldId,
      routine.id,
      routine.ownerId,
      routine.period.toString(),
      routine.phase.toString(),
      routine.kind,
      toJsonParameter(routine.payload, `routine ${routine.id} payload`),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`Routine insert returned no row: ${routine.id}`);
  }
  return mapRoutine(row) as PersistedRoutine<TPayload>;
}

export async function materializeNextRoutineCommitmentInTransaction<TPayload = unknown>(
  client: PoolClient,
  worldId: WorldId,
  routineId: RoutineId,
  from: SimTime,
  includeCurrent = false,
): Promise<PersistedCommitment<TPayload>> {
  const persisted = await lockRoutine(client, worldId, routineId);
  if (!persisted.enabled) {
    throw new DomainInvariantError(`Routine is disabled: ${routineId}`);
  }

  const existing = await client.query<CommitmentRow>(
    `SELECT ${COMMITMENT_COLUMNS}
       FROM commitments
      WHERE world_id = $1
        AND routine_id = $2
        AND status = 'planned'
      FOR UPDATE`,
    [worldId, routineId],
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    return mapCommitment(existingRow) as PersistedCommitment<TPayload>;
  }

  const dueAt = nextPeriodicOccurrence(persisted.routine, from, includeCurrent);
  const commitment = materializeRoutineCommitment(
    persisted.routine as PeriodicRoutine<TPayload>,
    dueAt,
  );
  return insertCommitmentAndSchedule(client, worldId, commitment);
}

export class PostgresRoutineRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create<TPayload>(
    worldId: WorldId,
    routine: PeriodicRoutine<TPayload>,
  ): Promise<PersistedRoutine<TPayload>> {
    return withTransaction(
      this.#pool,
      (client) => createRoutineInTransaction(client, worldId, routine),
      "read committed",
    );
  }

  async get(
    worldId: WorldId,
    routineId: RoutineId,
  ): Promise<PersistedRoutine | undefined> {
    const result = await this.#pool.query<RoutineRow>(
      `SELECT ${ROUTINE_COLUMNS}
         FROM routines
        WHERE world_id = $1 AND id = $2`,
      [worldId, routineId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRoutine(row);
  }

  async setEnabled(
    worldId: WorldId,
    routineId: RoutineId,
    enabled: boolean,
  ): Promise<PersistedRoutine> {
    const result = await this.#pool.query<RoutineRow>(
      `UPDATE routines
          SET enabled = $3, updated_at = now()
        WHERE world_id = $1 AND id = $2
      RETURNING ${ROUTINE_COLUMNS}`,
      [worldId, routineId, enabled],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(`Routine does not exist: ${routineId}`);
    }
    return mapRoutine(row);
  }

  async materializeNext(
    worldId: WorldId,
    routineId: RoutineId,
    from: SimTime,
    includeCurrent = false,
  ): Promise<PersistedCommitment> {
    return withTransaction(
      this.#pool,
      (client) =>
        materializeNextRoutineCommitmentInTransaction(
          client,
          worldId,
          routineId,
          from,
          includeCurrent,
        ),
      "read committed",
    );
  }

  async createOneTime<TPayload>(input: {
    readonly worldId: WorldId;
    readonly id: CommitmentId;
    readonly ownerId: EntityId;
    readonly dueAt: SimTime;
    readonly kind: string;
    readonly payload: TPayload;
    readonly correlationId: CorrelationId;
  }): Promise<PersistedCommitment<TPayload>> {
    const commitment = createCommitment({
      id: input.id,
      ownerId: input.ownerId,
      dueAt: input.dueAt,
      kind: input.kind,
      payload: input.payload,
      correlationId: input.correlationId,
    });
    return withTransaction(this.#pool, (client) =>
      insertCommitmentAndSchedule(client, input.worldId, commitment),
    );
  }

  async getCommitment(
    worldId: WorldId,
    commitmentId: CommitmentId,
  ): Promise<PersistedCommitment | undefined> {
    const result = await this.#pool.query<CommitmentRow>(
      `SELECT ${COMMITMENT_COLUMNS}
         FROM commitments
        WHERE world_id = $1 AND id = $2`,
      [worldId, commitmentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCommitment(row);
  }

  /**
   * Fulfils a claimed routine commitment and lazily creates exactly one next
   * occurrence in the same transaction as world-time/event updates.
   */
  async fulfillClaimedAndScheduleNext(input: {
    readonly worldId: WorldId;
    readonly commitmentId: CommitmentId;
    readonly workerId: string;
    readonly at: SimTime;
  }): Promise<{
    readonly fulfilled: PersistedCommitment;
    readonly next?: PersistedCommitment;
  }> {
    return withTransaction(this.#pool, async (client) => {
      const currentResult = await client.query<CommitmentRow>(
        `SELECT ${COMMITMENT_COLUMNS}
           FROM commitments
          WHERE world_id = $1 AND id = $2
          FOR UPDATE`,
        [input.worldId, input.commitmentId],
      );
      const currentRow = currentResult.rows[0];
      if (currentRow === undefined) {
        throw new DomainInvariantError(
          `Commitment does not exist: ${input.commitmentId}`,
        );
      }
      const current = mapCommitment(currentRow);
      if (current.commitment.status !== "planned") {
        throw new DomainInvariantError(
          `Commitment ${input.commitmentId} is already ${current.commitment.status}`,
        );
      }
      if (current.scheduledEventId === undefined) {
        throw new DomainInvariantError(
          `Commitment ${input.commitmentId} has no scheduled event`,
        );
      }
      if (current.commitment.dueAt !== input.at) {
        throw new DomainInvariantError(
          `Commitment ${input.commitmentId} is due at ${current.commitment.dueAt}, not ${input.at}`,
        );
      }

      await advanceWorldTimeInTransaction(client, input.worldId, input.at);

      const update = await client.query<CommitmentRow>(
        `UPDATE commitments
            SET status = 'fulfilled', resolved_at = $3, updated_at = now()
          WHERE world_id = $1 AND id = $2 AND status = 'planned'
        RETURNING ${COMMITMENT_COLUMNS}`,
        [input.worldId, input.commitmentId, input.at.toString()],
      );
      const fulfilledRow = update.rows[0];
      if (fulfilledRow === undefined) {
        throw new DomainInvariantError(`Commitment transition failed: ${input.commitmentId}`);
      }
      const fulfilled = mapCommitment(fulfilledRow);

      await appendDomainEventsInTransaction(client, input.worldId, [
        {
          id: asEventId(`commitment-fulfilled:${input.commitmentId}`),
          worldId: input.worldId,
          simTime: input.at,
          type: "commitment.fulfilled",
          actorId: fulfilled.commitment.ownerId,
          payload: {
            commitmentId: String(input.commitmentId),
            routineId:
              fulfilled.commitment.routineId === undefined
                ? null
                : String(fulfilled.commitment.routineId),
            kind: fulfilled.commitment.kind,
          },
          correlationId: fulfilled.commitment.correlationId,
        },
      ]);

      await completeScheduledEventInTransaction(
        client,
        input.worldId,
        current.scheduledEventId,
        input.workerId,
      );

      let next: PersistedCommitment | undefined;
      const routineId = fulfilled.commitment.routineId;
      if (routineId !== undefined) {
        const routine = await lockRoutine(client, input.worldId, routineId);
        if (routine.enabled) {
          const dueAt = nextPeriodicOccurrence(routine.routine, input.at, false);
          next = await insertCommitmentAndSchedule(
            client,
            input.worldId,
            materializeRoutineCommitment(routine.routine, dueAt),
          );
        }
      }

      return { fulfilled, ...(next === undefined ? {} : { next }) };
    });
  }
}
