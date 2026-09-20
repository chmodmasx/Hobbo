import {
  DomainInvariantError,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import { entityAffinityKey } from "@hobbo/simulation";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTransaction } from "./transaction.ts";

const DEFAULT_TRACE_LIMIT = 50;
const MAX_TRACE_LIMIT = 100;
const MAX_TRACE_OFFSET = 100_000;

export interface TracePageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface TracePage {
  readonly limit: number;
  readonly offset: number;
}

export interface TraceInventoryKind {
  readonly kind: string;
  readonly total: string;
  readonly available: string;
  readonly consumed: string;
}

export interface TracePersonState {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly hunger: {
    readonly value: number;
    readonly recordedAt: string;
    readonly ratePerHour: number;
  };
  readonly energy: {
    readonly value: number;
    readonly recordedAt: string;
    readonly mode: string;
    readonly awakeDrainPerHour: number;
    readonly sleepRecoveryPerHour: number;
  };
  readonly mealsEaten: number;
  readonly sleepSessions: number;
  readonly inventory: {
    readonly total: string;
    readonly available: string;
    readonly consumed: string;
    readonly byKind: readonly TraceInventoryKind[];
  };
}

export interface TraceDomainEvent {
  readonly sequence: string;
  readonly id: string;
  readonly simTime: string;
  readonly type: string;
  readonly actorId?: string;
  readonly targetIds: readonly string[];
  readonly payload: unknown;
  readonly causationId?: string;
  readonly correlationId: string;
}

export interface TraceScheduledEvent {
  readonly id: string;
  readonly dueAt: string;
  readonly ordinal: string;
  readonly type: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly affinityKeys: readonly string[];
  readonly status: string;
  readonly attempts: number;
  readonly lockedBy?: string;
  readonly lockedAt?: string;
}

export interface TraceBelief {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
  readonly learnedAt: string;
  readonly updatedAt: string;
  readonly sourcePerceptionId?: string;
}

export interface TraceMemory {
  readonly id: string;
  readonly category: string;
  readonly occurredAt: string;
  readonly content: string;
  readonly importanceBps: number;
  readonly emotionalStrengthBps: number;
  readonly relatedEntityIds: readonly string[];
  readonly sourceEventId?: string;
  readonly metadata?: unknown;
}

export interface TraceRelationship {
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly familiarity: number;
  readonly trust: number;
  readonly affection: number;
  readonly respect: number;
  readonly attraction: number;
  readonly fear: number;
  readonly resentment: number;
  readonly dependency: number;
  readonly updatedAt: string;
  readonly lastSourceEventId?: string;
}

export interface TraceConversationStatement {
  readonly id: string;
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
  readonly origin: string;
  readonly sourceStatementId?: string;
  readonly claimedSourceEntityId?: string;
  readonly hopCount: number;
}

export interface TraceConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly ordinal: number;
  readonly speakerId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly sourceEventId?: string;
  readonly statements: readonly TraceConversationStatement[];
}

export interface TraceCognitionRun {
  readonly requestId: string;
  readonly actorId: string;
  readonly simTime: string;
  readonly correlationId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly requestHash: string;
  readonly decision?: unknown;
  readonly status: string;
  readonly replayAvailable: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
  readonly errorMessage?: string;
}

export interface PersonTraceSnapshot {
  readonly worldId: string;
  readonly currentSimTime: string;
  readonly page: TracePage;
  readonly person: TracePersonState;
  readonly events: readonly TraceDomainEvent[];
  readonly scheduledEvents: readonly TraceScheduledEvent[];
  readonly beliefs: readonly TraceBelief[];
  readonly memories: readonly TraceMemory[];
  readonly relationships: readonly TraceRelationship[];
  readonly conversationMessages: readonly TraceConversationMessage[];
  readonly cognitionRuns: readonly TraceCognitionRun[];
}

interface PersonRow extends QueryResultRow {
  world_id: string;
  current_sim_time: string;
  person_id: string;
  created_at_sim: string;
  hunger_value: number;
  hunger_recorded_at: string;
  hunger_rate_per_hour: number;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: string;
  awake_drain_per_hour: number;
  sleep_recovery_per_hour: number;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
  version: string;
}

interface InventorySummaryRow extends QueryResultRow {
  kind: string;
  total: string;
  available: string;
  consumed: string;
}

interface EventRow extends QueryResultRow {
  sequence: string;
  id: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  target_ids: string[] | null;
  payload: unknown;
  causation_id: string | null;
  correlation_id: string;
}

