import { describe, expect, it } from "vitest";
import {
  INTEGRATED_LIFE_AGENT_COUNT,
  INTEGRATED_LIFE_DURATION,
  runIntegratedLifeSimulation,
} from "../src/integrated-life.ts";

describe("20-agent 30-day integrated life gate", () => {
  it("runs physiology, routines and social life on one bounded timeline", () => {
    const result = runIntegratedLifeSimulation();

    expect(result.agentCount).toBe(INTEGRATED_LIFE_AGENT_COUNT);
    expect(result.finalSimTime).toBe(BigInt(INTEGRATED_LIFE_DURATION));
    expect(result.agents).toHaveLength(20);
    expect(result.maxFutureQueueSize).toBeLessThanOrEqual(80);

    expect(result.mealsEaten).toBeGreaterThan(600);
    expect(result.sleepSessions).toBeGreaterThan(400);

    expect(result.routineOpportunities).toBe(600);
    expect(result.routinesFulfilled + result.routinesMissed).toBe(600);
    expect(result.routinesFulfilled).toBeGreaterThan(0);
    expect(result.routinesMissed).toBeGreaterThan(0);

    expect(result.socialOpportunities).toBe(600);
    expect(result.conversationCount).toBeGreaterThan(0);
    expect(result.conversationCount).toBeLessThan(600);
    expect(result.socialSkippedSleeping).toBeGreaterThan(0);
    expect(result.totalMemories).toBe(result.conversationCount * 2);
    expect(result.totalPerceptions).toBe(result.conversationCount);
    expect(result.totalBeliefs).toBeGreaterThan(0);
    expect(result.distinctBeliefSignatures).toBeGreaterThan(1);
    expect(result.familiarRelationshipEdges).toBeGreaterThan(0);

    expect(result.agents.every((agent) => agent.mealsEaten > 0)).toBe(true);
    expect(result.agents.every((agent) => agent.sleepSessions > 0)).toBe(true);
    expect(
      result.agents.every(
        (agent) => agent.routinesFulfilled + agent.routinesMissed === 30,
      ),
    ).toBe(true);
    expect(result.agents.every((agent) => agent.socialOpportunities === 30)).toBe(
      true,
    );
    expect(
      result.agents.every(
        (agent) =>
          agent.finalHunger >= 0 &&
          agent.finalHunger <= 10_000 &&
          agent.finalEnergy >= 0 &&
          agent.finalEnergy <= 10_000,
      ),
    ).toBe(true);
  });

  it("reproduces the exact integrated history summary for the same seed", () => {
    const first = runIntegratedLifeSimulation({ seed: 0x4c494645n });
    const second = runIntegratedLifeSimulation({ seed: 0x4c494645n });
    expect(second).toEqual(first);
  });

  it("allows different seeds to produce different life outcomes", () => {
    const first = runIntegratedLifeSimulation({ seed: 0x123456789abcn });
    const second = runIntegratedLifeSimulation({ seed: 0xabcdef123456n });

    expect(second.agents).not.toEqual(first.agents);
    expect(
      second.agents.map((agent) => ({
        id: agent.id,
        mealsEaten: agent.mealsEaten,
        sleepSessions: agent.sleepSessions,
        routinesMissed: agent.routinesMissed,
        conversationsSpoken: agent.conversationsSpoken,
        beliefSignature: agent.beliefSignature,
      })),
    ).not.toEqual(
      first.agents.map((agent) => ({
        id: agent.id,
        mealsEaten: agent.mealsEaten,
        sleepSessions: agent.sleepSessions,
        routinesMissed: agent.routinesMissed,
        conversationsSpoken: agent.conversationsSpoken,
        beliefSignature: agent.beliefSignature,
      })),
    );
  });
});
