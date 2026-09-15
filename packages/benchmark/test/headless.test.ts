import { describe, expect, it } from "vitest";
import { SIM_DAY } from "@hobbo/domain";
import {
  HEADLESS_AGENT_COUNT,
  HEADLESS_HUNGER_THRESHOLD,
  runHeadlessFoodSimulation,
} from "../src/index.ts";

describe("20-agent headless simulation fixture", () => {
  it("runs 20 agents for 30 simulated days without ticks, starvation or inventory corruption", () => {
    const result = runHeadlessFoodSimulation();

    expect(result.agentCount).toBe(HEADLESS_AGENT_COUNT);
    expect(result.agents).toHaveLength(HEADLESS_AGENT_COUNT);
    expect(result.finalSimTime).toBe(BigInt(SIM_DAY) * 30n);
    expect(result.processedScheduledEvents).toBe(result.domainEventCount);
    expect(result.domainEventCount).toBeGreaterThan(500);
    expect(result.domainEventCount).toBeLessThan(2_000);

    const totalMeals = result.agents.reduce(
      (total, agent) => total + agent.mealsEaten,
      0,
    );
    expect(totalMeals).toBe(result.domainEventCount);

    for (const agent of result.agents) {
      expect(agent.mealsEaten).toBeGreaterThan(0);
      expect(agent.remainingFood).toBe(100 - agent.mealsEaten);
      expect(agent.remainingFood).toBeGreaterThan(0);
      expect(agent.finalHunger).toBeGreaterThanOrEqual(0);
      expect(agent.finalHunger).toBeLessThan(HEADLESS_HUNGER_THRESHOLD);
    }
  });

  it("is bit-for-bit deterministic for the same seed", () => {
    const first = runHeadlessFoodSimulation({ seed: 123456789n });
    const second = runHeadlessFoodSimulation({ seed: 123456789n });
    expect(second).toEqual(first);
  });

  it("uses the seed to create a different deterministic population", () => {
    const first = runHeadlessFoodSimulation({ seed: 1n });
    const second = runHeadlessFoodSimulation({ seed: 2n });
    expect(second.agents).not.toEqual(first.agents);
  });
});
