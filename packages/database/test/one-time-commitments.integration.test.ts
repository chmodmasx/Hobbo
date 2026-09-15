import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asCommitmentId,
  asCorrelationId,
  asEntityId,
  asWorldId,
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
const commitments = new PostgresRoutineRepository(pool);
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

describe("one-time commitments", () => {
  it("persists, schedules and fulfils without inventing a recurrence", async () => {
    const worldId = asWorldId("one-time-world");
    await worlds.create(worldId);

    const planned = await commitments.createOneTime({
      worldId,
      id: asCommitmentId("meet-alex"),
      ownerId: asEntityId("person-1"),
      dueAt: simTime(500),
      kind: "social.meeting",
      payload: { with: "alex", place: "cafe" },
      correlationId: asCorrelationId("meeting:alex:500"),
    });

    expect(planned.commitment.routineId).toBeUndefined();
    expect(planned.commitment.status).toBe("planned");

    const claimed = await schedules.claimDue(worldId, simTime(500), "worker", 1);
    expect(claimed[0]?.event.id).toBe(planned.scheduledEventId);

    const result = await commitments.fulfillClaimedAndScheduleNext({
      worldId,
      commitmentId: planned.commitment.id,
      workerId: "worker",
      at: simTime(500),
    });

    expect(result.fulfilled.commitment.status).toBe("fulfilled");
    expect(result.next).toBeUndefined();
    expect(await schedules.loadPending(worldId)).toEqual([]);
    expect((await events.list(worldId)).map((event) => event.type)).toEqual([
      "commitment.fulfilled",
    ]);
  });
});
