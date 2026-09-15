\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('ledger-sql-test');

INSERT INTO ledger_accounts (
  world_id, id, owner_id, currency, kind, allow_negative, label
) VALUES
  ('ledger-sql-test', 'system', NULL, 'HBC', 'system', TRUE, 'System treasury'),
  ('ledger-sql-test', 'alice', 'person-alice', 'HBC', 'asset', FALSE, 'Alice wallet');

INSERT INTO ledger_transactions (
  world_id, id, sim_time, currency, type, idempotency_key,
  idempotency_fingerprint, metadata, status
) VALUES (
  'ledger-sql-test', 'fund-alice', 10, 'HBC', 'bootstrap',
  'sql:fund-alice', 'sql-fingerprint-1', '{}'::jsonb, 'posting'
);

INSERT INTO ledger_entries (
  world_id, transaction_id, line_no, account_id, amount
) VALUES
  ('ledger-sql-test', 'fund-alice', 0, 'system', -500),
  ('ledger-sql-test', 'fund-alice', 1, 'alice', 500);

UPDATE ledger_transactions
   SET status = 'posted', posted_at = now()
 WHERE world_id = 'ledger-sql-test' AND id = 'fund-alice';

DO $$
DECLARE
  alice_balance BIGINT;
  system_balance BIGINT;
BEGIN
  SELECT COALESCE(sum(e.amount), 0)
    INTO alice_balance
    FROM ledger_entries e
    JOIN ledger_transactions t
      ON t.world_id = e.world_id AND t.id = e.transaction_id
   WHERE e.world_id = 'ledger-sql-test'
     AND e.account_id = 'alice'
     AND t.status = 'posted';

  SELECT COALESCE(sum(e.amount), 0)
    INTO system_balance
    FROM ledger_entries e
    JOIN ledger_transactions t
      ON t.world_id = e.world_id AND t.id = e.transaction_id
   WHERE e.world_id = 'ledger-sql-test'
     AND e.account_id = 'system'
     AND t.status = 'posted';

  IF alice_balance <> 500 OR system_balance <> -500 THEN
    RAISE EXCEPTION 'ledger balances are incorrect: alice=%, system=%', alice_balance, system_balance;
  END IF;

  IF (SELECT COALESCE(sum(amount), 0) FROM ledger_entries
       WHERE world_id = 'ledger-sql-test' AND transaction_id = 'fund-alice') <> 0 THEN
    RAISE EXCEPTION 'posted ledger transaction is not balanced';
  END IF;

  IF to_regclass('ledger_transactions_world_id_idempotency_key_key') IS NULL THEN
    RAISE EXCEPTION 'ledger idempotency uniqueness is missing';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO ledger_entries (
      world_id, transaction_id, line_no, account_id, amount
    ) VALUES (
      'ledger-sql-test', 'fund-alice', 2, 'alice', 1
    );
    RAISE EXCEPTION 'posted transaction unexpectedly accepted another entry';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE ledger_transactions
       SET metadata = '{"tampered":true}'::jsonb
     WHERE world_id = 'ledger-sql-test' AND id = 'fund-alice';
    RAISE EXCEPTION 'posted transaction unexpectedly accepted mutation';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$$;
