BEGIN;

CREATE TABLE ledger_accounts (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  owner_id TEXT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9_]{1,11}$'),
  kind TEXT NOT NULL CHECK (kind IN ('asset','liability','income','expense','equity','system')),
  allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
  label TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id)
);

CREATE INDEX ledger_accounts_owner_idx
  ON ledger_accounts (world_id, owner_id)
  WHERE owner_id IS NOT NULL;

CREATE TABLE ledger_transactions (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  sim_time BIGINT NOT NULL CHECK (sim_time >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9_]{1,11}$'),
  type TEXT NOT NULL CHECK (length(type) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  idempotency_fingerprint TEXT NOT NULL CHECK (length(idempotency_fingerprint) > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'posting' CHECK (status IN ('posting','posted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ NULL,
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, idempotency_key),
  CONSTRAINT ledger_transaction_posted_consistency CHECK (
    (status = 'posting' AND posted_at IS NULL)
    OR
    (status = 'posted' AND posted_at IS NOT NULL)
  )
);

CREATE INDEX ledger_transactions_time_idx
  ON ledger_transactions (world_id, sim_time, id)
  WHERE status = 'posted';

CREATE TABLE ledger_entries (
  world_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 0),
  account_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount <> 0),
  PRIMARY KEY (world_id, transaction_id, line_no),
  FOREIGN KEY (world_id, transaction_id)
    REFERENCES ledger_transactions(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, account_id)
    REFERENCES ledger_accounts(world_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX ledger_entries_account_idx
  ON ledger_entries (world_id, account_id, transaction_id);

CREATE OR REPLACE FUNCTION validate_posted_ledger_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  tx_status TEXT;
  tx_currency TEXT;
  line_count BIGINT;
  entry_sum NUMERIC;
  wrong_currency_count BIGINT;
BEGIN
  SELECT status, currency
    INTO tx_status, tx_currency
    FROM ledger_transactions
   WHERE world_id = NEW.world_id AND id = NEW.id;

  IF tx_status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(sum(e.amount), 0),
         count(*) FILTER (WHERE a.currency <> tx_currency)
    INTO line_count, entry_sum, wrong_currency_count
    FROM ledger_entries e
    JOIN ledger_accounts a
      ON a.world_id = e.world_id
     AND a.id = e.account_id
   WHERE e.world_id = NEW.world_id
     AND e.transaction_id = NEW.id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'posted ledger transaction % requires at least two entries', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF entry_sum <> 0 THEN
    RAISE EXCEPTION 'posted ledger transaction % is unbalanced by %', NEW.id, entry_sum
      USING ERRCODE = '23514';
  END IF;

  IF wrong_currency_count <> 0 THEN
    RAISE EXCEPTION 'posted ledger transaction % contains an account with the wrong currency', NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_balance_guard
AFTER UPDATE ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_posted_ledger_transaction();

CREATE OR REPLACE FUNCTION prevent_posted_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'posted ledger transactions are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ledger_transactions t
     WHERE t.world_id = OLD.world_id
       AND t.id = OLD.transaction_id
       AND t.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'entries of posted ledger transactions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_transactions_immutable_after_post
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_posted_ledger_mutation();

CREATE TRIGGER ledger_entries_immutable_after_post
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_posted_ledger_mutation();

CREATE OR REPLACE FUNCTION prevent_ledger_account_identity_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.world_id <> OLD.world_id
     OR NEW.id <> OLD.id
     OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'ledger account identity and currency are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_account_identity_immutable
BEFORE UPDATE ON ledger_accounts
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_account_identity_mutation();

COMMIT;
