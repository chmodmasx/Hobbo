import { describe, expect, it } from "vitest";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import {
  DeterministicMockCognitiveProvider,
  DeterministicMockEmbeddingProvider,
  NomicEmbeddingProvider,
  ReplayCognitiveProvider,
  type CognitiveRequest,
  type EmbeddingFetch,
  type EmbeddingHttpResponse,
} from "../src/index.ts";

const eatId = asAffordanceId("eat_owned_food");
const waitId = asAffordanceId("wait");

function request(id = "cognition-1"): CognitiveRequest<{ hunger: number }> {
  return {
    id: asCognitionRequestId(id),
    actorId: asEntityId("person-1"),
    simTime: simTime(100),
    correlationId: asCorrelationId("corr-1"),
    context: { hunger: 100 },
    affordances: [
      {
        id: eatId,
        actionId: asActionId("inventory.consume_food"),
        label: "Eat owned sandwich",
        context: { itemId: "sandwich-1" },
      },
      {
        id: waitId,
        actionId: asActionId("activity.wait"),
        label: "Wait",
        context: {},
      },
    ],
  };
}

function jsonResponse(payload: unknown, status = 200): EmbeddingHttpResponse {
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

describe("DeterministicMockCognitiveProvider", () => {
  it("chooses the first affordance deterministically by default", async () => {
    const provider = new DeterministicMockCognitiveProvider();
    const decision = await provider.decide(request());

    expect(decision).toEqual({
      requestId: asCognitionRequestId("cognition-1"),
      affordanceId: eatId,
      intent: "Eat owned sandwich",
      providerId: "mock-deterministic",
      replayed: false,
    });
  });

  it("rejects strategies that invent unavailable affordances", async () => {
    const provider = new DeterministicMockCognitiveProvider(() => ({
      affordanceId: asAffordanceId("teleport_to_mars"),
      intent: "Teleport",
    }));

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });
});

describe("ReplayCognitiveProvider", () => {
  it("returns the recorded decision without inference", async () => {
    const provider = new ReplayCognitiveProvider([
      [
        asCognitionRequestId("cognition-1"),
        { affordanceId: waitId, intent: "Wait for the bus" },
      ],
    ]);

    const decision = await provider.decide(request());
    expect(decision.affordanceId).toBe(waitId);
    expect(decision.providerId).toBe("replay");
    expect(decision.replayed).toBe(true);
  });

  it("fails when replay data is missing instead of silently re-deciding", async () => {
    const provider = new ReplayCognitiveProvider();
    await expect(provider.decide(request("missing"))).rejects.toThrow(
      /missing replay decision/i,
    );
  });

  it("rejects a recorded decision that is invalid for the replayed affordances", async () => {
    const provider = new ReplayCognitiveProvider([
      [
        asCognitionRequestId("cognition-1"),
        {
          affordanceId: asAffordanceId("not-currently-available"),
          intent: "Invalid historical decision",
        },
      ],
    ]);

    await expect(provider.decide(request())).rejects.toThrow(
      /unavailable affordance/i,
    );
  });
});

describe("DeterministicMockEmbeddingProvider", () => {
  it("returns stable local vectors without a model server", async () => {
    const provider = new DeterministicMockEmbeddingProvider({ modelId: "mock-v1" });
    const result = await provider.embed({
      purpose: "query",
      inputs: ["hello", "world"],
    });

    expect(result.modelId).toBe("mock-v1");
    expect(result.providerId).toBe("mock-embeddings");
    expect(result.vectors).toEqual([
      [5, 1, 1],
      [5, 1, 2],
    ]);
  });
});

describe("NomicEmbeddingProvider", () => {
  it("prefixes documents and restores OpenAI-compatible response order by index", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Readonly<Record<string, string>> }> = [];
    const fetch: EmbeddingFetch = async (url, request) => {
      calls.push({
        url,
        body: JSON.parse(request.body) as unknown,
        headers: request.headers,
      });
      return jsonResponse({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      });
    };
    const provider = new NomicEmbeddingProvider({
      baseUrl: "http://127.0.0.1:8087/",
      modelId: "hobbo-embeddings",
      expectedDimensions: 3,
      apiKey: "local-test-key",
      fetch,
    });

    const result = await provider.embed({
      purpose: "document",
      inputs: ["Alice met Bob", "Bob works at the cafe"],
    });

    expect(result.vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8087/v1/embeddings");
    expect(calls[0]?.headers.Authorization).toBe("Bearer local-test-key");
    expect(calls[0]?.body).toEqual({
      model: "hobbo-embeddings",
      input: [
        "search_document: Alice met Bob",
        "search_document: Bob works at the cafe",
      ],
    });
  });

  it("uses search_query for retrieval queries", async () => {
    let postedBody: unknown;
    const fetch: EmbeddingFetch = async (_url, request) => {
      postedBody = JSON.parse(request.body) as unknown;
      return jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] });
    };
    const provider = new NomicEmbeddingProvider({
      baseUrl: "http://localhost:8087",
      modelId: "hobbo-embeddings",
      fetch,
    });

    await provider.embed({
      purpose: "query",
      inputs: ["what does Alice remember about Bob?"],
    });

    expect(postedBody).toEqual({
      model: "hobbo-embeddings",
      input: ["search_query: what does Alice remember about Bob?"],
    });
  });

  it("rejects missing, duplicate or out-of-range response indices", async () => {
    const cases: Array<{ data: unknown[]; pattern: RegExp }> = [
      {
        data: [{ index: 0, embedding: [1, 0] }],
        pattern: /count mismatch/i,
      },
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
        pattern: /duplicate index/i,
      },
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 2, embedding: [0, 1] },
        ],
        pattern: /out of range/i,
      },
    ];

    for (const testCase of cases) {
      const provider = new NomicEmbeddingProvider({
        baseUrl: "http://localhost:8087",
        modelId: "hobbo-embeddings",
        fetch: async () => jsonResponse({ data: testCase.data }),
      });
      await expect(
        provider.embed({ purpose: "document", inputs: ["one", "two"] }),
      ).rejects.toThrow(testCase.pattern);
    }
  });

  it("rejects inconsistent, non-finite, zero or unexpected dimensions", async () => {
    const payloads: Array<{ payload: unknown; pattern: RegExp; expectedDimensions?: number }> = [
      {
        payload: {
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [1, 0, 0] },
          ],
        },
        pattern: /dimensions differ/i,
      },
      {
        payload: { data: [{ index: 0, embedding: [0, 0] }] },
        pattern: /non-zero finite norm/i,
      },
      {
        payload: { data: [{ index: 0, embedding: [1, Number.NaN] }] },
        pattern: /non-finite/i,
      },
      {
        payload: { data: [{ index: 0, embedding: [1, 0] }] },
        pattern: /dimension mismatch/i,
        expectedDimensions: 3,
      },
    ];

    for (const testCase of payloads) {
      const provider = new NomicEmbeddingProvider({
        baseUrl: "http://localhost:8087",
        modelId: "hobbo-embeddings",
        ...(testCase.expectedDimensions === undefined
          ? {}
          : { expectedDimensions: testCase.expectedDimensions }),
        fetch: async () => jsonResponse(testCase.payload),
      });
      const inputs =
        typeof testCase.payload === "object" &&
        testCase.payload !== null &&
        "data" in testCase.payload &&
        Array.isArray((testCase.payload as { data: unknown }).data) &&
        (testCase.payload as { data: unknown[] }).data.length === 2
          ? ["one", "two"]
          : ["one"];
      await expect(
        provider.embed({ purpose: "document", inputs }),
      ).rejects.toThrow(testCase.pattern);
    }
  });

  it("surfaces HTTP failures and rejects blank requests before doing I/O", async () => {
    let calls = 0;
    const fetch: EmbeddingFetch = async () => {
      calls += 1;
      return jsonResponse("server overloaded", 503);
    };
    const provider = new NomicEmbeddingProvider({
      baseUrl: "http://localhost:8087",
      modelId: "hobbo-embeddings",
      fetch,
    });

    await expect(
      provider.embed({ purpose: "query", inputs: ["hello"] }),
    ).rejects.toThrow(/HTTP 503.*server overloaded/i);
    expect(calls).toBe(1);

    await expect(
      provider.embed({ purpose: "query", inputs: ["   "] }),
    ).rejects.toThrow(/cannot be blank/i);
    expect(calls).toBe(1);
  });
});
