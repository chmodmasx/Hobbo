import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  asEntityId,
  asMemoryId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  MEMORY_SCORE_BASIS_POINTS,
  cosineSimilarity,
  recencyScoreBps,
  retrieveMemories,
  semanticSimilarityBps,
  validateMemoryRecord,
  type EmbeddedMemory,
  type MemoryRecord,
} from "../src/index.ts";

const worldId = asWorldId("world");
const ownerId = asEntityId("person-alice");
const modelId = "nomic-test";

function memory(
  id: string,
  content: string,
  occurredAt: number,
  embedding: readonly number[],
  overrides: Partial<MemoryRecord> = {},
): EmbeddedMemory {
  const record: MemoryRecord = {
    id: asMemoryId(id),
    worldId,
    ownerId,
    category: "episodic",
    occurredAt: simTime(occurredAt),
    content,
    importanceBps: 5_000,
    emotionalStrengthBps: 2_000,
    relatedEntityIds: [],
    ...overrides,
  };
  return {
    memory: record,
    embedding: {
      memoryId: record.id,
      modelId,
      vector: embedding,
    },
  };
}

describe("memory validation and vector scoring", () => {
  it("rejects blank memories, duplicate related entities and invalid basis points", () => {
    const base = memory("m1", "Alice met Bob", 100, [1, 0]).memory;
    expect(() => validateMemoryRecord(base)).not.toThrow();
    expect(() => validateMemoryRecord({ ...base, content: "  " })).toThrow(/content/i);
    expect(() =>
      validateMemoryRecord({
        ...base,
        relatedEntityIds: [asEntityId("bob"), asEntityId("bob")],
      }),
    ).toThrow(/duplicates/i);
    expect(() =>
      validateMemoryRecord({ ...base, importanceBps: 10_001 }),
    ).toThrow(/between 0 and 10000/i);
  });

  it("maps cosine similarity into bounded semantic basis points", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(semanticSimilarityBps([1, 0], [1, 0])).toBe(10_000);
    expect(semanticSimilarityBps([1, 0], [-1, 0])).toBe(0);
    expect(semanticSimilarityBps([1, 0], [0, 1])).toBe(5_000);
  });

  it("uses a deterministic integer recency curve", () => {
    const halfLife = simDuration(100);
    expect(recencyScoreBps(simTime(100), simTime(100), halfLife)).toBe(10_000);
    expect(recencyScoreBps(simTime(0), simTime(100), halfLife)).toBe(5_000);
    expect(recencyScoreBps(simTime(0), simTime(300), halfLife)).toBe(2_500);
  });

  it("keeps semantic scores bounded for arbitrary finite non-zero vectors", () => {
    const vector = fc
      .tuple(
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
      )
      .filter(([a, b]) => a !== 0 || b !== 0);

    fc.assert(
      fc.property(vector, vector, (left, right) => {
        const score = semanticSimilarityBps(left, right);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(MEMORY_SCORE_BASIS_POINTS);
      }),
      { numRuns: 500 },
    );
  });
});

describe("exact per-agent memory retrieval", () => {
  it("ranks semantic relevance while preserving stable tie breaking", () => {
    const candidates = [
      memory("older-relevant", "Bob lost his job", 100, [1, 0]),
      memory("newer-relevant", "Bob discussed work", 200, [1, 0]),
      memory("unrelated", "Alice bought bread", 250, [0, 1]),
    ];

    const result = retrieveMemories(candidates, {
      now: simTime(300),
      modelId,
      queryEmbedding: [1, 0],
      limit: 3,
      recencyHalfLife: simDuration(1_000),
      weights: { semantic: 10_000, recency: 0, importance: 0, emotional: 0 },
    });

    expect(result.map((item) => String(item.memory.id))).toEqual([
      "newer-relevant",
      "older-relevant",
      "unrelated",
    ]);
  });

  it("lets importance and emotion outweigh a modest semantic advantage", () => {
    const candidates = [
      memory("ordinary", "A vaguely related event", 100, [1, 0], {
        importanceBps: 1_000,
        emotionalStrengthBps: 500,
      }),
      memory("important", "A major personal event", 100, [0.8, 0.2], {
        importanceBps: 10_000,
        emotionalStrengthBps: 10_000,
      }),
    ];

    const result = retrieveMemories(candidates, {
      now: simTime(100),
      modelId,
      queryEmbedding: [1, 0],
      limit: 2,
      recencyHalfLife: simDuration(100),
      weights: { semantic: 2_000, recency: 0, importance: 4_000, emotional: 4_000 },
    });

    expect(String(result[0]?.memory.id)).toBe("important");
  });

  it("applies category and related-entity filters before scoring", () => {
    const bob = asEntityId("person-bob");
    const carol = asEntityId("person-carol");
    const candidates = [
      memory("bob-social", "Bob helped Alice", 100, [1, 0], {
        category: "social",
        relatedEntityIds: [bob],
      }),
      memory("carol-social", "Carol helped Alice", 100, [1, 0], {
        category: "social",
        relatedEntityIds: [carol],
      }),
      memory("bob-semantic", "Bob works at the cafe", 100, [1, 0], {
        category: "semantic",
        relatedEntityIds: [bob],
      }),
    ];

    const result = retrieveMemories(candidates, {
      now: simTime(100),
      modelId,
      queryEmbedding: [1, 0],
      limit: 10,
      recencyHalfLife: simDuration(100),
      categories: ["social"],
      relatedEntityIds: [bob],
    });

    expect(result.map((item) => String(item.memory.id))).toEqual(["bob-social"]);
  });

  it("rejects dimension/model mismatches instead of silently comparing incompatible embeddings", () => {
    const candidate = memory("m1", "Memory", 100, [1, 0]);
    expect(() =>
      retrieveMemories([candidate], {
        now: simTime(100),
        modelId,
        queryEmbedding: [1, 0, 0],
        limit: 1,
        recencyHalfLife: simDuration(100),
      }),
    ).toThrow(/dimensions differ/i);

    expect(() =>
      retrieveMemories([candidate], {
        now: simTime(100),
        modelId: "different-model",
        queryEmbedding: [1, 0],
        limit: 1,
        recencyHalfLife: simDuration(100),
      }),
    ).toThrow(/model mismatch/i);
  });
});
