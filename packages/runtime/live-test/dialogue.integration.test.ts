import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import { GraniteCognitiveProvider } from "@hobbo/ai-provider/granite";
import type { CognitiveRequest } from "@hobbo/ai-provider";
import type { DialogueCognitionContext } from "../src/index.ts";

const baseUrl =
  process.env.HOBBO_COGNITION_BASE_URL ?? "http://127.0.0.1:8086";
const modelId =
  process.env.HOBBO_COGNITION_MODEL_ID ?? "hobbo-cognition";

function fixture(): CognitiveRequest<DialogueCognitionContext> {
  return {
    id: asCognitionRequestId("granite-live-dialogue-turn"),
    actorId: asEntityId("person-alice"),
    simTime: simTime(43_200),
    correlationId: asCorrelationId("granite-live-dialogue-corr"),
    context: {
      conversationId: "conversation-alice-bob",
      turnOrdinal: 3,
      speakerId: "person-alice",
      listenerId: "person-bob",
      relationship: {
        familiarity: 6_000,
        trust: 8_000,
        affection: 4_000,
        respect: 3_000,
        attraction: 0,
        fear: 0,
        resentment: 0,
        dependency: 0,
      },
      beliefs: [
        {
          subjectId: "cafe-1",
          predicate: "closing_hour",
          value: 18,
          confidenceBps: 9_500,
        },
      ],
      memories: [
        {
          category: "social",
          occurredAt: "36000",
          content: "Bob mentioned that he likes the cafe.",
          relatedEntityIds: ["person-bob"],
        },
      ],
      history: [
        {
          ordinal: 1,
          speakerId: "person-alice",
          sentAt: "42000",
          text: "How has your day been?",
          statements: [],
        },
        {
          ordinal: 2,
          speakerId: "person-bob",
          sentAt: "42600",
          text: "Pretty good. I may stop by the cafe later.",
          statements: [],
        },
      ],
      activePlan: {
        revision: 2,
        reason: "review",
        intentions: [
          {
            kind: "goal.social_connection",
            startsAt: "61200",
            endsAt: "64800",
          },
        ],
      },
    },
    affordances: [
      {
        id: asAffordanceId("dialogue.share-belief.01"),
        actionId: asActionId("dialogue.speak"),
        label: "Tell person-bob that cafe-1 closing_hour 18",
        context: {
          subjectId: "cafe-1",
          predicate: "closing_hour",
          value: 18,
          confidenceBps: 9_500,
        },
      },
      {
        id: asAffordanceId("dialogue.small-talk"),
        actionId: asActionId("dialogue.speak"),
        label: "Make ordinary small talk with person-bob",
        context: {},
      },
    ],
  };
}

describe("Granite live dialogue decision contract", () => {
  it(
    "selects only a supplied dialogue affordance from private visible context",
    async () => {
      const provider = new GraniteCognitiveProvider<DialogueCognitionContext>({
        baseUrl,
        modelId,
        mode: "dialogue",
      });

      const run = await provider.decideWithTrace(fixture());

      expect([
        "dialogue.share-belief.01",
        "dialogue.small-talk",
      ]).toContain(run.decision.affordanceId);
      expect(run.decision.intent.trim().length).toBeGreaterThan(0);
      expect(run.decision.intent.length).toBeLessThanOrEqual(280);
      expect(run.trace.providerId).toBe("granite-openai-compatible");
      expect(run.trace.modelId).toBe(modelId);
      expect(run.trace.rawResponse.length).toBeGreaterThan(0);
      expect(run.trace.schemaConfig).toMatchObject({
        json_schema: {
          name: "hobbo_dialogue_turn",
          schema: {
            properties: {
              intent: { maxLength: 280 },
            },
          },
        },
      });

      const payload = JSON.stringify(run.trace.requestPayload);
      expect(payload).toContain('"conversationId":"conversation-alice-bob"');
      expect(payload).toContain('"activePlan"');
      expect(payload).toContain('"beliefs"');
      expect(payload).not.toContain('"sourceStatementId"');
      expect(payload).not.toContain('"claimedSourceEntityId"');
      expect(payload).not.toContain('"hopCount"');
      expect(payload).not.toContain('"origin"');
      expect(payload).not.toContain('"metadata"');
    },
    30_000,
  );
});
