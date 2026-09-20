import {
  DomainInvariantError,
  asAffordanceId,
} from "@hobbo/domain";
import type {
  CognitiveDecision,
  CognitiveDecisionDraft,
  CognitiveDecisionStrategy,
  CognitiveProvider,
  CognitiveRequest,
} from "./index.ts";

export interface CognitiveHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface CognitiveHttpRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type CognitiveFetch = (
  url: string,
  request: CognitiveHttpRequest,
) => Promise<CognitiveHttpResponse>;

export interface CognitiveProviderPreparation {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestPayload: unknown;
  readonly samplingConfig: unknown;
  readonly schemaConfig: unknown;
}

export interface CognitiveProviderTrace extends CognitiveProviderPreparation {
  readonly rawResponse: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
}

export interface CognitiveProviderRun {
  readonly decision: CognitiveDecision;
  readonly trace: CognitiveProviderTrace;
}

export interface TraceableCognitiveProvider<TContext = unknown>
  extends CognitiveProvider<TContext> {
  readonly modelId: string;
  prepareRequest(
    request: CognitiveRequest<TContext>,
  ): CognitiveProviderPreparation;
  decideWithTrace(
    request: CognitiveRequest<TContext>,
  ): Promise<CognitiveProviderRun>;
}

export type GraniteCognitiveMode = "decision" | "dialogue";

export interface GraniteCognitiveProviderOptions {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly id?: string;
  readonly mode?: GraniteCognitiveMode;
  readonly maxTokens?: number;
  readonly intentMaxLength?: number;
  readonly fetch?: CognitiveFetch;
  readonly nowMs?: () => number;
}

const DECISION_SYSTEM_PROMPT =
  "You are the decision component of a deterministic social simulation. " +
  "Select exactly one affordance supplied by the simulation. " +
  "Never invent actions, memories, observations, or world state. " +
  "Use the supplied context only. Return only the schema-constrained result.";

const DIALOGUE_SYSTEM_PROMPT =
  "You are the dialogue component of a deterministic social simulation. " +
  "Select exactly one dialogue affordance supplied by the simulation. " +
  "Write the exact in-character spoken utterance in the intent field. " +
  "Never invent actions, memories, observations, beliefs, provenance, or world state. " +
  "Use only the supplied visible context and the selected affordance. " +
  "Return only the schema-constrained result.";

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new DomainInvariantError("Cognition base URL cannot be blank");
  }
  return trimmed;
}

