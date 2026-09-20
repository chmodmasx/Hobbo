BEGIN;

CREATE TABLE world_director_proposals (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  trigger_event_id TEXT NOT NULL,
  cognition_request_id TEXT NOT NULL,
  affordance_id TEXT NOT NULL CHECK (length(btrim(affordance_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected')),
  kind TEXT NOT NULL CHECK (kind IN ('social_opportunity','none')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  intent TEXT NOT NULL CHECK (length(btrim(intent)) > 0),
  created_at_sim BIGINT NOT NULL CHECK (created_at_sim >= 0),
  effect_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, trigger_event_id),
  FOREIGN KEY (world_id, trigger_event_id)
    REFERENCES scheduled_events(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, cognition_request_id)
    REFERENCES cognition_runs(world_id, request_id)
    ON DELETE RESTRICT,
  CHECK (
    (
      status = 'accepted'
      AND kind = 'social_opportunity'
      AND effect_event_id IS NOT NULL
    )
    OR
    (
      status = 'rejected'
      AND kind = 'none'
      AND effect_event_id IS NULL
    )
  )
);

CREATE INDEX world_director_proposals_time_idx
  ON world_director_proposals (world_id, created_at_sim, id);

CREATE INDEX world_director_proposals_cognition_idx
  ON world_director_proposals (world_id, cognition_request_id);

COMMIT;
