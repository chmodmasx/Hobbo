import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import type { CognitiveRequest } from "@hobbo/ai-provider";
import type {
  CognitiveProviderPreparation,
  CognitiveProviderRun,
  TraceableCognitiveProvider,
} from "@hobbo/ai-provider/granite";
import {
  DurableCognitionExecutor,
  cognitionRequestFingerprint,
  stableCognitionJson,
  type CognitionRunStore,
  type DurableCognitionRun,
} from "../src/persisted.ts";

interface Context {
  readonly situation: string;
  readonly memory: string;
}

const worldId = asWorldId("world-cognition");
const requestId = asCognitionRequestId("choice-1");
const helpId = asAffordanceId("help_friend");
const ignoreId = asAffordanceId("ignore_friend");

function request(): CognitiveRequest<Context> {
  return {
    id: requestId,
    actorId: asEntityId("person-alice"),
    simTime: simTime(100),
    correlationId: asCorrelationId("corr-1"),
    context: {
      situation: "Bob asks for help",
      memory: "Bob helped Alice yesterday",
    },
    affordances: [
      {
        id: helpId,
        actionId: asActionId("social.help"),
        label: "Help Bob",
        context: { targetId: "person-bob" },
      },
      {
        id: ignoreId,
        actionId: asActionId("social.ignore"),
        label: "Keep walking",
        context: { targetId: "person-bob" },
      },
    ],
  };
}

function preparation(): CognitiveProviderPreparation {
  return {
    providerId: "granite-openai-compatible",
    modelId: "hobbo-cognition",
    requestPayload: {
      model: "hobbo-cognition",
      messages: [{ role: "user", content: "fixture" }],
    },
    samplingConfig: { temperature: 0, max_tokens: 96 },
    schemaConfig: {
      type: "json_schema",
      allowed: ["help_friend", "ignore_friend"],
    },
  };
}

class FakeProvider implements TraceableCognitiveProvider<Context> {
  readonly id = "granite-openai-compatible";
  readonly modelId = "hobbo-cognition";
  calls = 0;
  readonly #fail: boolean;
  readonly #mutateTrace: boolean;

  constructor(options: { fail?: boolean; mutateTrace?: boolean } = {}) {
    this.#fail = options.fail ?? false;
    this.#mutateTrace = options.mutateTrace ?? false;
  }

  prepareRequest(): CognitiveProviderPreparation {
    return preparation();
  }

  async decide(input: CognitiveRequest<Context>) {
    return (await this.decideWithTrace(input)).decision;
  }

  async decideWithTrace(
    input: CognitiveRequest<Context>,
  ): Promise<CognitiveProviderRun> {
    this.calls += 1;
    if (this.#fail) throw new Error("llama.cpp unavailable");
    const prepared = preparation();
    return {
      decision: {
        requestId: input.id,
        affordanceId: helpId,
        intent: "Return Bob's help",
        providerId: this.id,
        replayed: false,
      },
      trace: {
        ...prepared,
        ...(this.#mutateTrace
          ? { samplingConfig: { temperature: 1, max_tokens: 96 } }
          : {}),
        rawResponse: '{"choices":[]}',
        promptTokens: 120,
        completionTokens: 14,
        latencyMs: 50,
      },
    };
  }
}

class FakeStore implements CognitionRunStore {
  readonly events: string[] = [];
  enqueued: Parameters<CognitionRunStore["enqueue"]>[0] | undefined;
  completed: Parameters<CognitionRunStore["complete"]>[2] | undefined;
  failedMessage: string | undefined;
  enqueueResult: DurableCognitionRun = {
    status: "queued",
    providerId: "granite-openai-compatible",
  };
  startResult: DurableCognitionRun = {
    status: "running",
    providerId: "granite-openai-compatible",
  };

  async enqueue(input: Parameters<CognitionRunStore["enqueue"]>[0]) {
    this.events.push("enqueue");
    this.enqueued = input;
    return this.enqueueResult;
  }

