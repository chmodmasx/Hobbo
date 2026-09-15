import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import {
  DeterministicMockCognitiveProvider,
  ReplayCognitiveProvider,
  type CognitiveRequest,
} from "../src/index.ts";

const eatId = asAffordanceId("eat_owned_food");
const waitId = asAffordanceId("wait");

function request(id = "cognition-1"): CognitiveRequest<{ hunger: number }> {
  return {
    id: asCognitionRequestId(id),
    actorId: asEntityId("person-1"),
    simTime: simTime(100),
    correlationId: asCorrelationId("corr-1"),
    context: { hunger: 100 },
    affordances: [
      {
        id: eatId,
        actionId: asActionId("inventory.consume_food"),
        label: "Eat owned sandwich",
        context: { itemId: "sandwich-1" },
      },
      {
        id: waitId,
        actionId: asActionId("activity.wait"),
        label: "Wait",
        context: {},
      },
    ],
  };
}

describe("DeterministicMockCognitiveProvider", () => {
  it("chooses the first affordance deterministically by default", async () => {
    const provider = new DeterministicMockCognitiveProvider();
    const decision = await provider.decide(request());

    expect(decision).toEqual({
      requestId: asCognitionRequestId("cognition-1"),
      affordanceId: eatId,
      intent: "Eat owned sandwich",
      providerId: "mock-deterministic",
      replayed: false,
    });
  });

  it("rejects strategies that invent unavailable affordances", async () => {
    const provider = new DeterministicMockCognitiveProvider(() => ({
      affordanceId: asAffordanceId("teleport_to_mars"),
      intent: "Teleport",
    }));

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });
});

describe("ReplayCognitiveProvider", () => {
  it("returns the recorded decision without inference", async () => {
    const provider = new ReplayCognitiveProvider([
      [
        asCognitionRequestId("cognition-1"),
        { affordanceId: waitId, intent: "Wait for the bus" },
      ],
    ]);

    const decision = await provider.decide(request());
    expect(decision.affordanceId).toBe(waitId);
    expect(decision.providerId).toBe("replay");
    expect(decision.replayed).toBe(true);
  });

  it("fails when replay data is missing instead of silently re-deciding", async () => {
    const provider = new ReplayCognitiveProvider();
    await expect(provider.decide(request("missing"))).rejects.toThrow(
      /missing replay decision/i,
    );
  });

  it("rejects a recorded decision that is invalid for the replayed affordances", async () => {
    const provider = new ReplayCognitiveProvider([
      [
        asCognitionRequestId("cognition-1"),
        {
          affordanceId: asAffordanceId("not-currently-available"),
          intent: "Invalid historical decision",
        },
      ],
    ]);

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });
});
