import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asCorrelationId,
  asScheduledEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("durable scheduler temporal frontier", () => {
  it("never claims a later simulation time while an earlier frontier is pending or processing", async () => {
    const worldId = asWorldId("scheduler-frontier-world");
    const correlationId = asCorrelationId("scheduler-frontier");
    await worlds.create(worldId);

    await schedules.scheduleMany(worldId, [
      {
        id: asScheduledEventId("time-10"),
        dueAt: simTime(10),
        type: "test.frontier",
        payload: {},
        correlationId,
      },
      {
        id: asScheduledEventId("time-20"),
        dueAt: simTime(20),
        type: "test.frontier",
        payload: {},
        correlationId,
      },
    ]);

    const first = await schedules.claimDue(worldId, simTime(100), "worker-a", 100);
    expect(first.map((entry) => entry.event.id)).toEqual(["time-10"]);

    // Even though time-20 is within `through`, worker B cannot cross the
    // unresolved time-10 frontier.
    expect(
      await schedules.claimDue(worldId, simTime(100), "worker-b", 100),
    ).toEqual([]);

    await schedules.complete(worldId, asScheduledEventId("time-10"), "worker-a");

    // A consequence created while resolving time-10 may land between already
    // persisted future work. It must become the new frontier before time-20.
    await schedules.schedule(worldId, {
      id: asScheduledEventId("time-15-consequence"),
      dueAt: simTime(15),
      type: "test.consequence",
      payload: {},
      correlationId,
    });

    const middle = await schedules.claimDue(worldId, simTime(100), "worker-b", 100);
    expect(middle.map((entry) => entry.event.id)).toEqual(["time-15-consequence"]);
    await schedules.complete(
      worldId,
      asScheduledEventId("time-15-consequence"),
      "worker-b",
    );

    const last = await schedules.claimDue(worldId, simTime(100), "worker-c", 100);
    expect(last.map((entry) => entry.event.id)).toEqual(["time-20"]);
  });

  it("still allows workers to split one same-time frontier without duplicate ownership", async () => {
    const worldId = asWorldId("scheduler-frontier-parallel-world");
    const correlationId = asCorrelationId("scheduler-frontier-parallel");
    await worlds.create(worldId);

    await schedules.scheduleMany(
      worldId,
      Array.from({ length: 6 }, (_, index) => ({
        id: asScheduledEventId(`same-time-${index + 1}`),
        dueAt: simTime(10),
        type: "test.same-time",
        payload: { index },
        correlationId,
      })),
    );

    const [workerA, workerB] = await Promise.all([
      schedules.claimDue(worldId, simTime(100), "worker-a", 3),
      schedules.claimDue(worldId, simTime(100), "worker-b", 3),
    ]);

    const all = [...workerA, ...workerB];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((entry) => String(entry.event.id))).size).toBe(6);
    expect(all.every((entry) => entry.event.dueAt === simTime(10))).toBe(true);
  });
});
