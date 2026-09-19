import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  SIM_DAY,
  SIM_HOUR,
  asCorrelationId,
  asEntityId,
  asLifeGoalId,
  asPlanRevisionId,
  asScheduledEventId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  derivePlanRevision,
  type LifeGoal,
} from "@hobbo/planning";
import {
  PostgresPlanningRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worldId = asWorldId("planning-repository-world");
const ownerId = asEntityId("person-alice");

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
  await new PostgresWorldRepository(pool).create(worldId);
});

afterAll(async () => {
  await pool.end();
});

function goal(id: string, priorityBps = 8_000): LifeGoal {
  return {
    id: asLifeGoalId(id),
    ownerId,
    title: `Goal ${id}`,
    priorityBps,
    createdAt: simTime(0),
    status: "active",
    strategy: {
      period: SIM_DAY,
      phase: simDuration(BigInt(SIM_HOUR) * 18n),
      duration: SIM_HOUR,
      intentionKind: "goal.activity",
      payload: { id },
    },
  };
}

describe("durable planning repository", () => {
  it("persists idempotent goals and superseding plan revisions", async () => {
    const planning = new PostgresPlanningRepository(pool);
    const schedules = new PostgresScheduledEventRepository(pool);
    const firstGoal = goal("goal-friends");

    expect(
      await planning.createGoal(worldId, firstGoal),
    ).toMatchObject({ goal: firstGoal });
    expect(
      await planning.createGoal(worldId, firstGoal),
    ).toMatchObject({ goal: firstGoal });

    await planning.createGoal(worldId, goal("goal-career", 9_000));
    expect(await planning.listGoals(worldId, ownerId, "active")).toHaveLength(2);

    const event1 = {
      id: asScheduledEventId("planning-review-1"),
      dueAt: simTime(100),
      type: "planning.review",
      payload: { personId: String(ownerId), occurrence: 1 },
      correlationId: asCorrelationId("planning-review-1"),
    };
    await schedules.schedule(worldId, event1);

    const firstPlan = derivePlanRevision({
      id: asPlanRevisionId("plan-1"),
      ownerId,
      revision: 1,
      createdAt: simTime(100),
      horizonEnd: simTime(BigInt(SIM_DAY) * 7n),
      goals: [goal("goal-career", 9_000), firstGoal],
      busyWindows: [
        {
          id: "work",
          kind: "employment.shift",
          start: simTime(BigInt(SIM_HOUR) * 18n),
          end: simTime(BigInt(SIM_HOUR) * 20n),
        },
      ],
    });

    const persisted = await planning.putPlanRevision({
      worldId,
      plan: firstPlan,
      triggerEventId: event1.id,
    });
    expect(persisted.plan.reason).toBe("conflict");
    expect(
      await planning.putPlanRevision({
        worldId,
        plan: firstPlan,
        triggerEventId: event1.id,
      }),
    ).toEqual(persisted);

    const event2 = {
      id: asScheduledEventId("planning-review-2"),
      dueAt: simTime(BigInt(SIM_DAY)),
      type: "planning.review",
      payload: { personId: String(ownerId), occurrence: 2 },
      correlationId: asCorrelationId("planning-review-2"),
    };
    await schedules.schedule(worldId, event2);
    const secondPlan = derivePlanRevision({
      id: asPlanRevisionId("plan-2"),
      ownerId,
      revision: 2,
      createdAt: event2.dueAt,
      horizonEnd: simTime(BigInt(SIM_DAY) * 8n),
      goals: [goal("goal-career", 9_000), firstGoal],
      previousPlan: firstPlan,
    });
    await planning.putPlanRevision({
      worldId,
      plan: secondPlan,
      triggerEventId: event2.id,
    });

    const revisions = await planning.listPlanRevisions(worldId, ownerId);
    expect(revisions.map((item) => item.plan.status)).toEqual([
      "superseded",
      "active",
    ]);
    expect((await planning.getActivePlan(worldId, ownerId))?.plan.id).toBe(
      secondPlan.id,
    );
    expect(
      (await planning.getPlanByTriggerEvent(worldId, event1.id))?.plan.id,
    ).toBe(firstPlan.id);

    const resolved = await planning.resolveGoal({
      worldId,
      goalId: firstGoal.id,
      status: "completed",
      at: simTime(BigInt(SIM_DAY) * 2n),
    });
    expect(resolved.goal.status).toBe("completed");
    expect(resolved.resolvedAt).toBe(simTime(BigInt(SIM_DAY) * 2n));
  });
});
