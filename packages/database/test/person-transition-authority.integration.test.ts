import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
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

function person(id: string): PersonState {
  return {
    id: asPersonId(id),
    hunger: createHungerState(0, simTime(0), 0),
    energy: createEnergyState(8_000, simTime(0), 500, 1_800, "awake"),
    inventory: [],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

describe("claimed physiology transition authority", () => {
  it("rejects a scheduler claim whose event type does not authorize the requested transition", async () => {
    const worldId = asWorldId("person-authority-type-world");
    const personId = asPersonId("alice");
    await worlds.create(worldId);
    await people.create({ worldId, person: person("alice"), at: simTime(0) });

    await schedules.schedule(worldId, {
      id: asScheduledEventId("rent-event"),
      dueAt: simTime(10),
      type: "tenancy.rent_due",
      payload: { personId: "alice" },
      correlationId: asCorrelationId("rent-event"),
    });
    await schedules.claimDue(worldId, simTime(10), "worker-a", 1);

    await expect(
      people.beginSleepClaimed({
        worldId,
        personId,
        scheduledEventId: asScheduledEventId("rent-event"),
        workerId: "worker-a",
      }),
    ).rejects.toThrow(/expected person\.energy_low/i);

    expect((await people.get(worldId, personId))?.person.energy.mode).toBe("awake");
    const row = await pool.query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM scheduled_events WHERE world_id = $1 AND id = $2`,
      [worldId, "rent-event"],
    );
    expect(row.rows[0]).toEqual({ status: "processing", locked_by: "worker-a" });
  });

  it("rejects a correct event type when the claimed payload targets another person", async () => {
    const worldId = asWorldId("person-authority-target-world");
    const alice = asPersonId("alice");
    await worlds.create(worldId);
    await people.create({ worldId, person: person("alice"), at: simTime(0) });
    await people.create({ worldId, person: person("bob"), at: simTime(0) });

    await schedules.schedule(worldId, {
      id: asScheduledEventId("bob-sleep"),
      dueAt: simTime(10),
      type: "person.energy_low",
      payload: { personId: "bob" },
      correlationId: asCorrelationId("bob-sleep"),
    });
    await schedules.claimDue(worldId, simTime(10), "worker-b", 1);

    await expect(
      people.beginSleepClaimed({
        worldId,
        personId: alice,
        scheduledEventId: asScheduledEventId("bob-sleep"),
        workerId: "worker-b",
      }),
    ).rejects.toThrow(/targets bob, expected alice/i);

    expect((await people.get(worldId, alice))?.person.energy.mode).toBe("awake");
  });
});
