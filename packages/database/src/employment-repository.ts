import {
  DomainInvariantError,
  asEmploymentId,
  asEntityId,
  asLedgerAccountId,
  asRoutineId,
  asWorldId,
  simTime,
  type CommitmentId,
  type EmploymentId,
  type EntityId,
  type LedgerAccountId,
  type RoutineId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  salaryIdempotencyKey,
  salaryTransactionId,
  validateEmploymentTerms,
  workRoutineIdForEmployment,
  type EmploymentShiftPayload,
  type EmploymentTerms,
} from "@hobbo/economy";
import {
  ledgerAffinityKey,
  type PeriodicRoutine,
} from "@hobbo/simulation";
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

interface EmploymentRow extends QueryResultRow {
  world_id: string;
  id: string;
  employer_id: string;
  employee_id: string;
  employer_account_id: string;
  employee_account_id: string;
  currency: string;
  wage_per_shift: string;
  work_routine_id: string;
  starts_at: string;
  status: "active" | "ended";
  ended_at: string | null;
}

interface AccountCurrencyRow extends QueryResultRow {
  id: string;
  currency: string;
}

export interface PersistedEmployment {
  readonly id: EmploymentId;
  readonly worldId: WorldId;
  readonly employerId: EntityId;
  readonly employeeId: EntityId;
  readonly employerAccountId: LedgerAccountId;
  readonly employeeAccountId: LedgerAccountId;
  readonly currency: string;
  readonly wagePerShift: bigint;
  readonly workRoutineId: RoutineId;
  readonly startsAt: SimTime;
  readonly status: "active" | "ended";
  readonly endedAt?: SimTime;
}

export interface CreatedEmployment {
  readonly employment: PersistedEmployment;
  readonly firstShift: PersistedCommitment<EmploymentShiftPayload>;
}

export interface SettledEmploymentShift {
  readonly employment: PersistedEmployment;
  readonly shift: PersistedCommitment<EmploymentShiftPayload>;
  readonly salary: PersistedLedgerTransaction;
  readonly nextShift?: PersistedCommitment;
}

const EMPLOYMENT_COLUMNS = `
  world_id, id, employer_id, employee_id, employer_account_id,
  employee_account_id, currency, wage_per_shift, work_routine_id,
  starts_at, status, ended_at
`;

function mapEmployment(row: EmploymentRow): PersistedEmployment {
  return {
    id: asEmploymentId(row.id),
    worldId: asWorldId(row.world_id),
    employerId: asEntityId(row.employer_id),
    employeeId: asEntityId(row.employee_id),
    employerAccountId: asLedgerAccountId(row.employer_account_id),
    employeeAccountId: asLedgerAccountId(row.employee_account_id),
    currency: row.currency,
    wagePerShift: BigInt(row.wage_per_shift),
    workRoutineId: asRoutineId(row.work_routine_id),
    startsAt: simTime(row.starts_at),
    status: row.status,
    ...(row.ended_at === null ? {} : { endedAt: simTime(row.ended_at) }),
  };
}

function assertEmploymentShift(
  employment: PersistedEmployment,
  persisted: PersistedCommitment,
): asserts persisted is PersistedCommitment<EmploymentShiftPayload> {
  const shift = persisted.commitment;
  if (shift.routineId !== employment.workRoutineId) {
    throw new DomainInvariantError(
      `Commitment ${shift.id} does not belong to employment ${employment.id}`,
    );
  }
  if (shift.ownerId !== employment.employeeId) {
    throw new DomainInvariantError(
      `Commitment ${shift.id} is not owned by employee ${employment.employeeId}`,
    );
  }
  if (shift.kind !== "employment.shift") {
    throw new DomainInvariantError(
      `Commitment ${shift.id} is not an employment shift`,
    );
  }
  if (
    typeof shift.payload !== "object" ||
    shift.payload === null ||
    (shift.payload as { employmentId?: unknown }).employmentId !== String(employment.id)
  ) {
    throw new DomainInvariantError(
      `Commitment ${shift.id} payload does not identify employment ${employment.id}`,
    );
  }
}

