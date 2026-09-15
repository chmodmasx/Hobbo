\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('employment-sql-test');

INSERT INTO ledger_accounts (
  world_id, id, owner_id, currency, kind, allow_negative
) VALUES
  ('employment-sql-test', 'employer-cash', 'business-cafe', 'HBC', 'asset', FALSE),
  ('employment-sql-test', 'employee-wallet', 'person-alice', 'HBC', 'asset', FALSE);

INSERT INTO routines (
  world_id, id, owner_id, period, phase, kind, payload
) VALUES (
  'employment-sql-test',
  'employment:sql-job:shift',
  'person-alice',
  86400,
  32400,
  'employment.shift',
  '{"employmentId":"sql-job","employerId":"business-cafe"}'::jsonb
);

INSERT INTO employments (
  world_id, id, employer_id, employee_id,
  employer_account_id, employee_account_id,
  currency, wage_per_shift, work_routine_id, starts_at
) VALUES (
  'employment-sql-test',
  'sql-job',
  'business-cafe',
  'person-alice',
  'employer-cash',
  'employee-wallet',
  'HBC',
  250,
  'employment:sql-job:shift',
  0
);

DO $$
BEGIN
  IF (SELECT count(*) FROM employments WHERE world_id = 'employment-sql-test') <> 1 THEN
    RAISE EXCEPTION 'employment insert was not persisted';
  END IF;

  IF (SELECT status FROM employments WHERE world_id = 'employment-sql-test' AND id = 'sql-job') <> 'active' THEN
    RAISE EXCEPTION 'employment did not default to active';
  END IF;

  IF to_regclass('employments_employee_idx') IS NULL THEN
    RAISE EXCEPTION 'employment employee index is missing';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO employments (
      world_id, id, employer_id, employee_id,
      employer_account_id, employee_account_id,
      currency, wage_per_shift, work_routine_id, starts_at
    ) VALUES (
      'employment-sql-test', 'bad-wage', 'business-cafe', 'person-alice',
      'employer-cash', 'employee-wallet', 'HBC', 0,
      'employment:sql-job:shift', 0
    );
    RAISE EXCEPTION 'zero wage unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE employments
       SET status = 'ended', ended_at = -1
     WHERE world_id = 'employment-sql-test' AND id = 'sql-job';
    RAISE EXCEPTION 'negative employment end time unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
