BEGIN;

CREATE TABLE spatial_nodes (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('room','building','street')),
  parent_id TEXT NULL,
  label TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, parent_id)
    REFERENCES spatial_nodes(world_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX spatial_nodes_kind_idx
  ON spatial_nodes (world_id, kind, id)
  WHERE enabled;

CREATE TABLE spatial_connections (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  travel_seconds INTEGER NOT NULL CHECK (travel_seconds > 0),
  bidirectional BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, from_node_id)
    REFERENCES spatial_nodes(world_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, to_node_id)
    REFERENCES spatial_nodes(world_id, id)
    ON DELETE CASCADE,
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX spatial_connections_from_idx
  ON spatial_connections (world_id, from_node_id, id)
  WHERE enabled;

CREATE INDEX spatial_connections_to_idx
  ON spatial_connections (world_id, to_node_id, id)
  WHERE enabled;

CREATE TABLE spatial_room_grids (
  world_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  min_x INTEGER NOT NULL,
  max_x INTEGER NOT NULL,
  min_y INTEGER NOT NULL,
  max_y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  PRIMARY KEY (world_id, room_id),
  FOREIGN KEY (world_id, room_id)
    REFERENCES spatial_nodes(world_id, id)
    ON DELETE CASCADE,
  CHECK (min_x <= max_x),
  CHECK (min_y <= max_y)
);

CREATE TABLE spatial_blocked_tiles (
  world_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  PRIMARY KEY (world_id, room_id, x, y, z),
  FOREIGN KEY (world_id, room_id)
    REFERENCES spatial_room_grids(world_id, room_id)
    ON DELETE CASCADE
);

CREATE TABLE spatial_resources (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(btrim(kind)) > 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, room_id)
    REFERENCES spatial_room_grids(world_id, room_id)
    ON DELETE CASCADE
);

CREATE INDEX spatial_resources_room_idx
  ON spatial_resources (world_id, room_id, kind, id)
  WHERE enabled;

CREATE TABLE spatial_reservations (
  world_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL CHECK (length(btrim(reservation_id)) > 0),
  person_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','released','consumed','cancelled')),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  closed_at_sim BIGINT NULL
    CHECK (closed_at_sim IS NULL OR closed_at_sim >= created_at_sim),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, reservation_id),
  FOREIGN KEY (world_id, resource_id)
    REFERENCES spatial_resources(world_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, person_id)
    REFERENCES persons(world_id, id)
    ON DELETE CASCADE,
  CHECK (
    (status = 'active' AND closed_at_sim IS NULL)
    OR
    (status <> 'active' AND closed_at_sim IS NOT NULL)
  )
);

CREATE UNIQUE INDEX spatial_reservations_active_person_resource_idx
  ON spatial_reservations (world_id, resource_id, person_id)
  WHERE status = 'active';

CREATE INDEX spatial_reservations_resource_status_idx
  ON spatial_reservations (world_id, resource_id, status, reservation_id);

CREATE TABLE spatial_travel_intents (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  person_id TEXT NOT NULL,
  origin_room_id TEXT NOT NULL,
  destination_room_id TEXT NOT NULL,
  route_node_ids TEXT[] NOT NULL CHECK (cardinality(route_node_ids) >= 1),
  route_connection_ids TEXT[] NOT NULL,
  total_travel_seconds INTEGER NOT NULL CHECK (total_travel_seconds >= 0),
  depart_at_sim BIGINT NOT NULL CHECK (depart_at_sim >= 0),
  arrive_at_sim BIGINT NOT NULL CHECK (arrive_at_sim >= depart_at_sim),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','travelling','arrived','cancelled')),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, person_id)
    REFERENCES persons(world_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, origin_room_id)
    REFERENCES spatial_nodes(world_id, id),
  FOREIGN KEY (world_id, destination_room_id)
    REFERENCES spatial_nodes(world_id, id),
  CHECK (
    cardinality(route_connection_ids) + 1 = cardinality(route_node_ids)
  )
);

CREATE UNIQUE INDEX spatial_travel_one_active_per_person_idx
  ON spatial_travel_intents (world_id, person_id)
  WHERE status IN ('planned','travelling');

CREATE INDEX spatial_travel_person_status_idx
  ON spatial_travel_intents (world_id, person_id, status, depart_at_sim, id);

COMMIT;
