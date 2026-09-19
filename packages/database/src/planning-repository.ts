import {
  DomainInvariantError,
  asEntityId,
  asLifeGoalId,
  asPlanRevisionId,
  asScheduledEventId,
  simDuration,
  simTime,
  type EntityId,
  type LifeGoalId,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  validateLifeGoal,
  validatePlanRevision,
  type GoalPlanningStrategy,
  type GoalStatus,
  type LifeGoal,
  type PlanIntention,
  type PlanRevision,
  type PlanRevisionReason,
  type PlanRevisionStatus,
} from "@hobbo/planning";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface LifeGoalRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  title: string;
  priority_bps: number;
  status: GoalStatus;
  strategy: unknown;
  created_at_sim: string;
  resolved_at_sim: string | null;
}

interface LifeGoalComparisonRow extends LifeGoalRow {
  same_strategy: boolean;
}

interface PlanRevisionRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  revision: number;
  created_at_sim: string;
  horizon_end: string;
  status: PlanRevisionStatus;
  reason: PlanRevisionReason;
  intentions: unknown;
  trigger_event_id: string | null;
}

interface PlanRevisionComparisonRow extends PlanRevisionRow {
  same_intentions: boolean;
}

export interface PersistedLifeGoal {
  readonly worldId: WorldId;
  readonly goal: LifeGoal;
  readonly resolvedAt?: SimTime;
}

export interface PersistedPlanRevision {
  readonly worldId: WorldId;
  readonly plan: PlanRevision;
  readonly triggerEventId?: ScheduledEventId;
}

const LIFE_GOAL_COLUMNS = `
  world_id, id, owner_id, title, priority_bps, status,
  strategy, created_at_sim, resolved_at_sim
`;

const PLAN_REVISION_COLUMNS = `
  world_id, id, owner_id, revision, created_at_sim, horizon_end,
  status, reason, intentions, trigger_event_id
`;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainInvariantError(`${label} has invalid ${key}`);
  }
  return value;
}

function serializeStrategy(strategy: GoalPlanningStrategy): Record<string, unknown> {
  return {
    period: strategy.period.toString(),
    phase: strategy.phase.toString(),
    duration: strategy.duration.toString(),
    intentionKind: strategy.intentionKind,
    payload: strategy.payload,
  };
}

function parseStrategy(value: unknown): GoalPlanningStrategy {
  const source = record(value, "Persisted goal strategy");
  return {
    period: simDuration(stringField(source, "period", "Persisted goal strategy")),
    phase: simDuration(stringField(source, "phase", "Persisted goal strategy")),
    duration: simDuration(
      stringField(source, "duration", "Persisted goal strategy"),
    ),
    intentionKind: stringField(
      source,
      "intentionKind",
      "Persisted goal strategy",
    ),
    payload: source.payload,
  };
}

function serializeIntention(
  intention: PlanIntention,
): Record<string, unknown> {
  return {
    id: intention.id,
    goalId: String(intention.goalId),
    kind: intention.kind,
    preferredStart: intention.preferredStart.toString(),
    startsAt: intention.startsAt.toString(),
    endsAt: intention.endsAt.toString(),
    payload: intention.payload,
    displacedBy: [...intention.displacedBy],
  };
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new DomainInvariantError(`${label} must be a string array`);
  }
  return value as string[];
}

function parseIntention(value: unknown): PlanIntention {
  const source = record(value, "Persisted plan intention");
  return {
    id: stringField(source, "id", "Persisted plan intention"),
    goalId: asLifeGoalId(
      stringField(source, "goalId", "Persisted plan intention"),
    ),
    kind: stringField(source, "kind", "Persisted plan intention"),
    preferredStart: simTime(
      stringField(source, "preferredStart", "Persisted plan intention"),
    ),
    startsAt: simTime(
      stringField(source, "startsAt", "Persisted plan intention"),
    ),
    endsAt: simTime(
      stringField(source, "endsAt", "Persisted plan intention"),
    ),
    payload: source.payload,
    displacedBy: parseStringArray(
      source.displacedBy,
      "Persisted plan intention displacedBy",
    ),
  };
}

function parseIntentions(value: unknown): readonly PlanIntention[] {
  if (!Array.isArray(value)) {
    throw new DomainInvariantError("Persisted plan intentions must be an array");
  }
  return value.map(parseIntention);
}

