BEGIN;

CREATE TABLE person_spatial_state (
  world_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  room_id TEXT NOT NULL CHECK (length(btrim(room_id)) > 0),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  facing TEXT NOT NULL
    CHECK (facing IN ('N','NE','E','SE','S','SW','W','NW')),
  updated_at_sim BIGINT NOT NULL CHECK (updated_at_sim >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, person_id),
  FOREIGN KEY (world_id, person_id)
    REFERENCES persons(world_id, id)
    ON DELETE CASCADE
);

CREATE INDEX person_spatial_room_idx
  ON person_spatial_state (world_id, room_id, y, x, person_id);

CREATE TABLE player_action_receipts (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
  person_id TEXT NOT NULL,
  action_id TEXT NOT NULL CHECK (length(btrim(action_id)) > 0),
  request_payload JSONB NOT NULL,
  result_payload JSONB NOT NULL,
  event_id TEXT NOT NULL,
  applied_at_sim BIGINT NOT NULL CHECK (applied_at_sim >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, request_id),
  FOREIGN KEY (world_id, person_id)
    REFERENCES persons(world_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX player_action_receipts_person_idx
  ON player_action_receipts (world_id, person_id, applied_at_sim, request_id);

COMMIT;
