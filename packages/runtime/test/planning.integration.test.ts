import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresEmploymentRepository,
  PostgresLedgerRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_DAY,
  SIM_HOUR,
  asEmploymentId,
  asEntityId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asLifeGoalId,
  asPersonId,
  asWorldId,
  simDuration,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import type { LifeGoal } from "@hobbo/planning";
import { CoreWorldRuntime } from "../src/index.ts";

const pool = new Pool();
const AGENT_COUNT = 8;
const FOOD_PER_AGENT = 48;
const WAGE_PER_SHIFT = 100n;
const MIDPOINT = simTime(BigInt(SIM_DAY) * 7n);
const END_TIME = simTime(BigInt(SIM_DAY) * 14n);

interface CountRow extends QueryResultRow {
  current_sim_time: string;
  goal_count: string;
  plan_count: string;
  active_plan_count: string;
  conflict_plan_count: string;
  reflection_count: string;
  planning_completed: string;
  planning_deferred: string;
  conversation_count: string;
  salary_count: string;
  work_fulfilled: string;
  work_missed: string;
}

interface GoalRow extends QueryResultRow {
  id: string;
  owner_id: string;
  title: string;
  priority_bps: number;
  status: string;
  strategy: unknown;
  created_at_sim: string;
  resolved_at_sim: string | null;
}

interface PlanRow extends QueryResultRow {
  id: string;
  owner_id: string;
  revision: number;
  created_at_sim: string;
  horizon_end: string;
  status: string;
  reason: string;
  intentions: unknown;
  trigger_event_id: string | null;
}

interface ReflectionRow extends QueryResultRow {
  id: string;
  owner_id: string;
  occurred_at: string;
  content: string;
  metadata: unknown;
}

interface CommitmentRow extends QueryResultRow {
  id: string;
  owner_id: string;
  due_at: string;
  kind: string;
  status: string;
  resolved_at: string | null;
}

interface PhysiologyRow extends QueryResultRow {
  person_id: string;
  hunger_value: number;
  hunger_recorded_at: string;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: string;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
  version: string;
}

interface EventRow extends QueryResultRow {
  sequence: string;
  id: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  payload: unknown;
  correlation_id: string;
}

interface PendingRow extends QueryResultRow {
  id: string;
  due_at: string;
  ordinal: string;
  type: string;
  payload: unknown;
  correlation_id: string;
}

interface PlanningSnapshot {
  readonly counts: CountRow;
  readonly goals: readonly GoalRow[];
  readonly plans: readonly PlanRow[];
  readonly reflections: readonly ReflectionRow[];
  readonly commitments: readonly CommitmentRow[];
  readonly physiology: readonly PhysiologyRow[];
  readonly events: readonly EventRow[];
  readonly pending: readonly PendingRow[];
}

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function personId(index: number): PersonId {
  return asPersonId(
    `planning-runtime-person-${String(index + 1).padStart(2, "0")}`,
  );
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  const startsSleeping = index % 3 === 0;
  return {
    id,
    hunger: createHungerState(
      700 + (index % 4) * 300,
      simTime(0),
      480,
    ),
    energy: createEnergyState(
      startsSleeping ? 3_000 : 7_000,
      simTime(0),
      500,
      1_500,
      startsSleeping ? "sleeping" : "awake",
    ),
    inventory: Array.from({ length: FOOD_PER_AGENT }, (_, itemIndex) =>
      createFoodItem(
        `${id}:planning-food-${String(itemIndex + 1).padStart(3, "0")}`,
        "Prepared meal",
        7_000,
      ),
    ),
    mealsEaten: 0,
    sleepSessions: startsSleeping ? 1 : 0,
  };
}

