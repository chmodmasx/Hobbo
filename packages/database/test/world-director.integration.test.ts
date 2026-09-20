import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresCognitionRepository,
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldDirectorRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const events = new PostgresDomainEventRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);
const cognition = new PostgresCognitionRepository(pool);
const director = new PostgresWorldDirectorRepository(pool);

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function person(id: string): PersonState {
  return {
    id: asPersonId(id),
    hunger: createHungerState(0, simTime(0), 0),
    energy: createEnergyState(10_000, simTime(0), 0, 0, "awake"),
    inventory: [],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

async function seedWorld(name: string) {
  const worldId = asWorldId(name);
  await worlds.create(worldId);
  for (let index = 1; index <= 5; index += 1) {
    await people.create({
      worldId,
      person: person(`person-${String(index).padStart(2, "0")}`),
      at: simTime(0),
    });
  }
  await events.appendMany(
    worldId,
    [1, 2, 3, 4].map((index) => ({
      id: asEventId(`summary-event-${index}`),
      worldId,
      simTime: simTime(0),
      type: `summary.event.${index}`,
      payload: { index },
      correlationId: asCorrelationId(`summary-event-${index}`),
    })),
  );
  return worldId;
}

describe("PostgresWorldDirectorRepository", () => {
  it("loads bounded recent events and rotates a deterministic population window", async () => {
    const worldId = await seedWorld("director-summary-world");

    const first = await director.loadSummary(worldId, {
      maxPeople: 2,
      maxRecentEvents: 2,
      sampleOrdinal: 1,
    });
    const second = await director.loadSummary(worldId, {
      maxPeople: 2,
      maxRecentEvents: 2,
      sampleOrdinal: 2,
    });
    const wrapped = await director.loadSummary(worldId, {
      maxPeople: 2,
      maxRecentEvents: 2,
      sampleOrdinal: 3,
    });

    expect(first.populationCount).toBe(5);
    expect(first.sampledPersonIds).toEqual(["person-01", "person-02"]);
    expect(second.sampledPersonIds).toEqual(["person-03", "person-04"]);
    expect(wrapped.sampledPersonIds).toEqual(["person-05", "person-01"]);
    expect(first.recentEvents.map((event) => event.type)).toEqual([
      "summary.event.3",
      "summary.event.4",
    ]);
  });

  it("records one exact replayable proposal per trigger and rejects semantic reuse", async () => {
    const worldId = await seedWorld("director-proposal-world");
    const reviewId = asScheduledEventId("director-review-test");
    await schedules.schedule(worldId, {
      id: reviewId,
      dueAt: simTime(10),
      type: "world_director.review",
      payload: { occurrence: 1, anchorDueAt: "10" },
      correlationId: asCorrelationId("director-review-test"),
      affinityKeys: ["world-director"],
    });

    const requestId = asCognitionRequestId("director-cognition-test");
    await cognition.enqueue({
      worldId,
      requestId,
      actorId: asEntityId("__world_director__"),
      simTime: simTime(10),
      correlationId: asCorrelationId("director-review-test"),
      providerId: "director-test-provider",
      modelId: "director-test-model",
      requestHash: "fnv1a64:0000000000000001",
      requestPayload: { bounded: true },
      affordances: [{ id: "candidate" }],
      samplingConfig: { deterministic: true },
      schemaConfig: { type: "test" },
    });
    await cognition.start(worldId, requestId);
    await cognition.complete(worldId, requestId, {
      decision: {
        affordance_id: "candidate",
        intent: "Create a bounded opportunity",
      },
    });

    const input = {
      worldId,
      id: "director-proposal-test",
      triggerEventId: String(reviewId),
      cognitionRequestId: String(requestId),
      affordanceId: "candidate",
      proposal: {
        status: "accepted" as const,
        kind: "social_opportunity" as const,
        payload: {
          participantIds: ["person-01", "person-02"] as const,
          dueAt: "70",
        },
      },
      intent: "Create a bounded opportunity",
      createdAt: simTime(10),
      effectEventId: "director-effect-test",
    };

    const first = await director.record(input);
    const replay = await director.record(input);
    expect(replay).toEqual(first);

    await expect(
      director.record({
        ...input,
        intent: "Changed semantics",
      }),
    ).rejects.toThrow(/different semantics/i);
  });
});
