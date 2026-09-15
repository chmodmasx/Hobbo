import {
  DomainInvariantError,
  type EntityId,
  type EventId,
  type MemoryId,
  type SimDuration,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";

export const MEMORY_SCORE_BASIS_POINTS = 10_000;

export type MemoryCategory =
  | "episodic"
  | "semantic"
  | "social"
  | "emotional"
  | "commitment"
  | "reflection"
  | "autobiographical";

export interface MemoryRecord {
  readonly id: MemoryId;
  readonly worldId: WorldId;
  readonly ownerId: EntityId;
  readonly category: MemoryCategory;
  readonly occurredAt: SimTime;
  readonly content: string;
  readonly importanceBps: number;
  readonly emotionalStrengthBps: number;
  readonly relatedEntityIds: readonly EntityId[];
  readonly sourceEventId?: EventId;
  readonly metadata?: unknown;
}

export interface MemoryEmbedding {
  readonly memoryId: MemoryId;
  readonly modelId: string;
  readonly vector: readonly number[];
}

export interface EmbeddedMemory {
  readonly memory: MemoryRecord;
  readonly embedding: MemoryEmbedding;
}

export interface RetrievalWeights {
  readonly semantic: number;
  readonly recency: number;
  readonly importance: number;
  readonly emotional: number;
}

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  semantic: 5_000,
  recency: 2_000,
  importance: 2_000,
  emotional: 1_000,
};

export interface MemoryRetrievalQuery {
  readonly now: SimTime;
  readonly modelId: string;
  readonly queryEmbedding: readonly number[];
  readonly limit: number;
  readonly recencyHalfLife: SimDuration;
  readonly weights?: RetrievalWeights;
  readonly categories?: readonly MemoryCategory[];
  /** If supplied, at least one related entity must overlap. */
  readonly relatedEntityIds?: readonly EntityId[];
}

export interface MemoryScoreComponents {
  readonly semanticBps: number;
  readonly recencyBps: number;
  readonly importanceBps: number;
  readonly emotionalBps: number;
}

export interface ScoredMemory {
  readonly memory: MemoryRecord;
  readonly scoreBps: number;
  readonly components: MemoryScoreComponents;
}

function assertBasisPoints(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MEMORY_SCORE_BASIS_POINTS
  ) {
    throw new DomainInvariantError(
      `${label} must be an integer between 0 and ${MEMORY_SCORE_BASIS_POINTS}`,
    );
  }
}

function assertEmbedding(vector: readonly number[], label: string): void {
  if (vector.length === 0) {
    throw new DomainInvariantError(`${label} cannot be empty`);
  }
  let normSquared = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new DomainInvariantError(`${label} must contain only finite numbers`);
    }
    normSquared += component * component;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw new DomainInvariantError(`${label} must have a non-zero finite norm`);
  }
}

function assertWeights(weights: RetrievalWeights): void {
  let total = 0;
  for (const [label, value] of Object.entries(weights)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainInvariantError(
        `Retrieval weight ${label} must be a non-negative safe integer`,
      );
    }
    total += value;
  }
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new DomainInvariantError("At least one retrieval weight must be positive");
  }
}

export function validateMemoryRecord(memory: MemoryRecord): void {
  if (String(memory.id).trim().length === 0) {
    throw new DomainInvariantError("Memory id cannot be blank");
  }
  if (String(memory.ownerId).trim().length === 0) {
    throw new DomainInvariantError("Memory owner cannot be blank");
  }
  if (memory.content.trim().length === 0) {
    throw new DomainInvariantError("Memory content cannot be blank");
  }
  assertBasisPoints(memory.importanceBps, "Memory importance");
  assertBasisPoints(memory.emotionalStrengthBps, "Memory emotional strength");

  const related = new Set(memory.relatedEntityIds.map(String));
  if (related.size !== memory.relatedEntityIds.length) {
    throw new DomainInvariantError("Memory related entities cannot contain duplicates");
  }
}

export function validateMemoryEmbedding(embedding: MemoryEmbedding): void {
  if (String(embedding.memoryId).trim().length === 0) {
    throw new DomainInvariantError("Embedding memory id cannot be blank");
  }
  if (embedding.modelId.trim().length === 0) {
    throw new DomainInvariantError("Embedding model id cannot be blank");
  }
  assertEmbedding(embedding.vector, "Memory embedding");
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  assertEmbedding(left, "Left embedding");
  assertEmbedding(right, "Right embedding");
  if (left.length !== right.length) {
    throw new DomainInvariantError(
      `Embedding dimensions differ: ${left.length} != ${right.length}`,
    );
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new DomainInvariantError("Embedding cosine denominator is invalid");
  }
  const cosine = dot / denominator;
  return Math.max(-1, Math.min(1, cosine));
}

