import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  asEntityId,
  asEventId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  SOCIAL_BASIS_POINTS,
  adoptPerceptionAsBelief,
  applyRelationshipDelta,
  validateBelief,
  validatePerception,
  validateRelationshipVector,
  zeroRelationshipVector,
  type PerceptionRecord,
  type RelationshipDelta,
  type RelationshipVector,
} from "../src/index.ts";

function perception(): PerceptionRecord {
  return {
    id: "perception-1",
    worldId: asWorldId("world"),
    observerId: asEntityId("person-alice"),
    observedAt: simTime(100),
    channel: "reported",
    subjectId: "person-bob",
    predicate: "employment.status",
    value: "fired",
    confidenceBps: 6_500,
    sourceEntityId: asEntityId("person-carol"),
    sourceEventId: asEventId("conversation-1"),
  };
}

describe("perceptions and private beliefs", () => {
  it("validates evidence without implicitly changing a belief", () => {
    const evidence = perception();
    expect(() => validatePerception(evidence)).not.toThrow();

    const belief = adoptPerceptionAsBelief(evidence);
    expect(belief.holderId).toBe(evidence.observerId);
    expect(belief.value).toBe("fired");
    expect(belief.confidenceBps).toBe(6_500);
    expect(belief.sourcePerceptionId).toBe(evidence.id);
    expect(() => validateBelief(belief)).not.toThrow();
  });

  it("allows contradictory evidence to coexist as separate perceptions", () => {
    const first = perception();
    const second: PerceptionRecord = {
      ...first,
      id: "perception-2",
      observedAt: simTime(110),
      value: "employed",
      confidenceBps: 8_000,
      channel: "direct",
    };

    expect(() => validatePerception(first)).not.toThrow();
    expect(() => validatePerception(second)).not.toThrow();
    expect(first.value).not.toEqual(second.value);
  });

  it("rejects invalid confidence and backwards belief timestamps", () => {
    expect(() =>
      validatePerception({ ...perception(), confidenceBps: 10_001 }),
    ).toThrow(/between 0 and 10000/i);

    const belief = adoptPerceptionAsBelief(perception());
    expect(() =>
      validateBelief({ ...belief, updatedAt: simTime(99) }),
    ).toThrow(/cannot precede/i);
  });
});

describe("multidimensional relationship vectors", () => {
  it("keeps positive-only and signed dimensions distinct", () => {
    const next = applyRelationshipDelta(zeroRelationshipVector(), {
      familiarity: 2_000,
      trust: -4_000,
      affection: 3_000,
      fear: 8_000,
      resentment: 7_000,
    });

    expect(next).toEqual({
      familiarity: 2_000,
      trust: -4_000,
      affection: 3_000,
      respect: 0,
      attraction: 0,
      fear: 8_000,
      resentment: 7_000,
      dependency: 0,
    });
  });

  it("clamps accumulated relationship changes to deterministic integer bounds", () => {
    const saturated = applyRelationshipDelta(zeroRelationshipVector(), {
      trust: 50_000,
      affection: -50_000,
      familiarity: -2_000,
      fear: 50_000,
    });

    expect(saturated.trust).toBe(SOCIAL_BASIS_POINTS);
    expect(saturated.affection).toBe(-SOCIAL_BASIS_POINTS);
    expect(saturated.familiarity).toBe(0);
    expect(saturated.fear).toBe(SOCIAL_BASIS_POINTS);
  });

  it("preserves all relationship bounds under arbitrary integer deltas", () => {
    const signed = fc.integer({ min: -50_000, max: 50_000 });
    const unsigned = fc.integer({ min: 0, max: SOCIAL_BASIS_POINTS });
    const currentArb: fc.Arbitrary<RelationshipVector> = fc.record({
      familiarity: unsigned,
      trust: fc.integer({ min: -SOCIAL_BASIS_POINTS, max: SOCIAL_BASIS_POINTS }),
      affection: fc.integer({ min: -SOCIAL_BASIS_POINTS, max: SOCIAL_BASIS_POINTS }),
      respect: fc.integer({ min: -SOCIAL_BASIS_POINTS, max: SOCIAL_BASIS_POINTS }),
      attraction: fc.integer({ min: -SOCIAL_BASIS_POINTS, max: SOCIAL_BASIS_POINTS }),
      fear: unsigned,
      resentment: unsigned,
      dependency: unsigned,
    });
    const deltaArb: fc.Arbitrary<RelationshipDelta> = fc.record(
      {
        familiarity: signed,
        trust: signed,
        affection: signed,
        respect: signed,
        attraction: signed,
        fear: signed,
        resentment: signed,
        dependency: signed,
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(currentArb, deltaArb, (current, delta) => {
        const next = applyRelationshipDelta(current, delta);
        expect(() => validateRelationshipVector(next)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });
});
