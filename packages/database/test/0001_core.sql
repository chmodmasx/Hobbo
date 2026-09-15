\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('world-test');

INSERT INTO domain_events (
  world_id,
  sequence,
  id,
  sim_time,
  type,
  actor_id,
  payload,
  correlation_id
) VALUES (
  'world-test',
  1,
  'event-1',
  10,
  'person.ate',
  'person-1',
  '{"item_id":"sandwich-1"}'::jsonb,
  'corr-1'
);

INSERT INTO scheduled_events (
  world_id,
  id,
  due_at,
  ordinal,
  type,
  payload,
  correlation_id,
  causation_id
) VALUES (
  'world-test',
  'scheduled-1',
  20,
  0,
  'digestion.complete',
  '{"person_id":"person-1"}'::jsonb,
  'corr-1',
  'event-1'
);

INSERT INTO cognition_runs (
  world_id,
  request_id,
  actor_id,
  sim_time,
  correlation_id,
  provider_id,
  model_id,
  request_hash,
  request_payload,
  affordances,
  schema_config,
  decision,
  status,
  prompt_tokens,
  completion_tokens,
  latency_ms
) VALUES (
  'world-test',
  'cognition-1',
  'person-1',
  10,
  'corr-1',
  'llamacpp',
  'granite-4.1-3b-Q4_K_M',
  'sha256:test',
  '{"hunger":100}'::jsonb,
  '[{"id":"eat_owned_food"},{"id":"wait"}]'::jsonb,
  '{"type":"object"}'::jsonb,
  '{"affordance_id":"eat_owned_food","intent":"eat the owned sandwich now"}'::jsonb,
  'completed',
  88,
  19,
  4831
);

DO $$
BEGIN
  IF (SELECT count(*) FROM domain_events WHERE world_id = 'world-test') <> 1 THEN
    RAISE EXCEPTION 'domain event insert was not persisted';
  END IF;

  IF (SELECT count(*) FROM scheduled_events WHERE status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'scheduled event insert was not persisted';
  END IF;

  IF (SELECT decision->>'affordance_id' FROM cognition_runs WHERE request_id = 'cognition-1') <> 'eat_owned_food' THEN
    RAISE EXCEPTION 'cognition decision is not replay-readable';
  END IF;

  IF to_regclass('scheduled_events_pending_idx') IS NULL THEN
    RAISE EXCEPTION 'pending scheduler index is missing';
  END IF;

  IF to_regclass('domain_events_correlation_idx') IS NULL THEN
    RAISE EXCEPTION 'event correlation index is missing';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO worlds (id, current_sim_time) VALUES ('invalid-world', -1);
    RAISE EXCEPTION 'negative simulation time unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO scheduled_events (
      world_id, id, due_at, ordinal, type, payload, correlation_id, status
    ) VALUES (
      'world-test', 'bad-status', 30, 1, 'test', '{}'::jsonb, 'corr-2', 'mystery'
    );
    RAISE EXCEPTION 'invalid scheduled status unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
