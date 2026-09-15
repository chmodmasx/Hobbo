BEGIN;

CREATE TABLE housing_units (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  label TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, id, owner_id),
  CONSTRAINT housing_unit_label_not_blank CHECK (label IS NULL OR length(btrim(label)) > 0)
);

CREATE INDEX housing_units_owner_idx
  ON housing_units (world_id, owner_id);

CREATE TABLE tenancies (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  housing_unit_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL CHECK (length(landlord_id) > 0),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  landlord_account_id TEXT NOT NULL,
  tenant_account_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9_]{1,11}$'),
  rent_per_period BIGINT NOT NULL CHECK (rent_per_period > 0),
  rent_routine_id TEXT NOT NULL,
  starts_at BIGINT NOT NULL CHECK (starts_at >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_at BIGINT NULL CHECK (ended_at IS NULL OR ended_at >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, rent_routine_id),
  FOREIGN KEY (world_id, housing_unit_id, landlord_id)
    REFERENCES housing_units(world_id, id, owner_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, landlord_account_id)
    REFERENCES ledger_accounts(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, tenant_account_id)
    REFERENCES ledger_accounts(world_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (world_id, rent_routine_id)
    REFERENCES routines(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tenancy_distinct_parties CHECK (landlord_id <> tenant_id),
  CONSTRAINT tenancy_distinct_accounts CHECK (landlord_account_id <> tenant_account_id),
  CONSTRAINT tenancy_status_consistency CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR
    (status = 'ended' AND ended_at IS NOT NULL AND ended_at >= starts_at)
  )
);

CREATE UNIQUE INDEX one_active_tenancy_per_housing_unit
  ON tenancies (world_id, housing_unit_id)
  WHERE status = 'active';

CREATE INDEX tenancies_tenant_idx
  ON tenancies (world_id, tenant_id, status);

CREATE INDEX tenancies_landlord_idx
  ON tenancies (world_id, landlord_id, status);

COMMIT;