interface ScheduledRow extends QueryResultRow {
  id: string;
  due_at: string;
  ordinal: string;
  type: string;
  payload: unknown;
  correlation_id: string;
  causation_id: string | null;
  affinity_keys: string[];
  status: string;
  attempts: number;
  locked_by: string | null;
  locked_at: string | null;
}

interface BeliefRow extends QueryResultRow {
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  learned_at: string;
  updated_at: string;
  source_perception_id: string | null;
}

interface MemoryRow extends QueryResultRow {
  id: string;
  category: string;
  occurred_at: string;
  content: string;
  importance_bps: number;
  emotional_strength_bps: number;
  related_entity_ids: string[];
  source_event_id: string | null;
  metadata: unknown | null;
}

interface RelationshipRow extends QueryResultRow {
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

interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  ordinal: number;
  speaker_id: string;
  sent_at: string;
  text: string;
  source_event_id: string | null;
  statements: unknown;
}

interface CognitionRow extends QueryResultRow {
  request_id: string;
  actor_id: string;
  sim_time: string;
  correlation_id: string;
  provider_id: string;
  model_id: string | null;
  request_hash: string;
  decision: unknown | null;
  status: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  error_message: string | null;
}

function normalizePage(options: TracePageOptions): TracePage {
  const limit = options.limit ?? DEFAULT_TRACE_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TRACE_LIMIT) {
    throw new DomainInvariantError(
      `Trace limit must be a safe integer between 1 and ${MAX_TRACE_LIMIT}`,
    );
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_TRACE_OFFSET
  ) {
    throw new DomainInvariantError(
      `Trace offset must be a safe integer between 0 and ${MAX_TRACE_OFFSET}`,
    );
  }
  return { limit, offset };
}

function optional<T>(
  value: T | null,
  key: string,
): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

function mapStatements(value: unknown): readonly TraceConversationStatement[] {
  if (!Array.isArray(value)) {
    throw new DomainInvariantError(
      "Trace conversation statements must be a JSON array",
    );
  }
  return value as TraceConversationStatement[];
}

function sumCounts(
  rows: readonly InventorySummaryRow[],
  key: "total" | "available" | "consumed",
): string {
  return rows
    .reduce((sum, row) => sum + BigInt(row[key]), 0n)
    .toString();
}

