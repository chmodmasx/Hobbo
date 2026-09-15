BEGIN;

CREATE TABLE perceptions (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  observer_id TEXT NOT NULL CHECK (length(observer_id) > 0),
  observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
  channel TEXT NOT NULL CHECK (channel IN ('direct','reported','inferred')),
  subject_id TEXT NOT NULL CHECK (length(btrim(subject_id)) > 0),
  predicate TEXT NOT NULL CHECK (length(btrim(predicate)) > 0),
  value JSONB NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  source_entity_id TEXT NULL,
  source_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, id, observer_id),
  FOREIGN KEY (world_id, source_event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX perceptions_observer_time_idx
  ON perceptions (world_id, observer_id, observed_at, id);

CREATE INDEX perceptions_claim_idx
  ON perceptions (world_id, observer_id, subject_id, predicate, observed_at, id);

CREATE INDEX perceptions_source_event_idx
  ON perceptions (world_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE beliefs (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  holder_id TEXT NOT NULL CHECK (length(holder_id) > 0),
  subject_id TEXT NOT NULL CHECK (length(btrim(subject_id)) > 0),
  predicate TEXT NOT NULL CHECK (length(btrim(predicate)) > 0),
  value JSONB NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  learned_at BIGINT NOT NULL CHECK (learned_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= learned_at),
  source_perception_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, holder_id, subject_id, predicate),
  FOREIGN KEY (world_id, source_perception_id, holder_id)
    REFERENCES perceptions(world_id, id, observer_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX beliefs_holder_updated_idx
  ON beliefs (world_id, holder_id, updated_at, subject_id, predicate);

CREATE INDEX beliefs_source_perception_idx
  ON beliefs (world_id, source_perception_id)
  WHERE source_perception_id IS NOT NULL;

CREATE TABLE relationships (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL CHECK (length(from_entity_id) > 0),
  to_entity_id TEXT NOT NULL CHECK (length(to_entity_id) > 0),
  familiarity INTEGER NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 10000),
  trust INTEGER NOT NULL DEFAULT 0 CHECK (trust BETWEEN -10000 AND 10000),
  affection INTEGER NOT NULL DEFAULT 0 CHECK (affection BETWEEN -10000 AND 10000),
  respect INTEGER NOT NULL DEFAULT 0 CHECK (respect BETWEEN -10000 AND 10000),
  attraction INTEGER NOT NULL DEFAULT 0 CHECK (attraction BETWEEN -10000 AND 10000),
  fear INTEGER NOT NULL DEFAULT 0 CHECK (fear BETWEEN 0 AND 10000),
  resentment INTEGER NOT NULL DEFAULT 0 CHECK (resentment BETWEEN 0 AND 10000),
  dependency INTEGER NOT NULL DEFAULT 0 CHECK (dependency BETWEEN 0 AND 10000),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  last_source_event_id TEXT NULL,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, from_entity_id, to_entity_id),
  FOREIGN KEY (world_id, last_source_event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT relationship_not_self CHECK (from_entity_id <> to_entity_id)
);

CREATE INDEX relationships_to_entity_idx
  ON relationships (world_id, to_entity_id, from_entity_id);

CREATE INDEX relationships_source_event_idx
  ON relationships (world_id, last_source_event_id)
  WHERE last_source_event_id IS NOT NULL;

CREATE TABLE relationship_effects (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL CHECK (length(btrim(effect_id)) > 0),
  from_entity_id TEXT NOT NULL CHECK (length(from_entity_id) > 0),
  to_entity_id TEXT NOT NULL CHECK (length(to_entity_id) > 0),
  sim_time BIGINT NOT NULL CHECK (sim_time >= 0),
  delta JSONB NOT NULL CHECK (jsonb_typeof(delta) = 'object'),
  source_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, effect_id),
  FOREIGN KEY (world_id, source_event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT relationship_effect_not_self CHECK (from_entity_id <> to_entity_id)
);

CREATE INDEX relationship_effects_pair_time_idx
  ON relationship_effects (world_id, from_entity_id, to_entity_id, sim_time, effect_id);

CREATE INDEX relationship_effects_source_event_idx
  ON relationship_effects (world_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

COMMIT;
