import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  SIM_DAY,
  SIM_HOUR,
  asCommitmentId,
  asEmploymentId,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asTenancyId,
  asWorldId,
  simDuration,
  simTime,
  type WorldId,
} from "@hobbo/domain";
import {
  PostgresEmploymentRepository,
  PostgresHousingRepository,
  PostgresLedgerRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();

const AGENT_COUNT = 20;
const WAGE_PER_SHIFT = 100n;
const RENT_PER_PERIOD = 1_000n;
const EMPLOYER_BOOTSTRAP = 100_000n;
const MIDPOINT = simTime(BigInt(SIM_DAY) * 15n);
const CRASH_POINT = simTime(BigInt(MIDPOINT) + BigInt(SIM_HOUR) * 9n);
const END_TIME = simTime(BigInt(SIM_DAY) * 30n);

interface CommitmentDuePayload {
  readonly commitmentId: string;
  readonly kind: string;
  readonly payload: unknown;
}

interface CountRow extends QueryResultRow {
  salary_count: string;
  rent_count: string;
  fulfilled_commitments: string;
  planned_commitments: string;
  completed_scheduled: string;
  pending_scheduled: string;
  domain_events: string;
  current_sim_time: string;
}

interface BalanceRow extends QueryResultRow {
  id: string;
  balance: string;
}

interface PlannedRow extends QueryResultRow {
  owner_id: string;
  kind: string;
  due_at: string;
}

interface AttemptRow extends QueryResultRow {
  attempts: string;
}

interface PopulationSnapshot {
  readonly counts: CountRow;
  readonly balances: readonly BalanceRow[];
  readonly planned: readonly PlannedRow[];
}

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function personKey(index: number): string {
  return `person-${String(index + 1).padStart(2, "0")}`;
}

async function setupPopulation(connection: Pool, worldName: string): Promise<WorldId> {
  const worldId = asWorldId(worldName);
  const worlds = new PostgresWorldRepository(connection);
  const ledger = new PostgresLedgerRepository(connection);
  const employments = new PostgresEmploymentRepository(connection);
  const housing = new PostgresHousingRepository(connection);

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
    const personId = asEntityId(personKey(index));
    const walletId = asLedgerAccountId(`${personId}:wallet`);
    const employmentId = asEmploymentId(`employment:${personId}`);
    const unitId = asHousingUnitId(`unit:${personId}`);
    const tenancyId = asTenancyId(`tenancy:${personId}`);

    await ledger.createAccount({
      id: walletId,
      worldId,
      currency: "HBC",
      kind: "asset",
      allowNegative: false,
      ownerId: personId,
    });

    await employments.create({
      id: employmentId,
      worldId,
      employerId,
      employeeId: personId,
      employerAccountId,
      employeeAccountId: walletId,
      currency: "HBC",
      wagePerShift: WAGE_PER_SHIFT,
      workPeriod: simDuration(SIM_DAY),
      workPhase: simDuration(BigInt(SIM_HOUR) * 9n),
      startsAt: simTime(0),
    });

    await housing.createUnit({
      id: unitId,
      worldId,
      ownerId: landlordId,
      label: `Apartment ${index + 1}`,
    });
    await housing.createTenancy({
      id: tenancyId,
      worldId,
      housingUnitId: unitId,
      landlordId,
      tenantId: personId,
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

function parseCommitmentDuePayload(value: unknown): CommitmentDuePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("Commitment event payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.commitmentId !== "string" ||
    typeof payload.kind !== "string" ||
    !("payload" in payload)
  ) {
    throw new Error("Commitment event payload is malformed");
  }
  return {
    commitmentId: payload.commitmentId,
    kind: payload.kind,
    payload: payload.payload,
  };
}

function nestedString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected nested payload containing ${key}`);
  }
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Expected non-empty nested string ${key}`);
  }
  return result;
}

async function processThrough(
  connection: Pool,
  worldId: WorldId,
  through: ReturnType<typeof simTime>,
  workerId: string,
): Promise<number> {
  const schedules = new PostgresScheduledEventRepository(connection);
  const employments = new PostgresEmploymentRepository(connection);
  const housing = new PostgresHousingRepository(connection);
  let processed = 0;

  while (true) {
    const claimed = await schedules.claimDue(worldId, through, workerId, 100);
    if (claimed.length === 0) return processed;

    for (const scheduled of claimed) {
      const due = parseCommitmentDuePayload(scheduled.event.payload);
      if (due.kind === "employment.shift") {
        await employments.settleShift({
          worldId,
          employmentId: asEmploymentId(nestedString(due.payload, "employmentId")),
          commitmentId: asCommitmentId(due.commitmentId),
          workerId,
          at: scheduled.event.dueAt,
        });
      } else if (due.kind === "tenancy.rent_due") {
        await housing.settleRent({
          worldId,
          tenancyId: asTenancyId(nestedString(due.payload, "tenancyId")),
          commitmentId: asCommitmentId(due.commitmentId),
          workerId,
          at: scheduled.event.dueAt,
        });
      } else {
        throw new Error(`Unexpected durable population commitment: ${due.kind}`);
      }
      processed += 1;
    }
  }
}

