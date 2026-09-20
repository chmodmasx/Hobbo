\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('realtime-spatial-sql-test');
INSERT INTO persons (world_id, id, created_at_sim)
VALUES ('realtime-spatial-sql-test', 'alice', 0);

INSERT INTO person_spatial_state (
  world_id, person_id, room_id, x, y, z, facing, updated_at_sim
) VALUES (
  'realtime-spatial-sql-test', 'alice', 'fixture-room', 1, 2, 0, 'S', 0
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM person_spatial_state
     WHERE world_id = 'realtime-spatial-sql-test'
       AND person_id = 'alice'
       AND room_id = 'fixture-room'
       AND x = 1
       AND y = 2
       AND facing = 'S'
  ) THEN
    RAISE EXCEPTION 'spatial state was not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO person_spatial_state (
      world_id, person_id, room_id, x, y, z, facing, updated_at_sim
    ) VALUES (
      'realtime-spatial-sql-test', 'bad-facing', 'fixture-room', 0, 0, 0, 'INVALID', 0
    );
    RAISE EXCEPTION 'invalid facing unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation OR check_violation THEN NULL;
  END;
END
$$;
