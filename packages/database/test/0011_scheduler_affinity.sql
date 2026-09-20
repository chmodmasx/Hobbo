\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('affinity-sql-test');

INSERT INTO scheduled_events (
  world_id, id, due_at, ordinal, type, payload, correlation_id, affinity_keys
) VALUES
(
  'affinity-sql-test', 'affinity-a', 10, 1, 'test.affinity', '{}'::jsonb,
  'corr-a', ARRAY['entity:alice','ledger:wallet-a']
),
(
  'affinity-sql-test', 'affinity-b', 10, 2, 'test.affinity', '{}'::jsonb,
  'corr-b', ARRAY['entity:bob']
);

DO $$
BEGIN
  IF NOT (
    SELECT affinity_keys @> ARRAY['entity:alice']::text[]
      FROM scheduled_events
     WHERE world_id = 'affinity-sql-test' AND id = 'affinity-a'
  ) THEN
    RAISE EXCEPTION 'scheduled affinity keys were not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO scheduled_events (
      world_id, id, due_at, ordinal, type, payload, correlation_id, affinity_keys
    ) VALUES (
      'affinity-sql-test', 'bad-affinity', 10, 3, 'test.affinity', '{}'::jsonb,
      'corr-bad', ARRAY['']
    );
    RAISE EXCEPTION 'blank affinity key unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
