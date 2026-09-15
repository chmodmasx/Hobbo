import type {
  CognitiveDecision,
  CognitiveRequest,
} from "@hobbo/ai-provider";
import type {
  CognitiveProviderPreparation,
  CognitiveProviderTrace,
  TraceableCognitiveProvider,
} from "@hobbo/ai-provider/granite";
import {
  DomainInvariantError,
  asAffordanceId,
  type CognitionRequestId,
  type WorldId,
} from "@hobbo/domain";

export type DurableCognitionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface DurableCognitionRun {
  readonly status: DurableCognitionStatus;
  readonly providerId: string;
  readonly decision?: unknown;
  readonly errorMessage?: string;
}

export interface CognitionRunStore {
  enqueue(input: {
    readonly worldId: WorldId;
    readonly requestId: CognitionRequestId;
    readonly actorId: CognitiveRequest["actorId"];
    readonly simTime: CognitiveRequest["simTime"];
    readonly correlationId: CognitiveRequest["correlationId"];
    readonly providerId: string;
    readonly modelId?: string;
    readonly requestHash: string;
    readonly requestPayload: unknown;
    readonly affordances: unknown;
    readonly samplingConfig?: unknown;
    readonly schemaConfig?: unknown;
  }): Promise<DurableCognitionRun>;
  start(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<DurableCognitionRun>;
  complete(
    worldId: WorldId,
    requestId: CognitionRequestId,
    output: {
      readonly decision: unknown;
      readonly rawResponse?: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly latencyMs?: number;
    },
  ): Promise<DurableCognitionRun>;
  fail(
    worldId: WorldId,
    requestId: CognitionRequestId,
    errorMessage: string,
  ): Promise<DurableCognitionRun>;
  get(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<DurableCognitionRun | undefined>;
}

function normalizeJson(value: unknown, inArray = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainInvariantError("Cognition provenance cannot contain non-finite numbers");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    if (inArray) return null;
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, true));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeJson(
        (value as Record<string, unknown>)[key],
        false,
      );
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  throw new DomainInvariantError("Cognition provenance contains unsupported data");
}

export function stableCognitionJson(value: unknown): string {
  const normalized = normalizeJson(value);
  if (normalized === undefined) {
    throw new DomainInvariantError("Cognition provenance cannot be undefined");
  }
  return JSON.stringify(normalized);
}

export function cognitionRequestFingerprint(value: unknown): string {
  const input = stableCognitionJson(value);
  let hash = 14_695_981_039_346_656_037n;
  const prime = 1_099_511_628_211n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function persistedDecision(
  value: unknown,
  request: CognitiveRequest,
  providerId: string,
): CognitiveDecision {
  if (
    typeof value !== "object" ||
    value === null ||
    !("affordance_id" in value) ||
    !("intent" in value) ||
    typeof value.affordance_id !== "string" ||
    typeof value.intent !== "string" ||
    value.intent.trim().length === 0
  ) {
    throw new DomainInvariantError(
      `Completed cognition run ${request.id} has invalid persisted decision`,
    );
  }
  const affordanceId = asAffordanceId(value.affordance_id);
  if (!request.affordances.some((affordance) => affordance.id === affordanceId)) {
    throw new DomainInvariantError(
      `Persisted cognition decision selected unavailable affordance: ${affordanceId}`,
    );
  }
  return {
    requestId: request.id,
    affordanceId,
    intent: value.intent,
    providerId,
    replayed: true,
  };
}

function serializableAffordances(request: CognitiveRequest): unknown {
  return request.affordances.map((affordance) => ({
    id: String(affordance.id),
    action_id: String(affordance.actionId),
    label: affordance.label,
    context: normalizeJson(affordance.context),
  }));
}

function semanticPreparation(preparation: CognitiveProviderPreparation): unknown {
  return {
    providerId: preparation.providerId,
    modelId: preparation.modelId,
    requestPayload: preparation.requestPayload,
    samplingConfig: preparation.samplingConfig,
    schemaConfig: preparation.schemaConfig,
  };
}

function completionFromTrace(
  decision: CognitiveDecision,
  trace: CognitiveProviderTrace,
): {
  readonly decision: unknown;
  readonly rawResponse: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
} {
  return {
    decision: {
      affordance_id: String(decision.affordanceId),
      intent: decision.intent,
    },
    rawResponse: trace.rawResponse,
    ...(trace.promptTokens === undefined
      ? {}
      : { promptTokens: trace.promptTokens }),
    ...(trace.completionTokens === undefined
      ? {}
      : { completionTokens: trace.completionTokens }),
    ...(trace.latencyMs === undefined ? {} : { latencyMs: trace.latencyMs }),
  };
}

export class DurableCognitionExecutor<TContext = unknown> {
  readonly #store: CognitionRunStore;
  readonly #provider: TraceableCognitiveProvider<TContext>;

  constructor(
    store: CognitionRunStore,
    provider: TraceableCognitiveProvider<TContext>,
  ) {
    this.#store = store;
    this.#provider = provider;
  }

  async decide(
    worldId: WorldId,
    request: CognitiveRequest<TContext>,
  ): Promise<CognitiveDecision> {
    const preparation = this.#provider.prepareRequest(request);
    const affordances = serializableAffordances(request);
    const requestHash = cognitionRequestFingerprint({
      actorId: String(request.actorId),
      simTime: request.simTime,
      correlationId: String(request.correlationId),
      preparation: semanticPreparation(preparation),
      affordances,
    });

    const queued = await this.#store.enqueue({
      worldId,
      requestId: request.id,
      actorId: request.actorId,
      simTime: request.simTime,
      correlationId: request.correlationId,
      providerId: preparation.providerId,
      modelId: preparation.modelId,
      requestHash,
      requestPayload: preparation.requestPayload,
      affordances,
      samplingConfig: preparation.samplingConfig,
      schemaConfig: preparation.schemaConfig,
    });
    if (queued.status === "completed") {
      return persistedDecision(queued.decision, request, queued.providerId);
    }
    if (queued.status === "failed") {
      throw new DomainInvariantError(
        `Cognition request ${request.id} previously failed: ${
          queued.errorMessage ?? "unknown error"
        }`,
      );
    }

    const started = await this.#store.start(worldId, request.id);
    if (started.status === "completed") {
      return persistedDecision(started.decision, request, started.providerId);
    }
    if (started.status !== "running") {
      throw new DomainInvariantError(
        `Cognition request ${request.id} did not enter running state`,
      );
    }

    try {
      const run = await this.#provider.decideWithTrace(request);
      if (
        stableCognitionJson(semanticPreparation(run.trace)) !==
        stableCognitionJson(semanticPreparation(preparation))
      ) {
        throw new DomainInvariantError(
          `Cognition provider changed request provenance during inference: ${request.id}`,
        );
      }
      await this.#store.complete(
        worldId,
        request.id,
        completionFromTrace(run.decision, run.trace),
      );
      return run.decision;
    } catch (error) {
      const alreadyCompleted = await this.#store.get(worldId, request.id);
      if (alreadyCompleted?.status === "completed") {
        return persistedDecision(
          alreadyCompleted.decision,
          request,
          alreadyCompleted.providerId,
        );
      }

      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.#store.fail(worldId, request.id, message);
      } catch (failureError) {
        const completedDuringFailure = await this.#store.get(
          worldId,
          request.id,
        );
        if (completedDuringFailure?.status === "completed") {
          return persistedDecision(
            completedDuringFailure.decision,
            request,
            completedDuringFailure.providerId,
          );
        }
        throw failureError;
      }
      throw error;
    }
  }
}
