INSERT INTO worlds (id, current_sim_time)
VALUES ('sql-routine-world', 0);

INSERT INTO routines (
  world_id, id, owner_id, period, phase, kind, payload
) VALUES (
  'sql-routine-world', 'daily-work', 'person-1', 86400, 32400,
  'work.start', '{"job":"cafe"}'::jsonb
);

INSERT INTO scheduled_events (
  world_id, id, due_at, ordinal, type, payload, correlation_id
) VALUES (
  'sql-routine-world', 'commitment-event-1', 32400, 0,
  'commitment.due', '{}', 'routine:daily-work:32400'
);

INSERT INTO commitments (
  world_id, id, routine_id, owner_id, due_at, kind, payload,
  correlation_id, scheduled_event_id
) VALUES (
  'sql-routine-world', 'commitment-1', 'daily-work', 'person-1', 32400,
  'work.start', '{"job":"cafe"}'::jsonb,
  'routine:daily-work:32400', 'commitment-event-1'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO commitments (
      world_id, id, routine_id, owner_id, due_at, kind, payload,
      correlation_id
    ) VALUES (
      'sql-routine-world', 'commitment-duplicate-planned', 'daily-work',
      'person-1', 118800, 'work.start', '{}', 'duplicate'
    );
    RAISE EXCEPTION 'expected one-planned-per-routine unique violation';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

UPDATE commitments
SET status = 'fulfilled', resolved_at = 32400
WHERE world_id = 'sql-routine-world' AND id = 'commitment-1';

DO $$
BEGIN
  BEGIN
    INSERT INTO routines (
      world_id, id, owner_id, period, phase, kind
    ) VALUES (
      'sql-routine-world', 'invalid-phase', 'person-1', 100, 100, 'invalid'
    );
    RAISE EXCEPTION 'expected routine phase check violation';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO commitments (
      world_id, id, owner_id, due_at, kind, payload, correlation_id,
      status, resolved_at
    ) VALUES (
      'sql-routine-world', 'invalid-resolution', 'person-1', 10,
      'invalid', '{}', 'invalid', 'planned', 10
    );
    RAISE EXCEPTION 'expected commitment resolution consistency violation';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
