import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
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
import {
  GraniteCognitiveProvider,
  type CognitiveFetch,
} from "@hobbo/ai-provider/granite";
import { DurableCognitionExecutor } from "@hobbo/cognition";
import {
  PostgresCognitionRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

interface FixtureContext {
  readonly situation: string;
  readonly memory: string;
}

const worldId = asWorldId("cognition-executor-world");
const requestId = asCognitionRequestId("ambiguous-choice-1");

function request(): CognitiveRequest<FixtureContext> {
  return {
    id: requestId,
    actorId: asEntityId("person-alice"),
    simTime: simTime(700),
    correlationId: asCorrelationId("ambiguous-choice-corr"),
    context: {
      situation: "Bob asks Alice to help carry groceries.",
      memory: "Bob helped Alice when she needed assistance.",
    },
    affordances: [
      {
        id: asAffordanceId("help_friend"),
        actionId: asActionId("social.help"),
        label: "Help Bob",
        context: { targetId: "person-bob" },
      },
      {
        id: asAffordanceId("ignore_friend"),
        actionId: asActionId("social.ignore"),
        label: "Keep walking",
        context: { targetId: "person-bob" },
      },
    ],
  };
}

function successfulFetch(counter: { value: number }): CognitiveFetch {
  return async () => {
    counter.value += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  affordance_id: "help_friend",
                  intent: "Return Bob's earlier help",
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 201,
            completion_tokens: 16,
          },
        };
      },
      async text() {
        return "";
      },
    };
  };
}

describe("DurableCognitionExecutor with PostgresCognitionRepository", () => {
  it("persists full provenance then replays after a process-style pool restart without inference", async () => {
    await worlds.create(worldId);
    const calls = { value: 0 };
    const repository = new PostgresCognitionRepository(pool);
    const provider = new GraniteCognitiveProvider<FixtureContext>({
      baseUrl: "http://unused.test",
      modelId: "hobbo-cognition",
      fetch: successfulFetch(calls),
      nowMs: (() => {
        const values = [1_000, 1_125];
        return () => values.shift() ?? 1_125;
      })(),
    });
    const executor = new DurableCognitionExecutor(repository, provider);

    const first = await executor.decide(worldId, request());
    expect(first.affordanceId).toBe("help_friend");
    expect(first.replayed).toBe(false);
    expect(calls.value).toBe(1);

    const persisted = await repository.get(worldId, requestId);
    expect(persisted).toMatchObject({
      status: "completed",
      providerId: "granite-openai-compatible",
      modelId: "hobbo-cognition",
      decision: {
        affordance_id: "help_friend",
        intent: "Return Bob's earlier help",
      },
      promptTokens: 201,
      completionTokens: 16,
      latencyMs: 125,
    });
    expect(persisted?.requestHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(persisted?.requestPayload).toMatchObject({
      model: "hobbo-cognition",
      temperature: 0,
      max_tokens: 96,
      reasoning_effort: "none",
    });
    expect(persisted?.schemaConfig).toMatchObject({
      type: "json_schema",
      json_schema: {
        strict: true,
      },
    });

    const restartedPool = new Pool();
    const restartedRepository = new PostgresCognitionRepository(restartedPool);
    let forbiddenCalls = 0;
    const restartedProvider = new GraniteCognitiveProvider<FixtureContext>({
      baseUrl: "http://must-not-be-called.test",
      modelId: "hobbo-cognition",
      fetch: async () => {
        forbiddenCalls += 1;
        throw new Error("replay unexpectedly attempted inference");
      },
    });
    const restartedExecutor = new DurableCognitionExecutor(
      restartedRepository,
      restartedProvider,
    );

    try {
      const replay = await restartedExecutor.decide(worldId, request());
      expect(replay.affordanceId).toBe("help_friend");
      expect(replay.intent).toBe("Return Bob's earlier help");
      expect(replay.replayed).toBe(true);
      expect(forbiddenCalls).toBe(0);
    } finally {
      await restartedPool.end();
    }
  });
});
