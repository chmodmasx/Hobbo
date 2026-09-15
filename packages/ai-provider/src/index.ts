import {
  DomainInvariantError,
  type Affordance,
  type AffordanceId,
  type CognitionRequestId,
  type CorrelationId,
  type EntityId,
  type SimTime,
} from "@hobbo/domain";

export interface CognitiveRequest<TContext = unknown> {
  readonly id: CognitionRequestId;
  readonly actorId: EntityId;
  readonly simTime: SimTime;
  readonly correlationId: CorrelationId;
  readonly context: Readonly<TContext>;
  readonly affordances: readonly Affordance[];
}

export interface CognitiveDecision {
  readonly requestId: CognitionRequestId;
  readonly affordanceId: AffordanceId;
  readonly intent: string;
  readonly providerId: string;
  readonly replayed: boolean;
}

export interface CognitiveDecisionDraft {
  readonly affordanceId: AffordanceId;
  readonly intent: string;
}

export interface CognitiveProvider<TContext = unknown> {
  readonly id: string;
  decide(request: CognitiveRequest<TContext>): Promise<CognitiveDecision>;
}

export type CognitiveDecisionStrategy<TContext = unknown> = (
  request: CognitiveRequest<TContext>,
) => CognitiveDecisionDraft | Promise<CognitiveDecisionDraft>;

function assertDecisionAllowed(
  request: CognitiveRequest,
  decision: CognitiveDecisionDraft,
): void {
  const allowed = request.affordances.some(
    (affordance) => affordance.id === decision.affordanceId,
  );
  if (!allowed) {
    throw new DomainInvariantError(
      `Cognitive provider selected unavailable affordance: ${decision.affordanceId}`,
    );
  }
  if (decision.intent.trim().length === 0) {
    throw new DomainInvariantError("Cognitive provider intent cannot be empty");
  }
}

export class DeterministicMockCognitiveProvider<TContext = unknown>
  implements CognitiveProvider<TContext>
{
  readonly id: string;
  readonly #strategy: CognitiveDecisionStrategy<TContext>;

  constructor(
    strategy?: CognitiveDecisionStrategy<TContext>,
    id = "mock-deterministic",
  ) {
    this.id = id;
    this.#strategy =
      strategy ??
      ((request) => {
        const first = request.affordances[0];
        if (first === undefined) {
          throw new DomainInvariantError(
            "Cognitive request must contain at least one affordance",
          );
        }
        return {
          affordanceId: first.id,
          intent: first.label,
        };
      });
  }

  async decide(request: CognitiveRequest<TContext>): Promise<CognitiveDecision> {
    if (request.affordances.length === 0) {
      throw new DomainInvariantError(
        "Cognitive request must contain at least one affordance",
      );
    }

    const draft = await this.#strategy(request);
    assertDecisionAllowed(request, draft);

    return {
      requestId: request.id,
      affordanceId: draft.affordanceId,
      intent: draft.intent,
      providerId: this.id,
      replayed: false,
    };
  }
}

export class ReplayCognitiveProvider<TContext = unknown>
  implements CognitiveProvider<TContext>
{
  readonly id = "replay";
  readonly #decisions = new Map<string, CognitiveDecisionDraft>();

  constructor(
    decisions: ReadonlyMap<CognitionRequestId, CognitiveDecisionDraft> | readonly [CognitionRequestId, CognitiveDecisionDraft][] = [],
  ) {
    for (const [requestId, decision] of decisions) {
      this.#decisions.set(String(requestId), decision);
    }
  }

  record(requestId: CognitionRequestId, decision: CognitiveDecisionDraft): void {
    const key = String(requestId);
    if (this.#decisions.has(key)) {
      throw new DomainInvariantError(
        `Replay decision already exists for cognition request: ${key}`,
      );
    }
    this.#decisions.set(key, decision);
  }

  async decide(request: CognitiveRequest<TContext>): Promise<CognitiveDecision> {
    const draft = this.#decisions.get(String(request.id));
    if (draft === undefined) {
      throw new DomainInvariantError(
        `Missing replay decision for cognition request: ${request.id}`,
      );
    }
    assertDecisionAllowed(request, draft);

    return {
      requestId: request.id,
      affordanceId: draft.affordanceId,
      intent: draft.intent,
      providerId: this.id,
      replayed: true,
    };
  }
}
