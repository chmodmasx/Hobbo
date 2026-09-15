import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SIM_HOUR,
  asPersonId,
  simTime,
} from "@hobbo/domain";
import {
  NEED_MAX,
  beginSleep,
  consumeFood,
  createEnergyState,
  createFoodItem,
  createHungerState,
  energyAt,
  hungerAt,
  timeUntilEnergyAtLeast,
  timeUntilEnergyAtMost,
  timeUntilHunger,
  wakeUp,
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

  it("preserves fractional rate progress when scheduling from a later time", () => {
    const hunger = createHungerState(0, simTime(0), 1_001);
    const from = simTime(1_000);
    const wait = timeUntilHunger(hunger, 1_000, from);
    expect(wait).toBeDefined();
    if (wait === undefined) return;

    const due = simTime(BigInt(from) + BigInt(wait));
    expect(hungerAt(hunger, due)).toBeGreaterThanOrEqual(1_000);
    expect(hungerAt(hunger, simTime(due - 1n))).toBeLessThan(1_000);
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

describe("analytical sleep and energy", () => {
  it("drains while awake and recovers while sleeping without ticks", () => {
    const awake = createEnergyState(8_000, simTime(0), 500, 2_000, "awake");
    expect(energyAt(awake, simTime(SIM_HOUR))).toBe(7_500);

    const sleeping = createEnergyState(
      2_000,
      simTime(0),
      500,
      2_000,
      "sleeping",
    );
    expect(energyAt(sleeping, simTime(SIM_HOUR))).toBe(4_000);
    expect(energyAt(sleeping, simTime(BigInt(SIM_HOUR) * 10n))).toBe(NEED_MAX);
  });

  it("finds the exact first second for low-energy and wake thresholds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: NEED_MAX }),
        fc.integer({ min: 1, max: 2_000 }),
        fc.integer({ min: 0, max: 9_999 }),
        (initial, rate, rawTarget) => {
          const target = Math.min(initial - 1, rawTarget);
          if (target < 0) return;

          const energy = createEnergyState(initial, simTime(0), rate, 1_000, "awake");
          const wait = timeUntilEnergyAtMost(energy, target, simTime(0));
          expect(wait).toBeDefined();
          if (wait === undefined) return;

          const due = simTime(wait);
          expect(energyAt(energy, due)).toBeLessThanOrEqual(target);
          if (due > 0n) {
            expect(energyAt(energy, simTime(due - 1n))).toBeGreaterThan(target);
          }
        },
      ),
      { numRuns: 500 },
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8_999 }),
        fc.integer({ min: 1, max: 4_000 }),
        fc.integer({ min: 1, max: NEED_MAX }),
        (initial, recovery, rawTarget) => {
          const target = Math.max(initial + 1, rawTarget);
          if (target > NEED_MAX) return;

          const energy = createEnergyState(
            initial,
            simTime(0),
            500,
            recovery,
            "sleeping",
          );
          const wait = timeUntilEnergyAtLeast(energy, target, simTime(0));
          expect(wait).toBeDefined();
          if (wait === undefined) return;

          const due = simTime(wait);
          expect(energyAt(energy, due)).toBeGreaterThanOrEqual(target);
          if (due > 0n) {
            expect(energyAt(energy, simTime(due - 1n))).toBeLessThan(target);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("switches rates only at explicit sleep/wake transitions", () => {
    const person: PersonState = {
      id: asPersonId("sleeper"),
      hunger: createHungerState(1_000, simTime(0), 0),
      energy: createEnergyState(5_000, simTime(0), 1_000, 2_000, "awake"),
      inventory: [],
      mealsEaten: 0,
      sleepSessions: 0,
    };

    const sleeping = beginSleep(person, simTime(SIM_HOUR));
    expect(sleeping.energy.value).toBe(4_000);
    expect(sleeping.energy.mode).toBe("sleeping");
    expect(sleeping.sleepSessions).toBe(1);

    const awake = wakeUp(sleeping, simTime(BigInt(SIM_HOUR) * 3n));
    expect(awake.energy.value).toBe(8_000);
    expect(awake.energy.mode).toBe("awake");
    expect(awake.sleepSessions).toBe(1);
  });
});

describe("food inventory", () => {
  it("consumes exactly one owned food item and applies satiety", () => {
    const person: PersonState = {
      id: asPersonId("person-1"),
      hunger: createHungerState(8_000, simTime(0), 0),
      energy: createEnergyState(8_000, simTime(0), 0, 0),
      inventory: [
        createFoodItem("sandwich", "Sandwich", 6_000),
        createFoodItem("apple", "Apple", 2_000),
      ],
      mealsEaten: 0,
      sleepSessions: 0,
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
      energy: createEnergyState(8_000, simTime(0), 0, 0),
      inventory: [],
      mealsEaten: 0,
      sleepSessions: 0,
    };

    expect(() => consumeFood(person, "missing", simTime(0))).toThrow(
      /does not own/i,
    );
  });
});
