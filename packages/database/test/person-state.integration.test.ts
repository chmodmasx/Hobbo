import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  asCorrelationId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function person(id = "person-alice"): PersonState {
  return {
    id: asPersonId(id),
    hunger: createHungerState(1_200, simTime(0), 600),
    energy: createEnergyState(8_000, simTime(0), 500, 1_800, "awake"),
    inventory: [
      createFoodItem("food-1", "Prepared meal", 6_500),
      createFoodItem("food-2", "Fruit", 3_000),
    ],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

describe("durable person snapshots", () => {
  it("round-trips physiology and physical inventory through a fresh PostgreSQL pool", async () => {
    const worldId = asWorldId("person-roundtrip-world");
    const personId = asPersonId("person-alice");
    await worlds.create(worldId);

    const created = await people.create({
      worldId,
      person: person(),
      at: simTime(0),
    });
    expect(created.version).toBe(0n);
    expect(created.person.inventory.map((item) => item.id)).toEqual([
      "food-1",
      "food-2",
    ]);

    const restartedPool = new Pool();
    try {
      const restartedPeople = new PostgresPersonRepository(restartedPool);
      const reloaded = await restartedPeople.get(worldId, personId);
      expect(reloaded).toEqual(created);
      expect(await restartedPeople.listInventory(worldId, personId)).toHaveLength(2);
    } finally {
      await restartedPool.end();
    }
  });

  it("rejects snapshots from a simulation time different from the authoritative world time", async () => {
    const worldId = asWorldId("person-time-world");
    await worlds.create(worldId);
    await worlds.advanceTime(worldId, simTime(10));

    await expect(
      people.create({
        worldId,
        person: person("person-wrong-time"),
        at: simTime(0),
      }),
    ).rejects.toThrow(/must equal world time/i);
  });
});

describe("claimed durable physiology transitions", () => {
  it("atomically consumes an item, updates physiology, appends history, schedules consequences and completes the claim", async () => {
    const worldId = asWorldId("person-consume-world");
    const personId = asPersonId("person-alice");
    await worlds.create(worldId);
    await people.create({ worldId, person: person(), at: simTime(0) });

    await schedules.schedule(worldId, {
      id: asScheduledEventId("hunger-1"),
      dueAt: simTime(100),
      type: "person.hunger_threshold",
      payload: { personId: String(personId) },
      correlationId: asCorrelationId("hunger-1"),
    });
    const claimed = await schedules.claimDue(worldId, simTime(100), "worker-a", 1);
    expect(claimed).toHaveLength(1);

    const consequence = {
      id: asScheduledEventId("hunger-2"),
      dueAt: simTime(200),
      type: "person.hunger_threshold",
      payload: { personId: String(personId) },
      correlationId: asCorrelationId("hunger-2"),
    };
    const result = await people.consumeFoodClaimed({
      worldId,
      personId,
      itemId: "food-1",
      scheduledEventId: asScheduledEventId("hunger-1"),
      workerId: "worker-a",
      scheduledConsequences: [consequence],
    });

    expect(result.person.version).toBe(1n);
    expect(result.person.person.mealsEaten).toBe(1);
    expect(result.person.person.inventory.map((item) => item.id)).toEqual(["food-2"]);
    expect(result.event.type).toBe("person.ate");
    expect(result.event.simTime).toBe(simTime(100));

    const inventory = await people.listInventory(worldId, personId, true);
    expect(inventory).toEqual([
      expect.objectContaining({
        id: "food-1",
        status: "consumed",
        consumedAt: simTime(100),
      }),
      expect.objectContaining({ id: "food-2", status: "available" }),
    ]);

    const events = await new PostgresDomainEventRepository(pool).list(worldId);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("physiology:hunger-1");

    const pending = await schedules.loadPending(worldId);
    expect(pending.map((entry) => entry.event.id)).toEqual(["hunger-2"]);
    const completed = await pool.query<{ status: string }>(
      `SELECT status FROM scheduled_events WHERE world_id = $1 AND id = $2`,
      [worldId, "hunger-1"],
    );
    expect(completed.rows[0]?.status).toBe("completed");
  });

  it("persists sleep and wake mode transitions across fresh repository instances", async () => {
    const worldId = asWorldId("person-sleep-world");
    const personId = asPersonId("person-alice");
    await worlds.create(worldId);
    await people.create({ worldId, person: person(), at: simTime(0) });

    await schedules.schedule(worldId, {
      id: asScheduledEventId("sleep-1"),
      dueAt: simTime(100),
      type: "person.energy_low",
      payload: { personId: String(personId) },
      correlationId: asCorrelationId("sleep-1"),
    });
    await schedules.claimDue(worldId, simTime(100), "sleep-worker", 1);
    const sleeping = await people.beginSleepClaimed({
      worldId,
      personId,
      scheduledEventId: asScheduledEventId("sleep-1"),
      workerId: "sleep-worker",
      scheduledConsequences: [
        {
          id: asScheduledEventId("wake-1"),
          dueAt: simTime(200),
          type: "person.energy_recovered",
          payload: { personId: String(personId) },
          correlationId: asCorrelationId("wake-1"),
        },
      ],
    });
    expect(sleeping.person.person.energy.mode).toBe("sleeping");
    expect(sleeping.person.person.sleepSessions).toBe(1);

    const restartedPool = new Pool();
    try {
      const restartedPeople = new PostgresPersonRepository(restartedPool);
      const restartedSchedules = new PostgresScheduledEventRepository(restartedPool);
      expect((await restartedPeople.get(worldId, personId))?.person.energy.mode).toBe(
        "sleeping",
      );
      await restartedSchedules.claimDue(worldId, simTime(200), "wake-worker", 1);
      const awake = await restartedPeople.wakeUpClaimed({
        worldId,
        personId,
        scheduledEventId: asScheduledEventId("wake-1"),
        workerId: "wake-worker",
      });
      expect(awake.person.person.energy.mode).toBe("awake");
      expect(awake.person.person.sleepSessions).toBe(1);
      expect(awake.person.version).toBe(2n);
    } finally {
      await restartedPool.end();
    }
  });

  it("leaves no partial body/item/history effects when a claimed transition fails", async () => {
    const worldId = asWorldId("person-transition-rollback-world");
    const personId = asPersonId("person-alice");
    await worlds.create(worldId);
    const original = await people.create({ worldId, person: person(), at: simTime(0) });

    await schedules.schedule(worldId, {
      id: asScheduledEventId("bad-consume"),
      dueAt: simTime(100),
      type: "person.hunger_threshold",
      payload: { personId: String(personId) },
      correlationId: asCorrelationId("bad-consume"),
    });
    await schedules.claimDue(worldId, simTime(100), "rollback-worker", 1);

    await expect(
      people.consumeFoodClaimed({
        worldId,
        personId,
        itemId: "missing-food",
        scheduledEventId: asScheduledEventId("bad-consume"),
        workerId: "rollback-worker",
      }),
    ).rejects.toThrow(/does not own food item/i);

    expect(await people.get(worldId, personId)).toEqual(original);
    expect(await new PostgresDomainEventRepository(pool).list(worldId)).toEqual([]);
    const claimed = await pool.query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM scheduled_events WHERE world_id = $1 AND id = $2`,
      [worldId, "bad-consume"],
    );
    expect(claimed.rows[0]).toEqual({
      status: "processing",
      locked_by: "rollback-worker",
    });
  });
});
