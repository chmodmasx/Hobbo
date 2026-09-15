import {
  DomainInvariantError,
  asEntityId,
  asEventId,
  asMemoryId,
  asWorldId,
  simTime,
  type EntityId,
  type MemoryId,
  type WorldId,
} from "@hobbo/domain";
import {
  retrieveMemories,
  validateMemoryEmbedding,
  validateMemoryRecord,
  type EmbeddedMemory,
  type MemoryEmbedding,
  type MemoryRecord,
  type MemoryRetrievalQuery,
  type ScoredMemory,
} from "@hobbo/memory";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface MemoryRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  category: MemoryRecord["category"];
  occurred_at: string;
  content: string;
  importance_bps: number;
  emotional_strength_bps: number;
  related_entity_ids: string[];
  source_event_id: string | null;
  metadata: unknown | null;
}

interface MemoryComparisonRow extends MemoryRow {
  same_related: boolean;
  same_metadata: boolean;
}

interface MemoryEmbeddingRow extends QueryResultRow {
  world_id: string;
  memory_id: string;
  model_id: string;
  dimensions: number;
  embedding: number[];
}

interface MemoryEmbeddingComparisonRow extends MemoryEmbeddingRow {
  same_embedding: boolean;
}

interface EmbeddedMemoryRow extends MemoryRow {
  model_id: string;
  dimensions: number;
  embedding: number[];
}

const MEMORY_COLUMNS = `
  world_id, id, owner_id, category, occurred_at, content,
  importance_bps, emotional_strength_bps, related_entity_ids,
  source_event_id, metadata
`;

const EMBEDDING_COLUMNS = `
  world_id, memory_id, model_id, dimensions, embedding
`;

function canonicalRelatedEntityIds(
  ids: readonly EntityId[],
): readonly EntityId[] {
  return [...ids]
    .map(String)
    .sort((left, right) => left.localeCompare(right))
    .map(asEntityId);
}

function canonicalMemory(memory: MemoryRecord): MemoryRecord {
  return {
    ...memory,
    relatedEntityIds: canonicalRelatedEntityIds(memory.relatedEntityIds),
  };
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: asMemoryId(row.id),
    worldId: asWorldId(row.world_id),
    ownerId: asEntityId(row.owner_id),
    category: row.category,
    occurredAt: simTime(row.occurred_at),
    content: row.content,
    importanceBps: row.importance_bps,
    emotionalStrengthBps: row.emotional_strength_bps,
    relatedEntityIds: row.related_entity_ids.map(asEntityId),
    ...(row.source_event_id === null
      ? {}
      : { sourceEventId: asEventId(row.source_event_id) }),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  };
}

function mapEmbedding(row: MemoryEmbeddingRow): MemoryEmbedding {
  if (row.embedding.length !== row.dimensions) {
    throw new DomainInvariantError(
      `Persisted embedding dimension mismatch for ${row.memory_id}:${row.model_id}`,
    );
  }
  const embedding: MemoryEmbedding = {
    memoryId: asMemoryId(row.memory_id),
    modelId: row.model_id,
    vector: row.embedding,
  };
  validateMemoryEmbedding(embedding);
  return embedding;
}

function mapEmbeddedMemory(row: EmbeddedMemoryRow): EmbeddedMemory {
  return {
    memory: mapMemory(row),
    embedding: mapEmbedding({
      world_id: row.world_id,
      memory_id: row.id,
      model_id: row.model_id,
      dimensions: row.dimensions,
      embedding: row.embedding,
    } as MemoryEmbeddingRow),
  };
}

