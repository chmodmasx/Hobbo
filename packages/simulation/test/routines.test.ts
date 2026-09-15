import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SIM_DAY,
  asEntityId,
  asRoutineId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  COMMITMENT_DUE_EVENT_TYPE,
  cancelCommitment,
  fulfillCommitment,
  materializeRoutineCommitment,
  missCommitment,
  nextPeriodicOccurrence,
  nextRoutineCommitment,
  scheduledEventForCommitment,
  type PeriodicRoutine,
} from "../src/index.ts";

function routine(period: bigint, phase: bigint): PeriodicRoutine<{ task: string }> {
  return {
    id: asRoutineId("routine-test"),
    ownerId: asEntityId("person-test"),
    period: simDuration(period),
    phase: simDuration(phase),
    kind: "test.task",
    payload: { task: "do something" },
  };
}

describe("periodic routines", () => {
  it("supports exact daily phases and explicit include-current semantics", () => {
    const breakfast = routine(BigInt(SIM_DAY), 8n * 3_600n);

    expect(nextPeriodicOccurrence(breakfast, simTime(0))).toBe(28_800n);
    expect(nextPeriodicOccurrence(breakfast, simTime(28_800), true)).toBe(28_800n);
    expect(nextPeriodicOccurrence(breakfast, simTime(28_800), false)).toBe(
      28_800n + BigInt(SIM_DAY),
    );
    expect(nextPeriodicOccurrence(breakfast, simTime(90_000))).toBe(
      28_800n + BigInt(SIM_DAY),
    );
  });

  it("always returns the first valid occurrence after the requested time", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (periodNumber, phaseRaw, fromNumber) => {
          const period = BigInt(periodNumber);
          const phase = BigInt(phaseRaw % periodNumber);
          const from = BigInt(fromNumber);
          const currentRoutine = routine(period, phase);

          const next = BigInt(
            nextPeriodicOccurrence(currentRoutine, simTime(from), false),
          );

          expect(next).toBeGreaterThan(from);
          expect(next).toBeGreaterThanOrEqual(phase);
          expect((next - phase) % period).toBe(0n);

          const previous = next - period;
          expect(previous < phase || previous <= from).toBe(true);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("materializes deterministic commitment and scheduled-event identities", () => {
    const work = routine(BigInt(SIM_DAY), 9n * 3_600n);
    const first = nextRoutineCommitment(work, simTime(0));
    const second = nextRoutineCommitment(work, simTime(0));

    expect(second).toEqual(first);
    expect(first.dueAt).toBe(32_400n);
    expect(first.status).toBe("planned");
    expect(first.routineId).toBe(work.id);

    const scheduled = scheduledEventForCommitment(first);
    expect(scheduled.type).toBe(COMMITMENT_DUE_EVENT_TYPE);
    expect(scheduled.dueAt).toBe(first.dueAt);
    expect(scheduled.correlationId).toBe(first.correlationId);
    expect(scheduled.payload).toEqual({
      commitmentId: first.id,
      ownerId: work.ownerId,
      kind: "test.task",
      payload: { task: "do something" },
      routineId: work.id,
    });
  });

  it("rejects times that are not actual occurrences of a routine", () => {
    const currentRoutine = routine(100n, 25n);
    expect(() =>
      materializeRoutineCommitment(currentRoutine, simTime(26)),
    ).toThrow(/not an occurrence/i);
  });
});

describe("concrete commitment lifecycle", () => {
  it("can be fulfilled, cancelled or missed exactly once", () => {
    const currentRoutine = routine(100n, 25n);
    const planned = materializeRoutineCommitment(currentRoutine, simTime(125));

    const fulfilled = fulfillCommitment(planned, simTime(125));
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.resolvedAt).toBe(125n);
    expect(() => cancelCommitment(fulfilled, simTime(126))).toThrow(
      /already resolved/i,
    );

    const cancelled = cancelCommitment(planned, simTime(100));
    expect(cancelled.status).toBe("cancelled");

    expect(() => missCommitment(planned, simTime(124))).toThrow(
      /before its due time/i,
    );
    const missed = missCommitment(planned, simTime(126));
    expect(missed.status).toBe("missed");
  });
});
