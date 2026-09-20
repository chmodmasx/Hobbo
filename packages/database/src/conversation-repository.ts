import {
  DomainInvariantError,
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asEntityId,
  asEventId,
  asWorldId,
  simTime,
  type ConversationId,
  type ConversationMessageId,
  type EntityId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  validateConversation,
  validateMessage,
  validateStatement,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationStatement,
  type ConversationStatus,
  type StatementOrigin,
} from "@hobbo/conversation";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface ConversationRow extends QueryResultRow {
  world_id: string;
  id: string;
  started_at: string;
  status: ConversationStatus;
  ended_at: string | null;
  max_turns: number;
  next_message_ordinal: number;
}

interface ParticipantRow extends QueryResultRow {
  entity_id: string;
}

interface MessageRow extends QueryResultRow {
  world_id: string;
  id: string;
  conversation_id: string;
  ordinal: number;
  speaker_id: string;
  sent_at: string;
  text: string;
  source_event_id: string | null;
}

interface StatementRow extends QueryResultRow {
  world_id: string;
  id: string;
  conversation_id: string;
  message_id: string;
  statement_index: number;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  origin: StatementOrigin;
  source_statement_id: string | null;
  claimed_source_entity_id: string | null;
  hop_count: number;
}

export type ConversationDeliveryStatus = "pending" | "processing" | "completed";

interface DeliveryRow extends QueryResultRow {
  world_id: string;
  message_id: string;
  listener_id: string;
  status: ConversationDeliveryStatus;
  attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  completed_at: Date | null;
}

export interface CreateConversationInput {
  readonly id: ConversationId;
  readonly worldId: WorldId;
  readonly participantIds: readonly EntityId[];
  readonly startedAt: SimTime;
  readonly maxTurns: number;
}

export interface AppendConversationMessageInput {
  readonly id: ConversationMessageId;
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  readonly speakerId: EntityId;
  readonly sentAt: SimTime;
  readonly text: string;
  readonly statements: readonly ConversationStatement[];
  readonly sourceEventId?: ReturnType<typeof asEventId>;
}

export interface PersistedConversationDelivery {
  readonly worldId: WorldId;
  readonly messageId: ConversationMessageId;
  readonly listenerId: EntityId;
  readonly status: ConversationDeliveryStatus;
  readonly attempts: number;
  readonly lockedBy?: string;
  readonly lockedAt?: Date;
  readonly completedAt?: Date;
}

const CONVERSATION_COLUMNS = `
  world_id, id, started_at, status, ended_at, max_turns, next_message_ordinal
`;

const MESSAGE_COLUMNS = `
  world_id, id, conversation_id, ordinal, speaker_id, sent_at, text, source_event_id
`;

const STATEMENT_COLUMNS = `
  world_id, id, conversation_id, message_id, statement_index,
  subject_id, predicate, value, confidence_bps, origin,
  source_statement_id, claimed_source_entity_id, hop_count
`;

const DELIVERY_COLUMNS = `
  world_id, message_id, listener_id, status, attempts,
  locked_by, locked_at, completed_at
`;

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

function canonicalParticipants(ids: readonly EntityId[]): readonly EntityId[] {
  return [...ids]
    .map(String)
    .sort((left, right) => left.localeCompare(right))
    .map(asEntityId);
}

function normalizeJson(value: unknown, inArray = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainInvariantError("Conversation JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return inArray ? null : undefined;
  }
  if (typeof value === "bigint") {
    throw new DomainInvariantError("Conversation JSON cannot contain bigint values");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, true));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeJson(
        (value as Record<string, unknown>)[key],
        false,
      );
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  throw new DomainInvariantError("Conversation JSON contains unsupported data");
}

function stableJson(value: unknown): string {
  const normalized = normalizeJson(value);
  if (normalized === undefined) {
    throw new DomainInvariantError("Conversation JSON cannot be undefined");
  }
  return JSON.stringify(normalized);
}

