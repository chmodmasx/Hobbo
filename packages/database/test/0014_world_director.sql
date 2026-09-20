\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('world-director-sql-test');

INSERT INTO scheduled_events (
  world_id, id, due_at, ordinal, type, payload, correlation_id
) VALUES (
  'world-director-sql-test',
  'director-review-1',
  10,
  0,
  'world_director.review',
  '{"occurrence":1,"anchorDueAt":"10"}'::jsonb,
  'director-review-1'
);

INSERT INTO cognition_runs (
  world_id, request_id, actor_id, sim_time, correlation_id,
  provider_id, model_id, request_hash, request_payload, affordances,
  sampling_config, schema_config, decision, status
) VALUES (
  'world-director-sql-test',
  'director-cognition-1',
  '__world_director__',
  10,
  'director-review-1',
  'mock-traceable',
  'mock-cognitive-model',
  'fnv1a64:0000000000000001',
  '{}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{"affordance_id":"candidate","intent":"seed opportunity"}'::jsonb,
  'completed'
);

INSERT INTO scheduled_events (
  world_id, id, due_at, ordinal, type, payload, correlation_id
) VALUES (
  'world-director-sql-test',
  'director-review-2',
  20,
  1,
  'world_director.review',
  '{"occurrence":2,"anchorDueAt":"20"}'::jsonb,
  'director-review-2'
);

INSERT INTO world_director_proposals (
  world_id, id, trigger_event_id, cognition_request_id,
  affordance_id, status, kind, payload, intent,
  created_at_sim, effect_event_id
) VALUES (
  'world-director-sql-test',
  'proposal-1',
  'director-review-1',
  'director-cognition-1',
  'candidate',
  'accepted',
  'social_opportunity',
  '{"participantIds":["alice","bob"],"dueAt":"70"}'::jsonb,
  'seed opportunity',
  10,
  'director-opportunity-1'
);

DO $$
BEGIN
  IF (
    SELECT status
      FROM world_director_proposals
     WHERE world_id = 'world-director-sql-test'
       AND id = 'proposal-1'
  ) <> 'accepted' THEN
    RAISE EXCEPTION 'world director proposal was not persisted';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO world_director_proposals (
      world_id, id, trigger_event_id, cognition_request_id,
      affordance_id, status, kind, payload, intent, created_at_sim
    ) VALUES (
      'world-director-sql-test',
      'proposal-invalid',
      'director-review-2',
      'director-cognition-1',
      'candidate',
      'accepted',
      'social_opportunity',
      '{}'::jsonb,
      'invalid accepted proposal',
      10
    );
    RAISE EXCEPTION 'accepted proposal without effect unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO world_director_proposals (
      world_id, id, trigger_event_id, cognition_request_id,
      affordance_id, status, kind, payload, intent,
      created_at_sim, effect_event_id
    ) VALUES (
      'world-director-sql-test',
      'proposal-duplicate-trigger',
      'director-review-1',
      'director-cognition-1',
      'candidate',
      'accepted',
      'social_opportunity',
      '{}'::jsonb,
      'duplicate trigger',
      10,
      'another-effect'
    );
    RAISE EXCEPTION 'duplicate trigger unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$$;
