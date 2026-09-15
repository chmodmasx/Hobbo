import {
  DomainInvariantError,
  type ConversationMessageId,
  type EntityId,
  type WorldId,
} from "@hobbo/domain";
import {
  deriveListenerEffects,
  deriveSpeakerMemory,
  reviseBeliefFromReportedPerception,
  type ConversationPropagationPolicy,
  type ConversationRecord,
  type ListenerConversationEffects,
} from "@hobbo/conversation";
import type { MemoryRecord } from "@hobbo/memory";
import { PostgresConversationRepository, type PersistedConversationDelivery } from "./conversation-repository.ts";
import { PostgresMemoryRepository } from "./memory-repository.ts";
import { PostgresSocialRepository } from "./social-repository.ts";
import type { Pool } from "pg";

export interface ConversationMemoryEmbedder {
  readonly modelId: string;
  embed(request: {
    readonly purpose: "document";
    readonly inputs: readonly string[];
  }): Promise<{
    readonly modelId: string;
    readonly vectors: readonly (readonly number[])[];
  }>;
}

export interface ConversationDeliveryProcessResult {
  readonly delivery: PersistedConversationDelivery;
  readonly effects: ListenerConversationEffects;
  readonly speakerMemory: MemoryRecord;
  readonly beliefUpdates: number;
  readonly embeddingsWritten: number;
}

function historicalConversation(conversation: ConversationRecord): ConversationRecord {
  // A final message may have automatically closed the conversation before its
  // durable delivery effects are processed. Message validity is historical;
  // reopening this immutable view only avoids conflating append permission with
  // validation of an already persisted message.
  if (conversation.status === "open") return conversation;
  return {
    id: conversation.id,
    worldId: conversation.worldId,
    participantIds: conversation.participantIds,
    startedAt: conversation.startedAt,
    maxTurns: conversation.maxTurns,
    status: "open",
  };
}

export class PostgresConversationDeliveryProcessor {
  readonly #conversations: PostgresConversationRepository;
  readonly #social: PostgresSocialRepository;
  readonly #memories: PostgresMemoryRepository;
  readonly #embedder: ConversationMemoryEmbedder | undefined;
  readonly #policy: ConversationPropagationPolicy | undefined;

  constructor(
    pool: Pool,
    options: {
      readonly embedder?: ConversationMemoryEmbedder;
      readonly policy?: ConversationPropagationPolicy;
    } = {},
  ) {
    this.#conversations = new PostgresConversationRepository(pool);
    this.#social = new PostgresSocialRepository(pool);
    this.#memories = new PostgresMemoryRepository(pool);
    this.#embedder = options.embedder;
    this.#policy = options.policy;
  }

  async processClaim(
    delivery: PersistedConversationDelivery,
    workerId: string,
  ): Promise<ConversationDeliveryProcessResult> {
    if (delivery.status !== "processing" || delivery.lockedBy !== workerId) {
      throw new DomainInvariantError(
        `Conversation delivery ${delivery.messageId}:${delivery.listenerId} is not claimed by ${workerId}`,
      );
    }

    const message = await this.#conversations.getMessage(
      delivery.worldId,
      delivery.messageId,
    );
    if (message === undefined) {
      throw new DomainInvariantError(
        `Conversation message does not exist: ${delivery.messageId}`,
      );
    }
    const conversation = await this.#conversations.getConversation(
      delivery.worldId,
      message.conversationId,
    );
    if (conversation === undefined) {
      throw new DomainInvariantError(
        `Conversation does not exist: ${message.conversationId}`,
      );
    }

    const relationship = await this.#social.getRelationship(
      delivery.worldId,
      delivery.listenerId,
      message.speakerId,
    );
    const stableConversation = historicalConversation(conversation);
    const effects = deriveListenerEffects(
      stableConversation,
      message,
      delivery.listenerId,
      relationship?.vector,
      this.#policy,
    );
    const speakerMemory = deriveSpeakerMemory(
      stableConversation,
      message,
      this.#policy,
    );

    for (const perception of effects.perceptions) {
      await this.#social.recordPerception(perception);
    }

    let beliefUpdates = 0;
    for (const candidate of effects.beliefCandidates) {
      const current = await this.#social.getBelief(
        candidate.worldId,
        candidate.holderId,
        candidate.subjectId,
        candidate.predicate,
      );
      const revision = reviseBeliefFromReportedPerception(current, candidate);
      if (revision === undefined) continue;
      await this.#social.putBelief(revision);
      beliefUpdates += 1;
    }

    const listenerMemory = await this.#memories.createMemory(effects.memory);
    const persistedSpeakerMemory = await this.#memories.createMemory(speakerMemory);

    let embeddingsWritten = 0;
    if (this.#embedder !== undefined) {
      const memories = [listenerMemory, persistedSpeakerMemory] as const;
      const embedded = await this.#embedder.embed({
        purpose: "document",
        inputs: memories.map((memory) => memory.content),
      });
      if (embedded.modelId !== this.#embedder.modelId) {
        throw new DomainInvariantError(
          `Conversation embedder returned model ${embedded.modelId}, expected ${this.#embedder.modelId}`,
        );
      }
      if (embedded.vectors.length !== memories.length) {
        throw new DomainInvariantError(
          `Conversation embedder returned ${embedded.vectors.length} vectors for ${memories.length} memories`,
        );
      }
      for (let index = 0; index < memories.length; index += 1) {
        const memory = memories[index]!;
        const vector = embedded.vectors[index];
        if (vector === undefined) {
          throw new DomainInvariantError(
            `Conversation embedder omitted vector ${index}`,
          );
        }
        await this.#memories.putEmbedding(delivery.worldId, {
          memoryId: memory.id,
          modelId: embedded.modelId,
          vector,
        });
        embeddingsWritten += 1;
      }
    }

    for (const effect of effects.relationshipEffects) {
      // Conversation deliveries are processed in per-listener causal order. If
      // another subsystem has already advanced this relationship beyond the
      // message time, the social repository deliberately rejects the stale
      // effect rather than rewinding relationship state.
      await this.#social.applyRelationshipEffect({
        worldId: delivery.worldId,
        effectId: effect.effectId,
        fromEntityId: effect.fromEntityId,
        toEntityId: effect.toEntityId,
        at: effect.at,
        delta: effect.delta,
        ...(effect.sourceEventId === undefined
          ? {}
          : { sourceEventId: effect.sourceEventId }),
      });
    }

    await this.#conversations.completeDelivery(
      delivery.worldId,
      delivery.messageId,
      delivery.listenerId,
      workerId,
    );

    return {
      delivery,
      effects,
      speakerMemory: persistedSpeakerMemory,
      beliefUpdates,
      embeddingsWritten,
    };
  }

  async processNext(
    worldId: WorldId,
    workerId: string,
  ): Promise<ConversationDeliveryProcessResult | undefined> {
    const claimed = await this.#conversations.claimPendingDeliveries(
      worldId,
      workerId,
      1,
    );
    const delivery = claimed[0];
    if (delivery === undefined) return undefined;
    return this.processClaim(delivery, workerId);
  }

  async processSpecific(
    worldId: WorldId,
    messageId: ConversationMessageId,
    listenerId: EntityId,
    workerId: string,
  ): Promise<ConversationDeliveryProcessResult> {
    const deliveries = await this.#conversations.listDeliveries(worldId, messageId);
    const delivery = deliveries.find((candidate) => candidate.listenerId === listenerId);
    if (delivery === undefined) {
      throw new DomainInvariantError(
        `Conversation delivery does not exist: ${messageId}:${listenerId}`,
      );
    }
    return this.processClaim(delivery, workerId);
  }
}
