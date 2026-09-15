import { describe, expect, it } from "vitest";
import { SIM_DAY } from "@hobbo/domain";
import {
  HEADLESS_SLEEP_AGENT_COUNT,
  runHeadlessSleepSimulation,
} from "../src/index.ts";

describe("20-agent headless sleep simulation", () => {
  it("cycles energy and sleep for 30 simulated days without physiology ticks", () => {
    const result = runHeadlessSleepSimulation();

    expect(result.agentCount).toBe(HEADLESS_SLEEP_AGENT_COUNT);
    expect(result.agents).toHaveLength(HEADLESS_SLEEP_AGENT_COUNT);
    expect(result.finalSimTime).toBe(BigInt(SIM_DAY) * 30n);
    expect(result.processedScheduledEvents).toBe(result.domainEventCount);
    expect(result.domainEventCount).toBeGreaterThan(1_000);
    expect(result.domainEventCount).toBeLessThan(3_000);

    for (const agent of result.agents) {
      expect(agent.sleepSessions).toBeGreaterThan(20);
      expect(agent.sleepSessions).toBeLessThan(80);
      expect(agent.finalEnergy).toBeGreaterThanOrEqual(0);
      expect(agent.finalEnergy).toBeLessThanOrEqual(10_000);
      expect(["awake", "sleeping"]).toContain(agent.finalMode);
    }
  });

  it("is exactly deterministic for the same seed", () => {
    const first = runHeadlessSleepSimulation({ seed: 99887766n });
    const second = runHeadlessSleepSimulation({ seed: 99887766n });
    expect(second).toEqual(first);
  });

  it("produces a different deterministic population for a different seed", () => {
    const first = runHeadlessSleepSimulation({ seed: 111n });
    const second = runHeadlessSleepSimulation({ seed: 222n });
    expect(second.agents).not.toEqual(first.agents);
  });
});
