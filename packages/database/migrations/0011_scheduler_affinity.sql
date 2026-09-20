BEGIN;

ALTER TABLE scheduled_events
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE routines
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE commitments
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE scheduled_events
  ADD CONSTRAINT scheduled_events_affinity_keys_no_empty CHECK (
    array_position(affinity_keys, '') IS NULL
  );

ALTER TABLE routines
  ADD CONSTRAINT routines_affinity_keys_no_empty CHECK (
    array_position(affinity_keys, '') IS NULL
  );

ALTER TABLE commitments
  ADD CONSTRAINT commitments_affinity_keys_no_empty CHECK (
    array_position(affinity_keys, '') IS NULL
  );

CREATE INDEX scheduled_events_processing_affinity_idx
  ON scheduled_events USING GIN (affinity_keys)
  WHERE status = 'processing';

COMMIT;
