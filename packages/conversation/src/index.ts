import {
  DomainInvariantError,
  asMemoryId,
  type ConversationId,
  type ConversationMessageId,
  type ConversationStatementId,
  type EntityId,
  type EventId,
  type MemoryId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { MemoryRecord } from "@hobbo/memory";
import {
  adoptPerceptionAsBelief,
  SOCIAL_BASIS_POINTS,
  type BeliefState,
  type PerceptionRecord,
  type RelationshipDelta,
  type RelationshipVector,
} from "@hobbo/social";

export const CONVERSATION_BASIS_POINTS = 10_000;

export type ConversationStatus = "open" | "closed";
export type StatementOrigin = "direct" | "reported" | "inferred" | "fabricated";

export interface ConversationRecord {
  readonly id: ConversationId;
  readonly worldId: WorldId;
  readonly participantIds: readonly EntityId[];
  readonly startedAt: SimTime;
  readonly maxTurns: number;
  readonly status: ConversationStatus;
  readonly endedAt?: SimTime;
}

export interface ConversationStatement {
  readonly id: ConversationStatementId;
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
  readonly origin: StatementOrigin;
  /** Internal lineage. Never expose this field to listeners unless dialogue says it aloud. */
  readonly sourceStatementId?: ConversationStatementId;
  /** Source claimed aloud by the speaker, if any. */
  readonly claimedSourceEntityId?: EntityId;
  readonly hopCount: number;
}

export interface ConversationMessage {
  readonly id: ConversationMessageId;
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  readonly ordinal: number;
  readonly speakerId: EntityId;
  readonly sentAt: SimTime;
  readonly text: string;
  readonly statements: readonly ConversationStatement[];
  readonly sourceEventId?: EventId;
}

export interface ConversationPropagationPolicy {
  readonly transmissionRetentionBps: number;
  readonly beliefAcceptanceThresholdBps: number;
  readonly familiarityDeltaPerMessage: number;
  readonly listenerMemoryImportanceBps: number;
  readonly speakerMemoryImportanceBps: number;
}

export const DEFAULT_CONVERSATION_PROPAGATION_POLICY: ConversationPropagationPolicy = {
  transmissionRetentionBps: 9_000,
  beliefAcceptanceThresholdBps: 6_500,
  familiarityDeltaPerMessage: 25,
  listenerMemoryImportanceBps: 5_000,
  speakerMemoryImportanceBps: 4_500,
};

export interface RelationshipEffectDraft {
  readonly effectId: string;
  readonly fromEntityId: EntityId;
  readonly toEntityId: EntityId;
  readonly at: SimTime;
  readonly delta: RelationshipDelta;
  readonly sourceEventId?: EventId;
}

export interface ListenerConversationEffects {
  readonly listenerId: EntityId;
  readonly perceptions: readonly PerceptionRecord[];
  readonly beliefCandidates: readonly BeliefState[];
  readonly memory: MemoryRecord;
  readonly relationshipEffects: readonly RelationshipEffectDraft[];
}

function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return trimmed;
}

function assertBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > CONVERSATION_BASIS_POINTS) {
    throw new DomainInvariantError(
      `${label} must be an integer between 0 and ${CONVERSATION_BASIS_POINTS}`,
    );
  }
}

function assertPolicy(policy: ConversationPropagationPolicy): void {
  assertBps(policy.transmissionRetentionBps, "Transmission retention");
  assertBps(policy.beliefAcceptanceThresholdBps, "Belief acceptance threshold");
  assertBps(policy.listenerMemoryImportanceBps, "Listener memory importance");
  assertBps(policy.speakerMemoryImportanceBps, "Speaker memory importance");
  if (
    !Number.isSafeInteger(policy.familiarityDeltaPerMessage) ||
    policy.familiarityDeltaPerMessage < 0 ||
    policy.familiarityDeltaPerMessage > SOCIAL_BASIS_POINTS
  ) {
    throw new DomainInvariantError(
      `Conversation familiarity delta must be an integer between 0 and ${SOCIAL_BASIS_POINTS}`,
    );
  }
}

function assertPositiveOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainInvariantError(`${label} must be a positive safe integer`);
  }
}

export function validateConversation(conversation: ConversationRecord): void {
  if (String(conversation.id).trim().length === 0) {
    throw new DomainInvariantError("Conversation id cannot be blank");
  }
  if (conversation.participantIds.length < 2) {
    throw new DomainInvariantError("Conversation requires at least two participants");
  }
  const participants = conversation.participantIds.map(String);
  if (new Set(participants).size !== participants.length) {
    throw new DomainInvariantError("Conversation participants cannot contain duplicates");
  }
  assertPositiveOrdinal(conversation.maxTurns, "Conversation maxTurns");

  if (conversation.status === "open" && conversation.endedAt !== undefined) {
    throw new DomainInvariantError("Open conversation cannot have endedAt");
  }
  if (conversation.status === "closed") {
    if (conversation.endedAt === undefined) {
      throw new DomainInvariantError("Closed conversation requires endedAt");
    }
    if (conversation.endedAt < conversation.startedAt) {
      throw new DomainInvariantError("Conversation cannot end before it starts");
    }
  }
}

export function validateStatement(statement: ConversationStatement): void {
  if (String(statement.id).trim().length === 0) {
    throw new DomainInvariantError("Conversation statement id cannot be blank");
  }
  assertNonBlank(statement.subjectId, "Statement subject");
  assertNonBlank(statement.predicate, "Statement predicate");
  assertBps(statement.confidenceBps, "Statement confidence");
  if (!Number.isSafeInteger(statement.hopCount) || statement.hopCount < 0) {
    throw new DomainInvariantError("Statement hopCount must be a non-negative safe integer");
  }
  if (statement.sourceStatementId === statement.id) {
    throw new DomainInvariantError("Statement cannot cite itself as its source");
  }
  if (statement.sourceStatementId !== undefined && statement.hopCount === 0) {
    throw new DomainInvariantError("Statement with source lineage must have hopCount >= 1");
  }
}

export function validateMessage(
  conversation: ConversationRecord,
  message: ConversationMessage,
): void {
  validateConversation(conversation);
  if (message.worldId !== conversation.worldId) {
    throw new DomainInvariantError("Message world does not match conversation world");
  }
  if (message.conversationId !== conversation.id) {
    throw new DomainInvariantError("Message conversation id does not match conversation");
  }
  if (!conversation.participantIds.includes(message.speakerId)) {
    throw new DomainInvariantError("Message speaker is not a conversation participant");
  }
  if (conversation.status !== "open") {
    throw new DomainInvariantError("Cannot append a message to a closed conversation");
  }
  assertPositiveOrdinal(message.ordinal, "Message ordinal");
  if (message.ordinal > conversation.maxTurns) {
    throw new DomainInvariantError("Message exceeds conversation maxTurns");
  }
  if (message.sentAt < conversation.startedAt) {
    throw new DomainInvariantError("Message cannot precede conversation start");
  }
  if (message.text.trim().length === 0 && message.statements.length === 0) {
    throw new DomainInvariantError("Conversation message must contain text or statements");
  }

  const ids = new Set<string>();
  for (const statement of message.statements) {
    validateStatement(statement);
    const id = String(statement.id);
    if (ids.has(id)) {
      throw new DomainInvariantError(`Duplicate statement id in message: ${id}`);
    }
    ids.add(id);
  }
}

export function speakerCredibilityBps(relationship?: RelationshipVector): number {
  const trust = relationship?.trust ?? 0;
  if (!Number.isSafeInteger(trust) || trust < -SOCIAL_BASIS_POINTS || trust > SOCIAL_BASIS_POINTS) {
    throw new DomainInvariantError("Relationship trust is outside its valid range");
  }
  return Math.max(5_000, Math.min(10_000, 7_500 + Math.trunc(trust / 4)));
}

