BEGIN;

CREATE TABLE worlds (
  id text PRIMARY KEY,
  current_sim_time bigint NOT NULL DEFAULT 0 CHECK (current_sim_time >= 0),
  next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  next_schedule_ordinal bigint NOT NULL DEFAULT 0 CHECK (next_schedule_ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domain_events (
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  id text NOT NULL,
  sim_time bigint NOT NULL CHECK (sim_time >= 0),
  type text NOT NULL CHECK (length(type) > 0),
  actor_id text,
  target_ids text[],
  payload jsonb NOT NULL,
  causation_id text,
  correlation_id text NOT NULL CHECK (length(correlation_id) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, sequence),
  UNIQUE (world_id, id),
  FOREIGN KEY (world_id, causation_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX domain_events_type_idx
  ON domain_events (world_id, type, sequence);

CREATE INDEX domain_events_actor_idx
  ON domain_events (world_id, actor_id, sequence)
  WHERE actor_id IS NOT NULL;

CREATE INDEX domain_events_correlation_idx
  ON domain_events (world_id, correlation_id, sequence);

CREATE TABLE scheduled_events (
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id text NOT NULL,
  due_at bigint NOT NULL CHECK (due_at >= 0),
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  type text NOT NULL CHECK (length(type) > 0),
  payload jsonb NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) > 0),
  causation_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, ordinal),
  FOREIGN KEY (world_id, causation_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX scheduled_events_pending_idx
  ON scheduled_events (world_id, due_at, ordinal)
  WHERE status = 'pending';

CREATE INDEX scheduled_events_processing_idx
  ON scheduled_events (locked_at)
  WHERE status = 'processing';

CREATE TABLE cognition_runs (
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  actor_id text NOT NULL,
  sim_time bigint NOT NULL CHECK (sim_time >= 0),
  correlation_id text NOT NULL CHECK (length(correlation_id) > 0),
  provider_id text NOT NULL CHECK (length(provider_id) > 0),
  model_id text,
  request_hash text NOT NULL CHECK (length(request_hash) > 0),
  request_payload jsonb NOT NULL,
  affordances jsonb NOT NULL,
  sampling_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision jsonb,
  raw_response text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (world_id, request_id)
);

CREATE INDEX cognition_runs_actor_time_idx
  ON cognition_runs (world_id, actor_id, sim_time, request_id);

CREATE INDEX cognition_runs_status_idx
  ON cognition_runs (status, created_at);

CREATE INDEX cognition_runs_correlation_idx
  ON cognition_runs (world_id, correlation_id);

COMMIT;
