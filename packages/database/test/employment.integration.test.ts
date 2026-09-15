import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  SIM_DAY,
  SIM_HOUR,
  asEmploymentId,
  asEntityId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import type { EmploymentTerms } from "@hobbo/economy";
import {
  PostgresEmploymentRepository,
  PostgresLedgerRepository,
  PostgresRoutineRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const ledger = new PostgresLedgerRepository(pool);
const employments = new PostgresEmploymentRepository(pool);
const routines = new PostgresRoutineRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE employments, ledger_entries, ledger_transactions, ledger_accounts, commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

async function setupPayrollWorld(worldName: string) {
  const worldId = asWorldId(worldName);
  const system = asLedgerAccountId("system");
  const employer = asLedgerAccountId("cafe-cash");
  const employee = asLedgerAccountId("alice-wallet");

  await worlds.create(worldId);
  await ledger.createAccount({
    id: system,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
  });
  await ledger.createAccount({
    id: employer,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "business-cafe",
  });
  await ledger.createAccount({
    id: employee,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "person-alice",
  });

  return { worldId, system, employer, employee };
}

function employmentTerms(input: {
  worldId: ReturnType<typeof asWorldId>;
  employerAccountId: ReturnType<typeof asLedgerAccountId>;
  employeeAccountId: ReturnType<typeof asLedgerAccountId>;
  id?: string;
}): EmploymentTerms {
  return {
    id: asEmploymentId(input.id ?? "cafe-job"),
    worldId: input.worldId,
    employerId: asEntityId("business-cafe"),
    employeeId: asEntityId("person-alice"),
    employerAccountId: input.employerAccountId,
    employeeAccountId: input.employeeAccountId,
    currency: "HBC",
    wagePerShift: 100n,
    workPeriod: simDuration(SIM_DAY),
    workPhase: simDuration(BigInt(SIM_HOUR) * 9n),
    startsAt: simTime(0),
  };
}

async function fundEmployer(input: {
  worldId: ReturnType<typeof asWorldId>;
  system: ReturnType<typeof asLedgerAccountId>;
  employer: ReturnType<typeof asLedgerAccountId>;
  at?: bigint;
  amount?: bigint;
  key?: string;
}) {
  return ledger.transfer({
    worldId: input.worldId,
    transactionId: asLedgerTransactionId(input.key ?? "fund-employer"),
    simTime: simTime(input.at ?? 1n),
    currency: "HBC",
    fromAccountId: input.system,
    toAccountId: input.employer,
    amount: input.amount ?? 1_000n,
    idempotencyKey: input.key ?? "fund-employer",
    type: "bootstrap.funding",
  });
}

describe("durable employment and salary settlement", () => {
  it("creates contract, work routine and first concrete shift atomically", async () => {
    const { worldId, employer, employee } = await setupPayrollWorld(
      "employment-create-world",
    );
    const created = await employments.create(
      employmentTerms({
        worldId,
        employerAccountId: employer,
        employeeAccountId: employee,
      }),
    );

    expect(created.employment.status).toBe("active");
    expect(created.employment.wagePerShift).toBe(100n);
    expect(created.firstShift.commitment.kind).toBe("employment.shift");
    expect(created.firstShift.commitment.dueAt).toBe(BigInt(SIM_HOUR) * 9n);
    expect(created.firstShift.commitment.status).toBe("planned");
    expect(created.firstShift.commitment.routineId).toBe(
      created.employment.workRoutineId,
    );

    const counts = await pool.query<{
      employments: string;
      routines: string;
      commitments: string;
      scheduled: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM employments WHERE world_id = $1) AS employments,
         (SELECT count(*)::text FROM routines WHERE world_id = $1) AS routines,
         (SELECT count(*)::text FROM commitments WHERE world_id = $1 AND status = 'planned') AS commitments,
         (SELECT count(*)::text FROM scheduled_events WHERE world_id = $1 AND status = 'pending') AS scheduled`,
      [worldId],
    );
    expect(counts.rows[0]).toEqual({
      employments: "1",
      routines: "1",
      commitments: "1",
      scheduled: "1",
    });
  });

  it("settles a claimed shift, schedules the next one and pays salary exactly once", async () => {
    const { worldId, system, employer, employee } = await setupPayrollWorld(
      "employment-pay-world",
    );
    await fundEmployer({ worldId, system, employer });
    const created = await employments.create(
      employmentTerms({
        worldId,
        employerAccountId: employer,
        employeeAccountId: employee,
      }),
    );
    const dueAt = created.firstShift.commitment.dueAt;
    const claimed = await schedules.claimDue(
      worldId,
      dueAt,
      "employment-worker",
      1,
    );
    expect(claimed).toHaveLength(1);

    const settled = await employments.settleShift({
      worldId,
      employmentId: created.employment.id,
      commitmentId: created.firstShift.commitment.id,
      workerId: "employment-worker",
      at: dueAt,
    });

    expect(settled.shift.commitment.status).toBe("fulfilled");
    expect(settled.salary.status).toBe("posted");
    expect(settled.salary.type).toBe("employment.salary");
    expect(settled.nextShift?.commitment.status).toBe("planned");
    expect(settled.nextShift?.commitment.dueAt).toBe(dueAt + BigInt(SIM_DAY));
    expect(await ledger.getBalance(worldId, employer)).toBe(900n);
    expect(await ledger.getBalance(worldId, employee)).toBe(100n);

    const replayed = await employments.settleShift({
      worldId,
      employmentId: created.employment.id,
      commitmentId: created.firstShift.commitment.id,
      workerId: "ignored-after-fulfillment",
      at: dueAt,
    });
    expect(replayed.salary.id).toBe(settled.salary.id);
    expect(await ledger.getBalance(worldId, employer)).toBe(900n);
    expect(await ledger.getBalance(worldId, employee)).toBe(100n);

    const salaryCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ledger_transactions
        WHERE world_id = $1 AND type = 'employment.salary'`,
      [worldId],
    );
    expect(salaryCount.rows[0]?.count).toBe("1");
  });

  it("recovers from a crash after shift fulfillment but before salary posting", async () => {
    const { worldId, system, employer, employee } = await setupPayrollWorld(
      "employment-crash-world",
    );
    await fundEmployer({ worldId, system, employer });
    const created = await employments.create(
      employmentTerms({
        worldId,
        employerAccountId: employer,
        employeeAccountId: employee,
      }),
    );
    const shift = created.firstShift.commitment;
    await schedules.claimDue(worldId, shift.dueAt, "crash-worker", 1);

    const fulfilled = await routines.fulfillClaimedAndScheduleNext({
      worldId,
      commitmentId: shift.id,
      workerId: "crash-worker",
      at: shift.dueAt,
    });
    expect(fulfilled.fulfilled.commitment.status).toBe("fulfilled");
    expect(await ledger.getBalance(worldId, employee)).toBe(0n);

    const freshPool = new Pool();
    try {
      const freshEmployment = new PostgresEmploymentRepository(freshPool);
      const freshLedger = new PostgresLedgerRepository(freshPool);
      const recovered = await freshEmployment.settleShift({
        worldId,
        employmentId: created.employment.id,
        commitmentId: shift.id,
        workerId: "restart-worker",
        at: shift.dueAt,
      });
      expect(recovered.shift.commitment.status).toBe("fulfilled");
      expect(recovered.salary.status).toBe("posted");
      expect(await freshLedger.getBalance(worldId, employee)).toBe(100n);

      const retry = await freshEmployment.settleShift({
        worldId,
        employmentId: created.employment.id,
        commitmentId: shift.id,
        workerId: "restart-worker-2",
        at: shift.dueAt,
      });
      expect(retry.salary.id).toBe(recovered.salary.id);
    } finally {
      await freshPool.end();
    }

    const salaryCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_transactions
        WHERE world_id = $1 AND type = 'employment.salary'`,
      [worldId],
    );
    expect(salaryCount.rows[0]?.count).toBe("1");
  });

  it("keeps work fulfilled when payroll is insolvent and pays on a later retry", async () => {
    const { worldId, system, employer, employee } = await setupPayrollWorld(
      "employment-unpaid-world",
    );
    const created = await employments.create(
      employmentTerms({
        worldId,
        employerAccountId: employer,
        employeeAccountId: employee,
      }),
    );
    const shift = created.firstShift.commitment;
    await schedules.claimDue(worldId, shift.dueAt, "insolvent-worker", 1);

    await expect(
      employments.settleShift({
        worldId,
        employmentId: created.employment.id,
        commitmentId: shift.id,
        workerId: "insolvent-worker",
        at: shift.dueAt,
      }),
    ).rejects.toThrow(/insufficient funds/i);

    const afterFailure = await routines.getCommitment(worldId, shift.id);
    expect(afterFailure?.commitment.status).toBe("fulfilled");
    expect(await ledger.getBalance(worldId, employee)).toBe(0n);

    const state = await pool.query<{ next_count: string; salary_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM commitments
           WHERE world_id = $1 AND routine_id = $2 AND status = 'planned') AS next_count,
         (SELECT count(*)::text FROM ledger_transactions
           WHERE world_id = $1 AND type = 'employment.salary') AS salary_count`,
      [worldId, created.employment.workRoutineId],
    );
    expect(state.rows[0]).toEqual({ next_count: "1", salary_count: "0" });

    await fundEmployer({
      worldId,
      system,
      employer,
      at: BigInt(shift.dueAt),
      amount: 500n,
      key: "late-funding",
    });
    const paid = await employments.settleShift({
      worldId,
      employmentId: created.employment.id,
      commitmentId: shift.id,
      workerId: "retry-worker",
      at: shift.dueAt,
    });
    expect(paid.salary.status).toBe("posted");
    expect(await ledger.getBalance(worldId, employer)).toBe(400n);
    expect(await ledger.getBalance(worldId, employee)).toBe(100n);
  });

  it("rolls back routine and commitment creation when payroll accounts mismatch currency", async () => {
    const { worldId, employer } = await setupPayrollWorld(
      "employment-rollback-world",
    );
    const usdEmployee = asLedgerAccountId("alice-usd");
    await ledger.createAccount({
      id: usdEmployee,
      worldId,
      currency: "USD",
      kind: "asset",
      allowNegative: false,
      ownerId: "person-alice",
    });

    await expect(
      employments.create(
        employmentTerms({
          worldId,
          employerAccountId: employer,
          employeeAccountId: usdEmployee,
          id: "bad-currency-job",
        }),
      ),
    ).rejects.toThrow(/does not match both payroll accounts/i);

    const counts = await pool.query<{
      employments: string;
      routines: string;
      commitments: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM employments WHERE world_id = $1) AS employments,
         (SELECT count(*)::text FROM routines WHERE world_id = $1) AS routines,
         (SELECT count(*)::text FROM commitments WHERE world_id = $1) AS commitments`,
      [worldId],
    );
    expect(counts.rows[0]).toEqual({
      employments: "0",
      routines: "0",
      commitments: "0",
    });
  });
});
