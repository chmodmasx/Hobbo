BEGIN;

ALTER TABLE scheduled_events
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE routines
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE commitments
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE scheduled_events
  ADD CONSTRAINT scheduled_events_affinity_keys_no_blank CHECK (
    NOT EXISTS (
      SELECT 1
        FROM unnest(affinity_keys) AS affinity_key
       WHERE length(btrim(affinity_key)) = 0
    )
  );

ALTER TABLE routines
  ADD CONSTRAINT routines_affinity_keys_no_blank CHECK (
    NOT EXISTS (
      SELECT 1
        FROM unnest(affinity_keys) AS affinity_key
       WHERE length(btrim(affinity_key)) = 0
    )
  );

ALTER TABLE commitments
  ADD CONSTRAINT commitments_affinity_keys_no_blank CHECK (
    NOT EXISTS (
      SELECT 1
        FROM unnest(affinity_keys) AS affinity_key
       WHERE length(btrim(affinity_key)) = 0
    )
  );

CREATE INDEX scheduled_events_processing_affinity_idx
  ON scheduled_events USING GIN (affinity_keys)
  WHERE status = 'processing';

COMMIT;