function mapLifeGoal(row: LifeGoalRow): PersistedLifeGoal {
  const goal: LifeGoal = {
    id: asLifeGoalId(row.id),
    ownerId: asEntityId(row.owner_id),
    title: row.title,
    priorityBps: row.priority_bps,
    createdAt: simTime(row.created_at_sim),
    status: row.status,
    strategy: parseStrategy(row.strategy),
  };
  validateLifeGoal(goal);
  return {
    worldId: row.world_id as WorldId,
    goal,
    ...(row.resolved_at_sim === null
      ? {}
      : { resolvedAt: simTime(row.resolved_at_sim) }),
  };
}

function mapPlanRevision(row: PlanRevisionRow): PersistedPlanRevision {
  const plan: PlanRevision = {
    id: asPlanRevisionId(row.id),
    ownerId: asEntityId(row.owner_id),
    revision: row.revision,
    createdAt: simTime(row.created_at_sim),
    horizonEnd: simTime(row.horizon_end),
    status: row.status,
    reason: row.reason,
    intentions: parseIntentions(row.intentions),
  };
  validatePlanRevision(plan);
  return {
    worldId: row.world_id as WorldId,
    plan,
    ...(row.trigger_event_id === null
      ? {}
      : { triggerEventId: asScheduledEventId(row.trigger_event_id) }),
  };
}

