BEGIN;

ALTER TABLE scheduled_events
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE routines
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE commitments
  ADD COLUMN affinity_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE commitments
   SET affinity_keys = ARRAY['entity:' || owner_id];

-- PeriodicRoutine.affinity_keys stores resources in addition to its owner.
-- createCommitment() adds the owner entity when materializing each occurrence.
UPDATE routines AS routine
   SET affinity_keys = ARRAY[
     'ledger:' || employment.employer_account_id,
     'ledger:' || employment.employee_account_id
   ]
  FROM employments AS employment
 WHERE employment.world_id = routine.world_id
   AND employment.work_routine_id = routine.id;

UPDATE routines AS routine
   SET affinity_keys = ARRAY[
     'housing:' || tenancy.housing_unit_id,
     'ledger:' || tenancy.landlord_account_id,
     'ledger:' || tenancy.tenant_account_id
   ]
  FROM tenancies AS tenancy
 WHERE tenancy.world_id = routine.world_id
   AND tenancy.rent_routine_id = routine.id;

UPDATE commitments AS commitment
   SET affinity_keys = ARRAY[
     'entity:' || commitment.owner_id,
     'ledger:' || employment.employer_account_id,
     'ledger:' || employment.employee_account_id
   ]
  FROM employments AS employment
 WHERE employment.world_id = commitment.world_id
   AND commitment.payload->>'employmentId' = employment.id;

UPDATE commitments AS commitment
   SET affinity_keys = ARRAY[
     'entity:' || commitment.owner_id,
     'housing:' || tenancy.housing_unit_id,
     'ledger:' || tenancy.landlord_account_id,
     'ledger:' || tenancy.tenant_account_id
   ]
  FROM tenancies AS tenancy
 WHERE tenancy.world_id = commitment.world_id
   AND commitment.payload->>'tenancyId' = tenancy.id;

UPDATE scheduled_events AS scheduled
   SET affinity_keys = commitment.affinity_keys
  FROM commitments AS commitment
 WHERE commitment.world_id = scheduled.world_id
   AND commitment.scheduled_event_id = scheduled.id;

UPDATE scheduled_events
   SET affinity_keys = ARRAY['entity:' || (payload->>'personId')]
 WHERE cardinality(affinity_keys) = 0
   AND payload ? 'personId'
   AND length(btrim(payload->>'personId')) > 0;

UPDATE scheduled_events AS scheduled
   SET affinity_keys = ARRAY[
     'conversation:' || (scheduled.payload->>'conversationId')
   ] || participants.affinity_keys
  FROM (
    SELECT world_id,
           conversation_id,
           array_agg('entity:' || entity_id ORDER BY entity_id) AS affinity_keys
      FROM conversation_participants
     GROUP BY world_id, conversation_id
  ) AS participants
 WHERE scheduled.world_id = participants.world_id
   AND scheduled.payload->>'conversationId' = participants.conversation_id
   AND scheduled.type = 'dialogue.turn';

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
