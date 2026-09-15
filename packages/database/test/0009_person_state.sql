\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('person-state-sql-test');

INSERT INTO persons (world_id, id, created_at_sim)
VALUES ('person-state-sql-test', 'person-alice', 0);

INSERT INTO person_physiology (
  world_id, person_id,
  hunger_value, hunger_recorded_at, hunger_rate_per_hour,
  energy_value, energy_recorded_at, energy_mode,
  awake_drain_per_hour, sleep_recovery_per_hour,
  meals_eaten, sleep_sessions, updated_at_sim
) VALUES (
  'person-state-sql-test', 'person-alice',
  1200, 0, 600,
  8000, 0, 'awake',
  500, 1800,
  0, 0, 0
);

INSERT INTO inventory_items (
  world_id, id, owner_id, kind, label, attributes,
  status, created_at_sim, updated_at_sim
) VALUES (
  'person-state-sql-test', 'food-1', 'person-alice', 'food', 'Prepared meal',
  '{"satiety":6500}'::jsonb, 'available', 0, 0
);

DO $$
BEGIN
  IF (SELECT count(*) FROM persons WHERE world_id = 'person-state-sql-test') <> 1 THEN
    RAISE EXCEPTION 'person row was not persisted';
  END IF;
  IF (SELECT hunger_value FROM person_physiology
       WHERE world_id = 'person-state-sql-test' AND person_id = 'person-alice') <> 1200 THEN
    RAISE EXCEPTION 'physiology row was not persisted';
  END IF;
  IF (SELECT attributes->>'satiety' FROM inventory_items
       WHERE world_id = 'person-state-sql-test' AND id = 'food-1') <> '6500' THEN
    RAISE EXCEPTION 'inventory attributes were not persisted';
  END IF;
END
$$;

UPDATE inventory_items
   SET status = 'consumed',
       consumed_at_sim = 100,
       updated_at_sim = 100,
       updated_at = now()
 WHERE world_id = 'person-state-sql-test'
   AND id = 'food-1';

DO $$
BEGIN
  IF (SELECT status FROM inventory_items
       WHERE world_id = 'person-state-sql-test' AND id = 'food-1') <> 'consumed' THEN
    RAISE EXCEPTION 'consumed state was not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE person_physiology
       SET hunger_value = 10001
     WHERE world_id = 'person-state-sql-test' AND person_id = 'person-alice';
    RAISE EXCEPTION 'out-of-range hunger unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO inventory_items (
      world_id, id, owner_id, kind, label, attributes,
      status, created_at_sim, updated_at_sim, consumed_at_sim
    ) VALUES (
      'person-state-sql-test', 'bad-available', 'person-alice', 'food', 'Bad item',
      '{"satiety":1}'::jsonb, 'available', 0, 10, 10
    );
    RAISE EXCEPTION 'available item with consumed_at unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO inventory_items (
      world_id, id, owner_id, kind, label, attributes,
      status, created_at_sim, updated_at_sim
    ) VALUES (
      'person-state-sql-test', 'bad-json', 'person-alice', 'food', 'Bad item',
      '[1,2,3]'::jsonb, 'available', 0, 0
    );
    RAISE EXCEPTION 'non-object item attributes unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
