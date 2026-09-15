BEGIN;

CREATE TABLE employments (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  employer_id TEXT NOT NULL CHECK (length(employer_id) > 0),
  employee_id TEXT NOT NULL CHECK (length(employee_id) > 0),
  employer_account_id TEXT NOT NULL,
  employee_account_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9_]{1,11}$'),
  wage_per_shift BIGINT NOT NULL CHECK (wage_per_shift > 0),
  work_routine_id TEXT NOT NULL,
  starts_at BIGINT NOT NULL CHECK (starts_at >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_at BIGINT NULL CHECK (ended_at IS NULL OR ended_at >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, work_routine_id),
  FOREIGN KEY (world_id, employer_account_id)
    REFERENCES ledger_accounts(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, employee_account_id)
    REFERENCES ledger_accounts(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, work_routine_id)
    REFERENCES routines(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT employment_distinct_parties CHECK (employer_id <> employee_id),
  CONSTRAINT employment_distinct_accounts CHECK (employer_account_id <> employee_account_id),
  CONSTRAINT employment_status_consistency CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR
    (status = 'ended' AND ended_at IS NOT NULL AND ended_at >= starts_at)
  )
);

CREATE INDEX employments_employee_idx
  ON employments (world_id, employee_id, status);

CREATE INDEX employments_employer_idx
  ON employments (world_id, employer_id, status);

COMMIT;
