BEGIN;

CREATE TABLE life_goals (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) > 0),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  priority_bps INTEGER NOT NULL CHECK (priority_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','abandoned')),
  strategy JSONB NOT NULL CHECK (jsonb_typeof(strategy) = 'object'),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  resolved_at_sim BIGINT NULL CHECK (
    resolved_at_sim IS NULL OR resolved_at_sim >= created_at_sim
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  CONSTRAINT life_goal_resolution_state CHECK (
    (status = 'active' AND resolved_at_sim IS NULL)
    OR
    (status <> 'active' AND resolved_at_sim IS NOT NULL)
  )
);

CREATE INDEX life_goals_owner_status_priority_idx
  ON life_goals (world_id, owner_id, status, priority_bps DESC, id);

CREATE TABLE plan_revisions (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  horizon_end BIGINT NOT NULL CHECK (horizon_end > created_at_sim),
  status TEXT NOT NULL CHECK (status IN ('active','superseded')),
  reason TEXT NOT NULL CHECK (reason IN ('initial','review','conflict')),
  intentions JSONB NOT NULL CHECK (jsonb_typeof(intentions) = 'array'),
  trigger_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ NULL,
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, owner_id, revision),
  FOREIGN KEY (world_id, trigger_event_id)
    REFERENCES scheduled_events(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT plan_revision_superseded_state CHECK (
    (status = 'active' AND superseded_at IS NULL)
    OR
    (status = 'superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX plan_revisions_one_active_owner_idx
  ON plan_revisions (world_id, owner_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX plan_revisions_trigger_event_idx
  ON plan_revisions (world_id, trigger_event_id)
  WHERE trigger_event_id IS NOT NULL;

CREATE INDEX plan_revisions_owner_history_idx
  ON plan_revisions (world_id, owner_id, revision DESC, id);

COMMIT;