function multiplyBps(...values: readonly number[]): number {
  let scaled = BigInt(CONVERSATION_BASIS_POINTS);
  for (const value of values) {
    assertBps(value, "Basis-point multiplier");
    scaled = (scaled * BigInt(value)) / BigInt(CONVERSATION_BASIS_POINTS);
  }
  return Number(scaled);
}

export function receivedStatementConfidenceBps(
  statement: ConversationStatement,
  relationship?: RelationshipVector,
  policy: ConversationPropagationPolicy = DEFAULT_CONVERSATION_PROPAGATION_POLICY,
): number {
  validateStatement(statement);
  assertPolicy(policy);
  return multiplyBps(
    statement.confidenceBps,
    speakerCredibilityBps(relationship),
    policy.transmissionRetentionBps,
  );
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  } catch {
    return "[unserializable]";
  }
}

function deterministicMemoryId(
  message: ConversationMessage,
  ownerId: EntityId,
  role: "speaker" | "listener",
): MemoryId {
  return asMemoryId(
    `conversation:${message.conversationId}:message:${message.id}:${role}:${ownerId}`,
  );
}

function listenerMemoryContent(message: ConversationMessage): string {
  if (message.text.trim().length > 0) {
    return `${message.speakerId} said: ${message.text.trim()}`;
  }
  const claims = message.statements
    .map(
      (statement) =>
        `${statement.subjectId} ${statement.predicate} ${safeJson(statement.value)}`,
    )
    .join("; ");
  return `${message.speakerId} communicated: ${claims}`;
}

function listenerMemory(
  message: ConversationMessage,
  listenerId: EntityId,
  policy: ConversationPropagationPolicy,
): MemoryRecord {
  return {
    id: deterministicMemoryId(message, listenerId, "listener"),
    worldId: message.worldId,
    ownerId: listenerId,
    category: "social",
    occurredAt: message.sentAt,
    content: listenerMemoryContent(message),
    importanceBps: policy.listenerMemoryImportanceBps,
    emotionalStrengthBps: 0,
    relatedEntityIds: [message.speakerId],
    ...(message.sourceEventId === undefined
      ? {}
      : { sourceEventId: message.sourceEventId }),
    metadata: {
      conversationId: String(message.conversationId),
      messageId: String(message.id),
      speakerId: String(message.speakerId),
      role: "listener",
      statementIds: message.statements.map((statement) => String(statement.id)),
    },
  };
}

export function deriveSpeakerMemory(
  conversation: ConversationRecord,
  message: ConversationMessage,
  policy: ConversationPropagationPolicy = DEFAULT_CONVERSATION_PROPAGATION_POLICY,
): MemoryRecord {
  validateMessage(conversation, message);
  assertPolicy(policy);
  const listeners = conversation.participantIds.filter((id) => id !== message.speakerId);
  return {
    id: deterministicMemoryId(message, message.speakerId, "speaker"),
    worldId: message.worldId,
    ownerId: message.speakerId,
    category: "social",
    occurredAt: message.sentAt,
    content:
      message.text.trim().length > 0
        ? `I told ${listeners.map(String).join(", ")}: ${message.text.trim()}`
        : `I communicated ${message.statements.length} structured claim(s) to ${listeners
            .map(String)
            .join(", ")}`,
    importanceBps: policy.speakerMemoryImportanceBps,
    emotionalStrengthBps: 0,
    relatedEntityIds: listeners,
    ...(message.sourceEventId === undefined
      ? {}
      : { sourceEventId: message.sourceEventId }),
    metadata: {
      conversationId: String(message.conversationId),
      messageId: String(message.id),
      role: "speaker",
      statements: message.statements.map((statement) => ({
        id: String(statement.id),
        origin: statement.origin,
        hopCount: statement.hopCount,
        sourceStatementId:
          statement.sourceStatementId === undefined
            ? null
            : String(statement.sourceStatementId),
      })),
    },
  };
}

