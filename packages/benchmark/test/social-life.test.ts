import { describe, expect, it } from "vitest";
import {
  SOCIAL_LIFE_AGENT_COUNT,
  SOCIAL_LIFE_DURATION,
  runSocialLifeSimulation,
} from "../src/social-life.ts";

describe("20-agent 30-day social life gate", () => {
  it("sustains bounded deterministic social propagation for the full fixture", () => {
    const result = runSocialLifeSimulation();

    expect(result.agentCount).toBe(SOCIAL_LIFE_AGENT_COUNT);
    expect(result.finalSimTime).toBe(BigInt(SOCIAL_LIFE_DURATION));
    expect(result.processedScheduledEvents).toBe(600);
    expect(result.conversationCount).toBe(600);
    expect(result.domainEventCount).toBe(600);
    expect(result.totalMemories).toBe(1_200);
    expect(result.maxFutureQueueSize).toBeLessThanOrEqual(SOCIAL_LIFE_AGENT_COUNT);

    expect(result.agents).toHaveLength(20);
    expect(result.agents.every((agent) => agent.conversationsSpoken === 30)).toBe(
      true,
    );
    expect(
      result.agents.reduce(
        (sum, agent) => sum + agent.conversationsHeard,
        0,
      ),
    ).toBe(600);

    expect(result.statementsSpoken).toBeGreaterThan(0);
    expect(result.rumorRetellings).toBeGreaterThan(0);
    expect(result.rumorMutations).toBeGreaterThan(0);
    expect(result.totalPerceptions).toBeGreaterThan(0);
    expect(result.totalBeliefs).toBeGreaterThan(0);
    expect(result.agentsWithBeliefs).toBeGreaterThan(1);
    expect(result.distinctBeliefSignatures).toBeGreaterThan(1);
    expect(result.familiarRelationshipEdges).toBeGreaterThan(20);
  });

  it("reproduces exactly for the same seed", () => {
    const first = runSocialLifeSimulation({ seed: 0x534f4349414cn });
    const second = runSocialLifeSimulation({ seed: 0x534f4349414cn });
    expect(second).toEqual(first);
  });

  it("produces divergent social histories for a different seed", () => {
    const first = runSocialLifeSimulation({ seed: 0x111111111111n });
    const second = runSocialLifeSimulation({ seed: 0x222222222222n });

    expect(second.agents).not.toEqual(first.agents);
    expect(
      second.agents.map((agent) => agent.beliefSignature),
    ).not.toEqual(first.agents.map((agent) => agent.beliefSignature));
  });
});
