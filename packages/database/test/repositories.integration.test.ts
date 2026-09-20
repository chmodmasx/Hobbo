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
  type WorldId,
} from "@hobbo/domain";
import { ScheduledEventQueue } from "@hobbo/simulation";
import {
  PostgresCognitionRepository,
  PostgresDomainEventRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
  commitScheduledEventOutcome,
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

  it("serializes conflicting affinity while independent workers keep claiming the frontier", async () => {
    const worldId = asWorldId("world-affinity-claims");
    await worlds.create(worldId);
    const correlationId = asCorrelationId("corr-affinity");

    await schedules.scheduleMany(worldId, [
      {
        id: asScheduledEventId("alice-first"),
        dueAt: simTime(10),
        type: "test.job",
        payload: {},
        correlationId,
        affinityKeys: ["entity:alice"],
      },
      {
        id: asScheduledEventId("alice-second"),
        dueAt: simTime(10),
        type: "test.job",
        payload: {},
        correlationId,
        affinityKeys: ["entity:alice"],
      },
      {
        id: asScheduledEventId("bob-independent"),
        dueAt: simTime(10),
        type: "test.job",
        payload: {},
        correlationId,
        affinityKeys: ["entity:bob"],
      },
    ]);

    const [firstClaim, secondClaim] = await Promise.all([
      schedules.claimDue(worldId, simTime(10), "worker-a", 1),
      schedules.claimDue(worldId, simTime(10), "worker-b", 1),
    ]);

    const claimedIds = [...firstClaim, ...secondClaim]
      .map((entry) => String(entry.event.id))
      .sort();
    expect(claimedIds).toEqual(["alice-first", "bob-independent"]);
    expect(
      [...firstClaim, ...secondClaim].some(
        (entry) => entry.event.id === "alice-second",
      ),
    ).toBe(false);

    const aliceClaim = [...firstClaim, ...secondClaim].find(
      (entry) => entry.event.id === "alice-first",
    );
    const bobClaim = [...firstClaim, ...secondClaim].find(
      (entry) => entry.event.id === "bob-independent",
    );
    expect(aliceClaim?.lockedBy).toBeDefined();
    expect(bobClaim?.lockedBy).toBeDefined();

    if (bobClaim?.lockedBy === undefined || aliceClaim?.lockedBy === undefined) {
      throw new Error("Affinity fixture did not return owned claims");
    }
    await schedules.complete(
      worldId,
      bobClaim.event.id,
      bobClaim.lockedBy,
    );

    expect(
      await schedules.claimDue(
        worldId,
        simTime(10),
        "worker-b",
        1,
      ),
    ).toEqual([]);

    await schedules.complete(
      worldId,
      aliceClaim.event.id,
      aliceClaim.lockedBy,
    );
    const nextAlice = await schedules.claimDue(
      worldId,
      simTime(10),
      "worker-b",
      1,
    );
    expect(nextAlice.map((entry) => entry.event.id)).toEqual([
      "alice-second",
    ]);
  });

  it("releases durable affinity when a stale processing lease is requeued", async () => {
    const worldId = asWorldId("world-affinity-stale");
    await worlds.create(worldId);
    const correlationId = asCorrelationId("corr-affinity-stale");

    await schedules.scheduleMany(worldId, [
      {
        id: asScheduledEventId("affinity-stale-first"),
        dueAt: simTime(10),
        type: "test.job",
        payload: {},
        correlationId,
        affinityKeys: ["entity:alice"],
      },
      {
        id: asScheduledEventId("affinity-stale-second"),
        dueAt: simTime(10),
        type: "test.job",
        payload: {},
        correlationId,
        affinityKeys: ["entity:alice"],
      },
    ]);

    const dead = await schedules.claimDue(
      worldId,
      simTime(10),
      "dead-affinity-worker",
      1,
    );
    expect(dead.map((entry) => entry.event.id)).toEqual([
      "affinity-stale-first",
    ]);
    expect(
      await schedules.claimDue(
        worldId,
        simTime(10),
        "replacement-worker",
        1,
      ),
    ).toEqual([]);

    await pool.query(
      `UPDATE scheduled_events
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND id = $2`,
      [worldId, "affinity-stale-first"],
    );
    expect(await schedules.requeueStale(worldId, new Date())).toBe(1);

    const recovered = await schedules.claimDue(
      worldId,
      simTime(10),
      "replacement-worker",
      1,
    );
    expect(recovered.map((entry) => entry.event.id)).toEqual([
      "affinity-stale-first",
    ]);
    expect(recovered[0]?.attempts).toBe(2);
  });

  it("requeues stale processing leases so another worker can recover them", async () => {
    const worldId = asWorldId("world-stale-lease");
    await worlds.create(worldId);
    await schedules.schedule(worldId, {
      id: asScheduledEventId("stale-job"),
      dueAt: simTime(10),
      type: "test.job",
      payload: {},
      correlationId: asCorrelationId("corr-stale"),
    });

    const firstClaim = await schedules.claimDue(
      worldId,
      simTime(10),
      "dead-worker",
      1,
    );
    expect(firstClaim).toHaveLength(1);

    await pool.query(
      `UPDATE scheduled_events
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND id = $2`,
      [worldId, "stale-job"],
    );

    expect(await schedules.requeueStale(worldId, new Date())).toBe(1);

    const recovered = await schedules.claimDue(
      worldId,
      simTime(10),
      "replacement-worker",
      1,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attempts).toBe(2);
    expect(recovered[0]?.lockedBy).toBe("replacement-worker");
  });
});

