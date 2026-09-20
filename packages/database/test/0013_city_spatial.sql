\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('city-spatial-sql-test');
INSERT INTO persons (world_id, id, created_at_sim)
VALUES ('city-spatial-sql-test', 'alice', 0);

INSERT INTO spatial_nodes (world_id, id, kind, parent_id, label) VALUES
  ('city-spatial-sql-test', 'building-home', 'building', NULL, 'Home building'),
  ('city-spatial-sql-test', 'room-home', 'room', 'building-home', 'Home room'),
  ('city-spatial-sql-test', 'street-main', 'street', NULL, 'Main street'),
  ('city-spatial-sql-test', 'building-work', 'building', NULL, 'Work building'),
  ('city-spatial-sql-test', 'room-work', 'room', 'building-work', 'Work room');

INSERT INTO spatial_connections (
  world_id, id, from_node_id, to_node_id, travel_seconds, bidirectional
) VALUES
  ('city-spatial-sql-test', 'home-door', 'room-home', 'building-home', 5, TRUE),
  ('city-spatial-sql-test', 'home-street', 'building-home', 'street-main', 20, TRUE),
  ('city-spatial-sql-test', 'street-work', 'street-main', 'building-work', 30, TRUE),
  ('city-spatial-sql-test', 'work-door', 'building-work', 'room-work', 5, TRUE);

INSERT INTO spatial_room_grids (
  world_id, room_id, min_x, max_x, min_y, max_y, z
) VALUES ('city-spatial-sql-test', 'room-home', 0, 4, 0, 4, 0);

INSERT INTO spatial_blocked_tiles (world_id, room_id, x, y, z)
VALUES ('city-spatial-sql-test', 'room-home', 2, 2, 0);

INSERT INTO spatial_resources (
  world_id, id, room_id, kind, capacity, x, y, z
) VALUES (
  'city-spatial-sql-test', 'home-bed', 'room-home', 'bed', 1, 3, 3, 0
);

INSERT INTO spatial_reservations (
  world_id, resource_id, reservation_id, person_id, created_at_sim
) VALUES (
  'city-spatial-sql-test', 'home-bed', 'reservation-1', 'alice', 0
);

INSERT INTO spatial_travel_intents (
  world_id, id, person_id, origin_room_id, destination_room_id,
  route_node_ids, route_connection_ids, total_travel_seconds,
  depart_at_sim, arrive_at_sim
) VALUES (
  'city-spatial-sql-test', 'travel-1', 'alice', 'room-home', 'room-work',
  ARRAY['room-home','building-home','street-main','building-work','room-work'],
  ARRAY['home-door','home-street','street-work','work-door'],
  60, 10, 70
);

DO $$
BEGIN
  IF (
    SELECT cardinality(route_node_ids)
      FROM spatial_travel_intents
     WHERE world_id = 'city-spatial-sql-test' AND id = 'travel-1'
  ) <> 5 THEN
    RAISE EXCEPTION 'travel route was not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO spatial_nodes (world_id, id, kind, label)
    VALUES ('city-spatial-sql-test', 'bad-kind', 'planet', 'Bad');
    RAISE EXCEPTION 'invalid node kind unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO spatial_connections (
      world_id, id, from_node_id, to_node_id, travel_seconds
    ) VALUES (
      'city-spatial-sql-test', 'bad-edge', 'room-home', 'room-home', 1
    );
    RAISE EXCEPTION 'self connection unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO spatial_reservations (
      world_id, resource_id, reservation_id, person_id, created_at_sim
    ) VALUES (
      'city-spatial-sql-test', 'home-bed', 'reservation-2', 'alice', 0
    );
    RAISE EXCEPTION 'duplicate active person/resource reservation unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO spatial_travel_intents (
      world_id, id, person_id, origin_room_id, destination_room_id,
      route_node_ids, route_connection_ids, total_travel_seconds,
      depart_at_sim, arrive_at_sim
    ) VALUES (
      'city-spatial-sql-test', 'travel-duplicate-active', 'alice',
      'room-home', 'room-work',
      ARRAY['room-home','building-home','street-main','building-work','room-work'],
      ARRAY['home-door','home-street','street-work','work-door'],
      60, 20, 80
    );
    RAISE EXCEPTION 'second active travel unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$$;
