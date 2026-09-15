\set ON_ERROR_STOP on

INSERT INTO worlds (id) VALUES ('housing-sql-test');

INSERT INTO ledger_accounts (
  world_id, id, owner_id, currency, kind, allow_negative
) VALUES
  ('housing-sql-test', 'landlord-wallet', 'person-landlord', 'HBC', 'asset', FALSE),
  ('housing-sql-test', 'tenant-wallet', 'person-tenant', 'HBC', 'asset', FALSE);

INSERT INTO housing_units (world_id, id, owner_id, label)
VALUES
  ('housing-sql-test', 'unit-1', 'person-landlord', 'Apartment 1'),
  ('housing-sql-test', 'unit-2', 'person-landlord', 'Apartment 2');

INSERT INTO routines (
  world_id, id, owner_id, period, phase, kind, payload
) VALUES
  ('housing-sql-test', 'tenancy:lease-1:rent', 'person-tenant', 2592000, 432000,
   'tenancy.rent_due', '{"tenancyId":"lease-1","housingUnitId":"unit-1","landlordId":"person-landlord"}'::jsonb),
  ('housing-sql-test', 'tenancy:lease-2:rent', 'person-other', 2592000, 432000,
   'tenancy.rent_due', '{"tenancyId":"lease-2","housingUnitId":"unit-1","landlordId":"person-landlord"}'::jsonb),
  ('housing-sql-test', 'tenancy:bad-owner:rent', 'person-tenant', 2592000, 432000,
   'tenancy.rent_due', '{"tenancyId":"bad-owner","housingUnitId":"unit-2","landlordId":"person-not-owner"}'::jsonb);

INSERT INTO tenancies (
  world_id, id, housing_unit_id, landlord_id, tenant_id,
  landlord_account_id, tenant_account_id, currency,
  rent_per_period, rent_routine_id, starts_at
) VALUES (
  'housing-sql-test', 'lease-1', 'unit-1', 'person-landlord', 'person-tenant',
  'landlord-wallet', 'tenant-wallet', 'HBC', 500,
  'tenancy:lease-1:rent', 0
);

DO $$
BEGIN
  IF (SELECT count(*) FROM tenancies WHERE world_id = 'housing-sql-test') <> 1 THEN
    RAISE EXCEPTION 'tenancy insert was not persisted';
  END IF;

  IF to_regclass('one_active_tenancy_per_housing_unit') IS NULL THEN
    RAISE EXCEPTION 'active tenancy uniqueness index is missing';
  END IF;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO tenancies (
      world_id, id, housing_unit_id, landlord_id, tenant_id,
      landlord_account_id, tenant_account_id, currency,
      rent_per_period, rent_routine_id, starts_at
    ) VALUES (
      'housing-sql-test', 'lease-2', 'unit-1', 'person-landlord', 'person-other',
      'landlord-wallet', 'tenant-wallet', 'HBC', 600,
      'tenancy:lease-2:rent', 0
    );
    RAISE EXCEPTION 'second active tenancy unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO tenancies (
      world_id, id, housing_unit_id, landlord_id, tenant_id,
      landlord_account_id, tenant_account_id, currency,
      rent_per_period, rent_routine_id, starts_at
    ) VALUES (
      'housing-sql-test', 'bad-owner', 'unit-2', 'person-not-owner', 'person-tenant',
      'landlord-wallet', 'tenant-wallet', 'HBC', 500,
      'tenancy:bad-owner:rent', 0
    );
    RAISE EXCEPTION 'non-owner landlord unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END
$$;