async function snapshot(connection: Pool, worldId: WorldId): Promise<PopulationSnapshot> {
  const counts = await connection.query<CountRow>(
    `SELECT
       (SELECT count(*)::text FROM ledger_transactions
         WHERE world_id = $1 AND type = 'employment.salary') AS salary_count,
       (SELECT count(*)::text FROM ledger_transactions
         WHERE world_id = $1 AND type = 'tenancy.rent') AS rent_count,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND status = 'fulfilled') AS fulfilled_commitments,
       (SELECT count(*)::text FROM commitments
         WHERE world_id = $1 AND status = 'planned') AS planned_commitments,
       (SELECT count(*)::text FROM scheduled_events
         WHERE world_id = $1 AND status = 'completed') AS completed_scheduled,
       (SELECT count(*)::text FROM scheduled_events
         WHERE world_id = $1 AND status = 'pending') AS pending_scheduled,
       (SELECT count(*)::text FROM domain_events WHERE world_id = $1) AS domain_events,
       (SELECT current_sim_time::text FROM worlds WHERE id = $1) AS current_sim_time`,
    [worldId],
  );
  const countRow = counts.rows[0];
  if (countRow === undefined) throw new Error(`Missing world counts for ${worldId}`);

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

  const planned = await connection.query<PlannedRow>(
    `SELECT owner_id, kind, due_at::text AS due_at
       FROM commitments
      WHERE world_id = $1 AND status = 'planned'
      ORDER BY kind, owner_id, due_at`,
    [worldId],
  );

  return {
    counts: countRow,
    balances: balances.rows,
    planned: planned.rows,
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

function balanceOf(snapshot: PopulationSnapshot, accountId: string): bigint {
  const row = snapshot.balances.find((candidate) => candidate.id === accountId);
  if (row === undefined) throw new Error(`Missing balance for ${accountId}`);
  return BigInt(row.balance);
}

describe("20-agent durable economy population gate", () => {
  it("matches a continuous 30-day run after a mid-run process restart and stale lease recovery", async () => {
    const controlWorld = await setupPopulation(pool, "population-economy-control");

    const firstProcessPool = new Pool();
    const restartWorld = await setupPopulation(
      firstProcessPool,
      "population-economy-restart",
    );

    expect(await processThrough(pool, controlWorld, MIDPOINT, "control-worker-a")).toBe(
      AGENT_COUNT * 15,
    );
    expect(
      await processThrough(
        firstProcessPool,
        restartWorld,
        MIDPOINT,
        "restart-worker-a",
      ),
    ).toBe(AGENT_COUNT * 15);

    // Claim exactly one day-15 shift, then simulate the process disappearing
    // before any employment/ledger side effect is applied.
    const firstSchedules = new PostgresScheduledEventRepository(firstProcessPool);
    const abandoned = await firstSchedules.claimDue(
      restartWorld,
      CRASH_POINT,
      "dead-worker",
      1,
    );
    expect(abandoned).toHaveLength(1);
    expect(parseCommitmentDuePayload(abandoned[0]!.event.payload).kind).toBe(
      "employment.shift",
    );
    await firstProcessPool.end();

    expect(await processThrough(pool, controlWorld, END_TIME, "control-worker-b")).toBe(
      AGENT_COUNT * 15 + AGENT_COUNT,
    );

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

      expect(
        await processThrough(
          restartedPool,
          restartWorld,
          END_TIME,
          "restart-worker-b",
        ),
      ).toBe(AGENT_COUNT * 15 + AGENT_COUNT);

      const control = await snapshot(pool, controlWorld);
      const restarted = await snapshot(restartedPool, restartWorld);

      expect(restarted).toEqual(control);
      expect(control.counts).toEqual({
        salary_count: String(AGENT_COUNT * 30),
        rent_count: String(AGENT_COUNT),
        fulfilled_commitments: String(AGENT_COUNT * 31),
        planned_commitments: String(AGENT_COUNT * 2),
        completed_scheduled: String(AGENT_COUNT * 31),
        pending_scheduled: String(AGENT_COUNT * 2),
        domain_events: String(AGENT_COUNT * 31),
        current_sim_time: String(BigInt(SIM_DAY) * 29n + BigInt(SIM_HOUR) * 9n),
      });

      expect(balanceOf(control, "business-payroll")).toBe(
        EMPLOYER_BOOTSTRAP - BigInt(AGENT_COUNT) * 30n * WAGE_PER_SHIFT,
      );
      expect(balanceOf(control, "landlord-wallet")).toBe(
        BigInt(AGENT_COUNT) * RENT_PER_PERIOD,
      );
      for (let index = 0; index < AGENT_COUNT; index += 1) {
        expect(balanceOf(control, `${personKey(index)}:wallet`)).toBe(
          30n * WAGE_PER_SHIFT - RENT_PER_PERIOD,
        );
      }

      expect(control.planned).toHaveLength(AGENT_COUNT * 2);
      expect(
        control.planned.filter((commitment) => commitment.kind === "employment.shift"),
      ).toHaveLength(AGENT_COUNT);
      expect(
        control.planned.filter((commitment) => commitment.kind === "tenancy.rent_due"),
      ).toHaveLength(AGENT_COUNT);

      // Semantic state is identical. Operational provenance correctly records
      // one additional claim attempt in the restarted execution.
      expect(await totalAttempts(restartedPool, restartWorld)).toBe(
        (await totalAttempts(pool, controlWorld)) + 1n,
      );
    } finally {
      await restartedPool.end();
    }
  }, 30_000);
});
