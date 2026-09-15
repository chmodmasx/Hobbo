import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asLedgerAccountId,
  asLedgerTransactionId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresLedgerRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const ledger = new PostgresLedgerRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE ledger_entries, ledger_transactions, ledger_accounts, commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

async function createWorldAndAccounts(worldName: string) {
  const worldId = asWorldId(worldName);
  await worlds.create(worldId);
  const system = asLedgerAccountId("system");
  const alice = asLedgerAccountId("alice");
  const bob = asLedgerAccountId("bob");
  const charlie = asLedgerAccountId("charlie");

  await ledger.createAccount({
    id: system,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
    label: "System treasury",
  });
  for (const [id, ownerId] of [
    [alice, "person-alice"],
    [bob, "person-bob"],
    [charlie, "person-charlie"],
  ] as const) {
    await ledger.createAccount({
      id,
      worldId,
      currency: "HBC",
      kind: "asset",
      allowNegative: false,
      ownerId,
    });
  }

  return { worldId, system, alice, bob, charlie };
}

async function fund(
  worldId: ReturnType<typeof asWorldId>,
  system: ReturnType<typeof asLedgerAccountId>,
  account: ReturnType<typeof asLedgerAccountId>,
  amount: bigint,
) {
  return ledger.transfer({
    worldId,
    transactionId: asLedgerTransactionId(`fund:${account}`),
    simTime: simTime(1),
    currency: "HBC",
    fromAccountId: system,
    toAccountId: account,
    amount,
    idempotencyKey: `fund:${account}`,
    type: "bootstrap.funding",
  });
}