async function advisoryLock(
  client: PoolClient,
  namespace: string,
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${namespace}:${key}`],
  );
}

export class PostgresPlanningRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createGoal(
    worldId: WorldId,
    goal: LifeGoal,
  ): Promise<PersistedLifeGoal> {
    validateLifeGoal(goal);
    if (goal.status !== "active") {
      throw new DomainInvariantError(
        "New life goals must begin in active state",
      );
    }
    const strategyJson = toJsonParameter(
      serializeStrategy(goal.strategy),
      `life goal ${goal.id} strategy`,
    );

    return withTransaction(this.#pool, async (client) => {
      await advisoryLock(
        client,
        "planning-goal",
        `${worldId}:${goal.id}`,
      );

      const existing = await client.query<LifeGoalComparisonRow>(
        `SELECT ${LIFE_GOAL_COLUMNS}, strategy = $3::jsonb AS same_strategy
           FROM life_goals
          WHERE world_id = $1 AND id = $2`,
        [worldId, goal.id, strategyJson],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const same =
          row.owner_id === goal.ownerId &&
          row.title === goal.title.trim() &&
          row.priority_bps === goal.priorityBps &&
          row.status === "active" &&
          BigInt(row.created_at_sim) === BigInt(goal.createdAt) &&
          row.resolved_at_sim === null &&
          row.same_strategy;
        if (!same) {
          throw new DomainInvariantError(
            `Life goal id ${goal.id} was already used with different data`,
          );
        }
        return mapLifeGoal(row);
      }

      const inserted = await client.query<LifeGoalRow>(
        `INSERT INTO life_goals (
           world_id, id, owner_id, title, priority_bps,
           status, strategy, created_at_sim
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
         RETURNING ${LIFE_GOAL_COLUMNS}`,
        [
          worldId,
          goal.id,
          goal.ownerId,
          goal.title.trim(),
          goal.priorityBps,
          strategyJson,
          goal.createdAt.toString(),
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        throw new DomainInvariantError(
          `Life goal insert returned no row: ${goal.id}`,
        );
      }
      return mapLifeGoal(insertedRow);
    }, "read committed");
  }

  async listGoals(
    worldId: WorldId,
    ownerId: EntityId,
    status?: GoalStatus,
  ): Promise<readonly PersistedLifeGoal[]> {
    const result = await this.#pool.query<LifeGoalRow>(
      `SELECT ${LIFE_GOAL_COLUMNS}
         FROM life_goals
        WHERE world_id = $1
          AND owner_id = $2
          AND ($3::text IS NULL OR status = $3)
        ORDER BY priority_bps DESC, id ASC`,
      [worldId, ownerId, status ?? null],
    );
    return result.rows.map(mapLifeGoal);
  }

  async resolveGoal(input: {
    readonly worldId: WorldId;
    readonly goalId: LifeGoalId;
    readonly status: Exclude<GoalStatus, "active">;
    readonly at: SimTime;
  }): Promise<PersistedLifeGoal> {
    const result = await this.#pool.query<LifeGoalRow>(
      `UPDATE life_goals
          SET status = $3,
              resolved_at_sim = $4,
              updated_at = now()
        WHERE world_id = $1
          AND id = $2
          AND status = 'active'
          AND created_at_sim <= $4
      RETURNING ${LIFE_GOAL_COLUMNS}`,
      [
        input.worldId,
        input.goalId,
        input.status,
        input.at.toString(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(
        `Active life goal does not exist or cannot resolve: ${input.goalId}`,
      );
    }
    return mapLifeGoal(row);
  }

  async putPlanRevision(input: {
    readonly worldId: WorldId;
    readonly plan: PlanRevision;
    readonly triggerEventId?: ScheduledEventId;
  }): Promise<PersistedPlanRevision> {
    validatePlanRevision(input.plan);
    if (input.plan.status !== "active") {
      throw new DomainInvariantError(
        "New plan revisions must begin in active state",
      );
    }
    const intentionsJson = toJsonParameter(
      input.plan.intentions.map(serializeIntention),
      `plan revision ${input.plan.id} intentions`,
    );

    return withTransaction(this.#pool, async (client) => {
      await advisoryLock(
        client,
        "planning-owner",
        `${input.worldId}:${input.plan.ownerId}`,
      );

      const existing = await client.query<PlanRevisionComparisonRow>(
        `SELECT ${PLAN_REVISION_COLUMNS},
                intentions = $3::jsonb AS same_intentions
           FROM plan_revisions
          WHERE world_id = $1 AND id = $2`,
        [input.worldId, input.plan.id, intentionsJson],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        const same =
          existingRow.owner_id === input.plan.ownerId &&
          existingRow.revision === input.plan.revision &&
          BigInt(existingRow.created_at_sim) ===
            BigInt(input.plan.createdAt) &&
          BigInt(existingRow.horizon_end) ===
            BigInt(input.plan.horizonEnd) &&
          existingRow.reason === input.plan.reason &&
          existingRow.trigger_event_id ===
            (input.triggerEventId ?? null) &&
          existingRow.same_intentions;
        if (!same) {
          throw new DomainInvariantError(
            `Plan revision id ${input.plan.id} was already used with different data`,
          );
        }
        return mapPlanRevision(existingRow);
      }

      await client.query(
        `UPDATE plan_revisions
            SET status = 'superseded',
                superseded_at = now()
          WHERE world_id = $1
            AND owner_id = $2
            AND status = 'active'`,
        [input.worldId, input.plan.ownerId],
      );

      const inserted = await client.query<PlanRevisionRow>(
        `INSERT INTO plan_revisions (
           world_id, id, owner_id, revision,
           created_at_sim, horizon_end, status, reason,
           intentions, trigger_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)
         RETURNING ${PLAN_REVISION_COLUMNS}`,
        [
          input.worldId,
          input.plan.id,
          input.plan.ownerId,
          input.plan.revision,
          input.plan.createdAt.toString(),
          input.plan.horizonEnd.toString(),
          input.plan.reason,
          intentionsJson,
          input.triggerEventId ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError(
          `Plan revision insert returned no row: ${input.plan.id}`,
        );
      }
      return mapPlanRevision(row);
    }, "read committed");
  }

  async getActivePlan(
    worldId: WorldId,
    ownerId: EntityId,
  ): Promise<PersistedPlanRevision | undefined> {
    const result = await this.#pool.query<PlanRevisionRow>(
      `SELECT ${PLAN_REVISION_COLUMNS}
         FROM plan_revisions
        WHERE world_id = $1
          AND owner_id = $2
          AND status = 'active'`,
      [worldId, ownerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPlanRevision(row);
  }

  async getPlanByTriggerEvent(
    worldId: WorldId,
    triggerEventId: ScheduledEventId,
  ): Promise<PersistedPlanRevision | undefined> {
    const result = await this.#pool.query<PlanRevisionRow>(
      `SELECT ${PLAN_REVISION_COLUMNS}
         FROM plan_revisions
        WHERE world_id = $1
          AND trigger_event_id = $2`,
      [worldId, triggerEventId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPlanRevision(row);
  }

  async listPlanRevisions(
    worldId: WorldId,
    ownerId: EntityId,
  ): Promise<readonly PersistedPlanRevision[]> {
    const result = await this.#pool.query<PlanRevisionRow>(
      `SELECT ${PLAN_REVISION_COLUMNS}
         FROM plan_revisions
        WHERE world_id = $1 AND owner_id = $2
        ORDER BY revision ASC, id ASC`,
      [worldId, ownerId],
    );
    return result.rows.map(mapPlanRevision);
  }
}
