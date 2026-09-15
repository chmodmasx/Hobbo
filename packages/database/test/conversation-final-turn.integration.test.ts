import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
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
const worldId = asWorldId("conversation-final-turn-world");
const alice = asEntityId("alice");
const bob = asEntityId("bob");

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
  await worlds.create(worldId);
});

afterAll(async () => {
  await pool.end();
});

describe("final conversation turn delivery", () => {
  it("materializes private effects after maxTurns has already closed the conversation", async () => {
    const conversation = await conversations.createConversation({
      id: asConversationId("one-turn"),
      worldId,
      participantIds: [alice, bob],
      startedAt: simTime(100),
      maxTurns: 1,
    });

    const message = await conversations.appendMessage({
      id: asConversationMessageId("one-turn-message"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "The cafe closes at six.",
      statements: [
        {
          id: asConversationStatementId("one-turn-statement"),
          subjectId: "cafe-1",
          predicate: "closing_time",
          value: "18:00",
          confidenceBps: 9_000,
          origin: "direct",
          hopCount: 0,
        },
      ],
    });

    expect((await conversations.getConversation(worldId, conversation.id))?.status).toBe(
      "closed",
    );

    const processor = new PostgresConversationDeliveryProcessor(pool);
    const result = await processor.processNext(worldId, "final-turn-worker");
    expect(result?.delivery.messageId).toBe(message.id);
    expect(await social.listPerceptions(worldId, bob)).toHaveLength(1);
    expect(await memories.listMemories(worldId, bob)).toHaveLength(1);
    expect(await memories.listMemories(worldId, alice)).toHaveLength(1);
    expect((await conversations.listDeliveries(worldId, message.id))[0]?.status).toBe(
      "completed",
    );
  });
});
