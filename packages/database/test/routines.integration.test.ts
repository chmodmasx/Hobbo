import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  SIM_DAY,
  SIM_HOUR,
  asEntityId,
  asRoutineId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  PostgresDomainEventRepository,
  PostgresRoutineRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const routines = new PostgresRoutineRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);
const events = new PostgresDomainEventRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

function dailyRoutine(id = "daily-work") {
  return {
    id: asRoutineId(id),
    ownerId: asEntityId("person-routine"),
    period: simDuration(SIM_DAY),
    phase: simDuration(BigInt(SIM_HOUR) * 9n),
    kind: "work.shift_start",
    payload: { workplace: "cafe" },
  };
}

describe("durable recurring routines", () => {
  it("materializes at most one planned occurrence under concurrent requests", async () => {
    const worldId = asWorldId("routine-concurrent-world");
    await worlds.create(worldId);
    const routine = dailyRoutine();
    await routines.create(worldId, routine);

    const [first, second] = await Promise.all([
      routines.materializeNext(worldId, routine.id, simTime(0)),
      routines.materializeNext(worldId, routine.id, simTime(0)),
    ]);

    expect(second.commitment.id).toBe(first.commitment.id);
    expect(first.commitment.dueAt).toBe(BigInt(SIM_HOUR) * 9n);

    const counts = await pool.query<{ commitments: string; events: string }>(
      `SELECT
         (SELECT count(*)::text FROM commitments
           WHERE world_id = $1 AND routine_id = $2 AND status = 'planned') AS commitments,
         (SELECT count(*)::text FROM scheduled_events
           WHERE world_id = $1 AND status = 'pending') AS events`,
      [worldId, routine.id],
    );
    expect(counts.rows[0]).toEqual({ commitments: "1", events: "1" });
  });

  it("fulfills one occurrence and atomically materializes exactly one next occurrence", async () => {
    const worldId = asWorldId("routine-fulfill-world");
    await worlds.create(worldId);
    const routine = dailyRoutine();
    await routines.create(worldId, routine);
    const first = await routines.materializeNext(worldId, routine.id, simTime(0));

    const claimed = await schedules.claimDue(
      worldId,
      first.commitment.dueAt,
      "routine-worker",
      1,
    );
    expect(claimed).toHaveLength(1);

    const result = await routines.fulfillClaimedAndScheduleNext({
      worldId,
      commitmentId: first.commitment.id,
      workerId: "routine-worker",
      at: first.commitment.dueAt,
    });

    expect(result.fulfilled.commitment.status).toBe("fulfilled");
    expect(result.next?.commitment.status).toBe("planned");
    expect(result.next?.commitment.dueAt).toBe(
      first.commitment.dueAt + BigInt(SIM_DAY),
    );

    const history = await events.list(worldId);
    expect(history).toHaveLength(1);
    expect(history[0]?.type).toBe("commitment.fulfilled");
    expect(history[0]?.simTime).toBe(first.commitment.dueAt);

    const world = await worlds.get(worldId);
    expect(world?.currentSimTime).toBe(first.commitment.dueAt);
    expect(world?.nextEventSequence).toBe(2n);

    const statusCounts = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM commitments
        WHERE world_id = $1
        GROUP BY status
        ORDER BY status`,
      [worldId],
    );
    expect(statusCounts.rows).toEqual([
      { status: "fulfilled", count: "1" },
      { status: "planned", count: "1" },
    ]);

    const scheduledCounts = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM scheduled_events
        WHERE world_id = $1
        GROUP BY status
        ORDER BY status`,
      [worldId],
    );
    expect(scheduledCounts.rows).toEqual([
      { status: "completed", count: "1" },
      { status: "pending", count: "1" },
    ]);
  });

  it("rolls back fulfillment and next materialization when worker ownership is wrong", async () => {
    const worldId = asWorldId("routine-rollback-world");
    await worlds.create(worldId);
    const routine = dailyRoutine();
    await routines.create(worldId, routine);
    const first = await routines.materializeNext(worldId, routine.id, simTime(0));

    await schedules.claimDue(
      worldId,
      first.commitment.dueAt,
      "actual-worker",
      1,
    );

    await expect(
      routines.fulfillClaimedAndScheduleNext({
        worldId,
        commitmentId: first.commitment.id,
        workerId: "wrong-worker",
        at: first.commitment.dueAt,
      }),
    ).rejects.toThrow(/not owned/i);

    const stillPlanned = await routines.getCommitment(
      worldId,
      first.commitment.id,
    );
    expect(stillPlanned?.commitment.status).toBe("planned");
    expect(await events.list(worldId)).toEqual([]);
    expect((await worlds.get(worldId))?.currentSimTime).toBe(0n);

    const commitmentCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM commitments WHERE world_id = $1`,
      [worldId],
    );
    expect(commitmentCount.rows[0]?.count).toBe("1");

    await routines.fulfillClaimedAndScheduleNext({
      worldId,
      commitmentId: first.commitment.id,
      workerId: "actual-worker",
      at: first.commitment.dueAt,
    });
    expect((await events.list(worldId)).map((event) => event.sequence)).toEqual([1n]);
  });

  it("does not materialize another occurrence after a routine is disabled", async () => {
    const worldId = asWorldId("routine-disabled-world");
    await worlds.create(worldId);
    const routine = dailyRoutine("disabled-after-first");
    await routines.create(worldId, routine);
    const first = await routines.materializeNext(worldId, routine.id, simTime(0));
    await routines.setEnabled(worldId, routine.id, false);

    await schedules.claimDue(
      worldId,
      first.commitment.dueAt,
      "routine-worker",
      1,
    );
    const result = await routines.fulfillClaimedAndScheduleNext({
      worldId,
      commitmentId: first.commitment.id,
      workerId: "routine-worker",
      at: first.commitment.dueAt,
    });

    expect(result.next).toBeUndefined();
    expect(await schedules.loadPending(worldId)).toEqual([]);
  });
});
