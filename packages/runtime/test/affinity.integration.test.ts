import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_HOUR,
  asCorrelationId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import {
  CoreWorldRuntime,
  DurableScheduledEventWorker,
  ScheduledEventHandlerRegistry,
} from "../src/index.ts";

const pool = new Pool();
const PERSON_COUNT = 4;
const FRONTIER = simTime(BigInt(SIM_HOUR));

interface PhysiologyRow extends QueryResultRow {
  person_id: string;
  hunger_value: number;
  hunger_recorded_at: string;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: string;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
}

interface InventoryRow extends QueryResultRow {
  owner_id: string;
  available: string;
  consumed: string;
}

interface EventRow extends QueryResultRow {
  id: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  payload: unknown;
  correlation_id: string;
}

interface PendingRow extends QueryResultRow {
  id: string;
  due_at: string;
  type: string;
  payload: unknown;
  correlation_id: string;
  affinity_keys: string[];
}

interface AffinitySnapshot {
  readonly worldTime: string;
  readonly physiology: readonly PhysiologyRow[];
  readonly inventory: readonly InventoryRow[];
  readonly events: readonly EventRow[];
  readonly pending: readonly PendingRow[];
}

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function personId(index: number): PersonId {
  return asPersonId(
    `affinity-person-${String(index + 1).padStart(2, "0")}`,
  );
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  return {
    id,
    // Both physiology frontiers intentionally land at exactly one hour.
    hunger: createHungerState(6_000, simTime(0), 1_000),
    energy: createEnergyState(3_000, simTime(0), 500, 1_500, "awake"),
    inventory: [
      createFoodItem(
        `${id}:meal-1`,
        "Prepared meal",
        6_500,
      ),
      createFoodItem(
        `${id}:meal-2`,
        "Prepared meal",
        6_500,
      ),
    ],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

async function setupPhysiologyWorld(
  connection: Pool,
  name: string,
): Promise<WorldId> {
  const worldId = asWorldId(name);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const runtime = new CoreWorldRuntime(connection);

  await worlds.create(worldId);
  for (let index = 0; index < PERSON_COUNT; index += 1) {
    const id = personId(index);
    await people.create({
      worldId,
      person: makePerson(index),
      at: simTime(0),
    });
    await runtime.scheduleInitialPhysiology(worldId, id, simTime(0));
  }
  return worldId;
}

async function affinitySnapshot(
  connection: Pool,
  worldId: WorldId,
): Promise<AffinitySnapshot> {
  const world = await connection.query<{ current_sim_time: string }>(
    "SELECT current_sim_time::text AS current_sim_time FROM worlds WHERE id = $1",
    [worldId],
  );
  const physiology = await connection.query<PhysiologyRow>(
    `SELECT person_id,
            hunger_value,
            hunger_recorded_at::text AS hunger_recorded_at,
            energy_value,
            energy_recorded_at::text AS energy_recorded_at,
            energy_mode,
            meals_eaten,
            sleep_sessions,
            updated_at_sim::text AS updated_at_sim
       FROM person_physiology
      WHERE world_id = $1
      ORDER BY person_id`,
    [worldId],
  );
  const inventory = await connection.query<InventoryRow>(
    `SELECT owner_id,
            count(*) FILTER (WHERE status = 'available')::text AS available,
            count(*) FILTER (WHERE status = 'consumed')::text AS consumed
       FROM inventory_items
      WHERE world_id = $1
      GROUP BY owner_id
      ORDER BY owner_id`,
    [worldId],
  );
  const events = await connection.query<EventRow>(
    `SELECT id,
            sim_time::text AS sim_time,
            type,
            actor_id,
            payload,
            correlation_id
       FROM domain_events
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const pending = await connection.query<PendingRow>(
    `SELECT id,
            due_at::text AS due_at,
            type,
            payload,
            correlation_id,
            affinity_keys
       FROM scheduled_events
      WHERE world_id = $1
        AND status = 'pending'
      ORDER BY id`,
    [worldId],
  );
  const row = world.rows[0];
  if (row === undefined) throw new Error(`Missing world ${worldId}`);
  return {
    worldTime: row.current_sim_time,
    physiology: physiology.rows,
    inventory: inventory.rows,
    events: events.rows,
    pending: pending.rows.map((entry) => ({
      ...entry,
      affinity_keys: [...entry.affinity_keys].sort(),
    })),
  };
}

async function runTwoWorkers(
  worldId: WorldId,
): Promise<readonly [number, number]> {
  const leftPool = new Pool();
  const rightPool = new Pool();
  try {
    const left = new CoreWorldRuntime(leftPool);
    const right = new CoreWorldRuntime(rightPool);
    return await Promise.all([
      left.processThrough({
        worldId,
        through: FRONTIER,
        workerId: "affinity-runtime-left",
        claimLimit: 1,
      }),
      right.processThrough({
        worldId,
        through: FRONTIER,
        workerId: "affinity-runtime-right",
        claimLimit: 1,
      }),
    ]);
  } finally {
    await Promise.all([leftPool.end(), rightPool.end()]);
  }
}

describe("durable scheduler affinity runtime", () => {
  it("executes independent affinity handlers concurrently across workers", async () => {
    const worldId = asWorldId("affinity-handler-overlap");
    await new PostgresWorldRepository(pool).create(worldId);
    const schedules = new PostgresScheduledEventRepository(pool);
    await schedules.scheduleMany(worldId, [
      {
        id: asScheduledEventId("parallel-alice"),
        dueAt: simTime(10),
        type: "test.parallel-affinity",
        payload: {},
        correlationId: asCorrelationId("parallel-alice"),
        affinityKeys: ["entity:alice"],
      },
      {
        id: asScheduledEventId("parallel-bob"),
        dueAt: simTime(10),
        type: "test.parallel-affinity",
        payload: {},
        correlationId: asCorrelationId("parallel-bob"),
        affinityKeys: ["entity:bob"],
      },
    ]);

    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const handlers = new ScheduledEventHandlerRegistry();
    handlers.register("test.parallel-affinity", async (context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started += 1;
      if (started === 2) releaseBoth();

      await Promise.race([
        bothStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("independent handlers did not overlap")),
            5_000,
          );
        }),
      ]);

      await new PostgresScheduledEventRepository(pool).complete(
        context.worldId,
        context.scheduled.event.id,
        context.workerId,
      );
      active -= 1;
    });

    const leftPool = new Pool();
    const rightPool = new Pool();
    try {
      const left = new DurableScheduledEventWorker(leftPool, handlers);
      const right = new DurableScheduledEventWorker(rightPool, handlers);
      const processed = await Promise.all([
        left.processThrough({
          worldId,
          through: simTime(10),
          workerId: "parallel-left",
          claimLimit: 1,
        }),
        right.processThrough({
          worldId,
          through: simTime(10),
          workerId: "parallel-right",
          claimLimit: 1,
        }),
      ]);
      expect(processed[0] + processed[1]).toBe(2);
      expect(maximumActive).toBe(2);
    } finally {
      await Promise.all([leftPool.end(), rightPool.end()]);
    }
  });

  it("matches sequential physiology semantics under two contending workers", async () => {
    const controlWorld = await setupPhysiologyWorld(
      pool,
      "affinity-physiology-control",
    );
    const concurrentWorld = await setupPhysiologyWorld(
      pool,
      "affinity-physiology-concurrent",
    );

    const controlCount = await new CoreWorldRuntime(pool).processThrough({
      worldId: controlWorld,
      through: FRONTIER,
      workerId: "affinity-control",
    });
    const concurrentCounts = await runTwoWorkers(concurrentWorld);

    expect(controlCount).toBe(PERSON_COUNT * 2);
    expect(concurrentCounts[0] + concurrentCounts[1]).toBe(controlCount);
    expect(await affinitySnapshot(pool, concurrentWorld)).toEqual(
      await affinitySnapshot(pool, controlWorld),
    );
  });

  it("recovers a dead affinity lease and converges to sequential semantics", async () => {
    const controlWorld = await setupPhysiologyWorld(
      pool,
      "affinity-crash-control",
    );
    const crashWorld = await setupPhysiologyWorld(
      pool,
      "affinity-crash-recovery",
    );

    await new CoreWorldRuntime(pool).processThrough({
      worldId: controlWorld,
      through: FRONTIER,
      workerId: "affinity-crash-control-worker",
    });

    const schedules = new PostgresScheduledEventRepository(pool);
    const abandoned = await schedules.claimDue(
      crashWorld,
      FRONTIER,
      "dead-affinity-runtime",
      1,
    );
    expect(abandoned).toHaveLength(1);
    const abandonedEvent = abandoned[0];
    if (abandonedEvent === undefined) {
      throw new Error("Crash fixture did not abandon an event");
    }

    await runTwoWorkers(crashWorld);

    await pool.query(
      `UPDATE scheduled_events
          SET locked_at = now() - interval '10 minutes'
        WHERE world_id = $1 AND id = $2`,
      [crashWorld, abandonedEvent.event.id],
    );
    expect(await schedules.requeueStale(crashWorld, new Date())).toBe(1);

    await runTwoWorkers(crashWorld);

    expect(await affinitySnapshot(pool, crashWorld)).toEqual(
      await affinitySnapshot(pool, controlWorld),
    );

    const attempts = await pool.query<{ attempts: number }>(
      `SELECT attempts
         FROM scheduled_events
        WHERE world_id = $1 AND id = $2`,
      [crashWorld, abandonedEvent.event.id],
    );
    expect(attempts.rows[0]?.attempts).toBe(2);
  });
});
