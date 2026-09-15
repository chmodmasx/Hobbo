import {
  DomainInvariantError,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asRoutineId,
  asTenancyId,
  asWorldId,
  simTime,
  type CommitmentId,
  type EntityId,
  type HousingUnitId,
  type LedgerAccountId,
  type RoutineId,
  type ScheduledEventId,
  type SimTime,
  type TenancyId,
  type WorldId,
} from "@hobbo/domain";
import {
  rentIdempotencyKey,
  rentRoutineIdForTenancy,
  rentTransactionId,
  validateHousingUnitDefinition,
  validateTenancyTerms,
  type HousingUnitDefinition,
  type RentDuePayload,
  type TenancyTerms,
} from "@hobbo/economy";
import type { PeriodicRoutine } from "@hobbo/simulation";
import type { Pool, QueryResultRow } from "pg";
import {
  PostgresLedgerRepository,
  type PersistedLedgerTransaction,
} from "./ledger-repository.ts";
import {
  PostgresRoutineRepository,
  createRoutineInTransaction,
  materializeNextRoutineCommitmentInTransaction,
  type PersistedCommitment,
} from "./routine-repository.ts";
import { withTransaction } from "./transaction.ts";

interface HousingUnitRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  label: string | null;
}

interface TenancyRow extends QueryResultRow {
  world_id: string;
  id: string;
  housing_unit_id: string;
  landlord_id: string;
  tenant_id: string;
  landlord_account_id: string;
  tenant_account_id: string;
  currency: string;
  rent_per_period: string;
  rent_routine_id: string;
  starts_at: string;
  status: "active" | "ended";
  ended_at: string | null;
}

interface AccountCurrencyRow extends QueryResultRow {
  id: string;
  currency: string;
}

interface ScheduledOwnershipRow extends QueryResultRow {
  status: string;
  locked_by: string | null;
}

export interface PersistedHousingUnit {
  readonly id: HousingUnitId;
  readonly worldId: WorldId;
  readonly ownerId: EntityId;
  readonly label?: string;
}

export interface PersistedTenancy {
  readonly id: TenancyId;
  readonly worldId: WorldId;
  readonly housingUnitId: HousingUnitId;
  readonly landlordId: EntityId;
  readonly tenantId: EntityId;
  readonly landlordAccountId: LedgerAccountId;
  readonly tenantAccountId: LedgerAccountId;
  readonly currency: string;
  readonly rentPerPeriod: bigint;
  readonly rentRoutineId: RoutineId;
  readonly startsAt: SimTime;
  readonly status: "active" | "ended";
  readonly endedAt?: SimTime;
}

export interface CreatedTenancy {
  readonly tenancy: PersistedTenancy;
  readonly firstRent: PersistedCommitment<RentDuePayload>;
}

export interface SettledRent {
  readonly tenancy: PersistedTenancy;
  readonly rentCommitment: PersistedCommitment<RentDuePayload>;
  readonly payment: PersistedLedgerTransaction;
  readonly nextRent?: PersistedCommitment;
}

const HOUSING_UNIT_COLUMNS = `world_id, id, owner_id, label`;
const TENANCY_COLUMNS = `
  world_id, id, housing_unit_id, landlord_id, tenant_id,
  landlord_account_id, tenant_account_id, currency, rent_per_period,
  rent_routine_id, starts_at, status, ended_at
`;

function mapHousingUnit(row: HousingUnitRow): PersistedHousingUnit {
  return {
    id: asHousingUnitId(row.id),
    worldId: asWorldId(row.world_id),
    ownerId: asEntityId(row.owner_id),
    ...(row.label === null ? {} : { label: row.label }),
  };
}

function mapTenancy(row: TenancyRow): PersistedTenancy {
  return {
    id: asTenancyId(row.id),
    worldId: asWorldId(row.world_id),
    housingUnitId: asHousingUnitId(row.housing_unit_id),
    landlordId: asEntityId(row.landlord_id),
    tenantId: asEntityId(row.tenant_id),
    landlordAccountId: asLedgerAccountId(row.landlord_account_id),
    tenantAccountId: asLedgerAccountId(row.tenant_account_id),
    currency: row.currency,
    rentPerPeriod: BigInt(row.rent_per_period),
    rentRoutineId: asRoutineId(row.rent_routine_id),
    startsAt: simTime(row.starts_at),
    status: row.status,
    ...(row.ended_at === null ? {} : { endedAt: simTime(row.ended_at) }),
  };
}

