import { describe, expect, it } from "vitest";
import { SIM_DAY } from "@hobbo/domain";
import {
  HEADLESS_ROUTINE_AGENT_COUNT,
  runHeadlessRoutineSimulation,
} from "../src/index.ts";

describe("20-agent recurring routine simulation", () => {
  it("runs 30 days while materializing only one future commitment per agent", () => {
    const result = runHeadlessRoutineSimulation();

    expect(result.agentCount).toBe(HEADLESS_ROUTINE_AGENT_COUNT);
    expect(result.finalSimTime).toBe(BigInt(SIM_DAY) * 30n);
    expect(result.processedScheduledEvents).toBe(600);
    expect(result.domainEventCount).toBe(600);
    expect(result.maxFutureQueueSize).toBe(HEADLESS_ROUTINE_AGENT_COUNT);

    for (const agent of result.agents) {
      expect(agent.fulfilledCommitments).toBe(30);
    }
  });

  it("is exactly deterministic for the same seed", () => {
    const first = runHeadlessRoutineSimulation({ seed: 123123n });
    const second = runHeadlessRoutineSimulation({ seed: 123123n });
    expect(second).toEqual(first);
  });

  it("changes routine timing distribution when the seed changes", () => {
    const first = runHeadlessRoutineSimulation({ seed: 1n });
    const second = runHeadlessRoutineSimulation({ seed: 2n });

    // Counts remain the same because every agent owns one daily routine, but
    // event ordering/timing differs internally. The deterministic summary is
    // intentionally count-only, so exercise a shorter horizon where phase
    // placement changes how many commitments have fired.
    const shortA = runHeadlessRoutineSimulation({
      seed: 1n,
      duration: BigInt(SIM_DAY) / 2n,
    });
    const shortB = runHeadlessRoutineSimulation({
      seed: 2n,
      duration: BigInt(SIM_DAY) / 2n,
    });

    expect(first.domainEventCount).toBe(second.domainEventCount);
    expect(shortA.domainEventCount).not.toBe(shortB.domainEventCount);
  });
});