function jsonStringify(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  } catch (error) {
    throw new DomainInvariantError(
      `${label} is not JSON-serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (serialized === undefined) {
    throw new DomainInvariantError(`${label} is not JSON-serializable`);
  }
  return serialized;
}


function assertTraceableMockDecision(
  request: CognitiveRequest,
  decision: CognitiveDecisionDraft,
): void {
  if (
    !request.affordances.some(
      (affordance) => affordance.id === decision.affordanceId,
    )
  ) {
    throw new DomainInvariantError(
      `Traceable mock selected unavailable affordance: ${decision.affordanceId}`,
    );
  }
  if (decision.intent.trim().length === 0) {
    throw new DomainInvariantError(
      "Traceable mock intent cannot be empty",
    );
  }
}

export class DeterministicTraceableCognitiveProvider<TContext = unknown>
  implements TraceableCognitiveProvider<TContext>
{
  readonly id: string;
  readonly modelId: string;
  readonly #strategy: CognitiveDecisionStrategy<TContext>;

  constructor(options: {
    readonly strategy?: CognitiveDecisionStrategy<TContext>;
    readonly id?: string;
    readonly modelId?: string;
  } = {}) {
    this.id = options.id ?? "mock-traceable";
    this.modelId = options.modelId ?? "mock-cognitive-model";
    this.#strategy =
      options.strategy ??
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

  prepareRequest(
    request: CognitiveRequest<TContext>,
  ): CognitiveProviderPreparation {
    if (request.affordances.length === 0) {
      throw new DomainInvariantError(
        "Cognitive request must contain at least one affordance",
      );
    }
    const requestPayload = JSON.parse(
      jsonStringify(
        {
          request_id: String(request.id),
          actor_id: String(request.actorId),
          sim_time: request.simTime,
          correlation_id: String(request.correlationId),
          context: request.context,
          affordances: request.affordances.map((affordance) => ({
            id: String(affordance.id),
            action_id: String(affordance.actionId),
            label: affordance.label,
            context: affordance.context,
          })),
        },
        "Traceable mock request",
      ),
    ) as unknown;
    return {
      providerId: this.id,
      modelId: this.modelId,
      requestPayload,
      samplingConfig: { deterministic: true },
      schemaConfig: { type: "mock-affordance-decision-v1" },
    };
  }

  async decideWithTrace(
    request: CognitiveRequest<TContext>,
  ): Promise<CognitiveProviderRun> {
    const preparation = this.prepareRequest(request);
    const draft = await this.#strategy(request);
    assertTraceableMockDecision(request, draft);
    const decision: CognitiveDecision = {
      requestId: request.id,
      affordanceId: draft.affordanceId,
      intent: draft.intent.trim(),
      providerId: this.id,
      replayed: false,
    };
    return {
      decision,
      trace: {
        ...preparation,
        rawResponse: JSON.stringify({
          affordance_id: String(decision.affordanceId),
          intent: decision.intent,
        }),
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
      },
    };
  }

  async decide(
    request: CognitiveRequest<TContext>,
  ): Promise<CognitiveDecision> {
    return (await this.decideWithTrace(request)).decision;
  }
}

function buildSchema(
  request: CognitiveRequest,
  intentMaxLength: number,
  mode: GraniteCognitiveMode,
): unknown {
  const ids = request.affordances.map((affordance) => String(affordance.id));
  if (ids.length === 0) {
    throw new DomainInvariantError(
      "Cognitive request must contain at least one affordance",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new DomainInvariantError(
      "Cognitive request contains duplicate affordance identities",
    );
  }

  return {
    type: "json_schema",
    json_schema: {
      name: mode === "dialogue" ? "hobbo_dialogue_turn" : "hobbo_decision",
      strict: true,
      schema: {
        type: "object",
        properties: {
          affordance_id: {
            type: "string",
            enum: ids,
          },
          intent: {
            type: "string",
            minLength: 1,
            maxLength: intentMaxLength,
          },
        },
        required: ["affordance_id", "intent"],
        additionalProperties: false,
      },
    },
  };
}

function buildUserContent<TContext>(
  request: CognitiveRequest<TContext>,
  mode: GraniteCognitiveMode,
): string {
  const payload = {
    request_id: String(request.id),
    actor_id: String(request.actorId),
    sim_time: request.simTime.toString(),
    context: request.context,
    affordances: request.affordances.map((affordance) => ({
      id: String(affordance.id),
      action_id: String(affordance.actionId),
      label: affordance.label,
      context: affordance.context,
    })),
  };
  const instruction =
    mode === "dialogue"
      ? "Choose exactly one available dialogue affordance and write the exact spoken utterance in intent from this input:"
      : "Choose exactly one available affordance from this input:";
  return `${instruction}\n${jsonStringify(
    payload,
    "Cognition prompt payload",
  )}`;
}

async function defaultCognitiveFetch(
  url: string,
  request: CognitiveHttpRequest,
): Promise<CognitiveHttpResponse> {
  if (typeof globalThis.fetch !== "function") {
    throw new DomainInvariantError("Global fetch is unavailable");
  }
  return globalThis.fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
  });
}

function parseUsage(payload: unknown): {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
} {
  if (typeof payload !== "object" || payload === null || !("usage" in payload)) {
    return {};
  }
  const usage = (payload as { readonly usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return {};
  }

  const candidate = usage as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
  const result: { promptTokens?: number; completionTokens?: number } = {};
  if (
    Number.isSafeInteger(candidate.prompt_tokens) &&
    (candidate.prompt_tokens as number) >= 0
  ) {
    result.promptTokens = candidate.prompt_tokens as number;
  }
  if (
    Number.isSafeInteger(candidate.completion_tokens) &&
    (candidate.completion_tokens as number) >= 0
  ) {
    result.completionTokens = candidate.completion_tokens as number;
  }
  return result;
}

function parseMessageContent(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("choices" in payload)) {
    throw new DomainInvariantError("Cognition response is missing choices");
  }
  const choices = (payload as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DomainInvariantError("Cognition response choices must be a non-empty array");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) {
    throw new DomainInvariantError("Cognition response is missing message");
  }
  const message = (first as { readonly message?: unknown }).message;
  if (typeof message !== "object" || message === null || !("content" in message)) {
    throw new DomainInvariantError("Cognition response is missing message content");
  }
  const content = (message as { readonly content?: unknown }).content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new DomainInvariantError(
        `Cognition message content is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (typeof content === "object" && content !== null) {
    return content;
  }
  throw new DomainInvariantError("Cognition message content has invalid type");
}

function decisionFromUnknown(
  payload: unknown,
  request: CognitiveRequest,
  providerId: string,
  intentMaxLength: number,
): CognitiveDecision {
  if (typeof payload !== "object" || payload === null) {
    throw new DomainInvariantError("Cognition decision must be an object");
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== "affordance_id" || keys[1] !== "intent") {
    throw new DomainInvariantError(
      "Cognition decision must contain only affordance_id and intent",
    );
  }

  const candidate = payload as {
    readonly affordance_id?: unknown;
    readonly intent?: unknown;
  };
  if (
    typeof candidate.affordance_id !== "string" ||
    candidate.affordance_id.length === 0
  ) {
    throw new DomainInvariantError("Cognition decision affordance_id is invalid");
  }
  if (
    typeof candidate.intent !== "string" ||
    candidate.intent.trim().length === 0 ||
    candidate.intent.length > intentMaxLength
  ) {
    throw new DomainInvariantError("Cognition decision intent is invalid");
  }

  const affordanceId = asAffordanceId(candidate.affordance_id);
  if (!request.affordances.some((affordance) => affordance.id === affordanceId)) {
    throw new DomainInvariantError(
      `Cognitive provider selected unavailable affordance: ${affordanceId}`,
    );
  }

  return {
    requestId: request.id,
    affordanceId,
    intent: candidate.intent,
    providerId,
    replayed: false,
  };
}

export class GraniteCognitiveProvider<TContext = unknown>
  implements TraceableCognitiveProvider<TContext>
{
  readonly id: string;
  readonly modelId: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #mode: GraniteCognitiveMode;
  readonly #maxTokens: number;
  readonly #intentMaxLength: number;
  readonly #fetch: CognitiveFetch;
  readonly #nowMs: () => number;

  constructor(options: GraniteCognitiveProviderOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const modelId = options.modelId.trim();
    if (modelId.length === 0) {
      throw new DomainInvariantError("Cognition model id cannot be blank");
    }
    const mode = options.mode ?? "decision";
    const maxTokens = options.maxTokens ?? (mode === "dialogue" ? 192 : 96);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      throw new DomainInvariantError(
        "Cognition maxTokens must be a positive safe integer",
      );
    }

    const intentMaxLength =
      options.intentMaxLength ?? (mode === "dialogue" ? 280 : 80);
    if (!Number.isSafeInteger(intentMaxLength) || intentMaxLength <= 0) {
      throw new DomainInvariantError(
        "Cognition intentMaxLength must be a positive safe integer",
      );
    }

    this.id = options.id ?? "granite-openai-compatible";
    this.modelId = modelId;
    this.#apiKey = options.apiKey;
    this.#mode = mode;
    this.#maxTokens = maxTokens;
    this.#intentMaxLength = intentMaxLength;
    this.#fetch = options.fetch ?? defaultCognitiveFetch;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  prepareRequest(
    request: CognitiveRequest<TContext>,
  ): CognitiveProviderPreparation {
    if (request.affordances.length === 0) {
      throw new DomainInvariantError(
        "Cognitive request must contain at least one affordance",
      );
    }

    const schemaConfig = buildSchema(
      request,
      this.#intentMaxLength,
      this.#mode,
    );
    const samplingConfig = {
      temperature: 0,
      max_tokens: this.#maxTokens,
      reasoning_effort: "none",
      chat_template_kwargs: {
        enable_thinking: false,
      },
    };
    const requestPayload = {
      model: this.modelId,
      ...samplingConfig,
      messages: [
        {
          role: "system",
          content:
            this.#mode === "dialogue"
              ? DIALOGUE_SYSTEM_PROMPT
              : DECISION_SYSTEM_PROMPT,
        },
        { role: "user", content: buildUserContent(request, this.#mode) },
      ],
      response_format: schemaConfig,
    };

    return {
      providerId: this.id,
      modelId: this.modelId,
      requestPayload,
      samplingConfig,
      schemaConfig,
    };
  }

  async decide(request: CognitiveRequest<TContext>): Promise<CognitiveDecision> {
    return (await this.decideWithTrace(request)).decision;
  }

  async decideWithTrace(
    request: CognitiveRequest<TContext>,
  ): Promise<CognitiveProviderRun> {
    const preparation = this.prepareRequest(request);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.#apiKey !== undefined && this.#apiKey.length > 0) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }

    const startedAt = this.#nowMs();
    const response = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: jsonStringify(preparation.requestPayload, "Cognition request"),
    });
    const finishedAt = this.#nowMs();

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        detail = "";
      }
      throw new DomainInvariantError(
        `Cognition request failed with HTTP ${response.status}${
          detail.length === 0 ? "" : `: ${detail}`
        }`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DomainInvariantError(
        `Cognition response is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const decision = decisionFromUnknown(
      parseMessageContent(payload),
      request,
      this.id,
      this.#intentMaxLength,
    );
    const usage = parseUsage(payload);
    const latencyMs = Math.max(0, Math.round(finishedAt - startedAt));

    return {
      decision,
      trace: {
        ...preparation,
        rawResponse: jsonStringify(payload, "Cognition response"),
        ...usage,
        latencyMs,
      },
    };
  }
}
