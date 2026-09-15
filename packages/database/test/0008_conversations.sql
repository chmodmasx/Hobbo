INSERT INTO worlds (id) VALUES ('conversation-smoke-world');

INSERT INTO conversations (
  world_id, id, started_at, max_turns
) VALUES (
  'conversation-smoke-world', 'conversation-1', 100, 4
);

INSERT INTO conversation_participants (
  world_id, conversation_id, entity_id, joined_at
) VALUES
  ('conversation-smoke-world', 'conversation-1', 'alice', 100),
  ('conversation-smoke-world', 'conversation-1', 'bob', 100),
  ('conversation-smoke-world', 'conversation-1', 'carol', 100);

INSERT INTO conversation_messages (
  world_id, id, conversation_id, ordinal, speaker_id, sent_at, text
) VALUES (
  'conversation-smoke-world', 'message-1', 'conversation-1', 1,
  'alice', 110, 'Carol told me the cafe closes at six.'
);

INSERT INTO conversation_statements (
  world_id, id, conversation_id, message_id, statement_index,
  subject_id, predicate, value, confidence_bps, origin,
  source_statement_id, claimed_source_entity_id, hop_count
) VALUES (
  'conversation-smoke-world', 'statement-1', 'conversation-1', 'message-1', 0,
  'cafe-1', 'closing_time', '"18:00"'::jsonb, 9000, 'reported',
  NULL, 'carol', 1
);

INSERT INTO conversation_deliveries (
  world_id, message_id, listener_id
) VALUES
  ('conversation-smoke-world', 'message-1', 'bob'),
  ('conversation-smoke-world', 'message-1', 'carol');

DO $$
BEGIN
  BEGIN
    INSERT INTO conversation_messages (
      world_id, id, conversation_id, ordinal, speaker_id, sent_at, text
    ) VALUES (
      'conversation-smoke-world', 'outsider-message', 'conversation-1', 2,
      'outsider', 111, 'I should not be able to speak here.'
    );
    RAISE EXCEPTION 'expected outsider speaker foreign key failure';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO conversation_statements (
      world_id, id, conversation_id, message_id, statement_index,
      subject_id, predicate, value, confidence_bps, origin,
      source_statement_id, hop_count
    ) VALUES (
      'conversation-smoke-world', 'self-source', 'conversation-1', 'message-1', 1,
      'cafe-1', 'closing_time', '"19:00"'::jsonb, 5000, 'reported',
      'self-source', 1
    );
    RAISE EXCEPTION 'expected self-source check failure';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE conversation_deliveries
       SET status = 'completed'
     WHERE world_id = 'conversation-smoke-world'
       AND message_id = 'message-1'
       AND listener_id = 'bob';
    RAISE EXCEPTION 'expected delivery state check failure';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

DO $$
DECLARE
  delivery_count INTEGER;
BEGIN
  SELECT count(*) INTO delivery_count
    FROM conversation_deliveries
   WHERE world_id = 'conversation-smoke-world'
     AND message_id = 'message-1';
  IF delivery_count <> 2 THEN
    RAISE EXCEPTION 'expected two conversation deliveries, found %', delivery_count;
  END IF;
END
$$;
