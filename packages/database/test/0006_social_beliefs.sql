\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('social-sql-test');

INSERT INTO perceptions (
  world_id, id, observer_id, observed_at, channel,
  subject_id, predicate, value, confidence_bps
) VALUES
  ('social-sql-test', 'perception-alice', 'person-alice', 100, 'reported',
   'person-bob', 'employment.status', '"fired"'::jsonb, 6500),
  ('social-sql-test', 'perception-bob', 'person-bob', 110, 'direct',
   'person-bob', 'housing.status', '"housed"'::jsonb, 9000);

INSERT INTO beliefs (
  world_id, holder_id, subject_id, predicate, value,
  confidence_bps, learned_at, updated_at, source_perception_id
) VALUES (
  'social-sql-test', 'person-alice', 'person-bob', 'employment.status',
  '"fired"'::jsonb, 6500, 100, 100, 'perception-alice'
);

INSERT INTO relationships (
  world_id, from_entity_id, to_entity_id,
  familiarity, trust, affection, respect, attraction,
  fear, resentment, dependency, updated_at
) VALUES (
  'social-sql-test', 'person-alice', 'person-bob',
  2000, 500, 1000, 300, 0, 100, 0, 0, 120
);

INSERT INTO relationship_effects (
  world_id, effect_id, from_entity_id, to_entity_id,
  sim_time, delta
) VALUES (
  'social-sql-test', 'effect-1', 'person-alice', 'person-bob',
  120, '{"familiarity":2000,"trust":500,"affection":1000,"respect":300,"attraction":0,"fear":100,"resentment":0,"dependency":0}'::jsonb
);

DO $$
BEGIN
  IF (SELECT count(*) FROM perceptions WHERE world_id = 'social-sql-test') <> 2 THEN
    RAISE EXCEPTION 'perception evidence rows were not persisted';
  END IF;
  IF (SELECT count(*) FROM beliefs WHERE world_id = 'social-sql-test') <> 1 THEN
    RAISE EXCEPTION 'belief row was not persisted';
  END IF;
  IF (SELECT trust FROM relationships
       WHERE world_id = 'social-sql-test'
         AND from_entity_id = 'person-alice'
         AND to_entity_id = 'person-bob') <> 500 THEN
    RAISE EXCEPTION 'relationship vector was not persisted';
  END IF;
  IF jsonb_typeof((SELECT delta FROM relationship_effects
                   WHERE world_id = 'social-sql-test' AND effect_id = 'effect-1')) <> 'object' THEN
    RAISE EXCEPTION 'relationship effect delta is not an object';
  END IF;
END
$$;

-- Force the holder/source composite FK to be checked at the statement that
-- follows so the smoke fixture can prove the privacy boundary explicitly.
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  BEGIN
    INSERT INTO beliefs (
      world_id, holder_id, subject_id, predicate, value,
      confidence_bps, learned_at, updated_at, source_perception_id
    ) VALUES (
      'social-sql-test', 'person-alice', 'person-bob', 'housing.status',
      '"housed"'::jsonb, 9000, 110, 110, 'perception-bob'
    );
    RAISE EXCEPTION 'cross-holder source perception unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO relationships (
      world_id, from_entity_id, to_entity_id, updated_at
    ) VALUES ('social-sql-test', 'person-alice', 'person-alice', 130);
    RAISE EXCEPTION 'self relationship unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO perceptions (
      world_id, id, observer_id, observed_at, channel,
      subject_id, predicate, value, confidence_bps
    ) VALUES (
      'social-sql-test', 'bad-confidence', 'person-alice', 130, 'direct',
      'person-bob', 'presence', 'true'::jsonb, 10001
    );
    RAISE EXCEPTION 'invalid perception confidence unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
