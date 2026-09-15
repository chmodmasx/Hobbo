import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asEntityId,
  asMemoryId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import type { MemoryRecord } from "@hobbo/memory";
import {
  PostgresMemoryRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const memories = new PostgresMemoryRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE memory_embeddings, memories, relationship_effects, relationships, beliefs, perceptions, tenancies, housing_units, employments, ledger_entries, ledger_transactions, ledger_accounts, commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

async function createWorld(name: string) {
  const worldId = asWorldId(name);
  await worlds.create(worldId);
  return worldId;
}

function memory(input: {
  worldId: ReturnType<typeof asWorldId>;
  id: string;
  owner?: string;
  at?: number;
  content?: string;
  category?: MemoryRecord["category"];
  importance?: number;
  emotional?: number;
  related?: string[];
}): MemoryRecord {
  return {
    id: asMemoryId(input.id),
    worldId: input.worldId,
    ownerId: asEntityId(input.owner ?? "person-alice"),
    category: input.category ?? "episodic",
    occurredAt: simTime(input.at ?? 100),
    content: input.content ?? `Memory ${input.id}`,
    importanceBps: input.importance ?? 5_000,
    emotionalStrengthBps: input.emotional ?? 2_000,
    relatedEntityIds: (input.related ?? []).map(asEntityId),
  };
}

describe("durable memory storage", () => {
  it("makes exact memory retries idempotent and rejects semantic reuse of an id", async () => {
    const worldId = await createWorld("memory-idempotent-world");
    const original = memory({
      worldId,
      id: "memory-1",
      content: "Bob helped Alice at the cafe",
      related: ["person-carol", "person-bob"],
    });

    const first = await memories.createMemory(original);
    const retry = await memories.createMemory(original);

    expect(retry).toEqual(first);
    expect(first.relatedEntityIds.map(String)).toEqual([
      "person-bob",
      "person-carol",
    ]);

    await expect(
      memories.createMemory({ ...original, content: "Rewritten history" }),
    ).rejects.toThrow(/already used for different content/i);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memories WHERE world_id = $1`,
      [worldId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("stores multiple embedding models without overwriting either vector", async () => {
    const worldId = await createWorld("memory-multiple-models-world");
    const record = memory({ worldId, id: "memory-1" });
    await memories.createMemory(record);

    await memories.putEmbedding(worldId, {
      memoryId: record.id,
      modelId: "model-a",
      vector: [1, 0],
    });
    await memories.putEmbedding(worldId, {
      memoryId: record.id,
      modelId: "model-b",
      vector: [0, 1],
    });

    expect((await memories.getEmbedding(worldId, record.id, "model-a"))?.vector).toEqual([
      1, 0,
    ]);
    expect((await memories.getEmbedding(worldId, record.id, "model-b"))?.vector).toEqual([
      0, 1,
    ]);
  });

  it("retries an embedding from a fresh pool without duplicating it and rejects changed vector data", async () => {
    const worldId = await createWorld("memory-embedding-retry-world");
    const record = memory({ worldId, id: "memory-1" });
    await memories.createMemory(record);
    const embedding = {
      memoryId: record.id,
      modelId: "nomic-test",
      vector: [0.5, -0.25, 0.75],
    } as const;

    const first = await memories.putEmbedding(worldId, embedding);

    const freshPool = new Pool();
    try {
      const freshRepo = new PostgresMemoryRepository(freshPool);
      expect(await freshRepo.putEmbedding(worldId, embedding)).toEqual(first);
    } finally {
      await freshPool.end();
    }

    await expect(
      memories.putEmbedding(worldId, {
        ...embedding,
        vector: [0.5, -0.2, 0.75],
      }),
    ).rejects.toThrow(/different vector data/i);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM memory_embeddings
        WHERE world_id = $1 AND memory_id = $2 AND model_id = $3`,
      [worldId, record.id, embedding.modelId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});

describe("exact semantic retrieval from persistent memory", () => {
  it("never retrieves another owner's memory even when it is the strongest semantic match", async () => {
    const worldId = await createWorld("memory-owner-isolation-world");
    const alice = memory({
      worldId,
      id: "alice-memory",
      owner: "person-alice",
      content: "Alice remembers Bob talking about work",
    });
    const bob = memory({
      worldId,
      id: "bob-private-memory",
      owner: "person-bob",
      content: "Bob privately knows he was fired",
    });
    await memories.createMemory(alice);
    await memories.createMemory(bob);
    await memories.putEmbedding(worldId, {
      memoryId: alice.id,
      modelId: "model",
      vector: [0.8, 0.2],
    });
    await memories.putEmbedding(worldId, {
      memoryId: bob.id,
      modelId: "model",
      vector: [1, 0],
    });

    const result = await memories.retrieve({
      worldId,
      ownerId: asEntityId("person-alice"),
      query: {
        now: simTime(200),
        modelId: "model",
        queryEmbedding: [1, 0],
        limit: 10,
        recencyHalfLife: simDuration(1_000),
      },
    });

    expect(result.map((item) => String(item.memory.id))).toEqual(["alice-memory"]);
  });

  it("applies persistent category and related-entity filters before exact ranking", async () => {
    const worldId = await createWorld("memory-filter-world");
    const records = [
      memory({
        worldId,
        id: "bob-social",
        category: "social",
        related: ["person-bob"],
      }),
      memory({
        worldId,
        id: "carol-social",
        category: "social",
        related: ["person-carol"],
      }),
      memory({
        worldId,
        id: "bob-semantic",
        category: "semantic",
        related: ["person-bob"],
      }),
    ];
    for (const record of records) {
      await memories.createMemory(record);
      await memories.putEmbedding(worldId, {
        memoryId: record.id,
        modelId: "model",
        vector: [1, 0],
      });
    }

    const result = await memories.retrieve({
      worldId,
      ownerId: asEntityId("person-alice"),
      query: {
        now: simTime(200),
        modelId: "model",
        queryEmbedding: [1, 0],
        limit: 10,
        recencyHalfLife: simDuration(1_000),
        categories: ["social"],
        relatedEntityIds: [asEntityId("person-bob")],
      },
    });

    expect(result.map((item) => String(item.memory.id))).toEqual(["bob-social"]);
  });

  it("can re-embed memories with a new model and obtain a different ranking without rewriting memory rows", async () => {
    const worldId = await createWorld("memory-reembed-world");
    const first = memory({ worldId, id: "memory-first", content: "First memory" });
    const second = memory({ worldId, id: "memory-second", content: "Second memory" });
    await memories.createMemory(first);
    await memories.createMemory(second);

    await memories.putEmbedding(worldId, {
      memoryId: first.id,
      modelId: "model-a",
      vector: [1, 0],
    });
    await memories.putEmbedding(worldId, {
      memoryId: second.id,
      modelId: "model-a",
      vector: [0, 1],
    });
    await memories.putEmbedding(worldId, {
      memoryId: first.id,
      modelId: "model-b",
      vector: [0, 1],
    });
    await memories.putEmbedding(worldId, {
      memoryId: second.id,
      modelId: "model-b",
      vector: [1, 0],
    });

    const retrieveWith = (modelId: string) =>
      memories.retrieve({
        worldId,
        ownerId: asEntityId("person-alice"),
        query: {
          now: simTime(200),
          modelId,
          queryEmbedding: [1, 0],
          limit: 2,
          recencyHalfLife: simDuration(1_000),
          weights: { semantic: 10_000, recency: 0, importance: 0, emotional: 0 },
        },
      });

    expect((await retrieveWith("model-a")).map((item) => String(item.memory.id))).toEqual([
      "memory-first",
      "memory-second",
    ]);
    expect((await retrieveWith("model-b")).map((item) => String(item.memory.id))).toEqual([
      "memory-second",
      "memory-first",
    ]);

    const persisted = await memories.listMemories(worldId, asEntityId("person-alice"));
    expect(persisted.map((item) => item.content)).toEqual(["First memory", "Second memory"]);
  });
});