describe("durable double-entry ledger", () => {
  it("derives balances exclusively from balanced posted entries", async () => {
    const { worldId, system, alice, bob } = await createWorldAndAccounts(
      "ledger-basic-world",
    );
    await fund(worldId, system, alice, 1_000n);

    const payment = await ledger.transfer({
      worldId,
      transactionId: asLedgerTransactionId("payment-1"),
      simTime: simTime(20),
      currency: "hbc",
      fromAccountId: alice,
      toAccountId: bob,
      amount: 300n,
      idempotencyKey: "payment:alice:bob:1",
      type: "purchase",
      metadata: { item: "coffee" },
    });

    expect(payment.status).toBe("posted");
    expect(payment.currency).toBe("HBC");
    expect(payment.entries).toEqual([
      { accountId: alice, amount: -300n },
      { accountId: bob, amount: 300n },
    ]);
    expect(await ledger.getBalance(worldId, system)).toBe(-1_000n);
    expect(await ledger.getBalance(worldId, alice)).toBe(700n);
    expect(await ledger.getBalance(worldId, bob)).toBe(300n);

    const globalSum = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(e.amount), 0)::text AS total
         FROM ledger_entries e
         JOIN ledger_transactions t
           ON t.world_id = e.world_id AND t.id = e.transaction_id
        WHERE e.world_id = $1 AND t.status = 'posted'`,
      [worldId],
    );
    expect(globalSum.rows[0]?.total).toBe("0");
  });

  it("serializes concurrent retries by idempotency key and posts once", async () => {
    const { worldId, system, alice, bob } = await createWorldAndAccounts(
      "ledger-idempotency-world",
    );
    await fund(worldId, system, alice, 500n);

    const common = {
      worldId,
      simTime: simTime(30),
      currency: "HBC",
      fromAccountId: alice,
      toAccountId: bob,
      amount: 125n,
      idempotencyKey: "payment:retry-safe",
      type: "purchase",
    } as const;

    const [first, second] = await Promise.all([
      ledger.transfer({
        ...common,
        transactionId: asLedgerTransactionId("payment-retry-a"),
      }),
      ledger.transfer({
        ...common,
        transactionId: asLedgerTransactionId("payment-retry-b"),
      }),
    ]);

    expect(second.id).toBe(first.id);
    expect(await ledger.getBalance(worldId, alice)).toBe(375n);
    expect(await ledger.getBalance(worldId, bob)).toBe(125n);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ledger_transactions
        WHERE world_id = $1 AND idempotency_key = $2`,
      [worldId, common.idempotencyKey],
    );
    expect(count.rows[0]?.count).toBe("1");

    await expect(
      ledger.transfer({
        ...common,
        transactionId: asLedgerTransactionId("payment-retry-changed"),
        amount: 126n,
      }),
    ).rejects.toThrow(/different ledger operation/i);
  });

  it("prevents concurrent double-spend from a non-negative account", async () => {
    const { worldId, system, alice, bob, charlie } = await createWorldAndAccounts(
      "ledger-double-spend-world",
    );
    await fund(worldId, system, alice, 100n);

    const results = await Promise.allSettled([
      ledger.transfer({
        worldId,
        transactionId: asLedgerTransactionId("spend-bob"),
        simTime: simTime(40),
        currency: "HBC",
        fromAccountId: alice,
        toAccountId: bob,
        amount: 80n,
        idempotencyKey: "spend:bob",
      }),
      ledger.transfer({
        worldId,
        transactionId: asLedgerTransactionId("spend-charlie"),
        simTime: simTime(40),
        currency: "HBC",
        fromAccountId: alice,
        toAccountId: charlie,
        amount: 80n,
        idempotencyKey: "spend:charlie",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(String(rejection?.status === "rejected" ? rejection.reason : "")).toMatch(
      /insufficient funds/i,
    );

    expect(await ledger.getBalance(worldId, alice)).toBe(20n);
    const destinationTotal =
      (await ledger.getBalance(worldId, bob)) +
      (await ledger.getBalance(worldId, charlie));
    expect(destinationTotal).toBe(80n);
  });

  it("replays an already committed payment from a fresh pool after response loss", async () => {
    const { worldId, system, alice, bob } = await createWorldAndAccounts(
      "ledger-restart-world",
    );
    await fund(worldId, system, alice, 400n);

    const first = await ledger.transfer({
      worldId,
      transactionId: asLedgerTransactionId("restart-original"),
      simTime: simTime(50),
      currency: "HBC",
      fromAccountId: alice,
      toAccountId: bob,
      amount: 150n,
      idempotencyKey: "restart-safe-payment",
      type: "purchase",
    });

    const freshPool = new Pool();
    try {
      const freshLedger = new PostgresLedgerRepository(freshPool);
      const replayed = await freshLedger.transfer({
        worldId,
        transactionId: asLedgerTransactionId("restart-new-request-id"),
        simTime: simTime(50),
        currency: "HBC",
        fromAccountId: alice,
        toAccountId: bob,
        amount: 150n,
        idempotencyKey: "restart-safe-payment",
        type: "purchase",
      });

      expect(replayed.id).toBe(first.id);
      expect(replayed.entries).toEqual(first.entries);
    } finally {
      await freshPool.end();
    }

    expect(await ledger.getBalance(worldId, alice)).toBe(250n);
    expect(await ledger.getBalance(worldId, bob)).toBe(150n);
  });

  it("rejects currency mismatch before posting anything", async () => {
    const { worldId, system, alice } = await createWorldAndAccounts(
      "ledger-currency-world",
    );
    const usd = asLedgerAccountId("usd-wallet");
    await ledger.createAccount({
      id: usd,
      worldId,
      currency: "USD",
      kind: "asset",
      allowNegative: false,
    });
    await fund(worldId, system, alice, 100n);

    await expect(
      ledger.transfer({
        worldId,
        transactionId: asLedgerTransactionId("wrong-currency"),
        simTime: simTime(60),
        currency: "HBC",
        fromAccountId: alice,
        toAccountId: usd,
        amount: 10n,
        idempotencyKey: "wrong-currency",
      }),
    ).rejects.toThrow(/does not match both ledger accounts/i);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ledger_transactions
        WHERE world_id = $1 AND id = 'wrong-currency'`,
      [worldId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("database constraints reject unbalanced posting and mutation after posting", async () => {
    const { worldId, system, alice } = await createWorldAndAccounts(
      "ledger-db-guard-world",
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ledger_transactions (
           world_id, id, sim_time, currency, type, idempotency_key,
           idempotency_fingerprint, metadata, status
         ) VALUES ($1,'unbalanced',70,'HBC','test','unbalanced-key','fp','{}','posting')`,
        [worldId],
      );
      await client.query(
        `INSERT INTO ledger_entries
           (world_id, transaction_id, line_no, account_id, amount)
         VALUES ($1,'unbalanced',0,$2,-10), ($1,'unbalanced',1,$3,9)`,
        [worldId, system, alice],
      );
      await client.query(
        `UPDATE ledger_transactions
            SET status = 'posted', posted_at = now()
          WHERE world_id = $1 AND id = 'unbalanced'`,
        [worldId],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const rolledBack = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ledger_transactions
        WHERE world_id = $1 AND id = 'unbalanced'`,
      [worldId],
    );
    expect(rolledBack.rows[0]?.count).toBe("0");

    const posted = await ledger.transfer({
      worldId,
      transactionId: asLedgerTransactionId("immutable-posted"),
      simTime: simTime(71),
      currency: "HBC",
      fromAccountId: system,
      toAccountId: alice,
      amount: 10n,
      idempotencyKey: "immutable-posted",
    });
    expect(posted.status).toBe("posted");

    await expect(
      pool.query(
        `INSERT INTO ledger_entries
           (world_id, transaction_id, line_no, account_id, amount)
         VALUES ($1,$2,2,$3,1)`,
        [worldId, posted.id, alice],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      pool.query(
        `UPDATE ledger_transactions
            SET metadata = '{"tampered":true}'::jsonb
          WHERE world_id = $1 AND id = $2`,
        [worldId, posted.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