function goal(
  owner: PersonId,
  suffix: string,
  priorityBps: number,
  phaseHours: number,
  durationHours: number,
): LifeGoal {
  return {
    id: asLifeGoalId(`${owner}:goal:${suffix}`),
    ownerId: asEntityId(String(owner)),
    title: `${suffix} goal`,
    priorityBps,
    createdAt: simTime(0),
    status: "active",
    strategy: {
      period: SIM_DAY,
      phase: simDuration(BigInt(SIM_HOUR) * BigInt(phaseHours)),
      duration: simDuration(BigInt(SIM_HOUR) * BigInt(durationHours)),
      intentionKind: `goal.${suffix}`,
      payload: { purpose: suffix },
    },
  };
}

async function setupWorld(connection: Pool, name: string): Promise<WorldId> {
  const worldId = asWorldId(name);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const ledger = new PostgresLedgerRepository(connection);
  const employment = new PostgresEmploymentRepository(connection);
  const runtime = new CoreWorldRuntime(connection);

  const systemAccountId = asLedgerAccountId("planning-system");
  const employerAccountId = asLedgerAccountId("planning-employer-wallet");
  const employerId = asEntityId("planning-employer");

  await worlds.create(worldId);
  await ledger.createAccount({
    id: systemAccountId,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
  });
  await ledger.createAccount({
    id: employerAccountId,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: employerId,
  });
  await ledger.transfer({
    worldId,
    transactionId: asLedgerTransactionId("planning-employer-bootstrap"),
    simTime: simTime(0),
    currency: "HBC",
    type: "bootstrap",
    idempotencyKey: "planning-employer-bootstrap",
    fromAccountId: systemAccountId,
    toAccountId: employerAccountId,
    amount: 1_000_000n,
  });

  for (let index = 0; index < AGENT_COUNT; index += 1) {
    const id = personId(index);
    const entityId = asEntityId(String(id));
    const walletId = asLedgerAccountId(`wallet:${id}`);

    await people.create({
      worldId,
      person: makePerson(index),
      at: simTime(0),
    });
    await ledger.createAccount({
      id: walletId,
      worldId,
      currency: "HBC",
      kind: "asset",
      allowNegative: false,
      ownerId: entityId,
    });
    await employment.create({
      id: asEmploymentId(`employment:${id}`),
      worldId,
      employerId,
      employeeId: entityId,
      employerAccountId,
      employeeAccountId: walletId,
      currency: "HBC",
      wagePerShift: WAGE_PER_SHIFT,
      workPeriod: SIM_DAY,
      workPhase: simDuration(BigInt(SIM_HOUR) * 9n),
      startsAt: simTime(0),
    });

    await runtime.scheduleInitialPhysiology(worldId, id, simTime(0));
    await runtime.scheduleInitialSocial(
      worldId,
      id,
      simTime(BigInt(SIM_HOUR) * 18n),
    );
    await runtime.scheduleInitialPlanning(
      worldId,
      id,
      simTime(
        BigInt(SIM_HOUR) * BigInt(index % 3 === 0 ? 1 : 6),
      ),
    );

    await runtime.createLifeGoal(
      worldId,
      goal(id, "career", 9_000, 9, 2),
    );
    await runtime.createLifeGoal(
      worldId,
      goal(id, "social", 8_000, 18, 1),
    );
    await runtime.createLifeGoal(
      worldId,
      goal(id, "personal", 7_000, 21, 1),
    );
  }

  return worldId;
}