export function deriveListenerEffects(
  conversation: ConversationRecord,
  message: ConversationMessage,
  listenerId: EntityId,
  relationship?: RelationshipVector,
  policy: ConversationPropagationPolicy = DEFAULT_CONVERSATION_PROPAGATION_POLICY,
): ListenerConversationEffects {
  validateMessage(conversation, message);
  assertPolicy(policy);
  if (listenerId === message.speakerId) {
    throw new DomainInvariantError("Speaker cannot receive their own listener effects");
  }
  if (!conversation.participantIds.includes(listenerId)) {
    throw new DomainInvariantError("Listener is not a conversation participant");
  }

  const perceptions = message.statements.map<PerceptionRecord>((statement) => ({
    id: `conversation:${message.conversationId}:message:${message.id}:listener:${listenerId}:statement:${statement.id}`,
    worldId: message.worldId,
    observerId: listenerId,
    observedAt: message.sentAt,
    channel: "reported",
    subjectId: statement.subjectId.trim(),
    predicate: statement.predicate.trim(),
    value: statement.value,
    confidenceBps: receivedStatementConfidenceBps(statement, relationship, policy),
    sourceEntityId: message.speakerId,
    ...(message.sourceEventId === undefined
      ? {}
      : { sourceEventId: message.sourceEventId }),
  }));

  const beliefCandidates = perceptions
    .filter((perception) => perception.confidenceBps >= policy.beliefAcceptanceThresholdBps)
    .map(adoptPerceptionAsBelief);

  const listenerToSpeaker: RelationshipEffectDraft = {
    effectId: `conversation:${message.conversationId}:message:${message.id}:familiarity:${listenerId}->${message.speakerId}`,
    fromEntityId: listenerId,
    toEntityId: message.speakerId,
    at: message.sentAt,
    delta: { familiarity: policy.familiarityDeltaPerMessage },
    ...(message.sourceEventId === undefined
      ? {}
      : { sourceEventId: message.sourceEventId }),
  };
  const speakerToListener: RelationshipEffectDraft = {
    effectId: `conversation:${message.conversationId}:message:${message.id}:familiarity:${message.speakerId}->${listenerId}`,
    fromEntityId: message.speakerId,
    toEntityId: listenerId,
    at: message.sentAt,
    delta: { familiarity: policy.familiarityDeltaPerMessage },
    ...(message.sourceEventId === undefined
      ? {}
      : { sourceEventId: message.sourceEventId }),
  };

  return {
    listenerId,
    perceptions,
    beliefCandidates,
    memory: listenerMemory(message, listenerId, policy),
    relationshipEffects: [listenerToSpeaker, speakerToListener],
  };
}

export function reviseBeliefFromReportedPerception(
  current: BeliefState | undefined,
  candidate: BeliefState,
): BeliefState | undefined {
  if (current === undefined) return candidate;
  if (
    current.worldId !== candidate.worldId ||
    current.holderId !== candidate.holderId ||
    current.subjectId !== candidate.subjectId ||
    current.predicate !== candidate.predicate
  ) {
    throw new DomainInvariantError("Belief revision candidate does not match current belief identity");
  }
  if (candidate.updatedAt <= current.updatedAt) {
    return undefined;
  }
  return {
    ...candidate,
    learnedAt: current.learnedAt,
  };
}

export function retellStatement(input: {
  readonly id: ConversationStatementId;
  readonly source: ConversationStatement;
  readonly confidenceBps: number;
  readonly subjectId?: string;
  readonly predicate?: string;
  readonly value?: unknown;
  readonly claimedSourceEntityId?: EntityId;
}): ConversationStatement {
  validateStatement(input.source);
  const statement: ConversationStatement = {
    id: input.id,
    subjectId: input.subjectId ?? input.source.subjectId,
    predicate: input.predicate ?? input.source.predicate,
    value: input.value === undefined ? input.source.value : input.value,
    confidenceBps: input.confidenceBps,
    origin: "reported",
    sourceStatementId: input.source.id,
    ...(input.claimedSourceEntityId === undefined
      ? {}
      : { claimedSourceEntityId: input.claimedSourceEntityId }),
    hopCount: input.source.hopCount + 1,
  };
  validateStatement(statement);
  return statement;
}
