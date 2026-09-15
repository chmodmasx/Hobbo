import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresCognitionRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const cognition = new PostgresCognitionRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

function enqueueInput(worldId = asWorldId("cognition-retry-world")) {
  return {
    worldId,
    requestId: asCognitionRequestId("choice-1"),
    actorId: asEntityId("person-alice"),
    simTime: simTime(500),
    correlationId: asCorrelationId("corr-choice-1"),
    providerId: "granite-openai-compatible",
    modelId: "hobbo-cognition",
    requestHash: "sha256:ambiguous-choice-v1",
    requestPayload: {
      situation: "Bob asks Alice for help.",
      memories: [{ id: "memory-1", score_bps: 9000 }],
    },
    affordances: [
      { id: "help_friend", action_id: "social.help" },
      { id: "ignore_friend", action_id: "social.ignore" },
    ],
    samplingConfig: {
      temperature: 0,
      max_tokens: 96,
      reasoning_effort: "none",
    },
    schemaConfig: {
      type: "json_schema",
      allowed: ["help_friend", "ignore_friend"],
    },
  } as const;
}

const completion = {
  decision: {
    affordance_id: "help_friend",
    intent: "Return Bob's earlier help",
  },
  rawResponse: '{"choices":[{"message":{"content":"ok"}}]}',
  promptTokens: 173,
  completionTokens: 18,
  latencyMs: 912,
} as const;

describe("PostgresCognitionRepository retry-safe provenance", () => {
  it("treats an exact enqueue retry from a fresh pool as the same durable request", async () => {
    const input = enqueueInput();
    await worlds.create(input.worldId);

    const first = await cognition.enqueue(input);
    expect(first.status).toBe("queued");

    const restartedPool = new Pool();
    const restarted = new PostgresCognitionRepository(restartedPool);
    try {
      const retried = await restarted.enqueue(input);
      expect(retried).toEqual(first);

      await expect(
        restarted.enqueue({
          ...input,
          requestPayload: {
            ...input.requestPayload,
            situation: "Alice sees a different situation.",
          },
        }),
      ).rejects.toThrow(/already used for different input/i);
    } finally {
      await restartedPool.end();
    }
  });

  it("resumes running work and returns an already-completed run instead of forcing re-inference", async () => {
    const input = enqueueInput();
    await worlds.create(input.worldId);
    await cognition.enqueue(input);

    const running = await cognition.start(input.worldId, input.requestId);
    expect(running.status).toBe("running");
    expect((await cognition.start(input.worldId, input.requestId)).status).toBe(
      "running",
    );

    const completed = await cognition.complete(
      input.worldId,
      input.requestId,
      completion,
    );
    expect(completed.status).toBe("completed");
    expect((await cognition.start(input.worldId, input.requestId)).status).toBe(
      "completed",
    );
  });

  it("persists the full provider provenance and accepts only an identical completion retry", async () => {
    const input = enqueueInput();
    await worlds.create(input.worldId);
    await cognition.enqueue(input);
    await cognition.start(input.worldId, input.requestId);
    const first = await cognition.complete(
      input.worldId,
      input.requestId,
      completion,
    );

    const restartedPool = new Pool();
    const restarted = new PostgresCognitionRepository(restartedPool);
    try {
      const retried = await restarted.complete(
        input.worldId,
        input.requestId,
        completion,
      );
      expect(retried).toEqual(first);
      expect(retried).toMatchObject({
        providerId: "granite-openai-compatible",
        modelId: "hobbo-cognition",
        requestHash: "sha256:ambiguous-choice-v1",
        requestPayload: input.requestPayload,
        affordances: input.affordances,
        samplingConfig: input.samplingConfig,
        schemaConfig: input.schemaConfig,
        decision: completion.decision,
        rawResponse: completion.rawResponse,
        promptTokens: 173,
        completionTokens: 18,
        latencyMs: 912,
      });

      await expect(
        restarted.complete(input.worldId, input.requestId, {
          ...completion,
          decision: {
            affordance_id: "ignore_friend",
            intent: "Changed retry",
          },
        }),
      ).rejects.toThrow(/conflicts with retry output/i);
    } finally {
      await restartedPool.end();
    }
  });

  it("makes failure retries idempotent but never overwrites a completed decision", async () => {
    const failedInput = enqueueInput(asWorldId("cognition-failed-world"));
    await worlds.create(failedInput.worldId);
    await cognition.enqueue(failedInput);

    const failed = await cognition.fail(
      failedInput.worldId,
      failedInput.requestId,
      "provider unavailable",
    );
    expect(failed.status).toBe("failed");
    expect(
      await cognition.fail(
        failedInput.worldId,
        failedInput.requestId,
        "provider unavailable",
      ),
    ).toEqual(failed);
    await expect(
      cognition.fail(
        failedInput.worldId,
        failedInput.requestId,
        "different failure",
      ),
    ).rejects.toThrow(/conflicts with retry error/i);

    const completedInput = enqueueInput(asWorldId("cognition-completed-world"));
    await worlds.create(completedInput.worldId);
    await cognition.enqueue(completedInput);
    await cognition.start(completedInput.worldId, completedInput.requestId);
    await cognition.complete(
      completedInput.worldId,
      completedInput.requestId,
      completion,
    );

    await expect(
      cognition.fail(
        completedInput.worldId,
        completedInput.requestId,
        "late worker failure",
      ),
    ).rejects.toThrow(/cannot transition to failed/i);
  });
});
