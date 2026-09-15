import { describe, expect, it } from "vitest";
import {
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asEntityId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { zeroRelationshipVector } from "@hobbo/social";
import {
  DEFAULT_CONVERSATION_PROPAGATION_POLICY,
  deriveListenerEffects,
  deriveSpeakerMemory,
  receivedStatementConfidenceBps,
  retellStatement,
  reviseBeliefFromReportedPerception,
  validateConversation,
  validateMessage,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationStatement,
} from "../src/index.ts";

const worldId = asWorldId("world-conversation");
const alice = asEntityId("alice");
const bob = asEntityId("bob");
const carol = asEntityId("carol");

function conversation(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: asConversationId("conversation-1"),
    worldId,
    participantIds: [alice, bob, carol],
    startedAt: simTime(100),
    maxTurns: 8,
    status: "open",
    ...overrides,
  };
}

function statement(
  overrides: Partial<ConversationStatement> = {},
): ConversationStatement {
  return {
    id: asConversationStatementId("statement-1"),
    subjectId: "cafe-1",
    predicate: "closing_time",
    value: "18:00",
    confidenceBps: 9_000,
    origin: "reported",
    sourceStatementId: asConversationStatementId("statement-origin"),
    claimedSourceEntityId: carol,
    hopCount: 1,
    ...overrides,
  };
}

function message(
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: asConversationMessageId("message-1"),
    worldId,
    conversationId: asConversationId("conversation-1"),
    ordinal: 1,
    speakerId: alice,
    sentAt: simTime(110),
    text: "Carol told me the cafe closes at six.",
    statements: [statement()],
    ...overrides,
  };
}

describe("finite conversation model", () => {
  it("requires unique participants and a finite positive turn budget", () => {
    expect(() =>
      validateConversation(
        conversation({ participantIds: [alice, alice] }),
      ),
    ).toThrow(/duplicates/i);
    expect(() => validateConversation(conversation({ maxTurns: 0 }))).toThrow(
      /positive/i,
    );
  });

  it("rejects turns beyond maxTurns and messages from outsiders", () => {
    const limited = conversation({ maxTurns: 2 });
    expect(() => validateMessage(limited, message({ ordinal: 3 }))).toThrow(
      /maxTurns/i,
    );
    expect(() =>
      validateMessage(limited, message({ speakerId: asEntityId("outsider") })),
    ).toThrow(/participant/i);
  });
});

describe("private information propagation", () => {
  it("turns speech into reported evidence without leaking omniscient origin metadata", () => {
    const fabricated = statement({
      origin: "fabricated",
      sourceStatementId: undefined,
      claimedSourceEntityId: carol,
      hopCount: 0,
    });
    const spoken = message({ statements: [fabricated] });

    const effects = deriveListenerEffects(conversation(), spoken, bob);
    expect(effects.perceptions).toHaveLength(1);
    expect(effects.perceptions[0]).toMatchObject({
      observerId: bob,
      channel: "reported",
      sourceEntityId: alice,
      subjectId: "cafe-1",
      predicate: "closing_time",
      value: "18:00",
    });

    const listenerMetadata = effects.memory.metadata as Record<string, unknown>;
    expect(JSON.stringify(listenerMetadata)).not.toContain("fabricated");
    expect(JSON.stringify(listenerMetadata)).not.toContain("statement-origin");

    const speaker = deriveSpeakerMemory(conversation(), spoken);
    expect(JSON.stringify(speaker.metadata)).toContain("fabricated");
  });

  it("uses relationship trust to produce different private confidence and belief outcomes", () => {
    const trustedRelationship = {
      ...zeroRelationshipVector(),
      trust: 8_000,
    };
    const distrustedRelationship = {
      ...zeroRelationshipVector(),
      trust: -8_000,
    };

    const trusted = deriveListenerEffects(
      conversation(),
      message(),
      bob,
      trustedRelationship,
    );
    const distrusted = deriveListenerEffects(
      conversation(),
      message(),
      carol,
      distrustedRelationship,
    );

    expect(trusted.perceptions[0]!.confidenceBps).toBeGreaterThan(
      distrusted.perceptions[0]!.confidenceBps,
    );
    expect(trusted.beliefCandidates).toHaveLength(1);
    expect(distrusted.beliefCandidates).toHaveLength(0);
  });

  it("applies transmission loss once per retelling and preserves lineage", () => {
    const source = statement({
      id: asConversationStatementId("source"),
      origin: "direct",
      sourceStatementId: undefined,
      hopCount: 0,
      confidenceBps: 10_000,
    });
    const retold = retellStatement({
      id: asConversationStatementId("retold"),
      source,
      confidenceBps: 8_000,
      value: "17:30",
      claimedSourceEntityId: alice,
    });

    expect(retold).toMatchObject({
      sourceStatementId: source.id,
      hopCount: 1,
      origin: "reported",
      value: "17:30",
    });
    expect(
      receivedStatementConfidenceBps(
        retold,
        zeroRelationshipVector(),
        DEFAULT_CONVERSATION_PROPAGATION_POLICY,
      ),
    ).toBe(5_400);
  });

  it("creates deterministic familiarity effects in both directions", () => {
    const effects = deriveListenerEffects(conversation(), message(), bob);
    expect(effects.relationshipEffects).toEqual([
      expect.objectContaining({
        effectId:
          "conversation:conversation-1:message:message-1:familiarity:bob->alice",
        fromEntityId: bob,
        toEntityId: alice,
        delta: { familiarity: 25 },
      }),
      expect.objectContaining({
        effectId:
          "conversation:conversation-1:message:message-1:familiarity:alice->bob",
        fromEntityId: alice,
        toEntityId: bob,
        delta: { familiarity: 25 },
      }),
    ]);
  });
});

describe("reported belief revision", () => {
  it("preserves original learnedAt and ignores same-time or stale revisions", () => {
    const first = deriveListenerEffects(
      conversation(),
      message({ sentAt: simTime(110) }),
      bob,
      { ...zeroRelationshipVector(), trust: 10_000 },
    ).beliefCandidates[0]!;
    const later = deriveListenerEffects(
      conversation(),
      message({
        id: asConversationMessageId("message-2"),
        ordinal: 2,
        sentAt: simTime(120),
        statements: [
          statement({
            id: asConversationStatementId("statement-2"),
            value: "19:00",
          }),
        ],
      }),
      bob,
      { ...zeroRelationshipVector(), trust: 10_000 },
    ).beliefCandidates[0]!;

    const revised = reviseBeliefFromReportedPerception(first, later);
    expect(revised?.learnedAt).toBe(first.learnedAt);
    expect(revised?.updatedAt).toBe(simTime(120));
    expect(revised?.value).toBe("19:00");
    expect(reviseBeliefFromReportedPerception(revised, first)).toBeUndefined();
  });
});
