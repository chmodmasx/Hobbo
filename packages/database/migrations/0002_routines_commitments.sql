BEGIN;

CREATE TABLE routines (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  period BIGINT NOT NULL CHECK (period > 0),
  phase BIGINT NOT NULL CHECK (phase >= 0 AND phase < period),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id)
);

CREATE INDEX routines_owner_idx
  ON routines (world_id, owner_id)
  WHERE enabled = TRUE;

CREATE TABLE commitments (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  routine_id TEXT NULL,
  owner_id TEXT NOT NULL,
  due_at BIGINT NOT NULL CHECK (due_at >= 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT NOT NULL,
  scheduled_event_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'fulfilled', 'missed', 'cancelled')),
  resolved_at BIGINT NULL CHECK (resolved_at IS NULL OR resolved_at >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  CONSTRAINT commitments_routine_fk
    FOREIGN KEY (world_id, routine_id)
    REFERENCES routines(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commitments_scheduled_event_fk
    FOREIGN KEY (world_id, scheduled_event_id)
    REFERENCES scheduled_events(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commitment_resolution_consistency CHECK (
    (status = 'planned' AND resolved_at IS NULL)
    OR
    (status <> 'planned' AND resolved_at IS NOT NULL)
  )
);

-- Lazy materialization invariant: an enabled recurring routine may have at
-- most one concrete future/planned occurrence at any given time.
CREATE UNIQUE INDEX commitments_one_planned_per_routine_idx
  ON commitments (world_id, routine_id)
  WHERE routine_id IS NOT NULL AND status = 'planned';

CREATE UNIQUE INDEX commitments_scheduled_event_idx
  ON commitments (world_id, scheduled_event_id)
  WHERE scheduled_event_id IS NOT NULL;

CREATE INDEX commitments_owner_due_idx
  ON commitments (world_id, owner_id, due_at, id);

CREATE INDEX commitments_due_planned_idx
  ON commitments (world_id, due_at, id)
  WHERE status = 'planned';

COMMIT;
