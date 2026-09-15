import {
  DomainInvariantError,
  asLedgerAccountId,
  asLedgerTransactionId,
  asWorldId,
  simTime,
  type LedgerAccountId,
  type LedgerTransactionId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  normalizeCurrencyCode,
  transferEntries,
  type LedgerAccount,
  type LedgerAccountKind,
  type LedgerEntryDraft,
} from "@hobbo/economy";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface LedgerAccountRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string | null;
  currency: string;
  kind: LedgerAccountKind;
  allow_negative: boolean;
  label: string | null;
}

interface LedgerTransactionRow extends QueryResultRow {
  world_id: string;
  id: string;
  sim_time: string;
  currency: string;
  type: string;
  idempotency_key: string;
  idempotency_fingerprint: string;
  metadata: unknown;
  status: "posting" | "posted";
}

interface LedgerEntryRow extends QueryResultRow {
  line_no: number;
  account_id: string;
  amount: string;
}

interface BalanceRow extends QueryResultRow {
  balance: string;
}

export interface PersistedLedgerTransaction {
  readonly id: LedgerTransactionId;
  readonly worldId: WorldId;
  readonly simTime: SimTime;
  readonly currency: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly metadata: unknown;
  readonly status: "posting" | "posted";
  readonly entries: readonly LedgerEntryDraft[];
}

export interface LedgerTransferInput {
  readonly worldId: WorldId;
  readonly transactionId: LedgerTransactionId;
  readonly simTime: SimTime;
  readonly currency: string;
  readonly fromAccountId: LedgerAccountId;
  readonly toAccountId: LedgerAccountId;
  readonly amount: bigint;
  readonly idempotencyKey: string;
  readonly type?: string;
  readonly metadata?: unknown;
}

const ACCOUNT_COLUMNS = `
  world_id, id, owner_id, currency, kind, allow_negative, label
`;

const TRANSACTION_COLUMNS = `
  world_id, id, sim_time, currency, type, idempotency_key,
  idempotency_fingerprint, metadata, status
`;

function mapAccount(row: LedgerAccountRow): LedgerAccount {
  return {
    id: asLedgerAccountId(row.id),
    worldId: asWorldId(row.world_id),
    currency: row.currency,
    kind: row.kind,
    allowNegative: row.allow_negative,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...(row.label === null ? {} : { label: row.label }),
  };
}

function transferFingerprint(input: LedgerTransferInput, currency: string): string {
  return JSON.stringify([
    "ledger-transfer-v1",
    String(input.worldId),
    String(input.fromAccountId),
    String(input.toAccountId),
    input.amount.toString(),
    input.simTime.toString(),
    currency,
    input.type?.trim() || "transfer",
  ]);
}

async function lockIdempotencyKey(
  client: PoolClient,
  worldId: WorldId,
  idempotencyKey: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`ledger-idempotency:${worldId}:${idempotencyKey}`],
  );
}

async function loadEntries(
  client: PoolClient,
  worldId: WorldId,
  transactionId: LedgerTransactionId,
): Promise<readonly LedgerEntryDraft[]> {
  const result = await client.query<LedgerEntryRow>(
    `SELECT line_no, account_id, amount
       FROM ledger_entries
      WHERE world_id = $1 AND transaction_id = $2
      ORDER BY line_no`,
    [worldId, transactionId],
  );
  return result.rows.map((row) => ({
    accountId: asLedgerAccountId(row.account_id),
    amount: BigInt(row.amount),
  }));
}

async function loadByIdempotencyKey(
  client: PoolClient,
  worldId: WorldId,
  idempotencyKey: string,
): Promise<
  | {
      readonly transaction: PersistedLedgerTransaction;
      readonly fingerprint: string;
    }
  | undefined
> {
  const result = await client.query<LedgerTransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS}
       FROM ledger_transactions
      WHERE world_id = $1 AND idempotency_key = $2`,
    [worldId, idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;

  const id = asLedgerTransactionId(row.id);
  const entries = await loadEntries(client, worldId, id);
  return {
    fingerprint: row.idempotency_fingerprint,
    transaction: {
      id,
      worldId: asWorldId(row.world_id),
      simTime: simTime(row.sim_time),
      currency: row.currency,
      type: row.type,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
      status: row.status,
      entries,
    },
  };
}

async function lockAccounts(
  client: PoolClient,
  worldId: WorldId,
  accountIds: readonly LedgerAccountId[],
): Promise<Map<string, LedgerAccount>> {
  const sortedIds = [...accountIds].map(String).sort((a, b) => a.localeCompare(b));
  const result = await client.query<LedgerAccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
       FROM ledger_accounts
      WHERE world_id = $1 AND id = ANY($2::text[])
      ORDER BY id
      FOR UPDATE`,
    [worldId, sortedIds],
  );

  if (result.rows.length !== sortedIds.length) {
    const found = new Set(result.rows.map((row) => row.id));
    const missing = sortedIds.filter((id) => !found.has(id));
    throw new DomainInvariantError(
      `Ledger account does not exist: ${missing.join(", ")}`,
    );
  }

  return new Map(result.rows.map((row) => [row.id, mapAccount(row)]));
}

async function accountBalanceInTransaction(
  client: Pool | PoolClient,
  worldId: WorldId,
  accountId: LedgerAccountId,
): Promise<bigint> {
  const result = await client.query<BalanceRow>(
    `SELECT COALESCE(sum(e.amount), 0)::text AS balance
       FROM ledger_entries e
       JOIN ledger_transactions t
         ON t.world_id = e.world_id
        AND t.id = e.transaction_id
      WHERE e.world_id = $1
        AND e.account_id = $2
        AND t.status = 'posted'`,
    [worldId, accountId],
  );
  return BigInt(result.rows[0]?.balance ?? "0");
}

