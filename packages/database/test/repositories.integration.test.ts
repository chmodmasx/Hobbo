import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asEventId,
  asScheduledEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { ScheduledEventQueue } from "@hobbo/simulation";
import {
  PostgresCognitionRepository,
  PostgresDomainEventRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const events = new PostgresDomainEventRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);
const cognition = new PostgresCognitionRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

describe("transactional world and event persistence", () => {
  it("assigns contiguous event sequences and advances world time atomically", async () => {
    const worldId = asWorldId("world-events");
    await worlds.create(worldId);

    const first = await events.append({
      id: asEventId("event-1"),
      worldId,
      simTime: simTime(10),
      type: "test.first",
      payload: { value: 1 },
      correlationId: asCorrelationId("corr-1"),
    });
    const second = await events.append({
      id: asEventId("event-2"),
      worldId,
      simTime: simTime(10),
      type: "test.second",
      payload: { value: 2 },
      causationId: first.id,
      correlationId: asCorrelationId("corr-1"),
    });

    expect(first.sequence).toBe(1n);
    expect(second.sequence).toBe(2n);

    const world = await worlds.get(worldId);
    expect(world?.currentSimTime).toBe(10n);
    expect(world?.nextEventSequence).toBe(3n);

    const replay = await events.list(worldId);
    expect(replay.map((event) => event.id)).toEqual(["event-1", "event-2"]);
  });

  it("rolls back a partially inserted event batch when an invariant fails", async () => {
    const worldId = asWorldId("world-rollback");
    await worlds.create(worldId);

    await expect(
      events.appendMany(worldId, [
        {
          id: asEventId("event-valid-before-failure"),
          worldId,
          simTime: simTime(20),
          type: "test.valid",
          payload: {},
          correlationId: asCorrelationId("corr-rb"),
        },
        {
          id: asEventId("event-invalid-time"),
          worldId,
          simTime: simTime(19),
          type: "test.invalid",
          payload: {},
          correlationId: asCorrelationId("corr-rb"),
        },
      ]),
    ).rejects.toThrow(/cannot move backwards/i);

    expect(await events.list(worldId)).toEqual([]);
    const world = await worlds.get(worldId);
    expect(world?.currentSimTime).toBe(0n);
    expect(world?.nextEventSequence).toBe(1n);
  });

  it("serializes concurrent sequence allocation through the world row lock", async () => {
    const worldId = asWorldId("world-concurrent-events");
    await worlds.create(worldId);

    const [a, b] = await Promise.all([
      events.append({
        id: asEventId("concurrent-a"),
        worldId,
        simTime: simTime(42),
        type: "test.concurrent",
        payload: { source: "a" },
        correlationId: asCorrelationId("corr-a"),
      }),
      events.append({
        id: asEventId("concurrent-b"),
        worldId,
        simTime: simTime(42),
        type: "test.concurrent",
        payload: { source: "b" },
        correlationId: asCorrelationId("corr-b"),
      }),
    ]);

    expect(new Set([a.sequence, b.sequence])).toEqual(new Set([1n, 2n]));
    const persisted = await events.list(worldId);
    expect(persisted.map((event) => event.sequence)).toEqual([1n, 2n]);
  });
});

describe("durable scheduler", () => {
  it("recovers pending work in exact (due time, ordinal) order", async () => {
    const worldId = asWorldId("world-scheduler-recovery");
    await worlds.create(worldId);
    const correlationId = asCorrelationId("corr-schedule");

    await schedules.scheduleMany(worldId, [
      {
        id: asScheduledEventId("same-time-first"),
        dueAt: simTime(100),
        type: "test",
        payload: { n: 1 },
        correlationId,
      },
      {
        id: asScheduledEventId("same-time-second"),
        dueAt: simTime(100),
        type: "test",
        payload: { n: 2 },
        correlationId,
      },
      {
        id: asScheduledEventId("earliest"),
        dueAt: simTime(50),
        type: "test",
        payload: { n: 0 },
        correlationId,
      },
    ]);

    const persisted = await schedules.loadPending(worldId);
    expect(persisted.map((entry) => entry.ordinal)).toEqual([2n, 0n, 1n]);
    expect(persisted.map((entry) => entry.event.id)).toEqual([
      "earliest",
      "same-time-first",
      "same-time-second",
    ]);

    const recoveredQueue = new ScheduledEventQueue();
    for (const entry of persisted) recoveredQueue.schedule(entry.event);
    expect(recoveredQueue.pop()?.id).toBe("earliest");
    expect(recoveredQueue.pop()?.id).toBe("same-time-first");
    expect(recoveredQueue.pop()?.id).toBe("same-time-second");
  });

  it("lets multiple workers claim due work without duplicate ownership", async () => {
    const worldId = asWorldId("world-worker-claims");
    await worlds.create(worldId);
    const correlationId = asCorrelationId("corr-worker");

    await schedules.scheduleMany(
      worldId,
      Array.from({ length: 4 }, (_, index) => ({
        id: asScheduledEventId(`job-${index + 1}`),
        dueAt: simTime(10),
        type: "test.job",
        payload: { index },
        correlationId,
      })),
    );

    const [workerA, workerB] = await Promise.all([
      schedules.claimDue(worldId, simTime(10), "worker-a", 2),
      schedules.claimDue(worldId, simTime(10), "worker-b", 2),
    ]);

    const all = [...workerA, ...workerB];
    expect(all).toHaveLength(4);
    expect(new Set(all.map((entry) => String(entry.event.id))).size).toBe(4);
    expect(all.every((entry) => entry.status === "processing")).toBe(true);
    expect(all.every((entry) => entry.attempts === 1)).toBe(true);

    const ownedByA = workerA[0];
    expect(ownedByA).toBeDefined();
    if (ownedByA === undefined) return;

    await expect(
      schedules.complete(worldId, ownedByA.event.id, "worker-b"),
    ).rejects.toThrow(/not owned/i);
    await schedules.complete(worldId, ownedByA.event.id, "worker-a");
  });
});

describe("persisted cognition replay", () => {
  it("stores a completed decision and loads the replay shape without inference", async () => {
    const worldId = asWorldId("world-cognition");
    const requestId = asCognitionRequestId("request-1");
    await worlds.create(worldId);

    await cognition.enqueue({
      worldId,
      requestId,
      actorId: asEntityId("person-1"),
      simTime: simTime(123),
      correlationId: asCorrelationId("corr-cognition"),
      providerId: "llamacpp",
      modelId: "granite-4.1-3b-Q4_K_M",
      requestHash: "sha256:test-request",
      requestPayload: { hunger: 9_000 },
      affordances: [
        { id: "eat_owned_food" },
        { id: "wait" },
      ],
      schemaConfig: { type: "json_schema" },
    });
    await cognition.start(worldId, requestId);
    await cognition.complete(worldId, requestId, {
      decision: {
        affordance_id: "eat_owned_food",
        intent: "eat the owned sandwich now",
      },
      rawResponse: "{\"choices\":[]}",
      promptTokens: 88,
      completionTokens: 19,
      latencyMs: 4831,
    });

    const replay = await cognition.loadReplayDecision(worldId, requestId);
    expect(replay).toEqual({
      affordanceId: "eat_owned_food",
      intent: "eat the owned sandwich now",
    });
  });
});