async function loadSnapshot(
  client: PoolClient,
  worldId: WorldId,
  personId: PersonId,
  page: TracePage,
): Promise<PersonTraceSnapshot | undefined> {
  const personResult = await client.query<PersonRow>(
    `SELECT world.id AS world_id,
            world.current_sim_time::text AS current_sim_time,
            person.id AS person_id,
            person.created_at_sim::text AS created_at_sim,
            physiology.hunger_value,
            physiology.hunger_recorded_at::text AS hunger_recorded_at,
            physiology.hunger_rate_per_hour,
            physiology.energy_value,
            physiology.energy_recorded_at::text AS energy_recorded_at,
            physiology.energy_mode,
            physiology.awake_drain_per_hour,
            physiology.sleep_recovery_per_hour,
            physiology.meals_eaten,
            physiology.sleep_sessions,
            physiology.updated_at_sim::text AS updated_at_sim,
            physiology.version::text AS version
       FROM worlds AS world
       JOIN persons AS person
         ON person.world_id = world.id
       JOIN person_physiology AS physiology
         ON physiology.world_id = person.world_id
        AND physiology.person_id = person.id
      WHERE world.id = $1
        AND person.id = $2`,
    [worldId, personId],
  );
  const personRow = personResult.rows[0];
  if (personRow === undefined) return undefined;

  const inventoryResult = await client.query<InventorySummaryRow>(
    `SELECT kind,
            count(*)::text AS total,
            count(*) FILTER (WHERE status = 'available')::text AS available,
            count(*) FILTER (WHERE status = 'consumed')::text AS consumed
       FROM inventory_items
      WHERE world_id = $1
        AND owner_id = $2
      GROUP BY kind
      ORDER BY kind ASC`,
    [worldId, personId],
  );

  const eventsResult = await client.query<EventRow>(
    `SELECT sequence::text AS sequence,
            id,
            sim_time::text AS sim_time,
            type,
            actor_id,
            target_ids,
            payload,
            causation_id,
            correlation_id
       FROM domain_events
      WHERE world_id = $1
        AND (
          actor_id = $2
          OR $2 = ANY(COALESCE(target_ids, ARRAY[]::text[]))
        )
      ORDER BY sequence DESC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const affinityKey = entityAffinityKey(String(personId));
  const scheduledResult = await client.query<ScheduledRow>(
    `SELECT id,
            due_at::text AS due_at,
            ordinal::text AS ordinal,
            type,
            payload,
            correlation_id,
            causation_id,
            affinity_keys,
            status,
            attempts,
            locked_by,
            locked_at::text AS locked_at
       FROM scheduled_events
      WHERE world_id = $1
        AND status IN ('pending','processing')
        AND affinity_keys @> ARRAY[$2]::text[]
      ORDER BY due_at ASC, ordinal ASC, id ASC
      LIMIT $3 OFFSET $4`,
    [worldId, affinityKey, page.limit, page.offset],
  );

  const beliefsResult = await client.query<BeliefRow>(
    `SELECT subject_id,
            predicate,
            value,
            confidence_bps,
            learned_at::text AS learned_at,
            updated_at::text AS updated_at,
            source_perception_id
       FROM beliefs
      WHERE world_id = $1
        AND holder_id = $2
      ORDER BY updated_at DESC, subject_id ASC, predicate ASC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const memoriesResult = await client.query<MemoryRow>(
    `SELECT id,
            category,
            occurred_at::text AS occurred_at,
            content,
            importance_bps,
            emotional_strength_bps,
            related_entity_ids,
            source_event_id,
            metadata
       FROM memories
      WHERE world_id = $1
        AND owner_id = $2
      ORDER BY occurred_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const relationshipsResult = await client.query<RelationshipRow>(
    `SELECT from_entity_id,
            to_entity_id,
            familiarity,
            trust,
            affection,
            respect,
            attraction,
            fear,
            resentment,
            dependency,
            updated_at::text AS updated_at,
            last_source_event_id
       FROM relationships
      WHERE world_id = $1
        AND (from_entity_id = $2 OR to_entity_id = $2)
      ORDER BY updated_at DESC, from_entity_id ASC, to_entity_id ASC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const messagesResult = await client.query<MessageRow>(
    `SELECT message.id,
            message.conversation_id,
            message.ordinal,
            message.speaker_id,
            message.sent_at::text AS sent_at,
            message.text,
            message.source_event_id,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_strip_nulls(
                    jsonb_build_object(
                      'id', statement.id,
                      'subjectId', statement.subject_id,
                      'predicate', statement.predicate,
                      'value', statement.value,
                      'confidenceBps', statement.confidence_bps,
                      'origin', statement.origin,
                      'sourceStatementId', statement.source_statement_id,
                      'claimedSourceEntityId', statement.claimed_source_entity_id,
                      'hopCount', statement.hop_count
                    )
                  )
                  ORDER BY statement.statement_index
                )
                  FROM conversation_statements AS statement
                 WHERE statement.world_id = message.world_id
                   AND statement.message_id = message.id
              ),
              '[]'::jsonb
            ) AS statements
       FROM conversation_messages AS message
      WHERE message.world_id = $1
        AND EXISTS (
          SELECT 1
            FROM conversation_participants AS participant
           WHERE participant.world_id = message.world_id
             AND participant.conversation_id = message.conversation_id
             AND participant.entity_id = $2
             AND participant.joined_at <= message.sent_at
        )
      ORDER BY message.sent_at DESC,
               message.conversation_id DESC,
               message.ordinal DESC,
               message.id DESC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const cognitionResult = await client.query<CognitionRow>(
    `SELECT request_id,
            actor_id,
            sim_time::text AS sim_time,
            correlation_id,
            provider_id,
            model_id,
            request_hash,
            decision,
            status,
            prompt_tokens,
            completion_tokens,
            latency_ms,
            error_message
       FROM cognition_runs
      WHERE world_id = $1
        AND actor_id = $2
      ORDER BY sim_time DESC, request_id DESC
      LIMIT $3 OFFSET $4`,
    [worldId, personId, page.limit, page.offset],
  );

  const inventoryRows = inventoryResult.rows;
  return {
    worldId: personRow.world_id,
    currentSimTime: personRow.current_sim_time,
    page,
    person: {
      id: personRow.person_id,
      createdAt: personRow.created_at_sim,
      updatedAt: personRow.updated_at_sim,
      version: personRow.version,
      hunger: {
        value: personRow.hunger_value,
        recordedAt: personRow.hunger_recorded_at,
        ratePerHour: personRow.hunger_rate_per_hour,
      },
      energy: {
        value: personRow.energy_value,
        recordedAt: personRow.energy_recorded_at,
        mode: personRow.energy_mode,
        awakeDrainPerHour: personRow.awake_drain_per_hour,
        sleepRecoveryPerHour: personRow.sleep_recovery_per_hour,
      },
      mealsEaten: personRow.meals_eaten,
      sleepSessions: personRow.sleep_sessions,
      inventory: {
        total: sumCounts(inventoryRows, "total"),
        available: sumCounts(inventoryRows, "available"),
        consumed: sumCounts(inventoryRows, "consumed"),
        byKind: inventoryRows.map((row) => ({
          kind: row.kind,
          total: row.total,
          available: row.available,
          consumed: row.consumed,
        })),
      },
    },
    events: eventsResult.rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      simTime: row.sim_time,
      type: row.type,
      ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
      targetIds: row.target_ids ?? [],
      payload: row.payload,
      ...(row.causation_id === null
        ? {}
        : { causationId: row.causation_id }),
      correlationId: row.correlation_id,
    })),
    scheduledEvents: scheduledResult.rows.map((row) => ({
      id: row.id,
      dueAt: row.due_at,
      ordinal: row.ordinal,
      type: row.type,
      payload: row.payload,
      correlationId: row.correlation_id,
      ...(row.causation_id === null
        ? {}
        : { causationId: row.causation_id }),
      affinityKeys: row.affinity_keys,
      status: row.status,
      attempts: row.attempts,
      ...(row.locked_by === null ? {} : { lockedBy: row.locked_by }),
      ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
    })),
    beliefs: beliefsResult.rows.map((row) => ({
      subjectId: row.subject_id,
      predicate: row.predicate,
      value: row.value,
      confidenceBps: row.confidence_bps,
      learnedAt: row.learned_at,
      updatedAt: row.updated_at,
      ...(row.source_perception_id === null
        ? {}
        : { sourcePerceptionId: row.source_perception_id }),
    })),
    memories: memoriesResult.rows.map((row) => ({
      id: row.id,
      category: row.category,
      occurredAt: row.occurred_at,
      content: row.content,
      importanceBps: row.importance_bps,
      emotionalStrengthBps: row.emotional_strength_bps,
      relatedEntityIds: row.related_entity_ids,
      ...(row.source_event_id === null
        ? {}
        : { sourceEventId: row.source_event_id }),
      ...(row.metadata === null ? {} : { metadata: row.metadata }),
    })),
    relationships: relationshipsResult.rows.map((row) => ({
      fromEntityId: row.from_entity_id,
      toEntityId: row.to_entity_id,
      familiarity: row.familiarity,
      trust: row.trust,
      affection: row.affection,
      respect: row.respect,
      attraction: row.attraction,
      fear: row.fear,
      resentment: row.resentment,
      dependency: row.dependency,
      updatedAt: row.updated_at,
      ...(row.last_source_event_id === null
        ? {}
        : { lastSourceEventId: row.last_source_event_id }),
    })),
    conversationMessages: messagesResult.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      ordinal: row.ordinal,
      speakerId: row.speaker_id,
      sentAt: row.sent_at,
      text: row.text,
      ...(row.source_event_id === null
        ? {}
        : { sourceEventId: row.source_event_id }),
      statements: mapStatements(row.statements),
    })),
    cognitionRuns: cognitionResult.rows.map((row) => ({
      requestId: row.request_id,
      actorId: row.actor_id,
      simTime: row.sim_time,
      correlationId: row.correlation_id,
      providerId: row.provider_id,
      ...(row.model_id === null ? {} : { modelId: row.model_id }),
      requestHash: row.request_hash,
      ...(row.decision === null ? {} : { decision: row.decision }),
      status: row.status,
      replayAvailable: row.status === "completed" && row.decision !== null,
      ...(row.prompt_tokens === null
        ? {}
        : { promptTokens: row.prompt_tokens }),
      ...(row.completion_tokens === null
        ? {}
        : { completionTokens: row.completion_tokens }),
      ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
      ...(row.error_message === null
        ? {}
        : { errorMessage: row.error_message }),
    })),
  };
}

export class PostgresTraceRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async inspectPerson(
    worldId: WorldId,
    personId: PersonId,
    options: TracePageOptions = {},
  ): Promise<PersonTraceSnapshot | undefined> {
    const page = normalizePage(options);
    return withTransaction(
      this.#pool,
      (client) => loadSnapshot(client, worldId, personId, page),
      "repeatable read",
    );
  }
}
