import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DeterministicMockEmbeddingProvider } from "@hobbo/ai-provider";
import {
  deriveListenerEffects,
  type ConversationStatement,
} from "@hobbo/conversation";
import {
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asEntityId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresConversationDeliveryProcessor,
  PostgresConversationRepository,
  PostgresMemoryRepository,
  PostgresSocialRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const conversations = new PostgresConversationRepository(pool);
const social = new PostgresSocialRepository(pool);
const memories = new PostgresMemoryRepository(pool);
const worldId = asWorldId("conversation-effects-world");
const alice = asEntityId("alice");
const bob = asEntityId("bob");
const carol = asEntityId("carol");

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
  await worlds.create(worldId);
});

afterAll(async () => {
  await pool.end();
});

function statement(
  id: string,
  value: unknown,
  origin: ConversationStatement["origin"] = "direct",
): ConversationStatement {
  return {
    id: asConversationStatementId(id),
    subjectId: "cafe-1",
    predicate: "closing_time",
    value,
    confidenceBps: 9_000,
    origin,
    hopCount: 0,
  };
}

describe("conversation information propagation", () => {
  it("creates private evidence, beliefs, memories and embeddings without leaking fabricated provenance", async () => {
    const conversation = await conversations.createConversation({
      id: asConversationId("belief-split"),
      worldId,
      participantIds: [alice, bob, carol],
      startedAt: simTime(100),
      maxTurns: 4,
    });

    await social.applyRelationshipEffect({
      worldId,
      effectId: "seed-bob-trust",
      fromEntityId: bob,
      toEntityId: alice,
      at: simTime(105),
      delta: { trust: 8_000 },
    });
    await social.applyRelationshipEffect({
      worldId,
      effectId: "seed-carol-distrust",
      fromEntityId: carol,
      toEntityId: alice,
      at: simTime(105),
      delta: { trust: -8_000 },
    });

    const message = await conversations.appendMessage({
      id: asConversationMessageId("private-message"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "The cafe closes at six.",
      statements: [statement("private-statement", "18:00", "fabricated")],
    });

    const embedder = new DeterministicMockEmbeddingProvider();
    const processor = new PostgresConversationDeliveryProcessor(pool, { embedder });
    expect(await processor.processNext(worldId, "conversation-worker")).toBeDefined();
    expect(await processor.processNext(worldId, "conversation-worker")).toBeDefined();
    expect(await processor.processNext(worldId, "conversation-worker")).toBeUndefined();

    const bobPerceptions = await social.listPerceptions(worldId, bob);
    const carolPerceptions = await social.listPerceptions(worldId, carol);
    expect(bobPerceptions).toHaveLength(1);
    expect(carolPerceptions).toHaveLength(1);
    expect(bobPerceptions[0]!.confidenceBps).toBeGreaterThan(
      carolPerceptions[0]!.confidenceBps,
    );

    expect(
      await social.getBelief(worldId, bob, "cafe-1", "closing_time"),
    ).toMatchObject({ value: "18:00", sourcePerceptionId: bobPerceptions[0]!.id });
    expect(
      await social.getBelief(worldId, carol, "cafe-1", "closing_time"),
    ).toBeUndefined();

    const bobMemories = await memories.listMemories(worldId, bob);
    const carolMemories = await memories.listMemories(worldId, carol);
    const aliceMemories = await memories.listMemories(worldId, alice);
    expect(bobMemories).toHaveLength(1);
    expect(carolMemories).toHaveLength(1);
    expect(aliceMemories).toHaveLength(1);

    for (const listenerMemory of [bobMemories[0]!, carolMemories[0]!]) {
      const metadata = listenerMemory.metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("statements");
      expect(metadata).not.toHaveProperty("origin");
      expect(metadata).not.toHaveProperty("sourceStatementId");
      expect(metadata.statementIds).toEqual(["private-statement"]);
    }
    expect(aliceMemories[0]!.metadata).toMatchObject({
      statements: [
        expect.objectContaining({
          id: "private-statement",
          origin: "fabricated",
          sourceStatementId: null,
        }),
      ],
    });

    for (const memory of [bobMemories[0]!, carolMemories[0]!, aliceMemories[0]!]) {
      expect(
        await memories.getEmbedding(worldId, memory.id, embedder.modelId),
      ).toBeDefined();
    }

    expect((await social.getRelationship(worldId, bob, alice))?.vector).toMatchObject({
      trust: 8_000,
      familiarity: 25,
    });
    expect((await social.getRelationship(worldId, carol, alice))?.vector).toMatchObject({
      trust: -8_000,
      familiarity: 25,
    });
    expect((await social.getRelationship(worldId, alice, bob))?.vector.familiarity).toBe(25);
    expect((await social.getRelationship(worldId, alice, carol))?.vector.familiarity).toBe(25);

    expect(
      (await conversations.listDeliveries(worldId, message.id)).every(
        (delivery) => delivery.status === "completed",
      ),
    ).toBe(true);
  });

  it("keeps contradictory evidence while revising only the private current belief", async () => {
    const conversation = await conversations.createConversation({
      id: asConversationId("contradiction"),
      worldId,
      participantIds: [alice, bob],
      startedAt: simTime(100),
      maxTurns: 4,
    });
    await social.applyRelationshipEffect({
      worldId,
      effectId: "seed-contradiction-trust",
      fromEntityId: bob,
      toEntityId: alice,
      at: simTime(105),
      delta: { trust: 10_000 },
    });

    await conversations.appendMessage({
      id: asConversationMessageId("contradiction-1"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "The cafe closes at six.",
      statements: [statement("contradiction-statement-1", "18:00")],
    });
    const processor = new PostgresConversationDeliveryProcessor(pool);
    await processor.processNext(worldId, "belief-worker");

    await conversations.appendMessage({
      id: asConversationMessageId("contradiction-2"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(120),
      text: "Correction: it closes at seven.",
      statements: [statement("contradiction-statement-2", "19:00")],
    });
    await processor.processNext(worldId, "belief-worker");

    const evidence = await social.listPerceptions(worldId, bob);
    expect(evidence.map((item) => item.value)).toEqual(["18:00", "19:00"]);

    const belief = await social.getBelief(worldId, bob, "cafe-1", "closing_time");
    expect(belief?.value).toBe("19:00");
    expect(belief?.learnedAt).toBe(simTime(110));
    expect(belief?.updatedAt).toBe(simTime(120));
  });
});

describe("conversation delivery crash recovery", () => {
  it("converges after partial side effects and a fresh PostgreSQL pool", async () => {
    const conversation = await conversations.createConversation({
      id: asConversationId("crash-recovery"),
      worldId,
      participantIds: [alice, bob],
      startedAt: simTime(100),
      maxTurns: 4,
    });
    const message = await conversations.appendMessage({
      id: asConversationMessageId("crash-message"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "The cafe closes at six.",
      statements: [statement("crash-statement", "18:00")],
    });

    const claimed = await conversations.claimPendingDeliveries(
      worldId,
      "dead-worker",
      1,
    );
    const delivery = claimed[0]!;
    const effects = deriveListenerEffects(conversation, message, bob);

    // Simulate a process dying after only some idempotent side effects landed.
    await social.recordPerception(effects.perceptions[0]!);
    await memories.createMemory(effects.memory);
    await social.applyRelationshipEffect({
      worldId,
      effectId: effects.relationshipEffects[0]!.effectId,
      fromEntityId: effects.relationshipEffects[0]!.fromEntityId,
      toEntityId: effects.relationshipEffects[0]!.toEntityId,
      at: effects.relationshipEffects[0]!.at,
      delta: effects.relationshipEffects[0]!.delta,
    });
    await pool.query(
      `UPDATE conversation_deliveries
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND message_id = $2 AND listener_id = $3`,
      [worldId, delivery.messageId, delivery.listenerId],
    );

    const restartedPool = new Pool();
    try {
      const restartedConversations = new PostgresConversationRepository(restartedPool);
      const restartedSocial = new PostgresSocialRepository(restartedPool);
      const restartedMemories = new PostgresMemoryRepository(restartedPool);
      const restartedProcessor = new PostgresConversationDeliveryProcessor(
        restartedPool,
        { embedder: new DeterministicMockEmbeddingProvider() },
      );

      expect(
        await restartedConversations.requeueStaleDeliveries(
          worldId,
          new Date(Date.now() - 60_000),
        ),
      ).toBe(1);
      const recovered = await restartedConversations.claimPendingDeliveries(
        worldId,
        "replacement-worker",
        1,
      );
      expect(recovered[0]?.attempts).toBe(2);
      await restartedProcessor.processClaim(
        recovered[0]!,
        "replacement-worker",
      );

      expect(await restartedSocial.listPerceptions(worldId, bob)).toHaveLength(1);
      expect(await restartedMemories.listMemories(worldId, bob)).toHaveLength(1);
      expect(await restartedMemories.listMemories(worldId, alice)).toHaveLength(1);
      expect(
        (await restartedSocial.getRelationship(worldId, bob, alice))?.vector
          .familiarity,
      ).toBe(25);
      expect(
        (await restartedSocial.getRelationship(worldId, alice, bob))?.vector
          .familiarity,
      ).toBe(25);
      expect(
        (await restartedConversations.listDeliveries(worldId, message.id))[0]?.status,
      ).toBe("completed");
    } finally {
      await restartedPool.end();
    }
  });
});
