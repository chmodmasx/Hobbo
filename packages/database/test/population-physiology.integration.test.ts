import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  beginSleep,
  consumeFood,
  createEnergyState,
  createFoodItem,
  createHungerState,
  timeUntilEnergyAtLeast,
  timeUntilEnergyAtMost,
  timeUntilHunger,
  wakeUp,
  type PersonState,
} from "@hobbo/agents";
import {
  SIM_DAY,
  addSimTime,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
  type PersonId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  commitScheduledEventOutcome,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();

const AGENT_COUNT = 20;
const FOOD_PER_AGENT = 80;
const HUNGER_THRESHOLD = 7_000;
const SLEEP_THRESHOLD = 2_500;
const WAKE_THRESHOLD = 9_000;
const MIDPOINT = simTime(BigInt(SIM_DAY) * 15n);
const END_TIME = simTime(BigInt(SIM_DAY) * 30n);

interface PhysiologyRow extends QueryResultRow {
  person_id: string;
  hunger_value: number;
  hunger_recorded_at: string;
  hunger_rate_per_hour: number;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: string;
  awake_drain_per_hour: number;
  sleep_recovery_per_hour: number;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
  version: string;
}

interface ItemSummaryRow extends QueryResultRow {
  owner_id: string;
  available: string;
  consumed: string;
}

interface EventRow extends QueryResultRow {
  sequence: string;
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
  ordinal: string;
  type: string;
  payload: unknown;
  correlation_id: string;
}

interface WorldRow extends QueryResultRow {
  current_sim_time: string;
}

interface AttemptRow extends QueryResultRow {
  attempts: string;
}

interface PhysiologySnapshot {
  readonly worldTime: string;
  readonly physiology: readonly PhysiologyRow[];
  readonly items: readonly ItemSummaryRow[];
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
  return asPersonId(`life-person-${String(index + 1).padStart(2, "0")}`);
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  const hunger = 400 + ((index * 173) % 2_600);
  const hungerRate = 450 + (index % 5) * 40;
  const energy = 6_000 + (index % 5) * 500;
  const awakeDrain = 450 + (index % 4) * 50;
  const recovery = 1_600 + (index % 3) * 200;

  return {
    id,
    hunger: createHungerState(hunger, simTime(0), hungerRate),
    energy: createEnergyState(
      energy,
      simTime(0),
      awakeDrain,
      recovery,
      "awake",
    ),
    inventory: Array.from({ length: FOOD_PER_AGENT }, (_, itemIndex) =>
      createFoodItem(
        `${id}:food-${String(itemIndex + 1).padStart(3, "0")}`,
        "Prepared meal",
        6_500 + ((index + itemIndex) % 4) * 400,
      ),
    ),
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

function hungerEvent(person: PersonState, from: SimTime) {
  const wait = timeUntilHunger(person.hunger, HUNGER_THRESHOLD, from);
  if (wait === undefined) return undefined;
  return {
    id: asScheduledEventId(`hunger:${person.id}:${person.mealsEaten}`),
    dueAt: addSimTime(from, wait),
    type: "person.hunger_threshold",
    payload: { personId: String(person.id) },
    correlationId: asCorrelationId(`hunger:${person.id}:${person.mealsEaten}`),
  };
}

function sleepEvent(person: PersonState, from: SimTime) {
  const wait = timeUntilEnergyAtMost(person.energy, SLEEP_THRESHOLD, from);
  if (wait === undefined) return undefined;
  const session = person.sleepSessions + 1;
  return {
    id: asScheduledEventId(`sleep:${person.id}:${session}`),
    dueAt: addSimTime(from, wait),
    type: "person.energy_low",
    payload: { personId: String(person.id) },
    correlationId: asCorrelationId(`sleep:${person.id}:${session}`),
  };
}

function wakeEvent(person: PersonState, from: SimTime) {
  const wait = timeUntilEnergyAtLeast(person.energy, WAKE_THRESHOLD, from);
  if (wait === undefined) return undefined;
  return {
    id: asScheduledEventId(`wake:${person.id}:${person.sleepSessions}`),
    dueAt: addSimTime(from, wait),
    type: "person.energy_recovered",
    payload: { personId: String(person.id) },
    correlationId: asCorrelationId(`wake:${person.id}:${person.sleepSessions}`),
  };
}

async function setupPopulation(connection: Pool, worldName: string): Promise<WorldId> {
  const worldId = asWorldId(worldName);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const schedules = new PostgresScheduledEventRepository(connection);
  await worlds.create(worldId);

  for (let index = 0; index < AGENT_COUNT; index += 1) {
    const person = makePerson(index);
    await people.create({ worldId, person, at: simTime(0) });
    const hunger = hungerEvent(person, simTime(0));
    const sleep = sleepEvent(person, simTime(0));
    if (hunger === undefined || sleep === undefined) {
      throw new Error(`Initial physiology did not schedule for ${person.id}`);
    }
    await schedules.scheduleMany(worldId, [hunger, sleep]);
  }

  return worldId;
}

function payloadPersonId(value: unknown): PersonId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Physiology event payload must be an object");
  }
  const valueId = (value as Record<string, unknown>).personId;
  if (typeof valueId !== "string" || valueId.length === 0) {
    throw new Error("Physiology event payload has no personId");
  }
  return asPersonId(valueId);
}

async function processThrough(
  connection: Pool,
  worldId: WorldId,
  through: SimTime,
  workerId: string,
): Promise<number> {
  const people = new PostgresPersonRepository(connection);
  const schedules = new PostgresScheduledEventRepository(connection);
  let processed = 0;

  while (true) {
    const claimed = await schedules.claimDue(worldId, through, workerId, 100);
    if (claimed.length === 0) return processed;

    for (const scheduled of claimed) {
      const at = scheduled.event.dueAt;
      const id = payloadPersonId(scheduled.event.payload);
      const current = await people.get(worldId, id);
      if (current === undefined) throw new Error(`Missing durable person ${id}`);

      if (scheduled.event.type === "person.hunger_threshold") {
        if (current.person.energy.mode === "sleeping") {
          const wait = timeUntilEnergyAtLeast(current.person.energy, WAKE_THRESHOLD, at);
          if (wait === undefined) {
            throw new Error(`Sleeping person ${id} has no wake threshold`);
          }
          const retryAt = addSimTime(at, wait);
          await commitScheduledEventOutcome(connection, {
            worldId,
            eventId: scheduled.event.id,
            workerId,
            processedAt: at,
            domainEvents: [
              {
                id: asEventId(`physiology:${scheduled.event.id}:deferred`),
                worldId,
                simTime: at,
                type: "person.hunger_deferred",
                actorId: asEntityId(String(id)),
                payload: { retryAt: retryAt.toString() },
                correlationId: scheduled.event.correlationId,
              },
            ],
            scheduledEvents: [
              {
                id: asScheduledEventId(
                  `hunger-retry:${id}:${current.person.mealsEaten}:${retryAt}`,
                ),
                dueAt: retryAt,
                type: "person.hunger_threshold",
                payload: { personId: String(id) },
                correlationId: scheduled.event.correlationId,
              },
            ],
          });
          processed += 1;
          continue;
        }

        const item = current.person.inventory[0];
        if (item === undefined) {
          throw new Error(`Durable physiology fixture exhausted food for ${id}`);
        }
        const simulated = consumeFood(current.person, item.id, at);
        const next = hungerEvent(simulated.person, at);
        await people.consumeFoodClaimed({
          worldId,
          personId: id,
          itemId: item.id,
          scheduledEventId: scheduled.event.id,
          workerId,
          scheduledConsequences: next === undefined ? [] : [next],
        });
        processed += 1;
        continue;
      }

      if (scheduled.event.type === "person.energy_low") {
        const simulated = beginSleep(current.person, at);
        const next = wakeEvent(simulated, at);
        if (next === undefined) throw new Error(`Sleep produced no wake for ${id}`);
        await people.beginSleepClaimed({
          worldId,
          personId: id,
          scheduledEventId: scheduled.event.id,
          workerId,
          scheduledConsequences: [next],
        });
        processed += 1;
        continue;
      }

      if (scheduled.event.type === "person.energy_recovered") {
        const simulated = wakeUp(current.person, at);
        const next = sleepEvent(simulated, at);
        if (next === undefined) throw new Error(`Wake produced no sleep for ${id}`);
        await people.wakeUpClaimed({
          worldId,
          personId: id,
          scheduledEventId: scheduled.event.id,
          workerId,
          scheduledConsequences: [next],
        });
        processed += 1;
        continue;
      }

      throw new Error(`Unexpected physiology event type: ${scheduled.event.type}`);
    }
  }
}

async function snapshot(connection: Pool, worldId: WorldId): Promise<PhysiologySnapshot> {
  const world = await connection.query<WorldRow>(
    `SELECT current_sim_time::text AS current_sim_time FROM worlds WHERE id = $1`,
    [worldId],
  );
  const physiology = await connection.query<PhysiologyRow>(
    `SELECT person_id, hunger_value, hunger_recorded_at::text AS hunger_recorded_at,
            hunger_rate_per_hour, energy_value,
            energy_recorded_at::text AS energy_recorded_at, energy_mode,
            awake_drain_per_hour, sleep_recovery_per_hour, meals_eaten,
            sleep_sessions, updated_at_sim::text AS updated_at_sim,
            version::text AS version
       FROM person_physiology
      WHERE world_id = $1
      ORDER BY person_id`,
    [worldId],
  );
  const items = await connection.query<ItemSummaryRow>(
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
    `SELECT sequence::text AS sequence, id, sim_time::text AS sim_time,
            type, actor_id, payload, correlation_id
       FROM domain_events
      WHERE world_id = $1
      ORDER BY sequence`,
    [worldId],
  );
  const pending = await connection.query<PendingRow>(
    `SELECT id, due_at::text AS due_at, ordinal::text AS ordinal,
            type, payload, correlation_id
       FROM scheduled_events
      WHERE world_id = $1 AND status = 'pending'
      ORDER BY due_at, ordinal`,
    [worldId],
  );

  const worldRow = world.rows[0];
  if (worldRow === undefined) throw new Error(`Missing world snapshot ${worldId}`);
  return {
    worldTime: worldRow.current_sim_time,
    physiology: physiology.rows,
    items: items.rows,
    events: events.rows,
    pending: pending.rows,
  };
}

async function totalAttempts(connection: Pool, worldId: WorldId): Promise<bigint> {
  const result = await connection.query<AttemptRow>(
    `SELECT COALESCE(sum(attempts), 0)::text AS attempts
       FROM scheduled_events
      WHERE world_id = $1`,
    [worldId],
  );
  return BigInt(result.rows[0]?.attempts ?? "0");
}

describe("20-agent durable physiology population gate", () => {
  it("matches continuous 30-day body/inventory history after a mid-run process restart", async () => {
    const controlWorld = await setupPopulation(pool, "population-physiology-control");

    const firstProcessPool = new Pool();
    const restartWorld = await setupPopulation(
      firstProcessPool,
      "population-physiology-restart",
    );

    const controlFirstHalf = await processThrough(
      pool,
      controlWorld,
      MIDPOINT,
      "control-physiology-a",
    );
    const restartFirstHalf = await processThrough(
      firstProcessPool,
      restartWorld,
      MIDPOINT,
      "restart-physiology-a",
    );
    expect(restartFirstHalf).toBe(controlFirstHalf);
    expect(controlFirstHalf).toBeGreaterThan(1_000);

    const firstSchedules = new PostgresScheduledEventRepository(firstProcessPool);
    const abandoned = await firstSchedules.claimDue(
      restartWorld,
      END_TIME,
      "dead-physiology-worker",
      1,
    );
    expect(abandoned).toHaveLength(1);
    await firstProcessPool.end();

    const controlSecondHalf = await processThrough(
      pool,
      controlWorld,
      END_TIME,
      "control-physiology-b",
    );
    expect(controlSecondHalf).toBeGreaterThan(1_000);

    const restartedPool = new Pool();
    try {
      const restartedSchedules = new PostgresScheduledEventRepository(restartedPool);
      expect(
        await restartedSchedules.requeueStale(
          restartWorld,
          new Date(Date.now() + 60_000),
          10,
        ),
      ).toBe(1);

      const restartSecondHalf = await processThrough(
        restartedPool,
        restartWorld,
        END_TIME,
        "restart-physiology-b",
      );
      expect(restartSecondHalf).toBe(controlSecondHalf);

      const control = await snapshot(pool, controlWorld);
      const restarted = await snapshot(restartedPool, restartWorld);
      expect(restarted).toEqual(control);

      expect(control.physiology).toHaveLength(AGENT_COUNT);
      expect(control.items).toHaveLength(AGENT_COUNT);
      expect(control.pending).toHaveLength(AGENT_COUNT * 2);
      expect(control.events.length).toBeGreaterThan(2_000);
      expect(
        control.events.some((event) => event.type === "person.hunger_deferred"),
      ).toBe(true);

      for (const row of control.physiology) {
        expect(row.hunger_value).toBeGreaterThanOrEqual(0);
        expect(row.hunger_value).toBeLessThanOrEqual(10_000);
        expect(row.energy_value).toBeGreaterThanOrEqual(0);
        expect(row.energy_value).toBeLessThanOrEqual(10_000);
        expect(row.meals_eaten).toBeGreaterThan(40);
        expect(row.sleep_sessions).toBeGreaterThan(20);
      }
      for (const row of control.items) {
        expect(Number(row.available) + Number(row.consumed)).toBe(FOOD_PER_AGENT);
        expect(Number(row.consumed)).toBeGreaterThan(40);
      }

      expect(await totalAttempts(restartedPool, restartWorld)).toBe(
        (await totalAttempts(pool, controlWorld)) + 1n,
      );
    } finally {
      await restartedPool.end();
    }
  }, 120_000);
});