async function snapshot(
  connection: Pool,
  worldId: WorldId,
): Promise<PlanningSnapshot> {
  const counts = await connection.query<CountRow>(
    `SELECT
       (SELECT current_sim_time::text FROM worlds WHERE id = $1) AS current_sim_time,
       (SELECT count(*)::text FROM life_goals WHERE world_id = $1) AS goal_count,
       (SELECT count(*)::text FROM plan_revisions WHERE world_id = $1) AS plan_count,
       (SELECT count(*)::text FROM plan_revisions
         WHERE world_id = $1 AND status = 'active') AS active_plan_count,
       (SELECT count(*)::text FROM plan_revisions
         WHERE world_id = $1 AND reason = 'conflict') AS conflict_plan_count,
       (SELECT count(*)::text FROM memories
         WHERE world_id = $1 AND category = 'reflection') AS reflection_count,
       (SELECT count(*)::text FROM domain_events
         WHERE world_id = $1 AND type = 'planning.review_completed') AS planning_completed,
       (SELECT count(*)::text FROM domain_events
         WHERE world_id = $1 AND type = 'planning.review_deferred') AS planning_deferred,
       (SELECT count(*)::text FROM conversations WHERE world_id = $1) AS conversation_count,
       (SELECT count(*)::text FROM ledger_transactions
         WHERE world_id = $1 AND type = 'employment.salary') AS salary_count,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND kind = 'employment.shift' AND status = 'fulfilled') AS work_fulfilled,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND kind = 'employment.shift' AND status = 'missed') AS work_missed`,
    [worldId],
  );
  const countRow = counts.rows[0];
  if (countRow === undefined) throw new Error(`Missing planning world ${worldId}`);

  const goals = await connection.query<GoalRow>(
    `SELECT id, owner_id, title, priority_bps, status, strategy,
            created_at_sim::text AS created_at_sim,
            resolved_at_sim::text AS resolved_at_sim
       FROM life_goals
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const plans = await connection.query<PlanRow>(
    `SELECT id, owner_id, revision,
            created_at_sim::text AS created_at_sim,
            horizon_end::text AS horizon_end,
            status, reason, intentions, trigger_event_id
       FROM plan_revisions
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const reflections = await connection.query<ReflectionRow>(
    `SELECT id, owner_id, occurred_at::text AS occurred_at, content, metadata
       FROM memories
      WHERE world_id = $1 AND category = 'reflection'
      ORDER BY id`,
    [worldId],
  );
  const commitments = await connection.query<CommitmentRow>(
    `SELECT id, owner_id, due_at::text AS due_at, kind, status,
            resolved_at::text AS resolved_at
       FROM commitments
      WHERE world_id = $1 AND kind = 'employment.shift'
      ORDER BY due_at, id`,
    [worldId],
  );
  const physiology = await connection.query<PhysiologyRow>(
    `SELECT person_id, hunger_value,
            hunger_recorded_at::text AS hunger_recorded_at,
            energy_value, energy_recorded_at::text AS energy_recorded_at,
            energy_mode, meals_eaten, sleep_sessions,
            updated_at_sim::text AS updated_at_sim, version::text AS version
       FROM person_physiology
      WHERE world_id = $1
      ORDER BY person_id`,
    [worldId],
  );
  const events = await connection.query<EventRow>(
    `SELECT sequence::text AS sequence, id, sim_time::text AS sim_time,
            type, actor_id, payload, correlation_id
       FROM domain_events
      WHERE world_id = $1 AND type LIKE 'planning.%'
      ORDER BY sequence`,
    [worldId],
  );
  const pending = await connection.query<PendingRow>(
    `SELECT id, due_at::text AS due_at, ordinal::text AS ordinal,
            type, payload, correlation_id
       FROM scheduled_events
      WHERE world_id = $1 AND status = 'pending'
      ORDER BY due_at, ordinal`,
    [worldId],
  );

  return {
    counts: countRow,
    goals: goals.rows,
    plans: plans.rows,
    reflections: reflections.rows,
    commitments: commitments.rows,
    physiology: physiology.rows,
    events: events.rows,
    pending: pending.rows,
  };
}

function displacedSources(plans: readonly PlanRow[]): readonly string[] {
  const sources: string[] = [];
  for (const row of plans) {
    if (!Array.isArray(row.intentions)) continue;
    for (const raw of row.intentions) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const displaced = (raw as Record<string, unknown>).displacedBy;
      if (!Array.isArray(displaced)) continue;
      for (const source of displaced) {
        if (typeof source === "string") sources.push(source);
      }
    }
  }
  return sources;
}

function reflectionSourceCount(row: ReflectionRow): number {
  if (typeof row.metadata !== "object" || row.metadata === null) return 0;
  const value = (row.metadata as Record<string, unknown>).sourceMemoryIds;
  return Array.isArray(value) ? value.length : 0;
}

