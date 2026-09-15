BEGIN;

CREATE TABLE memories (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) > 0),
  category TEXT NOT NULL CHECK (
    category IN (
      'episodic',
      'semantic',
      'social',
      'emotional',
      'commitment',
      'reflection',
      'autobiographical'
    )
  ),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  importance_bps INTEGER NOT NULL CHECK (importance_bps BETWEEN 0 AND 10000),
  emotional_strength_bps INTEGER NOT NULL CHECK (emotional_strength_bps BETWEEN 0 AND 10000),
  related_entity_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_event_id TEXT NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, source_event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX memories_owner_time_idx
  ON memories (world_id, owner_id, occurred_at DESC, id);

CREATE INDEX memories_owner_category_time_idx
  ON memories (world_id, owner_id, category, occurred_at DESC, id);

CREATE INDEX memories_related_entities_idx
  ON memories USING GIN (related_entity_ids);

CREATE INDEX memories_source_event_idx
  ON memories (world_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION hobbo_valid_embedding(values DOUBLE PRECISION[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    cardinality(values) > 0
    AND COALESCE(
      bool_and(
        value <> 'NaN'::DOUBLE PRECISION
        AND value <> 'Infinity'::DOUBLE PRECISION
        AND value <> '-Infinity'::DOUBLE PRECISION
      ),
      FALSE
    )
    AND COALESCE(bool_or(value <> 0::DOUBLE PRECISION), FALSE)
  FROM unnest(values) AS value;
$$;

CREATE TABLE memory_embeddings (
  world_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(btrim(model_id)) > 0),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding DOUBLE PRECISION[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, memory_id, model_id),
  FOREIGN KEY (world_id, memory_id)
    REFERENCES memories(world_id, id)
    ON DELETE CASCADE,
  CONSTRAINT memory_embedding_one_dimension
    CHECK (array_ndims(embedding) = 1),
  CONSTRAINT memory_embedding_dimensions_match
    CHECK (cardinality(embedding) = dimensions),
  CONSTRAINT memory_embedding_values_valid
    CHECK (hobbo_valid_embedding(embedding))
);

CREATE INDEX memory_embeddings_model_idx
  ON memory_embeddings (world_id, model_id, memory_id);

CREATE OR REPLACE FUNCTION prevent_memory_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'memories are append-only';
END;
$$;

CREATE TRIGGER memories_prevent_update
BEFORE UPDATE ON memories
FOR EACH ROW
EXECUTE FUNCTION prevent_memory_mutation();

COMMIT;