describe("atomic scheduled-event outcomes", () => {
  it("rolls back world time and event history if a consequence insert fails", async () => {
    const worldId = asWorldId("world-atomic-outcome");
    await worlds.create(worldId);
    const rootId = asScheduledEventId("root-job");
    await schedules.schedule(worldId, {
      id: rootId,
      dueAt: simTime(10),
      type: "test.root",
      payload: {},
      correlationId: asCorrelationId("corr-root"),
    });

    const claimed = await schedules.claimDue(worldId, simTime(10), "worker", 1);
    expect(claimed[0]?.event.id).toBe(rootId);

    await expect(
      commitScheduledEventOutcome(pool, {
        worldId,
        eventId: rootId,
        workerId: "worker",
        processedAt: simTime(10),
        domainEvents: [
          {
            id: asEventId("root-domain-event"),
            worldId,
            simTime: simTime(10),
            type: "test.processed",
            payload: { ok: true },
            correlationId: asCorrelationId("corr-root"),
          },
        ],
        scheduledEvents: [
          {
            id: rootId,
            dueAt: simTime(20),
            type: "test.duplicate",
            payload: {},
            correlationId: asCorrelationId("corr-root-next"),
          },
        ],
      }),
    ).rejects.toThrow();

    expect(await events.list(worldId)).toEqual([]);
    const worldAfterFailure = await worlds.get(worldId);
    expect(worldAfterFailure?.currentSimTime).toBe(0n);
    expect(worldAfterFailure?.nextEventSequence).toBe(1n);

    const status = await pool.query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by
         FROM scheduled_events
        WHERE world_id = $1 AND id = $2`,
      [worldId, rootId],
    );
    expect(status.rows[0]).toEqual({ status: "processing", locked_by: "worker" });

    await commitScheduledEventOutcome(pool, {
      worldId,
      eventId: rootId,
      workerId: "worker",
      processedAt: simTime(10),
      domainEvents: [
        {
          id: asEventId("root-domain-event"),
          worldId,
          simTime: simTime(10),
          type: "test.processed",
          payload: { ok: true },
          correlationId: asCorrelationId("corr-root"),
        },
      ],
    });

    expect((await events.list(worldId)).map((event) => event.sequence)).toEqual([1n]);
    expect((await worlds.get(worldId))?.currentSimTime).toBe(10n);
  });
});

interface ChainPayload {
  readonly step: number;
}

function readChainStep(payload: unknown): number {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("step" in payload) ||
    typeof payload.step !== "number" ||
    !Number.isSafeInteger(payload.step)
  ) {
    throw new Error("Invalid chain payload");
  }
  return payload.step;
}

async function seedChain(
  worldRepo: PostgresWorldRepository,
  scheduleRepo: PostgresScheduledEventRepository,
  worldId: WorldId,
): Promise<void> {
  await worldRepo.create(worldId);
  await scheduleRepo.schedule(worldId, {
    id: asScheduledEventId("chain-job-1"),
    dueAt: simTime(10),
    type: "test.chain",
    payload: { step: 1 } satisfies ChainPayload,
    correlationId: asCorrelationId("chain-corr-1"),
  });
}

async function processNextChainStep(
  dbPool: Pool,
  scheduleRepo: PostgresScheduledEventRepository,
  worldId: WorldId,
  workerId: string,
): Promise<boolean> {
  const claimed = await scheduleRepo.claimDue(
    worldId,
    simTime(1_000_000),
    workerId,
    1,
  );
  const job = claimed[0];
  if (job === undefined) return false;

  const step = readChainStep(job.event.payload);
  const domainEventId = asEventId(`chain-event-${step}`);
  const next =
    step < 10
      ? [
          {
            id: asScheduledEventId(`chain-job-${step + 1}`),
            dueAt: simTime((step + 1) * 10),
            type: "test.chain",
            payload: { step: step + 1 } satisfies ChainPayload,
            correlationId: asCorrelationId(`chain-corr-${step + 1}`),
            causationId: domainEventId,
          },
        ]
      : [];

  await commitScheduledEventOutcome(dbPool, {
    worldId,
    eventId: job.event.id,
    workerId,
    processedAt: job.event.dueAt,
    domainEvents: [
      {
        id: domainEventId,
        worldId,
        simTime: job.event.dueAt,
        type: "test.chain.processed",
        payload: { step } satisfies ChainPayload,
        correlationId: job.event.correlationId,
      },
    ],
    scheduledEvents: next,
  });
  return true;
}

async function runChainToCompletion(
  dbPool: Pool,
  scheduleRepo: PostgresScheduledEventRepository,
  worldId: WorldId,
  workerId: string,
): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    if (!(await processNextChainStep(dbPool, scheduleRepo, worldId, workerId))) {
      return;
    }
  }
  throw new Error("Chain guard exhausted");
}

function comparableHistory(
  history: Awaited<ReturnType<PostgresDomainEventRepository["list"]>>,
): unknown {
  return history.map((event) => ({
    sequence: event.sequence,
    id: event.id,
    simTime: event.simTime,
    type: event.type,
    payload: event.payload,
    correlationId: event.correlationId,
    causationId: event.causationId,
  }));
}

describe("crash/restart deterministic continuation", () => {
  it("produces the same history after a worker dies with a claimed event", async () => {
    const referenceWorld = asWorldId("world-reference-run");
    const recoveredWorld = asWorldId("world-recovered-run");

    await seedChain(worlds, schedules, referenceWorld);
    await runChainToCompletion(pool, schedules, referenceWorld, "reference-worker");

    await seedChain(worlds, schedules, recoveredWorld);
    for (let step = 0; step < 5; step += 1) {
      expect(
        await processNextChainStep(pool, schedules, recoveredWorld, "worker-before-crash"),
      ).toBe(true);
    }

    const abandoned = await schedules.claimDue(
      recoveredWorld,
      simTime(1_000_000),
      "dead-worker",
      1,
    );
    expect(abandoned[0]?.event.id).toBe("chain-job-6");

    await pool.query(
      `UPDATE scheduled_events
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND id = $2`,
      [recoveredWorld, "chain-job-6"],
    );

    // New pool/repositories model a fresh process with no in-memory scheduler state.
    const restartedPool = new Pool();
    const restartedSchedules = new PostgresScheduledEventRepository(restartedPool);
    const restartedEvents = new PostgresDomainEventRepository(restartedPool);
    const restartedWorlds = new PostgresWorldRepository(restartedPool);

    try {
      expect(await restartedSchedules.requeueStale(recoveredWorld, new Date())).toBe(1);
      await runChainToCompletion(
        restartedPool,
        restartedSchedules,
        recoveredWorld,
        "worker-after-restart",
      );

      const referenceHistory = await events.list(referenceWorld);
      const recoveredHistory = await restartedEvents.list(recoveredWorld);
      expect(comparableHistory(recoveredHistory)).toEqual(
        comparableHistory(referenceHistory),
      );

      expect(referenceHistory).toHaveLength(10);
      expect(recoveredHistory).toHaveLength(10);
      expect(recoveredHistory.map((event) => event.sequence)).toEqual(
        Array.from({ length: 10 }, (_, index) => BigInt(index + 1)),
      );

      const referenceState = await worlds.get(referenceWorld);
      const recoveredState = await restartedWorlds.get(recoveredWorld);
      expect(recoveredState?.currentSimTime).toBe(referenceState?.currentSimTime);
      expect(recoveredState?.nextEventSequence).toBe(
        referenceState?.nextEventSequence,
      );
      expect(recoveredState?.currentSimTime).toBe(100n);
      expect(recoveredState?.nextEventSequence).toBe(11n);
      expect(await restartedSchedules.loadPending(recoveredWorld)).toEqual([]);

      const scheduledCounts = await restartedPool.query<{
        status: string;
        count: string;
      }>(
        `SELECT status, count(*)::text AS count
           FROM scheduled_events
          WHERE world_id = $1
          GROUP BY status
          ORDER BY status`,
        [recoveredWorld],
      );
      expect(scheduledCounts.rows).toEqual([
        { status: "completed", count: "10" },
      ]);

      const retried = await restartedPool.query<{ attempts: number }>(
        `SELECT attempts
           FROM scheduled_events
          WHERE world_id = $1 AND id = 'chain-job-6'`,
        [recoveredWorld],
      );
      expect(retried.rows[0]?.attempts).toBe(2);
    } finally {
      await restartedPool.end();
    }
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
