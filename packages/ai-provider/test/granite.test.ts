import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import type { CognitiveRequest } from "../src/index.ts";
import {
  DeterministicTraceableCognitiveProvider,
  GraniteCognitiveProvider,
  type CognitiveFetch,
  type CognitiveHttpResponse,
} from "../src/granite.ts";

interface TestContext {
  readonly situation: string;
  readonly memory: string;
  readonly amount: bigint;
}

const helpId = asAffordanceId("help_friend");
const ignoreId = asAffordanceId("ignore_friend");

function request(): CognitiveRequest<TestContext> {
  return {
    id: asCognitionRequestId("choice-1"),
    actorId: asEntityId("person-alice"),
    simTime: simTime(123),
    correlationId: asCorrelationId("corr-1"),
    context: {
      situation: "Bob asks Alice for help.",
      memory: "Bob helped Alice yesterday.",
      amount: 42n,
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

function response(payload: unknown, status = 200): CognitiveHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function successPayload(
  content: unknown = JSON.stringify({
    affordance_id: "help_friend",
    intent: "Return Bob's earlier help",
  }),
): unknown {
  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: 111,
      completion_tokens: 17,
    },
  };
}

describe("DeterministicTraceableCognitiveProvider", () => {
  it("uses the same traceable contract as durable Granite decisions without I/O", async () => {
    const provider = new DeterministicTraceableCognitiveProvider<TestContext>({
      modelId: "dialogue-mock-v1",
      strategy: (input) => ({
        affordanceId: input.affordances[1]!.id,
        intent: "Keep this short",
      }),
    });

    const preparation = provider.prepareRequest(request());
    const run = await provider.decideWithTrace(request());

    expect(preparation).toMatchObject({
      providerId: "mock-traceable",
      modelId: "dialogue-mock-v1",
      samplingConfig: { deterministic: true },
      schemaConfig: { type: "mock-affordance-decision-v1" },
    });
    expect(preparation.requestPayload).toMatchObject({
      request_id: "choice-1",
      actor_id: "person-alice",
      sim_time: "123",
      context: {
        amount: "42",
      },
    });
    expect(run.decision).toEqual({
      requestId: asCognitionRequestId("choice-1"),
      affordanceId: ignoreId,
      intent: "Keep this short",
      providerId: "mock-traceable",
      replayed: false,
    });
    expect(run.trace).toMatchObject({
      ...preparation,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
    });
    expect(JSON.parse(run.trace.rawResponse)).toEqual({
      affordance_id: "ignore_friend",
      intent: "Keep this short",
    });
  });

  it("rejects a deterministic strategy that invents an unavailable affordance", async () => {
    const provider = new DeterministicTraceableCognitiveProvider<TestContext>({
      strategy: () => ({
        affordanceId: asAffordanceId("invented-dialogue-action"),
        intent: "Invent",
      }),
    });

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });
});

describe("GraniteCognitiveProvider", () => {
  it("sends deterministic OpenAI-compatible structured output with the exact affordance enum", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetch: CognitiveFetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body) as unknown;
      return response(successPayload());
    };
    const clock = [1_000, 1_037];
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://127.0.0.1:8086/",
      modelId: "hobbo-cognition",
      fetch,
      nowMs: () => clock.shift() ?? 1_037,
    });

    const run = await provider.decideWithTrace(request());

    expect(capturedUrl).toBe("http://127.0.0.1:8086/v1/chat/completions");
    expect(capturedBody).toMatchObject({
      model: "hobbo-cognition",
      temperature: 0,
      max_tokens: 96,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "hobbo_decision",
          strict: true,
          schema: {
            properties: {
              affordance_id: {
                type: "string",
                enum: ["help_friend", "ignore_friend"],
              },
            },
          },
        },
      },
    });

    const body = capturedBody as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    };
    const userMessage = body.messages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain('"situation":"Bob asks Alice for help."');
    expect(userMessage?.content).toContain('"memory":"Bob helped Alice yesterday."');
    expect(userMessage?.content).toContain('"amount":"42"');
    expect(userMessage?.content).toContain('"id":"help_friend"');
    expect(userMessage?.content).toContain('"action_id":"social.help"');

    expect(run.decision).toEqual({
      requestId: asCognitionRequestId("choice-1"),
      affordanceId: helpId,
      intent: "Return Bob's earlier help",
      providerId: "granite-openai-compatible",
      replayed: false,
    });
    expect(run.trace).toMatchObject({
      providerId: "granite-openai-compatible",
      modelId: "hobbo-cognition",
      promptTokens: 111,
      completionTokens: 17,
      latencyMs: 37,
    });
  });

  it("supports dialogue mode with an utterance-oriented prompt and wider schema", async () => {
    let capturedBody: unknown;
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      mode: "dialogue",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body) as unknown;
        return response(
          successPayload({
            affordance_id: "help_friend",
            intent:
              "Of course, Bob. You helped me before, so I am happy to return the favor.",
          }),
        );
      },
    });

    const decision = await provider.decide(request());
    expect(decision.affordanceId).toBe(helpId);
    expect(decision.intent).toContain("Bob");

    const body = capturedBody as {
      readonly max_tokens: number;
      readonly messages: readonly {
        readonly role: string;
        readonly content: string;
      }[];
      readonly response_format: {
        readonly json_schema: {
          readonly name: string;
          readonly schema: {
            readonly properties: {
              readonly intent: { readonly maxLength: number };
            };
          };
        };
      };
    };
    expect(body.max_tokens).toBe(192);
    expect(body.response_format.json_schema.name).toBe("hobbo_dialogue_turn");
    expect(
      body.response_format.json_schema.schema.properties.intent.maxLength,
    ).toBe(280);
    expect(
      body.messages.find((message) => message.role === "system")?.content,
    ).toContain("exact in-character spoken utterance");
    expect(
      body.messages.find((message) => message.role === "user")?.content,
    ).toContain("exact spoken utterance in intent");
  });

  it("accepts constrained message content returned directly as an object", async () => {
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      fetch: async () =>
        response(
          successPayload({
            affordance_id: "ignore_friend",
            intent: "Conserve energy",
          }),
        ),
    });

    const decision = await provider.decide(request());
    expect(decision.affordanceId).toBe(ignoreId);
    expect(decision.intent).toBe("Conserve energy");
  });

  it("rejects an invented affordance even if a server violates the requested schema", async () => {
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      fetch: async () =>
        response(
          successPayload(
            JSON.stringify({
              affordance_id: "teleport_to_mars",
              intent: "Teleport",
            }),
          ),
        ),
    });

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });

  it("rejects malformed decision content instead of accepting extra model fields", async () => {
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      fetch: async () =>
        response(
          successPayload(
            JSON.stringify({
              affordance_id: "help_friend",
              intent: "Help",
              invented_fact: "Bob is injured",
            }),
          ),
        ),
    });

    await expect(provider.decide(request())).rejects.toThrow(
      /only affordance_id and intent/i,
    );
  });

  it("surfaces HTTP failures with their response body", async () => {
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      fetch: async () => response("model unavailable", 503),
    });

    await expect(provider.decide(request())).rejects.toThrow(
      /HTTP 503: model unavailable/i,
    );
  });

  it("rejects duplicate affordance ids before issuing an HTTP request", async () => {
    let called = false;
    const provider = new GraniteCognitiveProvider<TestContext>({
      baseUrl: "http://localhost:8086",
      modelId: "hobbo-cognition",
      fetch: async () => {
        called = true;
        return response(successPayload());
      },
    });
    const base = request();

    await expect(
      provider.decide({
        ...base,
        affordances: [base.affordances[0]!, base.affordances[0]!],
      }),
    ).rejects.toThrow(/duplicate affordance/i);
    expect(called).toBe(false);
  });
});
