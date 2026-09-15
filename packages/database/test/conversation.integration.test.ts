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
  PostgresConversationRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const conversations = new PostgresConversationRepository(pool);
const worldId = asWorldId("conversation-integration-world");
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

async function createConversation(
  id = "conversation-1",
  participantIds = [alice, bob] as const,
  maxTurns = 4,
) {
  return conversations.createConversation({
    id: asConversationId(id),
    worldId,
    participantIds,
    startedAt: simTime(100),
    maxTurns,
  });
}

function reportedStatement(id: string, value = "18:00") {
  return {
    id: asConversationStatementId(id),
    subjectId: "cafe-1",
    predicate: "closing_time",
    value,
    confidenceBps: 9_000,
    origin: "reported" as const,
    claimedSourceEntityId: carol,
    hopCount: 1,
  };
}

describe("durable finite conversations", () => {
  it("assigns stable ordinals, makes exact append retries idempotent and closes at maxTurns", async () => {
    const conversation = await createConversation("finite", [alice, bob], 2);

    const firstInput = {
      id: asConversationMessageId("finite-message-1"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "The cafe closes at six.",
      statements: [reportedStatement("finite-statement-1")],
    };
    const first = await conversations.appendMessage(firstInput);
    const retry = await conversations.appendMessage(firstInput);
    expect(first.ordinal).toBe(1);
    expect(retry).toEqual(first);

    const second = await conversations.appendMessage({
      id: asConversationMessageId("finite-message-2"),
      worldId,
      conversationId: conversation.id,
      speakerId: bob,
      sentAt: simTime(120),
      text: "Okay.",
      statements: [],
    });
    expect(second.ordinal).toBe(2);

    const closed = await conversations.getConversation(worldId, conversation.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.endedAt).toBe(simTime(120));

    await expect(
      conversations.appendMessage({
        id: asConversationMessageId("finite-message-3"),
        worldId,
        conversationId: conversation.id,
        speakerId: alice,
        sentAt: simTime(130),
        text: "Too late.",
        statements: [],
      }),
    ).rejects.toThrow(/closed|turn budget/i);
  });

  it("serializes concurrent ordinal allocation through the conversation row lock", async () => {
    const conversation = await createConversation("concurrent", [alice, bob], 4);

    const [left, right] = await Promise.all([
      conversations.appendMessage({
        id: asConversationMessageId("concurrent-left"),
        worldId,
        conversationId: conversation.id,
        speakerId: alice,
        sentAt: simTime(110),
        text: "left",
        statements: [],
      }),
      conversations.appendMessage({
        id: asConversationMessageId("concurrent-right"),
        worldId,
        conversationId: conversation.id,
        speakerId: alice,
        sentAt: simTime(110),
        text: "right",
        statements: [],
      }),
    ]);

    expect(new Set([left.ordinal, right.ordinal])).toEqual(new Set([1, 2]));
    expect((await conversations.listMessages(worldId, conversation.id)).map((m) => m.ordinal)).toEqual([
      1,
      2,
    ]);
  });

  it("rejects semantic reuse of a message id", async () => {
    const conversation = await createConversation("idempotency");
    const input = {
      id: asConversationMessageId("same-id"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "original",
      statements: [],
    };
    await conversations.appendMessage(input);
    await expect(
      conversations.appendMessage({ ...input, text: "changed" }),
    ).rejects.toThrow(/different content/i);
  });

  it("persists rumor lineage across mutated retellings", async () => {
    const conversation = await createConversation("lineage", [alice, bob], 4);
    const sourceId = asConversationStatementId("lineage-source");
    await conversations.appendMessage({
      id: asConversationMessageId("lineage-message-1"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "I saw the cafe close at six.",
      statements: [
        {
          id: sourceId,
          subjectId: "cafe-1",
          predicate: "closing_time",
          value: "18:00",
          confidenceBps: 10_000,
          origin: "direct",
          hopCount: 0,
        },
      ],
    });
    await conversations.appendMessage({
      id: asConversationMessageId("lineage-message-2"),
      worldId,
      conversationId: conversation.id,
      speakerId: bob,
      sentAt: simTime(120),
      text: "Alice said the cafe closes at half past five.",
      statements: [
        {
          id: asConversationStatementId("lineage-retell"),
          subjectId: "cafe-1",
          predicate: "closing_time",
          value: "17:30",
          confidenceBps: 8_000,
          origin: "reported",
          sourceStatementId: sourceId,
          claimedSourceEntityId: alice,
          hopCount: 1,
        },
      ],
    });

    const history = await conversations.listMessages(worldId, conversation.id);
    expect(history[1]?.statements[0]).toMatchObject({
      sourceStatementId: sourceId,
      value: "17:30",
      hopCount: 1,
    });
  });
});

describe("durable conversation delivery queue", () => {
  it("allows only the oldest active delivery for one listener to be claimed", async () => {
    const conversation = await createConversation("delivery-order", [alice, bob], 4);
    await conversations.appendMessage({
      id: asConversationMessageId("delivery-message-1"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "first",
      statements: [],
    });
    await conversations.appendMessage({
      id: asConversationMessageId("delivery-message-2"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(120),
      text: "second",
      statements: [],
    });

    const first = await conversations.claimPendingDeliveries(worldId, "worker-a", 1);
    expect(first.map((delivery) => String(delivery.messageId))).toEqual([
      "delivery-message-1",
    ]);

    const blocked = await conversations.claimPendingDeliveries(worldId, "worker-b", 1);
    expect(blocked).toEqual([]);

    await conversations.completeDelivery(
      worldId,
      first[0]!.messageId,
      bob,
      "worker-a",
    );

    const second = await conversations.claimPendingDeliveries(worldId, "worker-b", 1);
    expect(second.map((delivery) => String(delivery.messageId))).toEqual([
      "delivery-message-2",
    ]);
  });

  it("requeues stale delivery leases for crash recovery", async () => {
    const conversation = await createConversation("delivery-recovery", [alice, bob], 2);
    const message = await conversations.appendMessage({
      id: asConversationMessageId("delivery-stale"),
      worldId,
      conversationId: conversation.id,
      speakerId: alice,
      sentAt: simTime(110),
      text: "recover me",
      statements: [],
    });

    const claimed = await conversations.claimPendingDeliveries(worldId, "dead-worker", 1);
    expect(claimed).toHaveLength(1);
    await pool.query(
      `UPDATE conversation_deliveries
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND message_id = $2 AND listener_id = $3`,
      [worldId, message.id, bob],
    );

    expect(
      await conversations.requeueStaleDeliveries(
        worldId,
        new Date(Date.now() - 60_000),
      ),
    ).toBe(1);

    const recovered = await conversations.claimPendingDeliveries(
      worldId,
      "replacement-worker",
      1,
    );
    expect(recovered[0]?.attempts).toBe(2);
    expect(recovered[0]?.lockedBy).toBe("replacement-worker");
  });
});
