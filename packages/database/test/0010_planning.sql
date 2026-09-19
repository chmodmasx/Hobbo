\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('planning-sql-test');

INSERT INTO scheduled_events (
  world_id, id, due_at, ordinal, type, payload, correlation_id
) VALUES (
  'planning-sql-test', 'planning-review-1', 100, 1,
  'planning.review', '{}'::jsonb, 'planning-review-1'
);

INSERT INTO life_goals (
  world_id, id, owner_id, title, priority_bps, strategy, created_at_sim
) VALUES (
  'planning-sql-test', 'goal-1', 'person-alice', 'Keep friendships alive', 8000,
  '{"period":"86400","phase":"64800","duration":"3600","intentionKind":"socialize","payload":{}}'::jsonb,
  0
);

INSERT INTO plan_revisions (
  world_id, id, owner_id, revision, created_at_sim, horizon_end,
  status, reason, intentions, trigger_event_id
) VALUES (
  'planning-sql-test', 'plan-1', 'person-alice', 1, 100, 604900,
  'active', 'initial',
  '[{"id":"i1","goalId":"goal-1","kind":"socialize","preferredStart":"64800","startsAt":"64800","endsAt":"68400","payload":{},"displacedBy":[]}]'::jsonb,
  'planning-review-1'
);

DO $$
BEGIN
  IF (SELECT count(*) FROM life_goals WHERE world_id = 'planning-sql-test') <> 1 THEN
    RAISE EXCEPTION 'life goal was not persisted';
  END IF;
  IF (SELECT status FROM plan_revisions
       WHERE world_id = 'planning-sql-test' AND id = 'plan-1') <> 'active' THEN
    RAISE EXCEPTION 'active plan revision was not persisted';
  END IF;
END
$$;

UPDATE plan_revisions
   SET status = 'superseded', superseded_at = now()
 WHERE world_id = 'planning-sql-test' AND id = 'plan-1';

INSERT INTO plan_revisions (
  world_id, id, owner_id, revision, created_at_sim, horizon_end,
  status, reason, intentions
) VALUES (
  'planning-sql-test', 'plan-2', 'person-alice', 2, 200, 605000,
  'active', 'review', '[]'::jsonb
);

DO $$
BEGIN
  IF (SELECT count(*) FROM plan_revisions
       WHERE world_id = 'planning-sql-test'
         AND owner_id = 'person-alice'
         AND status = 'active') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one active plan';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO life_goals (
      world_id, id, owner_id, title, priority_bps, strategy, created_at_sim
    ) VALUES (
      'planning-sql-test', 'bad-goal', 'person-alice', 'Bad', 10001,
      '{}'::jsonb, 0
    );
    RAISE EXCEPTION 'out-of-range goal priority unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$$;