  async start() {
    this.events.push("start");
    return this.startResult;
  }

  async complete(
    _worldId: Parameters<CognitionRunStore["complete"]>[0],
    _requestId: Parameters<CognitionRunStore["complete"]>[1],
    output: Parameters<CognitionRunStore["complete"]>[2],
  ) {
    this.events.push("complete");
    this.completed = output;
    return {
      status: "completed" as const,
      providerId: "granite-openai-compatible",
      decision: output.decision,
    };
  }

  async fail(
    _worldId: Parameters<CognitionRunStore["fail"]>[0],
    _requestId: Parameters<CognitionRunStore["fail"]>[1],
    errorMessage: string,
  ) {
    this.events.push("fail");
    this.failedMessage = errorMessage;
    return {
      status: "failed" as const,
      providerId: "granite-openai-compatible",
      errorMessage,
    };
  }
}

describe("durable cognition fingerprints", () => {
  it("is stable across object key insertion order", () => {
    expect(stableCognitionJson({ b: 2, a: 1 })).toBe(
      stableCognitionJson({ a: 1, b: 2 }),
    );
    expect(cognitionRequestFingerprint({ b: 2, a: 1 })).toBe(
      cognitionRequestFingerprint({ a: 1, b: 2 }),
    );
  });

  it("distinguishes bigint values from plain strings", () => {
    expect(cognitionRequestFingerprint({ value: 42n })).not.toBe(
      cognitionRequestFingerprint({ value: "42" }),
    );
  });
});

describe("DurableCognitionExecutor", () => {
  it("persists request provenance before inference and response provenance after it", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const executor = new DurableCognitionExecutor(store, provider);

    const decision = await executor.decide(worldId, request());

    expect(store.events).toEqual(["enqueue", "start", "complete"]);
    expect(provider.calls).toBe(1);
    expect(decision.affordanceId).toBe(helpId);
    expect(store.enqueued).toMatchObject({
      worldId,
      requestId,
      providerId: "granite-openai-compatible",
      modelId: "hobbo-cognition",
      requestPayload: preparation().requestPayload,
      samplingConfig: preparation().samplingConfig,
      schemaConfig: preparation().schemaConfig,
    });
    expect(store.enqueued?.requestHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(store.completed).toEqual({
      decision: {
        affordance_id: "help_friend",
        intent: "Return Bob's help",
      },
      rawResponse: '{"choices":[]}',
      promptTokens: 120,
      completionTokens: 14,
      latencyMs: 50,
    });
  });

  it("returns a completed durable decision as replay without inference", async () => {
    const store = new FakeStore();
    store.enqueueResult = {
      status: "completed",
      providerId: "granite-openai-compatible",
      decision: {
        affordance_id: "ignore_friend",
        intent: "Historical choice",
      },
    };
    const provider = new FakeProvider();
    const executor = new DurableCognitionExecutor(store, provider);

    const decision = await executor.decide(worldId, request());

    expect(decision.affordanceId).toBe(ignoreId);
    expect(decision.intent).toBe("Historical choice");
    expect(decision.replayed).toBe(true);
    expect(provider.calls).toBe(0);
    expect(store.events).toEqual(["enqueue"]);
  });

  it("records provider failures durably", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider({ fail: true });
    const executor = new DurableCognitionExecutor(store, provider);

    await expect(executor.decide(worldId, request())).rejects.toThrow(
      /llama\.cpp unavailable/i,
    );
    expect(store.events).toEqual(["enqueue", "start", "fail"]);
    expect(store.failedMessage).toBe("llama.cpp unavailable");
  });

  it("fails closed if provider provenance changes between preparation and response", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider({ mutateTrace: true });
    const executor = new DurableCognitionExecutor(store, provider);

    await expect(executor.decide(worldId, request())).rejects.toThrow(
      /changed request provenance/i,
    );
    expect(store.events).toEqual(["enqueue", "start", "fail"]);
    expect(store.completed).toBeUndefined();
  });
});
