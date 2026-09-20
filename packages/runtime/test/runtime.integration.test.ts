import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresEmploymentRepository,
  PostgresHousingRepository,
  PostgresLedgerRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_DAY,
  SIM_HOUR,
  asCorrelationId,
  asEmploymentId,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asPersonId,
  asScheduledEventId,
  asTenancyId,
  asWorldId,
  simDuration,
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
const AGENT_COUNT = 20;
const FOOD_PER_AGENT = 80;
const WAGE_PER_SHIFT = 200n;
const RENT_PER_PERIOD = 400n;
const EMPLOYER_BOOTSTRAP = 1_000_000n;
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

interface ItemRow extends QueryResultRow {
  owner_id: string;
  available: string;
  consumed: string;
}

interface BalanceRow extends QueryResultRow {
  id: string;
  balance: string;
}

interface CommitmentRow extends QueryResultRow {
  id: string;
  owner_id: string;
  due_at: string;
  kind: string;
  status: string;
  resolved_at: string | null;
}

interface LedgerRow extends QueryResultRow {
  id: string;
  sim_time: string;
  type: string;
  idempotency_key: string;
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

interface CountsRow extends QueryResultRow {
  current_sim_time: string;
  salary_count: string;
  rent_count: string;
  work_fulfilled: string;
  work_missed: string;
  rent_fulfilled: string;
}

interface AttemptRow extends QueryResultRow {
  attempts: string;
}

interface IntegratedSnapshot {
  readonly counts: CountsRow;
  readonly physiology: readonly PhysiologyRow[];
  readonly items: readonly ItemRow[];
  readonly balances: readonly BalanceRow[];
  readonly commitments: readonly CommitmentRow[];
  readonly ledger: readonly LedgerRow[];
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
  return asPersonId(`integrated-person-${String(index + 1).padStart(2, "0")}`);
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  const lowMorningEnergy = index % 2 === 0;
  return {
    id,
    hunger: createHungerState(
      500 + ((index * 191) % 2_500),
      simTime(0),
      460 + (index % 5) * 45,
    ),
    energy: createEnergyState(
      lowMorningEnergy ? 4_000 + (index % 3) * 150 : 7_500 + (index % 3) * 400,
      simTime(0),
      480 + (index % 4) * 45,
      1_300 + (index % 3) * 150,
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

async function setupWorld(connection: Pool, worldName: string): Promise<WorldId> {
  const worldId = asWorldId(worldName);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const ledger = new PostgresLedgerRepository(connection);
  const employment = new PostgresEmploymentRepository(connection);
  const housing = new PostgresHousingRepository(connection);
  const runtime = new CoreWorldRuntime(connection);

  const systemAccountId = asLedgerAccountId("system");
  const employerAccountId = asLedgerAccountId("business-payroll");
  const landlordAccountId = asLedgerAccountId("landlord-wallet");
  const employerId = asEntityId("business-employer");
  const landlordId = asEntityId("person-landlord");

  await worlds.create(worldId);
  await ledger.createAccount({
    id: systemAccountId,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
  });
  await ledger.createAccount({
    id: employerAccountId,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: employerId,
  });
  await ledger.createAccount({
    id: landlordAccountId,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: landlordId,
  });
  await ledger.transfer({
    worldId,
    transactionId: asLedgerTransactionId("bootstrap-employer"),
    simTime: simTime(0),
    currency: "HBC",
    fromAccountId: systemAccountId,
    toAccountId: employerAccountId,
    amount: EMPLOYER_BOOTSTRAP,
    idempotencyKey: "bootstrap-employer",
    type: "bootstrap.funding",
  });

  for (let index = 0; index < AGENT_COUNT; index += 1) {
    const id = personId(index);
    const entityId = asEntityId(String(id));
    const walletId = asLedgerAccountId(`${id}:wallet`);
    const person = makePerson(index);

    await people.create({ worldId, person, at: simTime(0) });
    await runtime.scheduleInitialPhysiology(worldId, id, simTime(0));

    await ledger.createAccount({
      id: walletId,
      worldId,
      currency: "HBC",
      kind: "asset",
      allowNegative: false,
      ownerId: entityId,
    });
    await employment.create({
      id: asEmploymentId(`employment:${id}`),
      worldId,
      employerId,
      employeeId: entityId,
      employerAccountId,
      employeeAccountId: walletId,
      currency: "HBC",
      wagePerShift: WAGE_PER_SHIFT,
      workPeriod: simDuration(SIM_DAY),
      workPhase: simDuration(BigInt(SIM_HOUR) * 9n),
      startsAt: simTime(0),
    });

    const unitId = asHousingUnitId(`unit:${id}`);
    await housing.createUnit({
      id: unitId,
      worldId,
      ownerId: landlordId,
      label: `Apartment ${index + 1}`,
    });
    await housing.createTenancy({
      id: asTenancyId(`tenancy:${id}`),
      worldId,
      housingUnitId: unitId,
      landlordId,
      tenantId: entityId,
      landlordAccountId,
      tenantAccountId: walletId,
      currency: "HBC",
      rentPerPeriod: RENT_PER_PERIOD,
      rentPeriod: simDuration(BigInt(SIM_DAY) * 30n),
      rentPhase: simDuration(BigInt(SIM_DAY) * 20n),
      startsAt: simTime(0),
    });
  }

  return worldId;
}

async function snapshot(connection: Pool, worldId: WorldId): Promise<IntegratedSnapshot> {
  const counts = await connection.query<CountsRow>(
    `SELECT
       (SELECT current_sim_time::text FROM worlds WHERE id = $1) AS current_sim_time,
       (SELECT count(*)::text FROM ledger_transactions
         WHERE world_id = $1 AND type = 'employment.salary') AS salary_count,
       (SELECT count(*)::text FROM ledger_transactions
         WHERE world_id = $1 AND type = 'tenancy.rent') AS rent_count,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND kind = 'employment.shift' AND status = 'fulfilled') AS work_fulfilled,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND kind = 'employment.shift' AND status = 'missed') AS work_missed,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND kind = 'tenancy.rent_due' AND status = 'fulfilled') AS rent_fulfilled`,
    [worldId],
  );
  const countRow = counts.rows[0];
  if (countRow === undefined) throw new Error(`Missing integrated world ${worldId}`);

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
  const items = await connection.query<ItemRow>(
    `SELECT owner_id,
            count(*) FILTER (WHERE status = 'available')::text AS available,
            count(*) FILTER (WHERE status = 'consumed')::text AS consumed
       FROM inventory_items
      WHERE world_id = $1
      GROUP BY owner_id
      ORDER BY owner_id`,
    [worldId],
  );
  const balances = await connection.query<BalanceRow>(
    `SELECT account.id,
            COALESCE(sum(entry.amount), 0)::text AS balance
       FROM ledger_accounts AS account
       LEFT JOIN ledger_entries AS entry
         ON entry.world_id = account.world_id
        AND entry.account_id = account.id
      WHERE account.world_id = $1
      GROUP BY account.id
      ORDER BY account.id`,
    [worldId],
  );
  const commitments = await connection.query<CommitmentRow>(
    `SELECT id, owner_id, due_at::text AS due_at, kind, status,
            resolved_at::text AS resolved_at
       FROM commitments
      WHERE world_id = $1
      ORDER BY due_at, id`,
    [worldId],
  );
  const ledger = await connection.query<LedgerRow>(
    `SELECT id, sim_time::text AS sim_time, type, idempotency_key
       FROM ledger_transactions
      WHERE world_id = $1
      ORDER BY sim_time, id`,
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

  return {
    counts: countRow,
    physiology: physiology.rows,
    items: items.rows,
    balances: balances.rows,
    commitments: commitments.rows,
    ledger: ledger.rows,
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

function semanticSnapshot(snapshot: IntegratedSnapshot) {
  return {
    counts: snapshot.counts,
    physiology: snapshot.physiology,
    items: snapshot.items,
    balances: snapshot.balances,
    commitments: snapshot.commitments,
    ledger: snapshot.ledger,
    events: snapshot.events
      .map(({ sequence: _sequence, ...event }) => event)
      .sort((left, right) => left.id.localeCompare(right.id)),
    pending: snapshot.pending
      .map(({ ordinal: _ordinal, ...event }) => event)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

async function processWithTwoRuntimes(
  worldId: WorldId,
  through: ReturnType<typeof simTime>,
): Promise<readonly [number, number]> {
  const leftPool = new Pool();
  const rightPool = new Pool();
  try {
    const left = new CoreWorldRuntime(leftPool);
    const right = new CoreWorldRuntime(rightPool);
    return await Promise.all([
      left.processThrough({
        worldId,
        through,
        workerId: "integrated-multi-left",
        claimLimit: 1,
      }),
      right.processThrough({
        worldId,
        through,
        workerId: "integrated-multi-right",
        claimLimit: 1,
      }),
    ]);
  } finally {
    await Promise.all([leftPool.end(), rightPool.end()]);
  }
}

function balance(snapshot: IntegratedSnapshot, accountId: string): bigint {
  const row = snapshot.balances.find((candidate) => candidate.id === accountId);
  if (row === undefined) throw new Error(`Missing account ${accountId}`);
  return BigInt(row.balance);
}

describe("durable scheduled-event runtime", () => {
  it("fails closed on an unknown event type and leaves the claim recoverable", async () => {
    const worldId = asWorldId("runtime-unknown-event");
    await new PostgresWorldRepository(pool).create(worldId);
    const schedules = new PostgresScheduledEventRepository(pool);
    await schedules.schedule(worldId, {
      id: asScheduledEventId("unknown-event"),
      dueAt: simTime(10),
      type: "unknown.runtime.event",
      payload: {},
      correlationId: asCorrelationId("runtime-unknown"),
    });

    const worker = new DurableScheduledEventWorker(
      pool,
      new ScheduledEventHandlerRegistry(),
    );
    await expect(
      worker.processThrough({
        worldId,
        through: simTime(10),
        workerId: "runtime-worker",
      }),
    ).rejects.toThrow(/no scheduled-event handler/i);

    const processing = await pool.query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM scheduled_events
        WHERE world_id = $1 AND id = 'unknown-event'`,
      [worldId],
    );
    expect(processing.rows[0]).toEqual({
      status: "processing",
      locked_by: "runtime-worker",
    });
    expect(
      await worker.requeueStale(worldId, new Date(Date.now() + 60_000)),
    ).toBe(1);
  });

  it("keeps physiology, work, salary, rent and future scheduling restart-equivalent for 20 agents over 30 days", async () => {
    const controlWorld = await setupWorld(pool, "runtime-integrated-control");
    const controlRuntime = new CoreWorldRuntime(pool);
    const multiWorld = await setupWorld(pool, "runtime-integrated-multi");

    const firstProcessPool = new Pool();
    const restartWorld = await setupWorld(
      firstProcessPool,
      "runtime-integrated-restart",
    );
    const firstRuntime = new CoreWorldRuntime(firstProcessPool);

    const controlFirst = await controlRuntime.processThrough({
      worldId: controlWorld,
      through: MIDPOINT,
      workerId: "control-runtime-a",
    });
    const restartFirst = await firstRuntime.processThrough({
      worldId: restartWorld,
      through: MIDPOINT,
      workerId: "restart-runtime-a",
    });
    expect(restartFirst).toBe(controlFirst);
    expect(controlFirst).toBeGreaterThan(1_000);

    const abandoned = await new PostgresScheduledEventRepository(
      firstProcessPool,
    ).claimDue(restartWorld, END_TIME, "dead-runtime-worker", 1);
    expect(abandoned).toHaveLength(1);
    await firstProcessPool.end();

    const controlSecond = await controlRuntime.processThrough({
      worldId: controlWorld,
      through: END_TIME,
      workerId: "control-runtime-b",
    });
    expect(controlSecond).toBeGreaterThan(1_000);

    const restartedPool = new Pool();
    try {
      const restartedRuntime = new CoreWorldRuntime(restartedPool);
      expect(
        await restartedRuntime.requeueStale(
          restartWorld,
          new Date(Date.now() + 60_000),
          10,
        ),
      ).toBe(1);

      const restartSecond = await restartedRuntime.processThrough({
        worldId: restartWorld,
        through: END_TIME,
        workerId: "restart-runtime-b",
      });
      expect(restartSecond).toBe(controlSecond);

      const control = await snapshot(pool, controlWorld);
      const restarted = await snapshot(restartedPool, restartWorld);
      expect(restarted).toEqual(control);

      expect(control.physiology).toHaveLength(AGENT_COUNT);
      expect(control.items).toHaveLength(AGENT_COUNT);
      expect(control.pending).toHaveLength(AGENT_COUNT * 4);
      expect(Number(control.counts.work_fulfilled)).toBeGreaterThan(0);
      expect(Number(control.counts.work_missed)).toBeGreaterThan(0);
      expect(
        Number(control.counts.work_fulfilled) + Number(control.counts.work_missed),
      ).toBe(AGENT_COUNT * 30);
      expect(Number(control.counts.salary_count)).toBe(
        Number(control.counts.work_fulfilled),
      );
      expect(Number(control.counts.rent_count)).toBe(AGENT_COUNT);
      expect(Number(control.counts.rent_fulfilled)).toBe(AGENT_COUNT);
      expect(control.events.some((event) => event.type === "commitment.missed")).toBe(
        true,
      );
      expect(
        control.events.some((event) => event.type === "person.hunger_deferred"),
      ).toBe(true);

      for (const row of control.physiology) {
        expect(row.hunger_value).toBeGreaterThanOrEqual(0);
        expect(row.hunger_value).toBeLessThanOrEqual(10_000);
        expect(row.energy_value).toBeGreaterThanOrEqual(0);
        expect(row.energy_value).toBeLessThanOrEqual(10_000);
        expect(row.meals_eaten).toBeGreaterThan(35);
        expect(row.sleep_sessions).toBeGreaterThan(15);
      }
      for (const row of control.items) {
        expect(Number(row.available) + Number(row.consumed)).toBe(FOOD_PER_AGENT);
        expect(Number(row.consumed)).toBeGreaterThan(35);
      }

      expect(balance(control, "business-payroll")).toBe(
        EMPLOYER_BOOTSTRAP -
          BigInt(control.counts.salary_count) * WAGE_PER_SHIFT,
      );
      expect(balance(control, "landlord-wallet")).toBe(
        BigInt(AGENT_COUNT) * RENT_PER_PERIOD,
      );
      for (let index = 0; index < AGENT_COUNT; index += 1) {
        expect(balance(control, `${personId(index)}:wallet`)).toBeGreaterThanOrEqual(0n);
      }

      expect(await totalAttempts(restartedPool, restartWorld)).toBe(
        (await totalAttempts(pool, controlWorld)) + 1n,
      );

      const multiCounts = await processWithTwoRuntimes(multiWorld, END_TIME);
      expect(multiCounts[0] + multiCounts[1]).toBe(
        controlFirst + controlSecond,
      );
      const multi = await snapshot(pool, multiWorld);
      expect(semanticSnapshot(multi)).toEqual(semanticSnapshot(control));
      // Worker affinity guarantees conflict safety, not fair claim
      // distribution. Independent work may be drained by one worker.
      expect(multiCounts).toHaveLength(2);
    } finally {
      await restartedPool.end();
    }
  }, 300_000);
});