async function advisoryLock(
  client: PoolClient,
  namespace: string,
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${namespace}:${key}`],
  );
}

export class PostgresMemoryRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    validateMemoryRecord(memory);
    const canonical = canonicalMemory(memory);
    const related = canonical.relatedEntityIds.map(String);
    const metadataJson =
      canonical.metadata === undefined
        ? null
        : toJsonParameter(canonical.metadata, `memory ${canonical.id} metadata`);

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(
          client,
          "memory",
          `${canonical.worldId}:${canonical.id}`,
        );

        const existing = await client.query<MemoryComparisonRow>(
          `SELECT ${MEMORY_COLUMNS},
                  related_entity_ids = $3::text[] AS same_related,
                  metadata IS NOT DISTINCT FROM $4::jsonb AS same_metadata
             FROM memories
            WHERE world_id = $1 AND id = $2`,
          [canonical.worldId, canonical.id, related, metadataJson],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          const same =
            row.owner_id === canonical.ownerId &&
            row.category === canonical.category &&
            BigInt(row.occurred_at) === BigInt(canonical.occurredAt) &&
            row.content === canonical.content &&
            row.importance_bps === canonical.importanceBps &&
            row.emotional_strength_bps === canonical.emotionalStrengthBps &&
            row.same_related &&
            row.source_event_id === (canonical.sourceEventId ?? null) &&
            row.same_metadata;
          if (!same) {
            throw new DomainInvariantError(
              `Memory id ${canonical.id} was already used for different content`,
            );
          }
          return mapMemory(row);
        }

        const inserted = await client.query<MemoryRow>(
          `INSERT INTO memories (
             world_id, id, owner_id, category, occurred_at, content,
             importance_bps, emotional_strength_bps, related_entity_ids,
             source_event_id, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${MEMORY_COLUMNS}`,
          [
            canonical.worldId,
            canonical.id,
            canonical.ownerId,
            canonical.category,
            canonical.occurredAt.toString(),
            canonical.content,
            canonical.importanceBps,
            canonical.emotionalStrengthBps,
            related,
            canonical.sourceEventId ?? null,
            metadataJson,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow === undefined) {
          throw new DomainInvariantError(
            `Memory insert returned no row: ${canonical.id}`,
          );
        }
        return mapMemory(insertedRow);
      },
      "read committed",
    );
  }

  async getMemory(
    worldId: WorldId,
    memoryId: MemoryId,
  ): Promise<MemoryRecord | undefined> {
    const result = await this.#pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
         FROM memories
        WHERE world_id = $1 AND id = $2`,
      [worldId, memoryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapMemory(row);
  }

  async listMemories(
    worldId: WorldId,
    ownerId: EntityId,
  ): Promise<readonly MemoryRecord[]> {
    const result = await this.#pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
         FROM memories
        WHERE world_id = $1 AND owner_id = $2
        ORDER BY occurred_at ASC, id ASC`,
      [worldId, ownerId],
    );
    return result.rows.map(mapMemory);
  }

  async putEmbedding(
    worldId: WorldId,
    embedding: MemoryEmbedding,
  ): Promise<MemoryEmbedding> {
    validateMemoryEmbedding(embedding);
    const modelId = embedding.modelId.trim();
    if (modelId !== embedding.modelId) {
      throw new DomainInvariantError(
        "Embedding model id cannot have leading or trailing whitespace",
      );
    }
    const vector = [...embedding.vector];

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(
          client,
          "memory-embedding",
          `${worldId}:${embedding.memoryId}:${modelId}`,
        );

        const memoryExists = await client.query(
          `SELECT 1 FROM memories WHERE world_id = $1 AND id = $2`,
          [worldId, embedding.memoryId],
        );
        if (memoryExists.rowCount !== 1) {
          throw new DomainInvariantError(
            `Memory does not exist: ${embedding.memoryId}`,
          );
        }

        const existing = await client.query<MemoryEmbeddingComparisonRow>(
          `SELECT ${EMBEDDING_COLUMNS}, embedding = $4::double precision[] AS same_embedding
             FROM memory_embeddings
            WHERE world_id = $1 AND memory_id = $2 AND model_id = $3`,
          [worldId, embedding.memoryId, modelId, vector],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          if (!row.same_embedding || row.dimensions !== vector.length) {
            throw new DomainInvariantError(
              `Embedding ${embedding.memoryId}:${modelId} already exists with different vector data`,
            );
          }
          return mapEmbedding(row);
        }

        const inserted = await client.query<MemoryEmbeddingRow>(
          `INSERT INTO memory_embeddings (
             world_id, memory_id, model_id, dimensions, embedding
           ) VALUES ($1,$2,$3,$4,$5)
           RETURNING ${EMBEDDING_COLUMNS}`,
          [worldId, embedding.memoryId, modelId, vector.length, vector],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow === undefined) {
          throw new DomainInvariantError(
            `Embedding insert returned no row: ${embedding.memoryId}:${modelId}`,
          );
        }
        return mapEmbedding(insertedRow);
      },
      "read committed",
    );
  }

  async getEmbedding(
    worldId: WorldId,
    memoryId: MemoryId,
    modelId: string,
  ): Promise<MemoryEmbedding | undefined> {
    const result = await this.#pool.query<MemoryEmbeddingRow>(
      `SELECT ${EMBEDDING_COLUMNS}
         FROM memory_embeddings
        WHERE world_id = $1 AND memory_id = $2 AND model_id = $3`,
      [worldId, memoryId, modelId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapEmbedding(row);
  }

  async retrieve(input: {
    readonly worldId: WorldId;
    readonly ownerId: EntityId;
    readonly query: MemoryRetrievalQuery;
  }): Promise<readonly ScoredMemory[]> {
    const categories =
      input.query.categories === undefined ? null : [...input.query.categories];
    const related =
      input.query.relatedEntityIds === undefined
        ? null
        : input.query.relatedEntityIds.map(String);

    const result = await this.#pool.query<EmbeddedMemoryRow>(
      `SELECT
         m.world_id, m.id, m.owner_id, m.category, m.occurred_at, m.content,
         m.importance_bps, m.emotional_strength_bps, m.related_entity_ids,
         m.source_event_id, m.metadata,
         e.model_id, e.dimensions, e.embedding
       FROM memories AS m
       JOIN memory_embeddings AS e
         ON e.world_id = m.world_id
        AND e.memory_id = m.id
      WHERE m.world_id = $1
        AND m.owner_id = $2
        AND e.model_id = $3
        AND m.occurred_at <= $4
        AND ($5::text[] IS NULL OR m.category = ANY($5::text[]))
        AND ($6::text[] IS NULL OR m.related_entity_ids && $6::text[])
      ORDER BY m.occurred_at ASC, m.id ASC`,
      [
        input.worldId,
        input.ownerId,
        input.query.modelId,
        input.query.now.toString(),
        categories,
        related,
      ],
    );

    const candidates = result.rows.map(mapEmbeddedMemory);
    return retrieveMemories(candidates, input.query);
  }
}
