import {
  DomainInvariantError,
  asEntityId,
  asEventId,
  asWorldId,
  simTime,
  type EntityId,
  type EventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  applyRelationshipDelta,
  validateBelief,
  validatePerception,
  zeroRelationshipVector,
  type BeliefState,
  type PerceptionChannel,
  type PerceptionRecord,
  type RelationshipDelta,
  type RelationshipVector,
} from "@hobbo/social";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface PerceptionRow extends QueryResultRow {
  world_id: string;
  id: string;
  observer_id: string;
  observed_at: string;
  channel: PerceptionChannel;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  source_entity_id: string | null;
  source_event_id: string | null;
}

interface PerceptionComparisonRow extends PerceptionRow {
  same_value: boolean;
}

interface BeliefRow extends QueryResultRow {
  world_id: string;
  holder_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  learned_at: string;
  updated_at: string;
  source_perception_id: string | null;
}

interface BeliefComparisonRow extends BeliefRow {
  same_value: boolean;
}

interface RelationshipRow extends QueryResultRow {
  world_id: string;
  from_entity_id: string;
  to_entity_id: string;
  familiarity: number;
  trust: number;
  affection: number;
  respect: number;
  attraction: number;
  fear: number;
  resentment: number;
  dependency: number;
  updated_at: string;
  last_source_event_id: string | null;
}

interface RelationshipEffectRow extends QueryResultRow {
  world_id: string;
  effect_id: string;
  from_entity_id: string;
  to_entity_id: string;
  sim_time: string;
  delta: unknown;
  source_event_id: string | null;
  same_delta: boolean;
}

interface SourcePerceptionRow extends QueryResultRow {
  observer_id: string;
  observed_at: string;
}

export interface PersistedRelationship {
  readonly worldId: WorldId;
  readonly fromEntityId: EntityId;
  readonly toEntityId: EntityId;
  readonly vector: RelationshipVector;
  readonly updatedAt: SimTime;
  readonly lastSourceEventId?: EventId;
}

export interface RelationshipEffectInput {
  readonly worldId: WorldId;
  readonly effectId: string;
  readonly fromEntityId: EntityId;
  readonly toEntityId: EntityId;
  readonly at: SimTime;
  readonly delta: RelationshipDelta;
  readonly sourceEventId?: EventId;
}

const PERCEPTION_COLUMNS = `
  world_id, id, observer_id, observed_at, channel, subject_id, predicate,
  value, confidence_bps, source_entity_id, source_event_id
`;

const BELIEF_COLUMNS = `
  world_id, holder_id, subject_id, predicate, value, confidence_bps,
  learned_at, updated_at, source_perception_id
`;

const RELATIONSHIP_COLUMNS = `
  world_id, from_entity_id, to_entity_id,
  familiarity, trust, affection, respect, attraction,
  fear, resentment, dependency, updated_at, last_source_event_id
`;

const RELATIONSHIP_FIELDS = [
  "familiarity",
  "trust",
  "affection",
  "respect",
  "attraction",
  "fear",
  "resentment",
  "dependency",
] as const;

type RelationshipField = (typeof RELATIONSHIP_FIELDS)[number];
type NormalizedRelationshipDelta = Record<RelationshipField, number>;

function normalizeClaimPart(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return trimmed;
}

function mapPerception(row: PerceptionRow): PerceptionRecord {
  return {
    id: row.id,
    worldId: asWorldId(row.world_id),
    observerId: asEntityId(row.observer_id),
    observedAt: simTime(row.observed_at),
    channel: row.channel,
    subjectId: row.subject_id,
    predicate: row.predicate,
    value: row.value,
    confidenceBps: row.confidence_bps,
    ...(row.source_entity_id === null
      ? {}
      : { sourceEntityId: asEntityId(row.source_entity_id) }),
    ...(row.source_event_id === null
      ? {}
      : { sourceEventId: asEventId(row.source_event_id) }),
  };
}