export function semanticSimilarityBps(
  left: readonly number[],
  right: readonly number[],
): number {
  const cosine = cosineSimilarity(left, right);
  return Math.max(
    0,
    Math.min(
      MEMORY_SCORE_BASIS_POINTS,
      Math.round(((cosine + 1) / 2) * MEMORY_SCORE_BASIS_POINTS),
    ),
  );
}

export function recencyScoreBps(
  occurredAt: SimTime,
  now: SimTime,
  halfLife: SimDuration,
): number {
  if (halfLife <= 0n) {
    throw new DomainInvariantError("Recency half-life must be greater than zero");
  }
  if (occurredAt > now) {
    throw new DomainInvariantError(
      `Memory occurs in the future (${occurredAt} > ${now})`,
    );
  }

  const age = BigInt(now) - BigInt(occurredAt);
  const numerator = BigInt(MEMORY_SCORE_BASIS_POINTS) * BigInt(halfLife);
  return Number(numerator / (BigInt(halfLife) + age));
}

export function scoreEmbeddedMemory(
  candidate: EmbeddedMemory,
  query: MemoryRetrievalQuery,
): ScoredMemory {
  validateMemoryRecord(candidate.memory);
  validateMemoryEmbedding(candidate.embedding);
  assertEmbedding(query.queryEmbedding, "Query embedding");
  if (candidate.embedding.memoryId !== candidate.memory.id) {
    throw new DomainInvariantError(
      `Embedding ${candidate.embedding.memoryId} does not belong to memory ${candidate.memory.id}`,
    );
  }
  if (candidate.embedding.modelId !== query.modelId) {
    throw new DomainInvariantError(
      `Embedding model mismatch: ${candidate.embedding.modelId} != ${query.modelId}`,
    );
  }

  const weights = query.weights ?? DEFAULT_RETRIEVAL_WEIGHTS;
  assertWeights(weights);
  const components: MemoryScoreComponents = {
    semanticBps: semanticSimilarityBps(
      candidate.embedding.vector,
      query.queryEmbedding,
    ),
    recencyBps: recencyScoreBps(
      candidate.memory.occurredAt,
      query.now,
      query.recencyHalfLife,
    ),
    importanceBps: candidate.memory.importanceBps,
    emotionalBps: candidate.memory.emotionalStrengthBps,
  };

  const weighted =
    BigInt(components.semanticBps) * BigInt(weights.semantic) +
    BigInt(components.recencyBps) * BigInt(weights.recency) +
    BigInt(components.importanceBps) * BigInt(weights.importance) +
    BigInt(components.emotionalBps) * BigInt(weights.emotional);
  const totalWeight = BigInt(
    weights.semantic + weights.recency + weights.importance + weights.emotional,
  );

  return {
    memory: candidate.memory,
    scoreBps: Number(weighted / totalWeight),
    components,
  };
}

function matchesFilters(
  memory: MemoryRecord,
  query: MemoryRetrievalQuery,
): boolean {
  if (
    query.categories !== undefined &&
    !query.categories.includes(memory.category)
  ) {
    return false;
  }

  if (query.relatedEntityIds !== undefined) {
    const requested = new Set(query.relatedEntityIds.map(String));
    if (!memory.relatedEntityIds.some((id) => requested.has(String(id)))) {
      return false;
    }
  }
  return true;
}

export function retrieveMemories(
  candidates: readonly EmbeddedMemory[],
  query: MemoryRetrievalQuery,
): readonly ScoredMemory[] {
  if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
    throw new DomainInvariantError("Memory retrieval limit must be a positive safe integer");
  }
  if (query.modelId.trim().length === 0) {
    throw new DomainInvariantError("Memory retrieval model id cannot be blank");
  }
  assertEmbedding(query.queryEmbedding, "Query embedding");
  assertWeights(query.weights ?? DEFAULT_RETRIEVAL_WEIGHTS);

  return candidates
    .filter((candidate) => matchesFilters(candidate.memory, query))
    .map((candidate) => scoreEmbeddedMemory(candidate, query))
    .sort((left, right) => {
      if (left.scoreBps !== right.scoreBps) {
        return right.scoreBps - left.scoreBps;
      }
      if (left.memory.occurredAt !== right.memory.occurredAt) {
        return left.memory.occurredAt > right.memory.occurredAt ? -1 : 1;
      }
      return String(left.memory.id).localeCompare(String(right.memory.id));
    })
    .slice(0, query.limit);
}
