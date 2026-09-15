import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SIM_HOUR,
  asPersonId,
  simTime,
} from "@hobbo/domain";
import {
  NEED_MAX,
  consumeFood,
  createFoodItem,
  createHungerState,
  hungerAt,
  timeUntilHunger,
  type PersonState,
} from "../src/index.ts";

describe("analytical hunger", () => {
  it("integrates hunger from elapsed simulation time without ticking", () => {
    const hunger = createHungerState(1_000, simTime(0), 600);
    expect(hungerAt(hunger, simTime(SIM_HOUR))).toBe(1_600);
    expect(hungerAt(hunger, simTime(BigInt(SIM_HOUR) * 100n))).toBe(NEED_MAX);
  });

  it("computes the first second at which a hunger threshold is reached", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_999 }),
        fc.integer({ min: 1, max: 2_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (initial, rate, rawTarget) => {
          const target = Math.max(initial + 1, rawTarget);
          if (target > NEED_MAX) return;

          const hunger = createHungerState(initial, simTime(0), rate);
          const wait = timeUntilHunger(hunger, target, simTime(0));
          expect(wait).toBeDefined();
          if (wait === undefined) return;

          const due = simTime(wait);
          expect(hungerAt(hunger, due)).toBeGreaterThanOrEqual(target);
          if (due > 0n) {
            expect(hungerAt(hunger, simTime(due - 1n))).toBeLessThan(target);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never leaves the bounded need range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: NEED_MAX }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 365 * 24 * 60 * 60 }),
        (initial, rate, seconds) => {
          const hunger = createHungerState(initial, simTime(0), rate);
          const value = hungerAt(hunger, simTime(seconds));
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(NEED_MAX);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("food inventory", () => {
  it("consumes exactly one owned food item and applies satiety", () => {
    const person: PersonState = {
      id: asPersonId("person-1"),
      hunger: createHungerState(8_000, simTime(0), 0),
      inventory: [
        createFoodItem("sandwich", "Sandwich", 6_000),
        createFoodItem("apple", "Apple", 2_000),
      ],
      mealsEaten: 0,
    };

    const result = consumeFood(person, "sandwich", simTime(0));

    expect(result.hungerBefore).toBe(8_000);
    expect(result.hungerAfter).toBe(2_000);
    expect(result.person.inventory.map((item) => item.id)).toEqual(["apple"]);
    expect(result.person.mealsEaten).toBe(1);
    expect(person.inventory).toHaveLength(2);
  });

  it("cannot consume food that is not owned", () => {
    const person: PersonState = {
      id: asPersonId("person-1"),
      hunger: createHungerState(8_000, simTime(0), 0),
      inventory: [],
      mealsEaten: 0,
    };

    expect(() => consumeFood(person, "missing", simTime(0))).toThrow(
      /does not own/i,
    );
  });
});