function mapBelief(row: BeliefRow): BeliefState {
  return {
    worldId: asWorldId(row.world_id),
    holderId: asEntityId(row.holder_id),
    subjectId: row.subject_id,
    predicate: row.predicate,
    value: row.value,
    confidenceBps: row.confidence_bps,
    learnedAt: simTime(row.learned_at),
    updatedAt: simTime(row.updated_at),
    ...(row.source_perception_id === null
      ? {}
      : { sourcePerceptionId: row.source_perception_id }),
  };
}

function mapRelationship(row: RelationshipRow): PersistedRelationship {
  return {
    worldId: asWorldId(row.world_id),
    fromEntityId: asEntityId(row.from_entity_id),
    toEntityId: asEntityId(row.to_entity_id),
    vector: {
      familiarity: row.familiarity,
      trust: row.trust,
      affection: row.affection,
      respect: row.respect,
      attraction: row.attraction,
      fear: row.fear,
      resentment: row.resentment,
      dependency: row.dependency,
    },
    updatedAt: simTime(row.updated_at),
    ...(row.last_source_event_id === null
      ? {}
      : { lastSourceEventId: asEventId(row.last_source_event_id) }),
  };
}

function normalizeRelationshipDelta(
  delta: RelationshipDelta,
): NormalizedRelationshipDelta {
  const allowed = new Set<string>(RELATIONSHIP_FIELDS);
  for (const [field, value] of Object.entries(delta)) {
    if (!allowed.has(field)) {
      throw new DomainInvariantError(`Unknown relationship delta field: ${field}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new DomainInvariantError(
        `Relationship delta ${field} must be a safe integer`,
      );
    }
  }

  const normalized = Object.fromEntries(
    RELATIONSHIP_FIELDS.map((field) => [field, delta[field] ?? 0]),
  ) as NormalizedRelationshipDelta;

  // Reuse the pure-domain validation path without changing state.
  applyRelationshipDelta(zeroRelationshipVector(), normalized);
  return normalized;
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

async function assertSourcePerception(
  client: PoolClient,
  worldId: WorldId,
  holderId: EntityId,
  sourcePerceptionId: string | undefined,
  beliefUpdatedAt: SimTime,
): Promise<void> {
  if (sourcePerceptionId === undefined) return;

  const result = await client.query<SourcePerceptionRow>(
    `SELECT observer_id, observed_at
       FROM perceptions
      WHERE world_id = $1 AND id = $2`,
    [worldId, sourcePerceptionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(
      `Source perception does not exist: ${sourcePerceptionId}`,
    );
  }
  if (row.observer_id !== holderId) {
    throw new DomainInvariantError(
      `Perception ${sourcePerceptionId} belongs to ${row.observer_id}, not belief holder ${holderId}`,
    );
  }
  if (BigInt(row.observed_at) > BigInt(beliefUpdatedAt)) {
    throw new DomainInvariantError(
      `Belief cannot cite future perception ${sourcePerceptionId}`,
    );
  }
}

async function loadRelationship(
  client: Pool | PoolClient,
  worldId: WorldId,
  fromEntityId: EntityId,
  toEntityId: EntityId,
  forUpdate = false,
): Promise<PersistedRelationship | undefined> {
  const result = await client.query<RelationshipRow>(
    `SELECT ${RELATIONSHIP_COLUMNS}
       FROM relationships
      WHERE world_id = $1
        AND from_entity_id = $2
        AND to_entity_id = $3
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [worldId, fromEntityId, toEntityId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapRelationship(row);
}

export class PostgresSocialRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async recordPerception(perception: PerceptionRecord): Promise<PerceptionRecord> {
    validatePerception(perception);
    const subjectId = normalizeClaimPart(perception.subjectId, "Perception subject");
    const predicate = normalizeClaimPart(perception.predicate, "Perception predicate");
    const valueJson = toJsonParameter(
      perception.value,
      `perception ${perception.id} value`,
    );

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(
          client,
          "social-perception",
          `${perception.worldId}:${perception.id}`,
        );

        const existing = await client.query<PerceptionComparisonRow>(
          `SELECT ${PERCEPTION_COLUMNS}, value = $3::jsonb AS same_value
             FROM perceptions
            WHERE world_id = $1 AND id = $2`,
          [perception.worldId, perception.id, valueJson],
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) {
          const same =
            existingRow.observer_id === perception.observerId &&
            BigInt(existingRow.observed_at) === BigInt(perception.observedAt) &&
            existingRow.channel === perception.channel &&
            existingRow.subject_id === subjectId &&
            existingRow.predicate === predicate &&
            existingRow.same_value &&
            existingRow.confidence_bps === perception.confidenceBps &&
            existingRow.source_entity_id === (perception.sourceEntityId ?? null) &&
            existingRow.source_event_id === (perception.sourceEventId ?? null);
          if (!same) {
            throw new DomainInvariantError(
              `Perception id ${perception.id} was already used for different evidence`,
            );
          }
          return mapPerception(existingRow);
        }

        const inserted = await client.query<PerceptionRow>(
          `INSERT INTO perceptions (
             world_id, id, observer_id, observed_at, channel,
             subject_id, predicate, value, confidence_bps,
             source_entity_id, source_event_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${PERCEPTION_COLUMNS}`,
          [
            perception.worldId,
            perception.id,
            perception.observerId,
            perception.observedAt.toString(),
            perception.channel,
            subjectId,
            predicate,
            valueJson,
            perception.confidenceBps,
            perception.sourceEntityId ?? null,
            perception.sourceEventId ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(
            `Perception insert returned no row: ${perception.id}`,
          );
        }
        return mapPerception(row);
      },
      "read committed",
    );
  }

  async listPerceptions(
    worldId: WorldId,
    observerId: EntityId,
  ): Promise<readonly PerceptionRecord[]> {
    const result = await this.#pool.query<PerceptionRow>(
      `SELECT ${PERCEPTION_COLUMNS}
         FROM perceptions
        WHERE world_id = $1 AND observer_id = $2
        ORDER BY observed_at ASC, id ASC`,
      [worldId, observerId],
    );
    return result.rows.map(mapPerception);
  }

  async getBelief(
    worldId: WorldId,
    holderId: EntityId,
    subjectId: string,
    predicate: string,
  ): Promise<BeliefState | undefined> {
    const normalizedSubject = normalizeClaimPart(subjectId, "Belief subject");
    const normalizedPredicate = normalizeClaimPart(predicate, "Belief predicate");
    const result = await this.#pool.query<BeliefRow>(
      `SELECT ${BELIEF_COLUMNS}
         FROM beliefs
        WHERE world_id = $1
          AND holder_id = $2
          AND subject_id = $3
          AND predicate = $4`,
      [worldId, holderId, normalizedSubject, normalizedPredicate],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapBelief(row);
  }

  async listBeliefs(
    worldId: WorldId,
    holderId: EntityId,
  ): Promise<readonly BeliefState[]> {
    const result = await this.#pool.query<BeliefRow>(
      `SELECT ${BELIEF_COLUMNS}
         FROM beliefs
        WHERE world_id = $1 AND holder_id = $2
        ORDER BY updated_at ASC, subject_id ASC, predicate ASC`,
      [worldId, holderId],
    );
    return result.rows.map(mapBelief);
  }

  async putBelief(belief: BeliefState): Promise<BeliefState> {
    validateBelief(belief);
    const subjectId = normalizeClaimPart(belief.subjectId, "Belief subject");
    const predicate = normalizeClaimPart(belief.predicate, "Belief predicate");
    const valueJson = toJsonParameter(
      belief.value,
      `belief ${belief.holderId}:${subjectId}:${predicate} value`,
    );
    const lockKey = `${belief.worldId}:${belief.holderId}:${subjectId}:${predicate}`;

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(client, "social-belief", lockKey);

        const existing = await client.query<BeliefComparisonRow>(
          `SELECT ${BELIEF_COLUMNS}, value = $5::jsonb AS same_value
             FROM beliefs
            WHERE world_id = $1
              AND holder_id = $2
              AND subject_id = $3
              AND predicate = $4
            FOR UPDATE`,
          [belief.worldId, belief.holderId, subjectId, predicate, valueJson],
        );
        const existingRow = existing.rows[0];

        if (existingRow !== undefined) {
          const existingUpdatedAt = BigInt(existingRow.updated_at);
          const incomingUpdatedAt = BigInt(belief.updatedAt);
          if (incomingUpdatedAt < existingUpdatedAt) {
            throw new DomainInvariantError(
              `Belief update is stale: ${belief.updatedAt} < ${existingRow.updated_at}`,
            );
          }

          if (incomingUpdatedAt === existingUpdatedAt) {
            const same =
              existingRow.same_value &&
              existingRow.confidence_bps === belief.confidenceBps &&
              BigInt(existingRow.learned_at) === BigInt(belief.learnedAt) &&
              existingRow.source_perception_id ===
                (belief.sourcePerceptionId ?? null);
            if (!same) {
              throw new DomainInvariantError(
                `Conflicting belief revision at simulation time ${belief.updatedAt}`,
              );
            }
            return mapBelief(existingRow);
          }

          if (BigInt(existingRow.learned_at) !== BigInt(belief.learnedAt)) {
            throw new DomainInvariantError(
              "Belief learnedAt is immutable after first persistence",
            );
          }

          await assertSourcePerception(
            client,
            belief.worldId,
            belief.holderId,
            belief.sourcePerceptionId,
            belief.updatedAt,
          );

          const updated = await client.query<BeliefRow>(
            `UPDATE beliefs
                SET value = $5,
                    confidence_bps = $6,
                    updated_at = $7,
                    source_perception_id = $8,
                    persisted_at = now()
              WHERE world_id = $1
                AND holder_id = $2
                AND subject_id = $3
                AND predicate = $4
            RETURNING ${BELIEF_COLUMNS}`,
            [
              belief.worldId,
              belief.holderId,
              subjectId,
              predicate,
              valueJson,
              belief.confidenceBps,
              belief.updatedAt.toString(),
              belief.sourcePerceptionId ?? null,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined) {
            throw new DomainInvariantError("Belief update returned no row");
          }
          return mapBelief(row);
        }

        await assertSourcePerception(
          client,
          belief.worldId,
          belief.holderId,
          belief.sourcePerceptionId,
          belief.updatedAt,
        );

        const inserted = await client.query<BeliefRow>(
          `INSERT INTO beliefs (
             world_id, holder_id, subject_id, predicate, value,
             confidence_bps, learned_at, updated_at, source_perception_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${BELIEF_COLUMNS}`,
          [
            belief.worldId,
            belief.holderId,
            subjectId,
            predicate,
            valueJson,
            belief.confidenceBps,
            belief.learnedAt.toString(),
            belief.updatedAt.toString(),
            belief.sourcePerceptionId ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError("Belief insert returned no row");
        }
        return mapBelief(row);
      },
      "read committed",
    );
  }

  async getRelationship(
    worldId: WorldId,
    fromEntityId: EntityId,
    toEntityId: EntityId,
  ): Promise<PersistedRelationship | undefined> {
    return loadRelationship(
      this.#pool,
      worldId,
      fromEntityId,
      toEntityId,
    );
  }

  async listRelationshipsFrom(
    worldId: WorldId,
    fromEntityId: EntityId,
  ): Promise<readonly PersistedRelationship[]> {
    const result = await this.#pool.query<RelationshipRow>(
      `SELECT ${RELATIONSHIP_COLUMNS}
         FROM relationships
        WHERE world_id = $1 AND from_entity_id = $2
        ORDER BY to_entity_id ASC`,
      [worldId, fromEntityId],
    );
    return result.rows.map(mapRelationship);
  }

  async applyRelationshipEffect(
    input: RelationshipEffectInput,
  ): Promise<PersistedRelationship> {
    const effectId = input.effectId.trim();
    if (effectId.length === 0) {
      throw new DomainInvariantError("Relationship effect id cannot be blank");
    }
    if (input.fromEntityId === input.toEntityId) {
      throw new DomainInvariantError("Relationship endpoints must differ");
    }

    const delta = normalizeRelationshipDelta(input.delta);
    const deltaJson = toJsonParameter(delta, `relationship effect ${effectId} delta`);

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(
          client,
          "social-relationship-effect",
          `${input.worldId}:${effectId}`,
        );

        const existingEffect = await client.query<RelationshipEffectRow>(
          `SELECT world_id, effect_id, from_entity_id, to_entity_id,
                  sim_time, delta, source_event_id,
                  delta = $3::jsonb AS same_delta
             FROM relationship_effects
            WHERE world_id = $1 AND effect_id = $2`,
          [input.worldId, effectId, deltaJson],
        );
        const effectRow = existingEffect.rows[0];
        if (effectRow !== undefined) {
          const same =
            effectRow.from_entity_id === input.fromEntityId &&
            effectRow.to_entity_id === input.toEntityId &&
            BigInt(effectRow.sim_time) === BigInt(input.at) &&
            effectRow.source_event_id === (input.sourceEventId ?? null) &&
            effectRow.same_delta;
          if (!same) {
            throw new DomainInvariantError(
              `Relationship effect id ${effectId} was already used for a different effect`,
            );
          }

          const current = await loadRelationship(
            client,
            input.worldId,
            input.fromEntityId,
            input.toEntityId,
          );
          if (current === undefined) {
            throw new DomainInvariantError(
              `Relationship effect ${effectId} exists without relationship state`,
            );
          }
          return current;
        }

        await advisoryLock(
          client,
          "social-relationship-pair",
          `${input.worldId}:${input.fromEntityId}:${input.toEntityId}`,
        );

        const current = await loadRelationship(
          client,
          input.worldId,
          input.fromEntityId,
          input.toEntityId,
          true,
        );
        if (
          current !== undefined &&
          BigInt(input.at) < BigInt(current.updatedAt)
        ) {
          throw new DomainInvariantError(
            `Relationship effect is stale: ${input.at} < ${current.updatedAt}`,
          );
        }

        const nextVector = applyRelationshipDelta(
          current?.vector ?? zeroRelationshipVector(),
          delta,
        );

        await client.query(
          `INSERT INTO relationship_effects (
             world_id, effect_id, from_entity_id, to_entity_id,
             sim_time, delta, source_event_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.worldId,
            effectId,
            input.fromEntityId,
            input.toEntityId,
            input.at.toString(),
            deltaJson,
            input.sourceEventId ?? null,
          ],
        );

        const persisted = await client.query<RelationshipRow>(
          `INSERT INTO relationships (
             world_id, from_entity_id, to_entity_id,
             familiarity, trust, affection, respect, attraction,
             fear, resentment, dependency, updated_at, last_source_event_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (world_id, from_entity_id, to_entity_id)
           DO UPDATE SET
             familiarity = EXCLUDED.familiarity,
             trust = EXCLUDED.trust,
             affection = EXCLUDED.affection,
             respect = EXCLUDED.respect,
             attraction = EXCLUDED.attraction,
             fear = EXCLUDED.fear,
             resentment = EXCLUDED.resentment,
             dependency = EXCLUDED.dependency,
             updated_at = EXCLUDED.updated_at,
             last_source_event_id = EXCLUDED.last_source_event_id,
             persisted_at = now()
           RETURNING ${RELATIONSHIP_COLUMNS}`,
          [
            input.worldId,
            input.fromEntityId,
            input.toEntityId,
            nextVector.familiarity,
            nextVector.trust,
            nextVector.affection,
            nextVector.respect,
            nextVector.attraction,
            nextVector.fear,
            nextVector.resentment,
            nextVector.dependency,
            input.at.toString(),
            input.sourceEventId ?? null,
          ],
        );
        const row = persisted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError("Relationship persistence returned no row");
        }
        return mapRelationship(row);
      },
      "read committed",
    );
  }
}
