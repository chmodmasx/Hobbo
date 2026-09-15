BEGIN;

CREATE TABLE persons (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id)
);

CREATE INDEX persons_created_idx
  ON persons (world_id, created_at_sim, id);

CREATE TABLE person_physiology (
  world_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  hunger_value INTEGER NOT NULL CHECK (hunger_value BETWEEN 0 AND 10000),
  hunger_recorded_at BIGINT NOT NULL CHECK (hunger_recorded_at >= 0),
  hunger_rate_per_hour INTEGER NOT NULL CHECK (hunger_rate_per_hour >= 0),
  energy_value INTEGER NOT NULL CHECK (energy_value BETWEEN 0 AND 10000),
  energy_recorded_at BIGINT NOT NULL CHECK (energy_recorded_at >= 0),
  energy_mode TEXT NOT NULL CHECK (energy_mode IN ('awake', 'sleeping')),
  awake_drain_per_hour INTEGER NOT NULL CHECK (awake_drain_per_hour >= 0),
  sleep_recovery_per_hour INTEGER NOT NULL CHECK (sleep_recovery_per_hour >= 0),
  meals_eaten INTEGER NOT NULL DEFAULT 0 CHECK (meals_eaten >= 0),
  sleep_sessions INTEGER NOT NULL DEFAULT 0 CHECK (sleep_sessions >= 0),
  updated_at_sim BIGINT NOT NULL CHECK (updated_at_sim >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, person_id),
  FOREIGN KEY (world_id, person_id)
    REFERENCES persons(world_id, id)
    ON DELETE CASCADE,
  CONSTRAINT person_physiology_recorded_times CHECK (
    hunger_recorded_at <= updated_at_sim
    AND energy_recorded_at <= updated_at_sim
  )
);

CREATE INDEX person_physiology_mode_idx
  ON person_physiology (world_id, energy_mode, person_id);

CREATE TABLE inventory_items (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) > 0),
  kind TEXT NOT NULL CHECK (length(btrim(kind)) > 0),
  label TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object'),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'consumed')),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  updated_at_sim BIGINT NOT NULL CHECK (updated_at_sim >= created_at_sim),
  consumed_at_sim BIGINT NULL CHECK (consumed_at_sim IS NULL OR consumed_at_sim >= created_at_sim),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  CONSTRAINT inventory_item_consumption_state CHECK (
    (status = 'available' AND consumed_at_sim IS NULL)
    OR
    (status = 'consumed' AND consumed_at_sim IS NOT NULL AND consumed_at_sim = updated_at_sim)
  )
);

CREATE INDEX inventory_items_owner_status_kind_idx
  ON inventory_items (world_id, owner_id, status, kind, id);

COMMIT;