export class PostgresLedgerRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createAccount(account: LedgerAccount): Promise<LedgerAccount> {
    const currency = normalizeCurrencyCode(account.currency);
    const result = await this.#pool.query<LedgerAccountRow>(
      `INSERT INTO ledger_accounts (
         world_id, id, owner_id, currency, kind, allow_negative, label
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        account.worldId,
        account.id,
        account.ownerId ?? null,
        currency,
        account.kind,
        account.allowNegative,
        account.label ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(`Ledger account insert returned no row: ${account.id}`);
    }
    return mapAccount(row);
  }

  async getAccount(
    worldId: WorldId,
    accountId: LedgerAccountId,
  ): Promise<LedgerAccount | undefined> {
    const result = await this.#pool.query<LedgerAccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM ledger_accounts
        WHERE world_id = $1 AND id = $2`,
      [worldId, accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  async getBalance(worldId: WorldId, accountId: LedgerAccountId): Promise<bigint> {
    const account = await this.getAccount(worldId, accountId);
    if (account === undefined) {
      throw new DomainInvariantError(`Ledger account does not exist: ${accountId}`);
    }
    return accountBalanceInTransaction(this.#pool, worldId, accountId);
  }

  async getByIdempotencyKey(
    worldId: WorldId,
    idempotencyKey: string,
  ): Promise<PersistedLedgerTransaction | undefined> {
    if (idempotencyKey.trim().length === 0) {
      throw new DomainInvariantError("Idempotency key cannot be empty");
    }
    const client = await this.#pool.connect();
    try {
      return (await loadByIdempotencyKey(client, worldId, idempotencyKey))?.transaction;
    } finally {
      client.release();
    }
  }

  async transfer(input: LedgerTransferInput): Promise<PersistedLedgerTransaction> {
    const currency = normalizeCurrencyCode(input.currency);
    const entries = transferEntries(
      input.fromAccountId,
      input.toAccountId,
      input.amount,
    );
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length === 0) {
      throw new DomainInvariantError("Idempotency key cannot be empty");
    }
    const type = input.type?.trim() || "transfer";
    const fingerprint = transferFingerprint(input, currency);
    const metadata = input.metadata ?? {};
    const metadataJson = toJsonParameter(metadata, `ledger transaction ${input.transactionId} metadata`);

    return withTransaction(
      this.#pool,
      async (client) => {
        await lockIdempotencyKey(client, input.worldId, idempotencyKey);

        const existing = await loadByIdempotencyKey(
          client,
          input.worldId,
          idempotencyKey,
        );
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new DomainInvariantError(
              `Idempotency key ${idempotencyKey} was already used for a different ledger operation`,
            );
          }
          if (existing.transaction.status !== "posted") {
            throw new DomainInvariantError(
              `Idempotent ledger transaction ${existing.transaction.id} is incomplete`,
            );
          }
          return existing.transaction;
        }

        const accounts = await lockAccounts(client, input.worldId, [
          input.fromAccountId,
          input.toAccountId,
        ]);
        const fromAccount = accounts.get(String(input.fromAccountId));
        const toAccount = accounts.get(String(input.toAccountId));
        if (fromAccount === undefined || toAccount === undefined) {
          throw new DomainInvariantError("Ledger account lock returned incomplete results");
        }
        if (fromAccount.currency !== currency || toAccount.currency !== currency) {
          throw new DomainInvariantError(
            `Transfer currency ${currency} does not match both ledger accounts`,
          );
        }

        const sourceBalance = await accountBalanceInTransaction(
          client,
          input.worldId,
          input.fromAccountId,
        );
        if (!fromAccount.allowNegative && sourceBalance < input.amount) {
          throw new DomainInvariantError(
            `Insufficient funds in ${input.fromAccountId}: balance=${sourceBalance.toString()}, required=${input.amount.toString()}`,
          );
        }

        await client.query(
          `INSERT INTO ledger_transactions (
             world_id, id, sim_time, currency, type, idempotency_key,
             idempotency_fingerprint, metadata, status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posting')`,
          [
            input.worldId,
            input.transactionId,
            input.simTime.toString(),
            currency,
            type,
            idempotencyKey,
            fingerprint,
            metadataJson,
          ],
        );

        for (const [lineNo, entry] of entries.entries()) {
          await client.query(
            `INSERT INTO ledger_entries (
               world_id, transaction_id, line_no, account_id, amount
             ) VALUES ($1,$2,$3,$4,$5)`,
            [
              input.worldId,
              input.transactionId,
              lineNo,
              entry.accountId,
              entry.amount.toString(),
            ],
          );
        }

        const posted = await client.query<LedgerTransactionRow>(
          `UPDATE ledger_transactions
              SET status = 'posted', posted_at = now()
            WHERE world_id = $1 AND id = $2 AND status = 'posting'
          RETURNING ${TRANSACTION_COLUMNS}`,
          [input.worldId, input.transactionId],
        );
        const row = posted.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(
            `Ledger transaction could not be posted: ${input.transactionId}`,
          );
        }

        return {
          id: asLedgerTransactionId(row.id),
          worldId: asWorldId(row.world_id),
          simTime: simTime(row.sim_time),
          currency: row.currency,
          type: row.type,
          idempotencyKey: row.idempotency_key,
          metadata: row.metadata,
          status: row.status,
          entries,
        };
      },
      "read committed",
    );
  }
}
