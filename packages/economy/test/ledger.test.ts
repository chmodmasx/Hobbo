import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asLedgerAccountId,
  asLedgerTransactionId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  normalizeCurrencyCode,
  sumEntries,
  transferEntries,
  validateBalancedEntries,
  validateLedgerTransactionDraft,
} from "../src/index.ts";

describe("integer double-entry ledger", () => {
  it("creates exactly balanced transfers for every positive integer amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000_000_000n }), (amount) => {
        const entries = transferEntries(
          asLedgerAccountId("payer"),
          asLedgerAccountId("receiver"),
          amount,
        );
        expect(sumEntries(entries)).toBe(0n);
        expect(entries).toEqual([
          { accountId: "payer", amount: -amount },
          { accountId: "receiver", amount },
        ]);
        expect(() => validateBalancedEntries(entries)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  it("rejects unbalanced or zero-value postings", () => {
    expect(() =>
      validateBalancedEntries([
        { accountId: asLedgerAccountId("a"), amount: -10n },
        { accountId: asLedgerAccountId("b"), amount: 9n },
      ]),
    ).toThrow(/unbalanced/i);

    expect(() =>
      validateBalancedEntries([
        { accountId: asLedgerAccountId("a"), amount: 0n },
        { accountId: asLedgerAccountId("b"), amount: 1n },
        { accountId: asLedgerAccountId("c"), amount: -1n },
      ]),
    ).toThrow(/zero/i);
  });

  it("rejects self-transfers and non-positive amounts", () => {
    expect(() =>
      transferEntries(asLedgerAccountId("same"), asLedgerAccountId("same"), 1n),
    ).toThrow(/must differ/i);
    expect(() =>
      transferEntries(asLedgerAccountId("a"), asLedgerAccountId("b"), 0n),
    ).toThrow(/greater than zero/i);
  });

  it("normalizes currency codes and validates transaction envelopes", () => {
    expect(normalizeCurrencyCode(" hbc ")).toBe("HBC");
    expect(() => normalizeCurrencyCode("$")).toThrow(/currency code/i);

    expect(() =>
      validateLedgerTransactionDraft({
        id: asLedgerTransactionId("tx-1"),
        worldId: asWorldId("world"),
        simTime: simTime(50),
        currency: "hbc",
        type: "transfer",
        idempotencyKey: "pay:1",
        entries: transferEntries(
          asLedgerAccountId("a"),
          asLedgerAccountId("b"),
          500n,
        ),
      }),
    ).not.toThrow();
  });
});
