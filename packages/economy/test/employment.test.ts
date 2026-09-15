import { describe, expect, it } from "vitest";
import {
  SIM_DAY,
  SIM_HOUR,
  asEmploymentId,
  asEntityId,
  asLedgerAccountId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  salaryIdempotencyKey,
  salaryTransactionId,
  validateEmploymentTerms,
  workRoutineIdForEmployment,
  type EmploymentTerms,
} from "../src/index.ts";

function validTerms(): EmploymentTerms {
  return {
    id: asEmploymentId("employment-1"),
    worldId: asWorldId("world"),
    employerId: asEntityId("business-cafe"),
    employeeId: asEntityId("person-alice"),
    employerAccountId: asLedgerAccountId("cafe-cash"),
    employeeAccountId: asLedgerAccountId("alice-wallet"),
    currency: " hbc ",
    wagePerShift: 250n,
    workPeriod: simDuration(SIM_DAY),
    workPhase: simDuration(BigInt(SIM_HOUR) * 9n),
    startsAt: simTime(0),
  };
}

describe("employment contracts", () => {
  it("validates deterministic recurring work terms and normalizes currency", () => {
    expect(validateEmploymentTerms(validTerms())).toBe("HBC");
    expect(String(workRoutineIdForEmployment(asEmploymentId("employment-1")))).toBe(
      "employment:employment-1:shift",
    );
  });

  it("rejects self-employment through the same entity and invalid payroll accounts", () => {
    const base = validTerms();
    expect(() =>
      validateEmploymentTerms({ ...base, employeeId: base.employerId }),
    ).toThrow(/must differ/i);
    expect(() =>
      validateEmploymentTerms({
        ...base,
        employeeAccountId: base.employerAccountId,
      }),
    ).toThrow(/must differ/i);
  });

  it("rejects non-positive wages and invalid recurrence phases", () => {
    const base = validTerms();
    expect(() => validateEmploymentTerms({ ...base, wagePerShift: 0n })).toThrow(
      /greater than zero/i,
    );
    expect(() =>
      validateEmploymentTerms({ ...base, workPhase: base.workPeriod }),
    ).toThrow(/within \[0, period\)/i);
  });

  it("derives stable salary identities from employment and concrete shift", () => {
    const employmentId = asEmploymentId("job/one");
    const commitmentA = "routine:employment%3Ajob%252Fone%3Ashift:32400";
    const commitmentB = "routine:employment%3Ajob%252Fone%3Ashift:118800";

    expect(salaryIdempotencyKey(employmentId, commitmentA)).toBe(
      salaryIdempotencyKey(employmentId, commitmentA),
    );
    expect(salaryTransactionId(employmentId, commitmentA)).toBe(
      salaryTransactionId(employmentId, commitmentA),
    );
    expect(salaryIdempotencyKey(employmentId, commitmentA)).not.toBe(
      salaryIdempotencyKey(employmentId, commitmentB),
    );
  });
});