async function loadParticipants(
  client: Pool | PoolClient,
  worldId: WorldId,
  conversationId: ConversationId,
): Promise<readonly EntityId[]> {
  const result = await client.query<ParticipantRow>(
    `SELECT entity_id
       FROM conversation_participants
      WHERE world_id = $1 AND conversation_id = $2
      ORDER BY entity_id ASC`,
    [worldId, conversationId],
  );
  return result.rows.map((row) => asEntityId(row.entity_id));
}

function mapConversation(
  row: ConversationRow,
  participantIds: readonly EntityId[],
): ConversationRecord {
  const result: ConversationRecord = {
    id: asConversationId(row.id),
    worldId: asWorldId(row.world_id),
    participantIds,
    startedAt: simTime(row.started_at),
    maxTurns: row.max_turns,
    status: row.status,
    ...(row.ended_at === null ? {} : { endedAt: simTime(row.ended_at) }),
  };
  validateConversation(result);
  return result;
}

async function loadConversation(
  client: Pool | PoolClient,
  worldId: WorldId,
  conversationId: ConversationId,
  forUpdate = false,
): Promise<{ readonly conversation: ConversationRecord; readonly nextOrdinal: number } | undefined> {
  const result = await client.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
      WHERE world_id = $1 AND id = $2
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [worldId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const participantIds = await loadParticipants(client, worldId, conversationId);
  return {
    conversation: mapConversation(row, participantIds),
    nextOrdinal: row.next_message_ordinal,
  };
}

function mapStatement(row: StatementRow): ConversationStatement {
  const statement: ConversationStatement = {
    id: asConversationStatementId(row.id),
    subjectId: row.subject_id,
    predicate: row.predicate,
    value: row.value,
    confidenceBps: row.confidence_bps,
    origin: row.origin,
    ...(row.source_statement_id === null
      ? {}
      : { sourceStatementId: asConversationStatementId(row.source_statement_id) }),
    ...(row.claimed_source_entity_id === null
      ? {}
      : { claimedSourceEntityId: asEntityId(row.claimed_source_entity_id) }),
    hopCount: row.hop_count,
  };
  validateStatement(statement);
  return statement;
}

async function loadStatements(
  client: Pool | PoolClient,
  worldId: WorldId,
  messageId: ConversationMessageId,
): Promise<readonly ConversationStatement[]> {
  const result = await client.query<StatementRow>(
    `SELECT ${STATEMENT_COLUMNS}
       FROM conversation_statements
      WHERE world_id = $1 AND message_id = $2
      ORDER BY statement_index ASC`,
    [worldId, messageId],
  );
  return result.rows.map(mapStatement);
}

async function loadMessage(
  client: Pool | PoolClient,
  worldId: WorldId,
  messageId: ConversationMessageId,
): Promise<ConversationMessage | undefined> {
  const result = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM conversation_messages
      WHERE world_id = $1 AND id = $2`,
    [worldId, messageId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const statements = await loadStatements(client, worldId, messageId);
  return {
    id: asConversationMessageId(row.id),
    worldId: asWorldId(row.world_id),
    conversationId: asConversationId(row.conversation_id),
    ordinal: row.ordinal,
    speakerId: asEntityId(row.speaker_id),
    sentAt: simTime(row.sent_at),
    text: row.text,
    statements,
    ...(row.source_event_id === null
      ? {}
      : { sourceEventId: asEventId(row.source_event_id) }),
  };
}

function sameStatement(
  left: ConversationStatement,
  right: ConversationStatement,
): boolean {
  return (
    left.id === right.id &&
    left.subjectId === right.subjectId.trim() &&
    left.predicate === right.predicate.trim() &&
    stableJson(left.value) === stableJson(right.value) &&
    left.confidenceBps === right.confidenceBps &&
    left.origin === right.origin &&
    left.sourceStatementId === right.sourceStatementId &&
    left.claimedSourceEntityId === right.claimedSourceEntityId &&
    left.hopCount === right.hopCount
  );
}

function sameMessage(
  persisted: ConversationMessage,
  input: AppendConversationMessageInput,
): boolean {
  return (
    persisted.worldId === input.worldId &&
    persisted.conversationId === input.conversationId &&
    persisted.speakerId === input.speakerId &&
    persisted.sentAt === input.sentAt &&
    persisted.text === input.text &&
    persisted.sourceEventId === input.sourceEventId &&
    persisted.statements.length === input.statements.length &&
    persisted.statements.every((statement, index) => {
      const incoming = input.statements[index];
      return incoming !== undefined && sameStatement(statement, incoming);
    })
  );
}

function mapDelivery(row: DeliveryRow): PersistedConversationDelivery {
  return {
    worldId: asWorldId(row.world_id),
    messageId: asConversationMessageId(row.message_id),
    listenerId: asEntityId(row.listener_id),
    status: row.status,
    attempts: row.attempts,
    ...(row.locked_by === null ? {} : { lockedBy: row.locked_by }),
    ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class PostgresConversationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<ConversationRecord> {
    const canonical: ConversationRecord = {
      id: input.id,
      worldId: input.worldId,
      participantIds: canonicalParticipants(input.participantIds),
      startedAt: input.startedAt,
      maxTurns: input.maxTurns,
      status: "open",
    };
    validateConversation(canonical);

    return withTransaction(this.#pool, async (client) => {
      await advisoryLock(
        client,
        "conversation-create",
        `${input.worldId}:${input.id}`,
      );

      const existing = await loadConversation(client, input.worldId, input.id, true);
      if (existing !== undefined) {
        const persisted = existing.conversation;
        const same =
          persisted.startedAt === canonical.startedAt &&
          persisted.maxTurns === canonical.maxTurns &&
          stableJson(persisted.participantIds.map(String)) ===
            stableJson(canonical.participantIds.map(String));
        if (!same) {
          throw new DomainInvariantError(
            `Conversation id ${input.id} was already used with different creation data`,
          );
        }
        return persisted;
      }

      await client.query(
        `INSERT INTO conversations (
           world_id, id, started_at, max_turns
         ) VALUES ($1,$2,$3,$4)`,
        [input.worldId, input.id, input.startedAt.toString(), input.maxTurns],
      );
      for (const participantId of canonical.participantIds) {
        await client.query(
          `INSERT INTO conversation_participants (
             world_id, conversation_id, entity_id, joined_at
           ) VALUES ($1,$2,$3,$4)`,
          [input.worldId, input.id, participantId, input.startedAt.toString()],
        );
      }

      return canonical;
    }, "read committed");
  }

  async getConversation(
    worldId: WorldId,
    conversationId: ConversationId,
  ): Promise<ConversationRecord | undefined> {
    return (await loadConversation(this.#pool, worldId, conversationId))?.conversation;
  }

  async appendMessage(
    input: AppendConversationMessageInput,
  ): Promise<ConversationMessage> {
    for (const statement of input.statements) validateStatement(statement);
    if (input.text.trim().length === 0 && input.statements.length === 0) {
      throw new DomainInvariantError("Conversation message must contain text or statements");
    }

    return withTransaction(this.#pool, async (client) => {
      await advisoryLock(
        client,
        "conversation-message",
        `${input.worldId}:${input.id}`,
      );

      const existing = await loadMessage(client, input.worldId, input.id);
      if (existing !== undefined) {
        if (!sameMessage(existing, input)) {
          throw new DomainInvariantError(
            `Conversation message id ${input.id} was already used for different content`,
          );
        }
        return existing;
      }

      const loaded = await loadConversation(
        client,
        input.worldId,
        input.conversationId,
        true,
      );
      if (loaded === undefined) {
        throw new DomainInvariantError(
          `Conversation does not exist: ${input.conversationId}`,
        );
      }
      const { conversation, nextOrdinal } = loaded;
      if (conversation.status !== "open") {
        throw new DomainInvariantError(
          `Conversation is closed: ${input.conversationId}`,
        );
      }
      if (nextOrdinal > conversation.maxTurns) {
        throw new DomainInvariantError(
          `Conversation exhausted its turn budget: ${input.conversationId}`,
        );
      }

      const last = await client.query<{ sent_at: string }>(
        `SELECT sent_at
           FROM conversation_messages
          WHERE world_id = $1 AND conversation_id = $2
          ORDER BY ordinal DESC
          LIMIT 1`,
        [input.worldId, input.conversationId],
      );
      const lastSentAt = last.rows[0]?.sent_at;
      if (lastSentAt !== undefined && BigInt(input.sentAt) < BigInt(lastSentAt)) {
        throw new DomainInvariantError(
          `Conversation message time is stale: ${input.sentAt} < ${lastSentAt}`,
        );
      }

      const message: ConversationMessage = {
        id: input.id,
        worldId: input.worldId,
        conversationId: input.conversationId,
        ordinal: nextOrdinal,
        speakerId: input.speakerId,
        sentAt: input.sentAt,
        text: input.text,
        statements: input.statements.map((statement) => ({
          ...statement,
          subjectId: statement.subjectId.trim(),
          predicate: statement.predicate.trim(),
        })),
        ...(input.sourceEventId === undefined
          ? {}
          : { sourceEventId: input.sourceEventId }),
      };
      validateMessage(conversation, message);

      await client.query(
        `INSERT INTO conversation_messages (
           world_id, id, conversation_id, ordinal, speaker_id,
           sent_at, text, source_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          message.worldId,
          message.id,
          message.conversationId,
          message.ordinal,
          message.speakerId,
          message.sentAt.toString(),
          message.text,
          message.sourceEventId ?? null,
        ],
      );

      for (let index = 0; index < message.statements.length; index += 1) {
        const statement = message.statements[index]!;
        await client.query(
          `INSERT INTO conversation_statements (
             world_id, id, conversation_id, message_id, statement_index,
             subject_id, predicate, value, confidence_bps, origin,
             source_statement_id, claimed_source_entity_id, hop_count
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            message.worldId,
            statement.id,
            message.conversationId,
            message.id,
            index,
            statement.subjectId,
            statement.predicate,
            toJsonParameter(
              statement.value,
              `conversation statement ${statement.id} value`,
            ),
            statement.confidenceBps,
            statement.origin,
            statement.sourceStatementId ?? null,
            statement.claimedSourceEntityId ?? null,
            statement.hopCount,
          ],
        );
      }

      for (const listenerId of conversation.participantIds) {
        if (listenerId === message.speakerId) continue;
        await client.query(
          `INSERT INTO conversation_deliveries (
             world_id, message_id, listener_id
           ) VALUES ($1,$2,$3)`,
          [message.worldId, message.id, listenerId],
        );
      }

      const finalTurn = nextOrdinal === conversation.maxTurns;
      await client.query(
        `UPDATE conversations
            SET next_message_ordinal = $3,
                status = CASE WHEN $4 THEN 'closed' ELSE status END,
                ended_at = CASE WHEN $4 THEN $5 ELSE ended_at END,
                persisted_at = now()
          WHERE world_id = $1 AND id = $2`,
        [
          input.worldId,
          input.conversationId,
          nextOrdinal + 1,
          finalTurn,
          finalTurn ? input.sentAt.toString() : null,
        ],
      );

      return message;
    }, "read committed");
  }

  async getMessage(
    worldId: WorldId,
    messageId: ConversationMessageId,
  ): Promise<ConversationMessage | undefined> {
    return loadMessage(this.#pool, worldId, messageId);
  }

  async listMessages(
    worldId: WorldId,
    conversationId: ConversationId,
  ): Promise<readonly ConversationMessage[]> {
    const result = await this.#pool.query<{ id: string }>(
      `SELECT id
         FROM conversation_messages
        WHERE world_id = $1 AND conversation_id = $2
        ORDER BY ordinal ASC`,
      [worldId, conversationId],
    );
    const messages: ConversationMessage[] = [];
    for (const row of result.rows) {
      const message = await loadMessage(
        this.#pool,
        worldId,
        asConversationMessageId(row.id),
      );
      if (message === undefined) {
        throw new DomainInvariantError(
          `Conversation message disappeared during load: ${row.id}`,
        );
      }
      messages.push(message);
    }
    return messages;
  }

  async closeConversation(
    worldId: WorldId,
    conversationId: ConversationId,
    endedAt: SimTime,
  ): Promise<ConversationRecord> {
    return withTransaction(this.#pool, async (client) => {
      const loaded = await loadConversation(client, worldId, conversationId, true);
      if (loaded === undefined) {
        throw new DomainInvariantError(`Conversation does not exist: ${conversationId}`);
      }
      if (loaded.conversation.status === "closed") {
        if (loaded.conversation.endedAt !== endedAt) {
          throw new DomainInvariantError(
            `Conversation ${conversationId} is already closed at a different time`,
          );
        }
        return loaded.conversation;
      }

      const last = await client.query<{ sent_at: string }>(
        `SELECT sent_at
           FROM conversation_messages
          WHERE world_id = $1 AND conversation_id = $2
          ORDER BY ordinal DESC
          LIMIT 1`,
        [worldId, conversationId],
      );
      const minimum = last.rows[0]?.sent_at ?? loaded.conversation.startedAt.toString();
      if (BigInt(endedAt) < BigInt(minimum)) {
        throw new DomainInvariantError(
          `Conversation cannot close before its latest message/start: ${endedAt} < ${minimum}`,
        );
      }

      const result = await client.query<ConversationRow>(
        `UPDATE conversations
            SET status = 'closed', ended_at = $3, persisted_at = now()
          WHERE world_id = $1 AND id = $2
        RETURNING ${CONVERSATION_COLUMNS}`,
        [worldId, conversationId, endedAt.toString()],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError("Conversation close returned no row");
      }
      const participants = await loadParticipants(client, worldId, conversationId);
      return mapConversation(row, participants);
    }, "read committed");
  }

  async claimDelivery(
    worldId: WorldId,
    messageId: ConversationMessageId,
    listenerId: EntityId,
    workerId: string,
  ): Promise<PersistedConversationDelivery | undefined> {
    if (workerId.trim().length === 0) {
      throw new DomainInvariantError(
        "Conversation delivery workerId cannot be blank",
      );
    }

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DeliveryRow>(
        `WITH target AS (
           SELECT d.world_id, d.message_id, d.listener_id
             FROM conversation_deliveries AS d
             JOIN conversation_messages AS m
               ON m.world_id = d.world_id
              AND m.id = d.message_id
            WHERE d.world_id = $1
              AND d.message_id = $2
              AND d.listener_id = $3
              AND d.status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                  FROM conversation_deliveries AS earlier
                  JOIN conversation_messages AS earlier_message
                    ON earlier_message.world_id = earlier.world_id
                   AND earlier_message.id = earlier.message_id
                 WHERE earlier.world_id = d.world_id
                   AND earlier.listener_id = d.listener_id
                   AND earlier.status IN ('pending','processing')
                   AND (
                     earlier_message.sent_at,
                     earlier_message.conversation_id,
                     earlier_message.ordinal,
                     earlier_message.id
                   ) < (
                     m.sent_at,
                     m.conversation_id,
                     m.ordinal,
                     m.id
                   )
              )
            FOR UPDATE OF d
         )
         UPDATE conversation_deliveries AS delivery
            SET status = 'processing',
                attempts = delivery.attempts + 1,
                locked_by = $4,
                locked_at = now()
           FROM target
          WHERE delivery.world_id = target.world_id
            AND delivery.message_id = target.message_id
            AND delivery.listener_id = target.listener_id
        RETURNING delivery.world_id, delivery.message_id,
                  delivery.listener_id, delivery.status, delivery.attempts,
                  delivery.locked_by, delivery.locked_at,
                  delivery.completed_at`,
        [worldId, messageId, listenerId, workerId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapDelivery(row);
    }, "read committed");
  }

  async claimPendingDeliveries(
    worldId: WorldId,
    workerId: string,
    limit = 100,
  ): Promise<readonly PersistedConversationDelivery[]> {
    if (workerId.trim().length === 0) {
      throw new DomainInvariantError("Conversation delivery workerId cannot be blank");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new DomainInvariantError(
        "Conversation delivery claim limit must be a positive safe integer",
      );
    }

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DeliveryRow>(
        `WITH candidates AS (
           SELECT d.world_id, d.message_id, d.listener_id,
                  m.sent_at, m.conversation_id, m.ordinal, m.id
             FROM conversation_deliveries AS d
             JOIN conversation_messages AS m
               ON m.world_id = d.world_id AND m.id = d.message_id
            WHERE d.world_id = $1
              AND d.status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                  FROM conversation_deliveries AS earlier
                  JOIN conversation_messages AS earlier_message
                    ON earlier_message.world_id = earlier.world_id
                   AND earlier_message.id = earlier.message_id
                 WHERE earlier.world_id = d.world_id
                   AND earlier.listener_id = d.listener_id
                   AND earlier.status IN ('pending','processing')
                   AND (
                     earlier_message.sent_at,
                     earlier_message.conversation_id,
                     earlier_message.ordinal,
                     earlier_message.id
                   ) < (
                     m.sent_at,
                     m.conversation_id,
                     m.ordinal,
                     m.id
                   )
              )
            ORDER BY m.sent_at ASC, m.conversation_id ASC, m.ordinal ASC,
                     m.id ASC, d.listener_id ASC
            FOR UPDATE OF d SKIP LOCKED
            LIMIT $3
         ), updated AS (
           UPDATE conversation_deliveries AS delivery
              SET status = 'processing',
                  attempts = delivery.attempts + 1,
                  locked_by = $2,
                  locked_at = now()
             FROM candidates
            WHERE delivery.world_id = candidates.world_id
              AND delivery.message_id = candidates.message_id
              AND delivery.listener_id = candidates.listener_id
           RETURNING delivery.*
         )
         SELECT updated.world_id, updated.message_id, updated.listener_id,
                updated.status, updated.attempts, updated.locked_by,
                updated.locked_at, updated.completed_at
           FROM updated
           JOIN candidates
             ON candidates.world_id = updated.world_id
            AND candidates.message_id = updated.message_id
            AND candidates.listener_id = updated.listener_id
          ORDER BY candidates.sent_at ASC, candidates.conversation_id ASC,
                   candidates.ordinal ASC, candidates.id ASC,
                   candidates.listener_id ASC`,
        [worldId, workerId, limit],
      );
      return result.rows.map(mapDelivery);
    }, "read committed");
  }

  async requeueStaleDeliveries(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    if (Number.isNaN(staleBefore.getTime())) {
      throw new DomainInvariantError("staleBefore must be a valid Date");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new DomainInvariantError(
        "Conversation delivery requeue limit must be a positive safe integer",
      );
    }
    const result = await this.#pool.query(
      `WITH stale AS (
         SELECT world_id, message_id, listener_id
           FROM conversation_deliveries
          WHERE world_id = $1
            AND status = 'processing'
            AND locked_at <= $2
          ORDER BY locked_at ASC, message_id ASC, listener_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE conversation_deliveries AS delivery
          SET status = 'pending', locked_by = NULL, locked_at = NULL
         FROM stale
        WHERE delivery.world_id = stale.world_id
          AND delivery.message_id = stale.message_id
          AND delivery.listener_id = stale.listener_id`,
      [worldId, staleBefore, limit],
    );
    return result.rowCount ?? 0;
  }

  async completeDelivery(
    worldId: WorldId,
    messageId: ConversationMessageId,
    listenerId: EntityId,
    workerId: string,
  ): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE conversation_deliveries
          SET status = 'completed',
              completed_at = now(),
              locked_by = NULL,
              locked_at = NULL
        WHERE world_id = $1
          AND message_id = $2
          AND listener_id = $3
          AND status = 'processing'
          AND locked_by = $4`,
      [worldId, messageId, listenerId, workerId],
    );
    if (result.rowCount !== 1) {
      throw new DomainInvariantError(
        `Conversation delivery ${messageId}:${listenerId} is not owned by worker ${workerId}`,
      );
    }
  }

  async listDeliveries(
    worldId: WorldId,
    messageId: ConversationMessageId,
  ): Promise<readonly PersistedConversationDelivery[]> {
    const result = await this.#pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS}
         FROM conversation_deliveries
        WHERE world_id = $1 AND message_id = $2
        ORDER BY listener_id ASC`,
      [worldId, messageId],
    );
    return result.rows.map(mapDelivery);
  }
}
