import { describe, expect, it } from "vitest";
import {
  SIM_DAY,
  SIM_HOUR,
  asEntityId,
  asLifeGoalId,
  asPlanRevisionId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  derivePlanRevision,
  validateLifeGoal,
  type LifeGoal,
} from "../src/index.ts";

function goal(input: {
  id: string;
  priority: number;
  phaseHours: number;
  durationHours?: number;
}): LifeGoal {
  return {
    id: asLifeGoalId(input.id),
    ownerId: asEntityId("alice"),
    title: input.id,
    priorityBps: input.priority,
    createdAt: simTime(0),
    status: "active",
    strategy: {
      period: SIM_DAY,
      phase: simDuration(BigInt(SIM_HOUR) * BigInt(input.phaseHours)),
      duration: simDuration(
        BigInt(SIM_HOUR) * BigInt(input.durationHours ?? 1),
      ),
      intentionKind: "goal.activity",
      payload: { goal: input.id },
    },
  };
}

describe("deterministic goal planning", () => {
  it("moves intentions after durable busy windows instead of overlapping them", () => {
    const plan = derivePlanRevision({
      id: asPlanRevisionId("plan-1"),
      ownerId: asEntityId("alice"),
      revision: 1,
      createdAt: simTime(0),
      horizonEnd: simTime(BigInt(SIM_DAY) * 2n),
      goals: [goal({ id: "goal-1", priority: 9000, phaseHours: 9 })],
      busyWindows: [
        {
          id: "work-shift",
          kind: "employment.shift",
          start: simTime(BigInt(SIM_HOUR) * 9n),
          end: simTime(BigInt(SIM_HOUR) * 12n),
        },
      ],
    });

    expect(plan.reason).toBe("conflict");
    expect(plan.intentions[0]).toMatchObject({
      displacedBy: ["work-shift"],
      startsAt: simTime(BigInt(SIM_HOUR) * 12n),
    });
  });

  it("lets higher-priority goals reserve time before lower-priority goals", () => {
    const plan = derivePlanRevision({
      id: asPlanRevisionId("plan-priority"),
      ownerId: asEntityId("alice"),
      revision: 1,
      createdAt: simTime(0),
      horizonEnd: simTime(BigInt(SIM_DAY)),
      goals: [
        goal({ id: "low", priority: 5000, phaseHours: 10, durationHours: 2 }),
        goal({ id: "high", priority: 9000, phaseHours: 10, durationHours: 2 }),
      ],
    });

    const high = plan.intentions.find((item) => item.goalId === "high");
    const low = plan.intentions.find((item) => item.goalId === "low");
    expect(high?.startsAt).toBe(simTime(BigInt(SIM_HOUR) * 10n));
    expect(low?.startsAt).toBe(simTime(BigInt(SIM_HOUR) * 12n));
    expect(low?.displacedBy).toEqual([
      "intention:goal:high:at:36000",
    ]);
  });

  it("is reproducible for the same goal and conflict state", () => {
    const input = {
      id: asPlanRevisionId("plan-repeat"),
      ownerId: asEntityId("alice"),
      revision: 3,
      createdAt: simTime(BigInt(SIM_DAY) * 3n),
      horizonEnd: simTime(BigInt(SIM_DAY) * 10n),
      goals: [goal({ id: "goal-repeat", priority: 8000, phaseHours: 18 })],
    };
    expect(derivePlanRevision(input)).toEqual(derivePlanRevision(input));
  });

  it("rejects invalid goal timing policy", () => {
    const invalid = goal({ id: "bad", priority: 5000, phaseHours: 9 });
    expect(() =>
      validateLifeGoal({
        ...invalid,
        strategy: { ...invalid.strategy, period: simDuration(0) },
      }),
    ).toThrow(/period must be positive/i);
  });
});
