import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import type { CognitiveRequest } from "../src/index.ts";
import { GraniteCognitiveProvider } from "../src/granite.ts";

const baseUrl = process.env.HOBBO_COGNITION_BASE_URL ?? "http://127.0.0.1:8086";
const modelId = process.env.HOBBO_COGNITION_MODEL_ID ?? "hobbo-cognition";

interface FixtureContext {
  readonly hunger: number;
  readonly ownsEdibleFood: boolean;
  readonly instruction: string;
}

function fixture(): CognitiveRequest<FixtureContext> {
  return {
    id: asCognitionRequestId("granite-live-hunger"),
    actorId: asEntityId("person-fixture"),
    simTime: simTime(100),
    correlationId: asCorrelationId("granite-live-corr"),
    context: {
      hunger: 9_900,
      ownsEdibleFood: true,
      instruction:
        "Hunger is critically high. The actor already owns edible food and should satisfy the urgent need.",
    },
    affordances: [
      {
        id: asAffordanceId("eat_owned_food"),
        actionId: asActionId("inventory.consume_food"),
        label: "Eat the owned sandwich now",
        context: { itemId: "sandwich-1" },
      },
      {
        id: asAffordanceId("wait"),
        actionId: asActionId("activity.wait"),
        label: "Do nothing",
        context: {},
      },
    ],
  };
}

describe("GraniteCognitiveProvider live llama.cpp contract", () => {
  it("chooses the physically available food action through the production provider", async () => {
    const provider = new GraniteCognitiveProvider<FixtureContext>({
      baseUrl,
      modelId,
    });

    const run = await provider.decideWithTrace(fixture());

    expect(run.decision.affordanceId).toBe("eat_owned_food");
    expect(run.decision.intent.trim().length).toBeGreaterThan(0);
    expect(run.decision.replayed).toBe(false);
    expect(run.trace.providerId).toBe("granite-openai-compatible");
    expect(run.trace.modelId).toBe(modelId);
    expect(run.trace.rawResponse.length).toBeGreaterThan(0);
    expect(run.trace.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