function assertRentCommitment(
  tenancy: PersistedTenancy,
  persisted: PersistedCommitment,
): asserts persisted is PersistedCommitment<RentDuePayload> {
  const rent = persisted.commitment;
  if (rent.routineId !== tenancy.rentRoutineId) {
    throw new DomainInvariantError(
      `Commitment ${rent.id} does not belong to tenancy ${tenancy.id}`,
    );
  }
  if (rent.ownerId !== tenancy.tenantId) {
    throw new DomainInvariantError(
      `Commitment ${rent.id} is not owned by tenant ${tenancy.tenantId}`,
    );
  }
  if (rent.kind !== "tenancy.rent_due") {
    throw new DomainInvariantError(`Commitment ${rent.id} is not a rent obligation`);
  }
  if (
    typeof rent.payload !== "object" ||
    rent.payload === null ||
    (rent.payload as { tenancyId?: unknown }).tenancyId !== String(tenancy.id)
  ) {
    throw new DomainInvariantError(
      `Commitment ${rent.id} payload does not identify tenancy ${tenancy.id}`,
    );
  }
}

async function assertScheduledOwnership(
  pool: Pool,
  worldId: WorldId,
  scheduledEventId: ScheduledEventId,
  workerId: string,
): Promise<void> {
  const result = await pool.query<ScheduledOwnershipRow>(
    `SELECT status, locked_by
       FROM scheduled_events
      WHERE world_id = $1 AND id = $2`,
    [worldId, scheduledEventId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(`Scheduled event does not exist: ${scheduledEventId}`);
  }
  if (row.status !== "processing" || row.locked_by !== workerId) {
    throw new DomainInvariantError(
      `Scheduled event ${scheduledEventId} is not owned by worker ${workerId}`,
    );
  }
}

export class PostgresHousingRepository {
  readonly #pool: Pool;
  readonly #routines: PostgresRoutineRepository;
  readonly #ledger: PostgresLedgerRepository;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#routines = new PostgresRoutineRepository(pool);
    this.#ledger = new PostgresLedgerRepository(pool);
  }

  async createUnit(unit: HousingUnitDefinition): Promise<PersistedHousingUnit> {
    validateHousingUnitDefinition(unit);
    const result = await this.#pool.query<HousingUnitRow>(
      `INSERT INTO housing_units (world_id, id, owner_id, label)
       VALUES ($1,$2,$3,$4)
       RETURNING ${HOUSING_UNIT_COLUMNS}`,
      [unit.worldId, unit.id, unit.ownerId, unit.label ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(`Housing unit insert returned no row: ${unit.id}`);
    }
    return mapHousingUnit(row);
  }

  async getUnit(
    worldId: WorldId,
    housingUnitId: HousingUnitId,
  ): Promise<PersistedHousingUnit | undefined> {
    const result = await this.#pool.query<HousingUnitRow>(
      `SELECT ${HOUSING_UNIT_COLUMNS}
         FROM housing_units
        WHERE world_id = $1 AND id = $2`,
      [worldId, housingUnitId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapHousingUnit(row);
  }

  async createTenancy(terms: TenancyTerms): Promise<CreatedTenancy> {
    const currency = validateTenancyTerms(terms);
    const rentRoutineId = rentRoutineIdForTenancy(terms.id);
    const routine: PeriodicRoutine<RentDuePayload> = {
      id: rentRoutineId,
      ownerId: terms.tenantId,
      period: terms.rentPeriod,
      phase: terms.rentPhase,
      kind: "tenancy.rent_due",
      payload: {
        tenancyId: String(terms.id),
        housingUnitId: String(terms.housingUnitId),
        landlordId: String(terms.landlordId),
      },
    };

    return withTransaction(
      this.#pool,
      async (client) => {
        const unitResult = await client.query<HousingUnitRow>(
          `SELECT ${HOUSING_UNIT_COLUMNS}
             FROM housing_units
            WHERE world_id = $1 AND id = $2
            FOR KEY SHARE`,
          [terms.worldId, terms.housingUnitId],
        );
        const unitRow = unitResult.rows[0];
        if (unitRow === undefined) {
          throw new DomainInvariantError(
            `Housing unit does not exist: ${terms.housingUnitId}`,
          );
        }
        if (unitRow.owner_id !== String(terms.landlordId)) {
          throw new DomainInvariantError(
            `Landlord ${terms.landlordId} does not own housing unit ${terms.housingUnitId}`,
          );
        }

        const accountIds = [
          String(terms.landlordAccountId),
          String(terms.tenantAccountId),
        ].sort((a, b) => a.localeCompare(b));
        const accounts = await client.query<AccountCurrencyRow>(
          `SELECT id, currency
             FROM ledger_accounts
            WHERE world_id = $1 AND id = ANY($2::text[])
            ORDER BY id
            FOR KEY SHARE`,
          [terms.worldId, accountIds],
        );
        if (accounts.rows.length !== 2) {
          const found = new Set(accounts.rows.map((row) => row.id));
          const missing = accountIds.filter((id) => !found.has(id));
          throw new DomainInvariantError(
            `Tenancy ledger account does not exist: ${missing.join(", ")}`,
          );
        }
        if (accounts.rows.some((row) => row.currency !== currency)) {
          throw new DomainInvariantError(
            `Tenancy currency ${currency} does not match both rent accounts`,
          );
        }

        await createRoutineInTransaction(client, terms.worldId, routine);
        const inserted = await client.query<TenancyRow>(
          `INSERT INTO tenancies (
             world_id, id, housing_unit_id, landlord_id, tenant_id,
             landlord_account_id, tenant_account_id, currency,
             rent_per_period, rent_routine_id, starts_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${TENANCY_COLUMNS}`,
          [
            terms.worldId,
            terms.id,
            terms.housingUnitId,
            terms.landlordId,
            terms.tenantId,
            terms.landlordAccountId,
            terms.tenantAccountId,
            currency,
            terms.rentPerPeriod.toString(),
            rentRoutineId,
            terms.startsAt.toString(),
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(`Tenancy insert returned no row: ${terms.id}`);
        }

        const firstRent =
          await materializeNextRoutineCommitmentInTransaction<RentDuePayload>(
            client,
            terms.worldId,
            rentRoutineId,
            terms.startsAt,
            true,
          );
        return { tenancy: mapTenancy(row), firstRent };
      },
      "read committed",
    );
  }

  async getTenancy(
    worldId: WorldId,
    tenancyId: TenancyId,
  ): Promise<PersistedTenancy | undefined> {
    const result = await this.#pool.query<TenancyRow>(
      `SELECT ${TENANCY_COLUMNS}
         FROM tenancies
        WHERE world_id = $1 AND id = $2`,
      [worldId, tenancyId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapTenancy(row);
  }

  async settleRent(input: {
    readonly worldId: WorldId;
    readonly tenancyId: TenancyId;
    readonly commitmentId: CommitmentId;
    readonly workerId: string;
    readonly at: SimTime;
  }): Promise<SettledRent> {
    const tenancy = await this.getTenancy(input.worldId, input.tenancyId);
    if (tenancy === undefined) {
      throw new DomainInvariantError(`Tenancy does not exist: ${input.tenancyId}`);
    }

    let persisted = await this.#routines.getCommitment(
      input.worldId,
      input.commitmentId,
    );
    if (persisted === undefined) {
      throw new DomainInvariantError(`Commitment does not exist: ${input.commitmentId}`);
    }
    assertRentCommitment(tenancy, persisted);

    const idempotencyKey = rentIdempotencyKey(
      tenancy.id,
      String(input.commitmentId),
    );

    if (persisted.commitment.status === "fulfilled") {
      const existing = await this.#ledger.getByIdempotencyKey(
        input.worldId,
        idempotencyKey,
      );
      if (existing === undefined || existing.type !== "tenancy.rent") {
        throw new DomainInvariantError(
          `Fulfilled rent commitment ${input.commitmentId} has no posted rent payment`,
        );
      }
      return { tenancy, rentCommitment: persisted, payment: existing };
    }

    if (persisted.commitment.status !== "planned") {
      throw new DomainInvariantError(
        `Rent commitment ${input.commitmentId} cannot be settled because it is ${persisted.commitment.status}`,
      );
    }
    if (input.at < persisted.commitment.dueAt) {
      throw new DomainInvariantError(
        `Rent commitment ${input.commitmentId} cannot be settled before ${persisted.commitment.dueAt}`,
      );
    }
    if (persisted.scheduledEventId === undefined) {
      throw new DomainInvariantError(
        `Rent commitment ${input.commitmentId} has no scheduled event`,
      );
    }
    await assertScheduledOwnership(
      this.#pool,
      input.worldId,
      persisted.scheduledEventId,
      input.workerId,
    );

    const payment = await this.#ledger.transfer({
      worldId: input.worldId,
      transactionId: rentTransactionId(tenancy.id, String(input.commitmentId)),
      simTime: persisted.commitment.dueAt,
      currency: tenancy.currency,
      fromAccountId: tenancy.tenantAccountId,
      toAccountId: tenancy.landlordAccountId,
      amount: tenancy.rentPerPeriod,
      idempotencyKey,
      type: "tenancy.rent",
      metadata: {
        tenancyId: String(tenancy.id),
        housingUnitId: String(tenancy.housingUnitId),
        commitmentId: String(input.commitmentId),
        dueAt: persisted.commitment.dueAt.toString(),
      },
    });

    let nextRent: PersistedCommitment | undefined;
    try {
      const fulfilled = await this.#routines.fulfillClaimedAndScheduleNext({
        worldId: input.worldId,
        commitmentId: input.commitmentId,
        workerId: input.workerId,
        at: input.at,
      });
      persisted = fulfilled.fulfilled;
      nextRent = fulfilled.next;
    } catch (error) {
      const reread = await this.#routines.getCommitment(
        input.worldId,
        input.commitmentId,
      );
      if (reread === undefined || reread.commitment.status !== "fulfilled") {
        throw error;
      }
      assertRentCommitment(tenancy, reread);
      persisted = reread;
    }

    assertRentCommitment(tenancy, persisted);
    return {
      tenancy,
      rentCommitment: persisted,
      payment,
      ...(nextRent === undefined ? {} : { nextRent }),
    };
  }
}
