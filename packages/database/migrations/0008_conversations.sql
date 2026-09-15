BEGIN;

CREATE TABLE conversations (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  started_at BIGINT NOT NULL CHECK (started_at >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  ended_at BIGINT NULL CHECK (ended_at IS NULL OR ended_at >= 0),
  max_turns INTEGER NOT NULL CHECK (max_turns > 0),
  next_message_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_message_ordinal > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  CONSTRAINT conversation_end_state CHECK (
    (status = 'open' AND ended_at IS NULL)
    OR
    (status = 'closed' AND ended_at IS NOT NULL AND ended_at >= started_at)
  ),
  CONSTRAINT conversation_turn_cursor CHECK (next_message_ordinal <= max_turns + 1)
);

CREATE INDEX conversations_status_time_idx
  ON conversations (world_id, status, started_at, id);

CREATE TABLE conversation_participants (
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(btrim(entity_id)) > 0),
  joined_at BIGINT NOT NULL CHECK (joined_at >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, conversation_id, entity_id),
  FOREIGN KEY (world_id, conversation_id)
    REFERENCES conversations(world_id, id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_participants_entity_idx
  ON conversation_participants (world_id, entity_id, conversation_id);

CREATE TABLE conversation_messages (
  world_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  conversation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  speaker_id TEXT NOT NULL CHECK (length(btrim(speaker_id)) > 0),
  sent_at BIGINT NOT NULL CHECK (sent_at >= 0),
  text TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, conversation_id, ordinal),
  UNIQUE (world_id, id, conversation_id),
  FOREIGN KEY (world_id, conversation_id)
    REFERENCES conversations(world_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, conversation_id, speaker_id)
    REFERENCES conversation_participants(world_id, conversation_id, entity_id),
  FOREIGN KEY (world_id, source_event_id)
    REFERENCES domain_events(world_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX conversation_messages_conversation_idx
  ON conversation_messages (world_id, conversation_id, ordinal);

CREATE INDEX conversation_messages_speaker_idx
  ON conversation_messages (world_id, speaker_id, sent_at, id);

CREATE TABLE conversation_statements (
  world_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(btrim(id)) > 0),
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  statement_index INTEGER NOT NULL CHECK (statement_index >= 0),
  subject_id TEXT NOT NULL CHECK (length(btrim(subject_id)) > 0),
  predicate TEXT NOT NULL CHECK (length(btrim(predicate)) > 0),
  value JSONB NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  origin TEXT NOT NULL CHECK (origin IN ('direct','reported','inferred','fabricated')),
  source_statement_id TEXT NULL,
  claimed_source_entity_id TEXT NULL,
  hop_count INTEGER NOT NULL CHECK (hop_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, message_id, statement_index),
  FOREIGN KEY (world_id, message_id, conversation_id)
    REFERENCES conversation_messages(world_id, id, conversation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, source_statement_id)
    REFERENCES conversation_statements(world_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_statement_not_self_source CHECK (
    source_statement_id IS NULL OR source_statement_id <> id
  ),
  CONSTRAINT conversation_statement_lineage_hop CHECK (
    source_statement_id IS NULL OR hop_count >= 1
  )
);

CREATE INDEX conversation_statements_message_idx
  ON conversation_statements (world_id, message_id, statement_index);

CREATE INDEX conversation_statements_lineage_idx
  ON conversation_statements (world_id, source_statement_id)
  WHERE source_statement_id IS NOT NULL;

CREATE TABLE conversation_deliveries (
  world_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  listener_id TEXT NOT NULL CHECK (length(btrim(listener_id)) > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by TEXT NULL,
  locked_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, message_id, listener_id),
  FOREIGN KEY (world_id, message_id)
    REFERENCES conversation_messages(world_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_delivery_lock_state CHECK (
    (status = 'pending' AND locked_by IS NULL AND locked_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'processing' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND locked_by IS NULL AND locked_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX conversation_deliveries_pending_idx
  ON conversation_deliveries (world_id, status, message_id, listener_id)
  WHERE status <> 'completed';

CREATE INDEX conversation_deliveries_listener_idx
  ON conversation_deliveries (world_id, listener_id, status, message_id);

COMMIT;
