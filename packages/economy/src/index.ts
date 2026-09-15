import {
  DomainInvariantError,
  asLedgerTransactionId,
  asRoutineId,
  type EmploymentId,
  type EntityId,
  type LedgerAccountId,
  type LedgerTransactionId,
  type RoutineId,
  type SimDuration,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";

export type LedgerAccountKind =
  | "asset"
  | "liability"
  | "income"
  | "expense"
  | "equity"
  | "system";

export interface LedgerAccount {
  readonly id: LedgerAccountId;
  readonly worldId: WorldId;
  readonly currency: string;
  readonly kind: LedgerAccountKind;
  readonly allowNegative: boolean;
  readonly ownerId?: string;
  readonly label?: string;
}

export interface LedgerEntryDraft {
  readonly accountId: LedgerAccountId;
  /** Signed integer amount in the currency's smallest simulation unit. */
  readonly amount: bigint;
}

export interface LedgerTransactionDraft {
  readonly id: LedgerTransactionId;
  readonly worldId: WorldId;
  readonly simTime: SimTime;
  readonly currency: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly entries: readonly LedgerEntryDraft[];
  readonly metadata?: unknown;
}

export interface EmploymentTerms {
  readonly id: EmploymentId;
  readonly worldId: WorldId;
  readonly employerId: EntityId;
  readonly employeeId: EntityId;
  readonly employerAccountId: LedgerAccountId;
  readonly employeeAccountId: LedgerAccountId;
  readonly currency: string;
  readonly wagePerShift: bigint;
  readonly workPeriod: SimDuration;
  readonly workPhase: SimDuration;
  readonly startsAt: SimTime;
}

export interface EmploymentShiftPayload {
  readonly employmentId: string;
  readonly employerId: string;
}

export function normalizeCurrencyCode(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,11}$/.test(normalized)) {
    throw new DomainInvariantError(
      "Currency code must contain 2-12 uppercase letters, digits or underscores and start with a letter",
    );
  }
  return normalized;
}

export function assertPositiveMinorUnits(amount: bigint): void {
  if (amount <= 0n) {
    throw new DomainInvariantError("Money amount must be greater than zero");
  }
}

export function sumEntries(entries: readonly LedgerEntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + entry.amount, 0n);
}

export function validateBalancedEntries(
  entries: readonly LedgerEntryDraft[],
): void {
  if (entries.length < 2) {
    throw new DomainInvariantError(
      "A ledger transaction requires at least two entries",
    );
  }

  for (const entry of entries) {
    if (entry.amount === 0n) {
      throw new DomainInvariantError("Ledger entries cannot have zero amount");
    }
  }

  const sum = sumEntries(entries);
  if (sum !== 0n) {
    throw new DomainInvariantError(
      `Ledger transaction is unbalanced by ${sum.toString()} minor units`,
    );
  }
}

export function transferEntries(
  fromAccountId: LedgerAccountId,
  toAccountId: LedgerAccountId,
  amount: bigint,
): readonly LedgerEntryDraft[] {
  assertPositiveMinorUnits(amount);
  if (fromAccountId === toAccountId) {
    throw new DomainInvariantError(
      "Transfer source and destination accounts must differ",
    );
  }

  return [
    { accountId: fromAccountId, amount: -amount },
    { accountId: toAccountId, amount },
  ];
}

export function validateLedgerTransactionDraft(
  draft: LedgerTransactionDraft,
): void {
  normalizeCurrencyCode(draft.currency);
  if (String(draft.id).length === 0) {
    throw new DomainInvariantError("Ledger transaction id cannot be empty");
  }
  if (draft.type.trim().length === 0) {
    throw new DomainInvariantError("Ledger transaction type cannot be empty");
  }
  if (draft.idempotencyKey.trim().length === 0) {
    throw new DomainInvariantError("Idempotency key cannot be empty");
  }
  validateBalancedEntries(draft.entries);
}

export function validateEmploymentTerms(terms: EmploymentTerms): string {
  if (String(terms.id).length === 0) {
    throw new DomainInvariantError("Employment id cannot be empty");
  }
  if (String(terms.employerId).length === 0 || String(terms.employeeId).length === 0) {
    throw new DomainInvariantError("Employment parties cannot be empty");
  }
  if (terms.employerId === terms.employeeId) {
    throw new DomainInvariantError("Employer and employee must differ");
  }
  if (terms.employerAccountId === terms.employeeAccountId) {
    throw new DomainInvariantError("Employer and employee ledger accounts must differ");
  }
  assertPositiveMinorUnits(terms.wagePerShift);
  if (terms.workPeriod <= 0n) {
    throw new DomainInvariantError("Employment work period must be greater than zero");
  }
  if (terms.workPhase < 0n || terms.workPhase >= terms.workPeriod) {
    throw new DomainInvariantError(
      `Employment work phase must be within [0, period), received phase=${terms.workPhase} period=${terms.workPeriod}`,
    );
  }
  return normalizeCurrencyCode(terms.currency);
}

export function workRoutineIdForEmployment(employmentId: EmploymentId): RoutineId {
  if (String(employmentId).length === 0) {
    throw new DomainInvariantError("Employment id cannot be empty");
  }
  return asRoutineId(`employment:${encodeURIComponent(String(employmentId))}:shift`);
}

export function salaryIdempotencyKey(
  employmentId: EmploymentId,
  commitmentId: string,
): string {
  if (commitmentId.length === 0) {
    throw new DomainInvariantError("Salary commitment id cannot be empty");
  }
  return `salary:${encodeURIComponent(String(employmentId))}:${encodeURIComponent(commitmentId)}`;
}

export function salaryTransactionId(
  employmentId: EmploymentId,
  commitmentId: string,
): LedgerTransactionId {
  return asLedgerTransactionId(
    `salary:${encodeURIComponent(String(employmentId))}:${encodeURIComponent(commitmentId)}`,
  );
}
