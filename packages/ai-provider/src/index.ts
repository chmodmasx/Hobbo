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

export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingRequest {
  readonly purpose: EmbeddingPurpose;
  readonly inputs: readonly string[];
}

export interface EmbeddingResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly vectors: readonly (readonly number[])[];
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export type DeterministicEmbeddingStrategy = (
  input: string,
  purpose: EmbeddingPurpose,
  index: number,
) => readonly number[];

export class DeterministicMockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly #strategy: DeterministicEmbeddingStrategy;

  constructor(options: {
    readonly modelId?: string;
    readonly id?: string;
    readonly strategy?: DeterministicEmbeddingStrategy;
  } = {}) {
    this.id = options.id ?? "mock-embeddings";
    this.modelId = options.modelId ?? "mock-embedding-model";
    this.#strategy =
      options.strategy ??
      ((input, purpose, index) => [
        input.length,
        purpose === "query" ? 1 : -1,
        index + 1,
      ]);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const inputs = validateEmbeddingInputs(request.inputs);
    const vectors = inputs.map((input, index) => {
      const vector = [...this.#strategy(input, request.purpose, index)];
      assertEmbeddingVector(vector, `Mock embedding ${index}`);
      return vector;
    });
    assertConsistentDimensions(vectors);
    return {
      providerId: this.id,
      modelId: this.modelId,
      vectors,
    };
  }
}

export interface EmbeddingHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface EmbeddingHttpRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type EmbeddingFetch = (
  url: string,
  request: EmbeddingHttpRequest,
) => Promise<EmbeddingHttpResponse>;

export interface NomicEmbeddingProviderOptions {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly expectedDimensions?: number;
  readonly id?: string;
  readonly fetch?: EmbeddingFetch;
}

interface OpenAIEmbeddingDatum {
  readonly index: number;
  readonly embedding: readonly number[];
}

function validateEmbeddingInputs(inputs: readonly string[]): readonly string[] {
  if (inputs.length === 0) {
    throw new DomainInvariantError("Embedding request must contain at least one input");
  }
  return inputs.map((input, index) => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new DomainInvariantError(`Embedding input ${index} cannot be blank`);
    }
    return trimmed;
  });
}

function embeddingNorm(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

function assertEmbeddingVector(vector: readonly number[], label: string): void {
  if (vector.length === 0) {
    throw new DomainInvariantError(`${label} cannot be empty`);
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new DomainInvariantError(`${label} contains a non-finite value`);
    }
  }
  const norm = embeddingNorm(vector);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new DomainInvariantError(`${label} must have a non-zero finite norm`);
  }
}

function assertConsistentDimensions(vectors: readonly (readonly number[])[]): number {
  const first = vectors[0];
  if (first === undefined) {
    throw new DomainInvariantError("Embedding response returned no vectors");
  }
  const dimensions = first.length;
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index]!;
    assertEmbeddingVector(vector, `Embedding vector ${index}`);
    if (vector.length !== dimensions) {
      throw new DomainInvariantError(
        `Embedding dimensions differ: ${vector.length} != ${dimensions}`,
      );
    }
  }
  return dimensions;
}

function nomicInput(purpose: EmbeddingPurpose, input: string): string {
  return `${purpose === "query" ? "search_query" : "search_document"}: ${input}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new DomainInvariantError("Embedding base URL cannot be blank");
  }
  return trimmed;
}

async function defaultEmbeddingFetch(
  url: string,
  request: EmbeddingHttpRequest,
): Promise<EmbeddingHttpResponse> {
  if (typeof globalThis.fetch !== "function") {
    throw new DomainInvariantError("Global fetch is unavailable");
  }
  return globalThis.fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
  });
}

function parseEmbeddingData(payload: unknown): readonly OpenAIEmbeddingDatum[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new DomainInvariantError("Embedding response is missing data");
  }
  const data = (payload as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new DomainInvariantError("Embedding response data must be an array");
  }

  return data.map((item, position) => {
    if (typeof item !== "object" || item === null) {
      throw new DomainInvariantError(`Embedding response item ${position} is invalid`);
    }
    const candidate = item as {
      readonly index?: unknown;
      readonly embedding?: unknown;
    };
    if (!Number.isSafeInteger(candidate.index)) {
      throw new DomainInvariantError(
        `Embedding response item ${position} has invalid index`,
      );
    }
    if (!Array.isArray(candidate.embedding)) {
      throw new DomainInvariantError(
        `Embedding response item ${position} has invalid vector`,
      );
    }
    const vector = candidate.embedding.map((value) => {
      if (typeof value !== "number") {
        throw new DomainInvariantError(
          `Embedding response item ${position} contains a non-number`,
        );
      }
      return value;
    });
    assertEmbeddingVector(vector, `Embedding response item ${position}`);
    return {
      index: candidate.index as number,
      embedding: vector,
    };
  });
}

export class NomicEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #expectedDimensions: number | undefined;
  readonly #fetch: EmbeddingFetch;

  constructor(options: NomicEmbeddingProviderOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const modelId = options.modelId.trim();
    if (modelId.length === 0) {
      throw new DomainInvariantError("Embedding model id cannot be blank");
    }
    if (
      options.expectedDimensions !== undefined &&
      (!Number.isSafeInteger(options.expectedDimensions) ||
        options.expectedDimensions <= 0)
    ) {
      throw new DomainInvariantError(
        "Expected embedding dimensions must be a positive safe integer",
      );
    }
    this.id = options.id ?? "nomic-openai-compatible";
    this.modelId = modelId;
    this.#apiKey = options.apiKey;
    this.#expectedDimensions = options.expectedDimensions;
    this.#fetch = options.fetch ?? defaultEmbeddingFetch;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const inputs = validateEmbeddingInputs(request.inputs);
    const prefixed = inputs.map((input) => nomicInput(request.purpose, input));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.#apiKey !== undefined && this.#apiKey.length > 0) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }

    const response = await this.#fetch(`${this.#baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.modelId,
        input: prefixed,
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        detail = "";
      }
      throw new DomainInvariantError(
        `Embedding request failed with HTTP ${response.status}${
          detail.length === 0 ? "" : `: ${detail}`
        }`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DomainInvariantError(
        `Embedding response is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const data = parseEmbeddingData(payload);
    if (data.length !== inputs.length) {
      throw new DomainInvariantError(
        `Embedding response count mismatch: ${data.length} != ${inputs.length}`,
      );
    }

    const byIndex = new Map<number, readonly number[]>();
    for (const item of data) {
      if (item.index < 0 || item.index >= inputs.length) {
        throw new DomainInvariantError(
          `Embedding response index out of range: ${item.index}`,
        );
      }
      if (byIndex.has(item.index)) {
        throw new DomainInvariantError(
          `Embedding response contains duplicate index: ${item.index}`,
        );
      }
      byIndex.set(item.index, item.embedding);
    }

    const vectors = inputs.map((_, index) => {
      const vector = byIndex.get(index);
      if (vector === undefined) {
        throw new DomainInvariantError(
          `Embedding response is missing index: ${index}`,
        );
      }
      return vector;
    });
    const dimensions = assertConsistentDimensions(vectors);
    if (
      this.#expectedDimensions !== undefined &&
      dimensions !== this.#expectedDimensions
    ) {
      throw new DomainInvariantError(
        `Embedding dimension mismatch: ${dimensions} != ${this.#expectedDimensions}`,
      );
    }

    return {
      providerId: this.id,
      modelId: this.modelId,
      vectors,
    };
  }
}