export class PostgresEmploymentRepository {
  readonly #pool: Pool;
  readonly #routines: PostgresRoutineRepository;
  readonly #ledger: PostgresLedgerRepository;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#routines = new PostgresRoutineRepository(pool);
    this.#ledger = new PostgresLedgerRepository(pool);
  }

  async create(terms: EmploymentTerms): Promise<CreatedEmployment> {
    const currency = validateEmploymentTerms(terms);
    const workRoutineId = workRoutineIdForEmployment(terms.id);
    const routine: PeriodicRoutine<EmploymentShiftPayload> = {
      id: workRoutineId,
      ownerId: terms.employeeId,
      period: terms.workPeriod,
      phase: terms.workPhase,
      kind: "employment.shift",
      payload: {
        employmentId: String(terms.id),
        employerId: String(terms.employerId),
      },
      affinityKeys: [
        ledgerAffinityKey(String(terms.employerAccountId)),
        ledgerAffinityKey(String(terms.employeeAccountId)),
      ],
    };

    return withTransaction(
      this.#pool,
      async (client) => {
        const accountIds = [
          String(terms.employerAccountId),
          String(terms.employeeAccountId),
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
            `Employment ledger account does not exist: ${missing.join(", ")}`,
          );
        }
        if (accounts.rows.some((row) => row.currency !== currency)) {
          throw new DomainInvariantError(
            `Employment currency ${currency} does not match both payroll accounts`,
          );
        }

        await createRoutineInTransaction(client, terms.worldId, routine);

        const inserted = await client.query<EmploymentRow>(
          `INSERT INTO employments (
             world_id, id, employer_id, employee_id, employer_account_id,
             employee_account_id, currency, wage_per_shift, work_routine_id,
             starts_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING ${EMPLOYMENT_COLUMNS}`,
          [
            terms.worldId,
            terms.id,
            terms.employerId,
            terms.employeeId,
            terms.employerAccountId,
            terms.employeeAccountId,
            currency,
            terms.wagePerShift.toString(),
            workRoutineId,
            terms.startsAt.toString(),
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(`Employment insert returned no row: ${terms.id}`);
        }

        const firstShift =
          await materializeNextRoutineCommitmentInTransaction<EmploymentShiftPayload>(
            client,
            terms.worldId,
            workRoutineId,
            terms.startsAt,
            true,
          );

        return {
          employment: mapEmployment(row),
          firstShift,
        };
      },
      "read committed",
    );
  }

  async get(
    worldId: WorldId,
    employmentId: EmploymentId,
  ): Promise<PersistedEmployment | undefined> {
    const result = await this.#pool.query<EmploymentRow>(
      `SELECT ${EMPLOYMENT_COLUMNS}
         FROM employments
        WHERE world_id = $1 AND id = $2`,
      [worldId, employmentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapEmployment(row);
  }

  async settleShift(input: {
    readonly worldId: WorldId;
    readonly employmentId: EmploymentId;
    readonly commitmentId: CommitmentId;
    readonly workerId: string;
    readonly at: SimTime;
  }): Promise<SettledEmploymentShift> {
    const employment = await this.get(input.worldId, input.employmentId);
    if (employment === undefined) {
      throw new DomainInvariantError(`Employment does not exist: ${input.employmentId}`);
    }

    let persisted = await this.#routines.getCommitment(
      input.worldId,
      input.commitmentId,
    );
    if (persisted === undefined) {
      throw new DomainInvariantError(`Commitment does not exist: ${input.commitmentId}`);
    }
    assertEmploymentShift(employment, persisted);

    let nextShift: PersistedCommitment | undefined;
    if (persisted.commitment.status === "planned") {
      try {
        const fulfilled = await this.#routines.fulfillClaimedAndScheduleNext({
          worldId: input.worldId,
          commitmentId: input.commitmentId,
          workerId: input.workerId,
          at: input.at,
        });
        persisted = fulfilled.fulfilled;
        nextShift = fulfilled.next;
      } catch (error) {
        // Another worker may have completed the durable shift between our read
        // and fulfillment attempt. Re-read before deciding whether this was a
        // genuine invariant failure. Salary posting is independently idempotent.
        const reread = await this.#routines.getCommitment(
          input.worldId,
          input.commitmentId,
        );
        if (reread === undefined || reread.commitment.status !== "fulfilled") {
          throw error;
        }
        assertEmploymentShift(employment, reread);
        persisted = reread;
      }
    }

    assertEmploymentShift(employment, persisted);
    if (persisted.commitment.status !== "fulfilled") {
      throw new DomainInvariantError(
        `Shift ${input.commitmentId} cannot be paid because it is ${persisted.commitment.status}`,
      );
    }
    const resolvedAt = persisted.commitment.resolvedAt;
    if (resolvedAt === undefined) {
      throw new DomainInvariantError(
        `Fulfilled shift ${input.commitmentId} has no resolution time`,
      );
    }

    const salary = await this.#ledger.transfer({
      worldId: input.worldId,
      transactionId: salaryTransactionId(
        employment.id,
        String(input.commitmentId),
      ),
      simTime: resolvedAt,
      currency: employment.currency,
      fromAccountId: employment.employerAccountId,
      toAccountId: employment.employeeAccountId,
      amount: employment.wagePerShift,
      idempotencyKey: salaryIdempotencyKey(
        employment.id,
        String(input.commitmentId),
      ),
      type: "employment.salary",
      metadata: {
        employmentId: String(employment.id),
        commitmentId: String(input.commitmentId),
      },
    });

    return {
      employment,
      shift: persisted,
      salary,
      ...(nextShift === undefined ? {} : { nextShift }),
    };
  }
}
