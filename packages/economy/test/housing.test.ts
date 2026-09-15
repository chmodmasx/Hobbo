import { describe, expect, it } from "vitest";
import {
  SIM_DAY,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asTenancyId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  rentIdempotencyKey,
  rentRoutineIdForTenancy,
  rentTransactionId,
  validateHousingUnitDefinition,
  validateTenancyTerms,
  type TenancyTerms,
} from "../src/index.ts";

function validTenancy(): TenancyTerms {
  return {
    id: asTenancyId("tenancy-1"),
    worldId: asWorldId("world"),
    housingUnitId: asHousingUnitId("apartment-1"),
    landlordId: asEntityId("person-landlord"),
    tenantId: asEntityId("person-tenant"),
    landlordAccountId: asLedgerAccountId("landlord-wallet"),
    tenantAccountId: asLedgerAccountId("tenant-wallet"),
    currency: " hbc ",
    rentPerPeriod: 500n,
    rentPeriod: simDuration(BigInt(SIM_DAY) * 30n),
    rentPhase: simDuration(BigInt(SIM_DAY) * 5n),
    startsAt: simTime(0),
  };
}

describe("housing and tenancy contracts", () => {
  it("validates housing units and normalizes tenancy currency", () => {
    expect(() =>
      validateHousingUnitDefinition({
        id: asHousingUnitId("unit-1"),
        worldId: asWorldId("world"),
        ownerId: asEntityId("owner"),
        label: "Apartment 1",
      }),
    ).not.toThrow();
    expect(validateTenancyTerms(validTenancy())).toBe("HBC");
  });

  it("rejects invalid parties, accounts, rent amounts and recurrence", () => {
    const base = validTenancy();
    expect(() =>
      validateTenancyTerms({ ...base, tenantId: base.landlordId }),
    ).toThrow(/must differ/i);
    expect(() =>
      validateTenancyTerms({ ...base, tenantAccountId: base.landlordAccountId }),
    ).toThrow(/must differ/i);
    expect(() => validateTenancyTerms({ ...base, rentPerPeriod: 0n })).toThrow(
      /greater than zero/i,
    );
    expect(() =>
      validateTenancyTerms({ ...base, rentPhase: base.rentPeriod }),
    ).toThrow(/within \[0, period\)/i);
  });

  it("rejects blank housing labels", () => {
    expect(() =>
      validateHousingUnitDefinition({
        id: asHousingUnitId("unit-1"),
        worldId: asWorldId("world"),
        ownerId: asEntityId("owner"),
        label: "   ",
      }),
    ).toThrow(/label cannot be blank/i);
  });

  it("derives stable and shift-specific rent identities", () => {
    const tenancyId = asTenancyId("lease/one");
    const first = "routine:tenancy%3Alease%252Fone%3Arent:432000";
    const second = "routine:tenancy%3Alease%252Fone%3Arent:3024000";

    expect(String(rentRoutineIdForTenancy(tenancyId))).toBe(
      "tenancy:lease%2Fone:rent",
    );
    expect(rentIdempotencyKey(tenancyId, first)).toBe(
      rentIdempotencyKey(tenancyId, first),
    );
    expect(rentTransactionId(tenancyId, first)).toBe(
      rentTransactionId(tenancyId, first),
    );
    expect(rentIdempotencyKey(tenancyId, first)).not.toBe(
      rentIdempotencyKey(tenancyId, second),
    );
  });
});
