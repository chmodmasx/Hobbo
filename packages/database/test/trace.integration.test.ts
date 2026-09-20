import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
} from "@hobbo/agents";
import {
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { entityAffinityKey } from "@hobbo/simulation";
import {
  PostgresConversationRepository,
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresTraceRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const alice = asPersonId("trace-alice");
const bob = asEntityId("trace-bob");
const worldId = asWorldId("trace-world");
const otherWorldId = asWorldId("trace-other-world");

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");

  const worlds = new PostgresWorldRepository(pool);
  const people = new PostgresPersonRepository(pool);
  await worlds.create(worldId);
  await worlds.create(otherWorldId);

  const person = {
    id: alice,
    hunger: createHungerState(2_000, simTime(0), 500),
    energy: createEnergyState(7_000, simTime(0), 450, 1_400, "awake"),
    inventory: [
      createFoodItem("trace-food-1", "Meal one", 6_000),
      createFoodItem("trace-food-2", "Meal two", 6_500),
    ],
    mealsEaten: 0,
    sleepSessions: 0,
  };
  await people.create({ worldId, person, at: simTime(0) });
  await people.create({
    worldId: otherWorldId,
    person: {
      ...person,
      inventory: [
        createFoodItem("other-food", "Other meal", 5_000),
      ],
    },
    at: simTime(0),
  });

  const events = new PostgresDomainEventRepository(pool);
  await events.append({
    id: asEventId("trace-event-1"),
    worldId,
    simTime: simTime(1),
    type: "trace.actor",
    actorId: asEntityId(String(alice)),
    payload: { order: 1 },
    correlationId: asCorrelationId("trace-corr-1"),
  });
  await events.append({
    id: asEventId("trace-event-2"),
    worldId,
    simTime: simTime(2),
    type: "trace.target",
    actorId: bob,
    targetIds: [asEntityId(String(alice))],
    payload: { order: 2 },
    causationId: asEventId("trace-event-1"),
    correlationId: asCorrelationId("trace-corr-1"),
  });
  await events.append({
    id: asEventId("trace-event-3"),
    worldId,
    simTime: simTime(3),
    type: "trace.both",
    actorId: asEntityId(String(alice)),
    targetIds: [bob],
    payload: { order: 3 },
    causationId: asEventId("trace-event-2"),
    correlationId: asCorrelationId("trace-corr-1"),
  });
  await events.append({
    id: asEventId("trace-unrelated"),
    worldId,
    simTime: simTime(4),
    type: "trace.unrelated",
    actorId: bob,
    payload: { secret: false },
    correlationId: asCorrelationId("trace-other"),
  });

  const schedules = new PostgresScheduledEventRepository(pool);
  await schedules.schedule(worldId, {
    id: asScheduledEventId("trace-scheduled-alice"),
    dueAt: simTime(10),
    type: "trace.pending",
    payload: { owner: String(alice) },
    correlationId: asCorrelationId("trace-pending"),
    affinityKeys: [entityAffinityKey(String(alice))],
  });
  await schedules.schedule(worldId, {
    id: asScheduledEventId("trace-scheduled-bob"),
    dueAt: simTime(10),
    type: "trace.pending",
    payload: { owner: String(bob) },
    correlationId: asCorrelationId("trace-pending-bob"),
    affinityKeys: [entityAffinityKey(String(bob))],
  });

  await pool.query(
    `INSERT INTO beliefs (
       world_id, holder_id, subject_id, predicate, value,
       confidence_bps, learned_at, updated_at
     ) VALUES ($1,$2,'cafe-1','closing_hour',$3::jsonb,9000,2,3)`,
    [worldId, alice, JSON.stringify(18)],
  );
  await pool.query(
    `INSERT INTO memories (
       world_id, id, owner_id, category, occurred_at, content,
       importance_bps, emotional_strength_bps, related_entity_ids, metadata
     ) VALUES ($1,'trace-memory',$2,'episodic',3,'Saw Bob near the cafe.',
               7000,1200,$3,$4::jsonb)`,
    [
      worldId,
      alice,
      [String(bob)],
      JSON.stringify({ fixture: "trace" }),
    ],
  );
  await pool.query(
    `INSERT INTO memories (
       world_id, id, owner_id, category, occurred_at, content,
       importance_bps, emotional_strength_bps
     ) VALUES ($1,'other-secret',$2,'episodic',1,'OTHER WORLD SECRET',5000,0)`,
    [otherWorldId, alice],
  );

  await pool.query(
    `INSERT INTO relationships (
       world_id, from_entity_id, to_entity_id,
       familiarity, trust, affection, respect, attraction,
       fear, resentment, dependency, updated_at
     ) VALUES
       ($1,$2,$3,5000,4000,1000,2000,0,0,0,0,3),
       ($1,$3,$2,3000,-1000,0,1000,0,0,500,0,2)`,
    [worldId, alice, bob],
  );

  const conversations = new PostgresConversationRepository(pool);
  const conversation = await conversations.createConversation({
    id: asConversationId("trace-conversation"),
    worldId,
    participantIds: [asEntityId(String(alice)), bob],
    startedAt: simTime(4),
    maxTurns: 2,
  });
  await conversations.appendMessage({
    id: asConversationMessageId("trace-message"),
    worldId,
    conversationId: conversation.id,
    speakerId: bob,
    sentAt: simTime(4),
    text: "The cafe closes at six.",
    sourceEventId: asEventId("trace-event-3"),
    statements: [
      {
        id: asConversationStatementId("trace-statement"),
        subjectId: "cafe-1",
        predicate: "closing_hour",
        value: 18,
        confidenceBps: 8_500,
        origin: "reported",
        claimedSourceEntityId: bob,
        hopCount: 1,
      },
    ],
  });

  await pool.query(
    `INSERT INTO cognition_runs (
       world_id, request_id, actor_id, sim_time, correlation_id,
       provider_id, model_id, request_hash, request_payload, affordances,
       sampling_config, schema_config, decision, raw_response, status,
       prompt_tokens, completion_tokens, latency_ms, started_at, finished_at
     ) VALUES (
       $1,'trace-cognition',$2,3,'trace-cognition-corr',
       'trace-provider','trace-model','sha256:trace',
       $3::jsonb,$4::jsonb,'{}'::jsonb,'{}'::jsonb,$5::jsonb,
       'raw-private-model-output','completed',12,5,7,now(),now()
     )`,
    [
      worldId,
      alice,
      JSON.stringify({ privatePrompt: "must not be returned" }),
      JSON.stringify([{ id: "speak" }]),
      JSON.stringify({
        affordance_id: "speak",
        intent: "Say hello",
      }),
    ],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("read-only person trace repository", () => {
  it("assembles an ordered, bounded, world-isolated durable trace", async () => {
    const traces = new PostgresTraceRepository(pool);
    const snapshot = await traces.inspectPerson(worldId, alice, {
      limit: 2,
      offset: 0,
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.worldId).toBe(worldId);
    expect(snapshot?.currentSimTime).toBe("4");
    expect(snapshot?.page).toEqual({ limit: 2, offset: 0 });

    expect(snapshot?.person.id).toBe(alice);
    expect(snapshot?.person.hunger.value).toBe(2_000);
    expect(snapshot?.person.energy.mode).toBe("awake");
    expect(snapshot?.person.inventory).toMatchObject({
      total: "2",
      available: "2",
      consumed: "0",
    });

    expect(snapshot?.events.map((event) => event.id)).toEqual([
      "trace-event-3",
      "trace-event-2",
    ]);
    expect(snapshot?.events[1]).toMatchObject({
      causationId: "trace-event-1",
      correlationId: "trace-corr-1",
      targetIds: [String(alice)],
    });
    expect(
      snapshot?.events.some((event) => event.id === "trace-unrelated"),
    ).toBe(false);

    expect(snapshot?.scheduledEvents.map((event) => event.id)).toEqual([
      "trace-scheduled-alice",
    ]);
    expect(snapshot?.scheduledEvents[0]?.affinityKeys).toContain(
      entityAffinityKey(String(alice)),
    );

    expect(snapshot?.beliefs).toHaveLength(1);
    expect(snapshot?.beliefs[0]).toMatchObject({
      subjectId: "cafe-1",
      predicate: "closing_hour",
      value: 18,
      confidenceBps: 9_000,
    });

    expect(snapshot?.memories.map((memory) => memory.id)).toEqual([
      "trace-memory",
    ]);
    expect(
      JSON.stringify(snapshot).includes("OTHER WORLD SECRET"),
    ).toBe(false);

    expect(snapshot?.relationships).toHaveLength(2);
    expect(
      snapshot?.relationships.some(
        (relationship) =>
          relationship.fromEntityId === String(alice) &&
          relationship.toEntityId === String(bob),
      ),
    ).toBe(true);
    expect(
      snapshot?.relationships.some(
        (relationship) =>
          relationship.fromEntityId === String(bob) &&
          relationship.toEntityId === String(alice),
      ),
    ).toBe(true);

    expect(snapshot?.conversationMessages).toHaveLength(1);
    expect(snapshot?.conversationMessages[0]).toMatchObject({
      id: "trace-message",
      speakerId: String(bob),
      text: "The cafe closes at six.",
    });
    expect(snapshot?.conversationMessages[0]?.statements[0]).toMatchObject({
      id: "trace-statement",
      subjectId: "cafe-1",
      hopCount: 1,
    });

    expect(snapshot?.cognitionRuns).toHaveLength(1);
    expect(snapshot?.cognitionRuns[0]).toMatchObject({
      requestId: "trace-cognition",
      providerId: "trace-provider",
      modelId: "trace-model",
      requestHash: "sha256:trace",
      status: "completed",
      replayAvailable: true,
      promptTokens: 12,
      completionTokens: 5,
      latencyMs: 7,
    });
    const serialized = JSON.stringify(snapshot?.cognitionRuns[0]);
    expect(serialized).not.toContain("privatePrompt");
    expect(serialized).not.toContain("raw-private-model-output");
  });

  it("paginates recent sections deterministically", async () => {
    const traces = new PostgresTraceRepository(pool);
    const page = await traces.inspectPerson(worldId, alice, {
      limit: 2,
      offset: 1,
    });
    expect(page?.events.map((event) => event.id)).toEqual([
      "trace-event-2",
      "trace-event-1",
    ]);
    expect(page?.page).toEqual({ limit: 2, offset: 1 });
  });

  it("returns undefined for a missing person and rejects unbounded requests", async () => {
    const traces = new PostgresTraceRepository(pool);
    await expect(
      traces.inspectPerson(worldId, asPersonId("missing-person")),
    ).resolves.toBeUndefined();

    await expect(
      traces.inspectPerson(worldId, alice, { limit: 0 }),
    ).rejects.toThrow(/trace limit/i);
    await expect(
      traces.inspectPerson(worldId, alice, { limit: 101 }),
    ).rejects.toThrow(/trace limit/i);
    await expect(
      traces.inspectPerson(worldId, alice, { offset: -1 }),
    ).rejects.toThrow(/trace offset/i);
  });
});