describe("durable long-term planning runtime", () => {
  it(
    "keeps goals, conflict-aware plans and reflections restart-equivalent across 14 days",
    async () => {
      const controlWorld = await setupWorld(pool, "runtime-planning-control");
      const controlRuntime = new CoreWorldRuntime(pool);

      const firstProcessPool = new Pool();
      const restartWorld = await setupWorld(
        firstProcessPool,
        "runtime-planning-restart",
      );
      const firstRuntime = new CoreWorldRuntime(firstProcessPool);

      const controlFirst = await controlRuntime.processThrough({
        worldId: controlWorld,
        through: MIDPOINT,
        workerId: "planning-control-a",
      });
      const restartFirst = await firstRuntime.processThrough({
        worldId: restartWorld,
        through: MIDPOINT,
        workerId: "planning-restart-a",
      });
      expect(restartFirst).toBe(controlFirst);
      expect(controlFirst).toBeGreaterThan(300);

      const abandoned = await new PostgresScheduledEventRepository(
        firstProcessPool,
      ).claimDue(
        restartWorld,
        END_TIME,
        "dead-planning-worker",
        1,
      );
      expect(abandoned).toHaveLength(1);
      await firstProcessPool.end();

      const controlSecond = await controlRuntime.processThrough({
        worldId: controlWorld,
        through: END_TIME,
        workerId: "planning-control-b",
      });
      expect(controlSecond).toBeGreaterThan(300);

      const restartedPool = new Pool();
      try {
        const restartedRuntime = new CoreWorldRuntime(restartedPool);
        expect(
          await restartedRuntime.requeueStale(
            restartWorld,
            new Date(Date.now() + 60_000),
            10,
          ),
        ).toBe(1);

        const restartSecond = await restartedRuntime.processThrough({
          worldId: restartWorld,
          through: END_TIME,
          workerId: "planning-restart-b",
        });
        expect(restartSecond).toBe(controlSecond);

        const control = await snapshot(pool, controlWorld);
        const restarted = await snapshot(restartedPool, restartWorld);
        expect(restarted).toEqual(control);

        expect(Number(control.counts.goal_count)).toBe(AGENT_COUNT * 3);
        expect(Number(control.counts.plan_count)).toBeGreaterThanOrEqual(
          AGENT_COUNT * 13,
        );
        expect(Number(control.counts.active_plan_count)).toBe(AGENT_COUNT);
        expect(Number(control.counts.reflection_count)).toBe(
          Number(control.counts.plan_count),
        );
        expect(Number(control.counts.planning_completed)).toBe(
          Number(control.counts.plan_count),
        );
        expect(Number(control.counts.planning_deferred)).toBeGreaterThan(0);
        expect(Number(control.counts.conflict_plan_count)).toBeGreaterThan(0);
        expect(Number(control.counts.conversation_count)).toBeGreaterThan(50);
        expect(
          Number(control.counts.work_fulfilled) +
            Number(control.counts.work_missed),
        ).toBeGreaterThan(80);
        expect(Number(control.counts.salary_count)).toBe(
          Number(control.counts.work_fulfilled),
        );

        const displaced = displacedSources(control.plans);
        expect(displaced.some((source) => source.startsWith("commitment:"))).toBe(
          true,
        );
        expect(displaced.some((source) => source.startsWith("social:"))).toBe(
          true,
        );
        expect(displaced.some((source) => source.startsWith("physiology:"))).toBe(
          true,
        );
        expect(
          control.reflections.some((row) => reflectionSourceCount(row) > 0),
        ).toBe(true);

        expect(control.physiology).toHaveLength(AGENT_COUNT);
        expect(
          control.pending.filter((event) => event.type === "planning.review"),
        ).toHaveLength(AGENT_COUNT);
      } finally {
        await restartedPool.end();
      }
    },
    240_000,
  );
});
