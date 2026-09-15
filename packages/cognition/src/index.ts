import type {
  CognitiveDecision,
  CognitiveProvider,
  CognitiveRequest,
} from "@hobbo/ai-provider";
import {
  DomainInvariantError,
  type Affordance,
  type AffordanceId,
  type CognitionRequestId,
  type CorrelationId,
  type EntityId,
  type MemoryId,
  type SimTime,
} from "@hobbo/domain";
import type {
  MemoryCategory,
  MemoryScoreComponents,
  ScoredMemory,
} from "@hobbo/memory";

export interface CognitiveMemoryContext {
  readonly id: MemoryId;
  readonly category: MemoryCategory;
  readonly occurredAt: SimTime;
  readonly content: string;
  readonly relatedEntityIds: readonly EntityId[];
  readonly scoreBps: number;
  readonly components: MemoryScoreComponents;
}

export interface AmbiguousChoiceContext<TState = unknown> {
  readonly situation: string;
  readonly state: Readonly<TState>;
  readonly memories: readonly CognitiveMemoryContext[];
}

export interface AmbiguousChoiceInput<TState = unknown> {
  readonly id: CognitionRequestId;
  readonly actorId: EntityId;
  readonly simTime: SimTime;
  readonly correlationId: CorrelationId;
  readonly situation: string;
  readonly state: Readonly<TState>;
  readonly affordances: readonly Affordance[];
  readonly memories: readonly ScoredMemory[];
}

function validateAffordances(affordances: readonly Affordance[]): void {
  if (affordances.length < 2) {
    throw new DomainInvariantError(
      "Ambiguous choice requires at least two available affordances",
    );
  }

  const ids = new Set<AffordanceId>();
  for (const affordance of affordances) {
    if (ids.has(affordance.id)) {
      throw new DomainInvariantError(
        `Ambiguous choice contains duplicate affordance: ${affordance.id}`,
      );
    }
    ids.add(affordance.id);

    if (affordance.label.trim().length === 0) {
      throw new DomainInvariantError(
        `Affordance ${affordance.id} must have a non-empty label`,
      );
    }
  }
}

function memoryContext(
  scored: ScoredMemory,
  now: SimTime,
): CognitiveMemoryContext {
  if (scored.memory.occurredAt > now) {
    throw new DomainInvariantError(
      `Cognitive context cannot include future memory ${scored.memory.id}`,
    );
  }

  return {
    id: scored.memory.id,
    category: scored.memory.category,
    occurredAt: scored.memory.occurredAt,
    content: scored.memory.content,
    relatedEntityIds: scored.memory.relatedEntityIds,
    scoreBps: scored.scoreBps,
    components: scored.components,
  };
}

function compactMemories(
  memories: readonly ScoredMemory[],
  now: SimTime,
): readonly CognitiveMemoryContext[] {
  const ids = new Set<MemoryId>();
  return memories.map((scored) => {
    if (ids.has(scored.memory.id)) {
      throw new DomainInvariantError(
        `Cognitive context contains duplicate memory: ${scored.memory.id}`,
      );
    }
    ids.add(scored.memory.id);
    return memoryContext(scored, now);
  });
}

export function assembleAmbiguousChoiceRequest<TState>(
  input: AmbiguousChoiceInput<TState>,
): CognitiveRequest<AmbiguousChoiceContext<TState>> {
  const situation = input.situation.trim();
  if (situation.length === 0) {
    throw new DomainInvariantError("Ambiguous choice situation cannot be blank");
  }
  validateAffordances(input.affordances);

  return {
    id: input.id,
    actorId: input.actorId,
    simTime: input.simTime,
    correlationId: input.correlationId,
    context: {
      situation,
      state: input.state,
      memories: compactMemories(input.memories, input.simTime),
    },
    affordances: input.affordances,
  };
}

export class AmbiguousChoiceEngine<TState = unknown> {
  readonly #provider: CognitiveProvider<AmbiguousChoiceContext<TState>>;

  constructor(provider: CognitiveProvider<AmbiguousChoiceContext<TState>>) {
    this.#provider = provider;
  }

  async decide(input: AmbiguousChoiceInput<TState>): Promise<CognitiveDecision> {
    return this.#provider.decide(assembleAmbiguousChoiceRequest(input));
  }
}

export * from "./persisted.ts";
