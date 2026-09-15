\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('memory-sql-test');

INSERT INTO memories (
  world_id, id, owner_id, category, occurred_at, content,
  importance_bps, emotional_strength_bps, related_entity_ids, metadata
) VALUES (
  'memory-sql-test', 'memory-1', 'person-alice', 'episodic', 100,
  'Bob helped Alice at the cafe', 7000, 5000,
  ARRAY['person-bob'], '{"place":"cafe"}'::jsonb
);

INSERT INTO memory_embeddings (
  world_id, memory_id, model_id, dimensions, embedding
) VALUES
  ('memory-sql-test', 'memory-1', 'model-a', 3, ARRAY[1.0, 0.5, -0.25]::DOUBLE PRECISION[]),
  ('memory-sql-test', 'memory-1', 'model-b', 3, ARRAY[0.9, 0.4, -0.2]::DOUBLE PRECISION[]);

DO $$
BEGIN
  IF (SELECT count(*) FROM memories WHERE world_id = 'memory-sql-test') <> 1 THEN
    RAISE EXCEPTION 'memory row was not persisted';
  END IF;
  IF (SELECT count(*) FROM memory_embeddings WHERE world_id = 'memory-sql-test') <> 2 THEN
    RAISE EXCEPTION 'multiple model embeddings were not persisted';
  END IF;
  IF NOT (SELECT related_entity_ids @> ARRAY['person-bob']::TEXT[]
            FROM memories
           WHERE world_id = 'memory-sql-test' AND id = 'memory-1') THEN
    RAISE EXCEPTION 'related entity ids were not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE memories
       SET content = 'rewritten history'
     WHERE world_id = 'memory-sql-test' AND id = 'memory-1';
    RAISE EXCEPTION 'memory mutation unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'memories are append-only' THEN
        RAISE;
      END IF;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_embeddings (
      world_id, memory_id, model_id, dimensions, embedding
    ) VALUES (
      'memory-sql-test', 'memory-1', 'bad-dimensions', 2,
      ARRAY[1.0, 2.0, 3.0]::DOUBLE PRECISION[]
    );
    RAISE EXCEPTION 'dimension mismatch unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_embeddings (
      world_id, memory_id, model_id, dimensions, embedding
    ) VALUES (
      'memory-sql-test', 'memory-1', 'zero-vector', 3,
      ARRAY[0.0, 0.0, 0.0]::DOUBLE PRECISION[]
    );
    RAISE EXCEPTION 'zero embedding unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_embeddings (
      world_id, memory_id, model_id, dimensions, embedding
    ) VALUES (
      'memory-sql-test', 'memory-1', 'nan-vector', 3,
      ARRAY[1.0, 'NaN'::DOUBLE PRECISION, 0.5]::DOUBLE PRECISION[]
    );
    RAISE EXCEPTION 'NaN embedding unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
