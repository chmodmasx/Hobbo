import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  SIM_DAY,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asTenancyId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  rentIdempotencyKey,
  rentTransactionId,
  type TenancyTerms,
} from "@hobbo/economy";
import {
  PostgresHousingRepository,
  PostgresLedgerRepository,
  PostgresRoutineRepository,
  PostgresScheduledEventRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const ledger = new PostgresLedgerRepository(pool);
const housing = new PostgresHousingRepository(pool);
const routines = new PostgresRoutineRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE tenancies, housing_units, employments, ledger_entries, ledger_transactions, ledger_accounts, commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

async function setupHousingWorld(worldName: string) {
  const worldId = asWorldId(worldName);
  const system = asLedgerAccountId("system");
  const landlord = asLedgerAccountId("landlord-wallet");
  const tenant = asLedgerAccountId("tenant-wallet");
  const unitId = asHousingUnitId("unit-1");

  await worlds.create(worldId);
  await ledger.createAccount({
    id: system,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
  });
  await ledger.createAccount({
    id: landlord,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "person-landlord",
  });
  await ledger.createAccount({
    id: tenant,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "person-tenant",
  });
  await housing.createUnit({
    id: unitId,
    worldId,
    ownerId: asEntityId("person-landlord"),
    label: "Apartment 1",
  });

  return { worldId, system, landlord, tenant, unitId };
}

function tenancyTerms(input: {
  worldId: ReturnType<typeof asWorldId>;
  unitId: ReturnType<typeof asHousingUnitId>;
  landlordAccountId: ReturnType<typeof asLedgerAccountId>;
  tenantAccountId: ReturnType<typeof asLedgerAccountId>;
  id?: string;
}): TenancyTerms {
  return {
    id: asTenancyId(input.id ?? "lease-1"),
    worldId: input.worldId,
    housingUnitId: input.unitId,
    landlordId: asEntityId("person-landlord"),
    tenantId: asEntityId("person-tenant"),
    landlordAccountId: input.landlordAccountId,
    tenantAccountId: input.tenantAccountId,
    currency: "HBC",
    rentPerPeriod: 500n,
    rentPeriod: simDuration(BigInt(SIM_DAY) * 30n),
    rentPhase: simDuration(BigInt(SIM_DAY) * 5n),
    startsAt: simTime(0),
  };
}

async function fundTenant(input: {
  worldId: ReturnType<typeof asWorldId>;
  system: ReturnType<typeof asLedgerAccountId>;
  tenant: ReturnType<typeof asLedgerAccountId>;
  amount?: bigint;
  at?: bigint;
  key?: string;
}) {
  const key = input.key ?? "fund-tenant";
  return ledger.transfer({
    worldId: input.worldId,
    transactionId: asLedgerTransactionId(key),
    simTime: simTime(input.at ?? 1n),
    currency: "HBC",
    fromAccountId: input.system,
    toAccountId: input.tenant,
    amount: input.amount ?? 1_000n,
    idempotencyKey: key,
    type: "bootstrap.funding",
  });
}

describe("durable housing tenancy and rent settlement", () => {
  it("creates unit tenancy, rent routine and first obligation atomically", async () => {
    const { worldId, landlord, tenant, unitId } = await setupHousingWorld(
      "housing-create-world",
    );
    const created = await housing.createTenancy(
      tenancyTerms({
        worldId,
        unitId,
        landlordAccountId: landlord,
        tenantAccountId: tenant,
      }),
    );

    expect(created.tenancy.status).toBe("active");
    expect(created.tenancy.rentPerPeriod).toBe(500n);
    expect(created.firstRent.commitment.kind).toBe("tenancy.rent_due");
    expect(created.firstRent.commitment.dueAt).toBe(BigInt(SIM_DAY) * 5n);
    expect(created.firstRent.commitment.status).toBe("planned");

    await expect(
      housing.createTenancy(
        tenancyTerms({
          worldId,
          unitId,
          landlordAccountId: landlord,
          tenantAccountId: tenant,
          id: "lease-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const counts = await pool.query<{
      tenancies: string;
      routines: string;
      commitments: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM tenancies WHERE world_id = $1) AS tenancies,
         (SELECT count(*)::text FROM routines WHERE world_id = $1) AS routines,
         (SELECT count(*)::text FROM commitments WHERE world_id = $1) AS commitments`,
      [worldId],
    );
    expect(counts.rows[0]).toEqual({
      tenancies: "1",
      routines: "1",
      commitments: "1",
    });
  });

  it("settles overdue rent without shifting the recurring due-date phase", async () => {
    const { worldId, system, landlord, tenant, unitId } = await setupHousingWorld(
      "housing-overdue-world",
    );
    await fundTenant({ worldId, system, tenant });
    const created = await housing.createTenancy(
      tenancyTerms({
        worldId,
        unitId,
        landlordAccountId: landlord,
        tenantAccountId: tenant,
      }),
    );
    const rent = created.firstRent.commitment;
    const lateAt = simTime(BigInt(rent.dueAt) + BigInt(SIM_DAY) * 2n);
    await schedules.claimDue(worldId, lateAt, "rent-worker", 1);

    const settled = await housing.settleRent({
      worldId,
      tenancyId: created.tenancy.id,
      commitmentId: rent.id,
      workerId: "rent-worker",
      at: lateAt,
    });

    expect(settled.rentCommitment.commitment.status).toBe("fulfilled");
    expect(settled.rentCommitment.commitment.resolvedAt).toBe(lateAt);
    expect(settled.payment.status).toBe("posted");
    expect(await ledger.getBalance(worldId, tenant)).toBe(500n);
    expect(await ledger.getBalance(worldId, landlord)).toBe(500n);
    expect(settled.nextRent?.commitment.dueAt).toBe(
      BigInt(rent.dueAt) + BigInt(SIM_DAY) * 30n,
    );
  });

  it("recovers after payment commits but the worker crashes before fulfillment", async () => {
    const { worldId, system, landlord, tenant, unitId } = await setupHousingWorld(
      "housing-crash-world",
    );
    await fundTenant({ worldId, system, tenant });
    const created = await housing.createTenancy(
      tenancyTerms({
        worldId,
        unitId,
        landlordAccountId: landlord,
        tenantAccountId: tenant,
      }),
    );
    const rent = created.firstRent.commitment;
    await schedules.claimDue(worldId, rent.dueAt, "crashed-rent-worker", 1);

    const payment = await ledger.transfer({
      worldId,
      transactionId: rentTransactionId(created.tenancy.id, String(rent.id)),
      simTime: rent.dueAt,
      currency: "HBC",
      fromAccountId: tenant,
      toAccountId: landlord,
      amount: created.tenancy.rentPerPeriod,
      idempotencyKey: rentIdempotencyKey(created.tenancy.id, String(rent.id)),
      type: "tenancy.rent",
      metadata: { simulatedCrash: true },
    });
    expect(payment.status).toBe("posted");
    expect((await routines.getCommitment(worldId, rent.id))?.commitment.status).toBe(
      "planned",
    );

    const freshPool = new Pool();
    try {
      const freshSchedules = new PostgresScheduledEventRepository(freshPool);
      const freshHousing = new PostgresHousingRepository(freshPool);
      const freshLedger = new PostgresLedgerRepository(freshPool);

      expect(
        await freshSchedules.requeueStale(
          worldId,
          new Date(Date.now() + 60_000),
          1,
        ),
      ).toBe(1);
      const lateAt = simTime(BigInt(rent.dueAt) + BigInt(SIM_DAY));
      const reclaimed = await freshSchedules.claimDue(
        worldId,
        lateAt,
        "restart-rent-worker",
        1,
      );
      expect(reclaimed).toHaveLength(1);

      const recovered = await freshHousing.settleRent({
        worldId,
        tenancyId: created.tenancy.id,
        commitmentId: rent.id,
        workerId: "restart-rent-worker",
        at: lateAt,
      });
      expect(recovered.payment.id).toBe(payment.id);
      expect(recovered.rentCommitment.commitment.status).toBe("fulfilled");
      expect(await freshLedger.getBalance(worldId, tenant)).toBe(500n);
      expect(await freshLedger.getBalance(worldId, landlord)).toBe(500n);
    } finally {
      await freshPool.end();
    }

    const paymentCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_transactions
        WHERE world_id = $1 AND type = 'tenancy.rent'`,
      [worldId],
    );
    expect(paymentCount.rows[0]?.count).toBe("1");
  });

  it("keeps rent obligation open when tenant lacks funds and settles after funding", async () => {
    const { worldId, system, landlord, tenant, unitId } = await setupHousingWorld(
      "housing-insolvent-world",
    );
    const created = await housing.createTenancy(
      tenancyTerms({
        worldId,
        unitId,
        landlordAccountId: landlord,
        tenantAccountId: tenant,
      }),
    );
    const rent = created.firstRent.commitment;
    await schedules.claimDue(worldId, rent.dueAt, "rent-retry-worker", 1);

    await expect(
      housing.settleRent({
        worldId,
        tenancyId: created.tenancy.id,
        commitmentId: rent.id,
        workerId: "rent-retry-worker",
        at: rent.dueAt,
      }),
    ).rejects.toThrow(/insufficient funds/i);

    expect((await routines.getCommitment(worldId, rent.id))?.commitment.status).toBe(
      "planned",
    );
    const beforeFunding = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_transactions
        WHERE world_id = $1 AND type = 'tenancy.rent'`,
      [worldId],
    );
    expect(beforeFunding.rows[0]?.count).toBe("0");

    await fundTenant({
      worldId,
      system,
      tenant,
      amount: 500n,
      at: BigInt(rent.dueAt),
      key: "late-rent-funding",
    });
    const settled = await housing.settleRent({
      worldId,
      tenancyId: created.tenancy.id,
      commitmentId: rent.id,
      workerId: "rent-retry-worker",
      at: simTime(BigInt(rent.dueAt) + 1n),
    });
    expect(settled.rentCommitment.commitment.status).toBe("fulfilled");
    expect(await ledger.getBalance(worldId, tenant)).toBe(0n);
    expect(await ledger.getBalance(worldId, landlord)).toBe(500n);
  });

  it("rejects a non-owning worker before creating any rent payment", async () => {
    const { worldId, system, landlord, tenant, unitId } = await setupHousingWorld(
      "housing-worker-world",
    );
    await fundTenant({ worldId, system, tenant });
    const created = await housing.createTenancy(
      tenancyTerms({
        worldId,
        unitId,
        landlordAccountId: landlord,
        tenantAccountId: tenant,
      }),
    );
    const rent = created.firstRent.commitment;
    await schedules.claimDue(worldId, rent.dueAt, "actual-rent-worker", 1);

    await expect(
      housing.settleRent({
        worldId,
        tenancyId: created.tenancy.id,
        commitmentId: rent.id,
        workerId: "wrong-rent-worker",
        at: rent.dueAt,
      }),
    ).rejects.toThrow(/not owned/i);

    const paymentCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_transactions
        WHERE world_id = $1 AND type = 'tenancy.rent'`,
      [worldId],
    );
    expect(paymentCount.rows[0]?.count).toBe("0");

    const settled = await housing.settleRent({
      worldId,
      tenancyId: created.tenancy.id,
      commitmentId: rent.id,
      workerId: "actual-rent-worker",
      at: rent.dueAt,
    });
    expect(settled.payment.status).toBe("posted");
  });
});
