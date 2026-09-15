import {
  DomainInvariantError,
  SIM_HOUR,
  elapsedSimTime,
  simDuration,
  type PersonId,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";

export const NEED_MIN = 0;
export const NEED_MAX = 10_000;

export interface HungerState {
  readonly value: number;
  readonly recordedAt: SimTime;
  readonly ratePerHour: number;
}

export type EnergyMode = "awake" | "sleeping";

export interface EnergyState {
  readonly value: number;
  readonly recordedAt: SimTime;
  readonly mode: EnergyMode;
  readonly awakeDrainPerHour: number;
  readonly sleepRecoveryPerHour: number;
}

export interface FoodItem {
  readonly id: string;
  readonly kind: "food";
  readonly label: string;
  readonly satiety: number;
}

export interface PersonState {
  readonly id: PersonId;
  readonly hunger: HungerState;
  readonly energy: EnergyState;
  readonly inventory: readonly FoodItem[];
  readonly mealsEaten: number;
  readonly sleepSessions: number;
}

function assertNeedValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < NEED_MIN || value > NEED_MAX) {
    throw new DomainInvariantError(
      `${label} must be an integer between ${NEED_MIN} and ${NEED_MAX}`,
    );
  }
}

function assertNonNegativeRate(ratePerHour: number, label: string): void {
  if (!Number.isSafeInteger(ratePerHour) || ratePerHour < 0) {
    throw new DomainInvariantError(`${label} must be a non-negative integer`);
  }
}

function ceilDivPositive(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new DomainInvariantError("ceilDivPositive requires numerator >= 0 and denominator > 0");
  }
  return (numerator + denominator - 1n) / denominator;
}

export function createHungerState(
  value: number,
  recordedAt: SimTime,
  ratePerHour: number,
): HungerState {
  assertNeedValue(value, "Hunger");
  assertNonNegativeRate(ratePerHour, "Hunger rate");
  return { value, recordedAt, ratePerHour };
}

export function createEnergyState(
  value: number,
  recordedAt: SimTime,
  awakeDrainPerHour: number,
  sleepRecoveryPerHour: number,
  mode: EnergyMode = "awake",
): EnergyState {
  assertNeedValue(value, "Energy");
  assertNonNegativeRate(awakeDrainPerHour, "Awake energy drain");
  assertNonNegativeRate(sleepRecoveryPerHour, "Sleep energy recovery");
  return {
    value,
    recordedAt,
    mode,
    awakeDrainPerHour,
    sleepRecoveryPerHour,
  };
}

export function createFoodItem(
  id: string,
  label: string,
  satiety: number,
): FoodItem {
  if (id.length === 0) throw new DomainInvariantError("Food id cannot be empty");
  if (label.length === 0) {
    throw new DomainInvariantError("Food label cannot be empty");
  }
  if (!Number.isSafeInteger(satiety) || satiety <= 0 || satiety > NEED_MAX) {
    throw new DomainInvariantError(
      `Food satiety must be an integer between 1 and ${NEED_MAX}`,
    );
  }
  return { id, kind: "food", label, satiety };
}

export function hungerAt(state: HungerState, at: SimTime): number {
  const elapsed = elapsedSimTime(state.recordedAt, at);
  const increase =
    (BigInt(elapsed) * BigInt(state.ratePerHour)) / BigInt(SIM_HOUR);
  const value = BigInt(state.value) + increase;
  return Number(value > BigInt(NEED_MAX) ? BigInt(NEED_MAX) : value);
}

export function refreshHunger(state: HungerState, at: SimTime): HungerState {
  return {
    value: hungerAt(state, at),
    recordedAt: at,
    ratePerHour: state.ratePerHour,
  };
}

export function timeUntilHunger(
  state: HungerState,
  target: number,
  from: SimTime,
): SimDuration | undefined {
  assertNeedValue(target, "Hunger target");
  const current = hungerAt(state, from);
  if (current >= target) return simDuration(0);
  if (state.ratePerHour === 0) return undefined;

  const requiredIncrease = BigInt(target - state.value);
  const absoluteElapsed = ceilDivPositive(
    requiredIncrease * BigInt(SIM_HOUR),
    BigInt(state.ratePerHour),
  );
  const dueAt = BigInt(state.recordedAt) + absoluteElapsed;
  return simDuration(dueAt - BigInt(from));
}

export function energyAt(state: EnergyState, at: SimTime): number {
  const elapsed = elapsedSimTime(state.recordedAt, at);
  const rate =
    state.mode === "awake"
      ? state.awakeDrainPerHour
      : state.sleepRecoveryPerHour;
  const change = (BigInt(elapsed) * BigInt(rate)) / BigInt(SIM_HOUR);

  if (state.mode === "awake") {
    const value = BigInt(state.value) - change;
    return Number(value < BigInt(NEED_MIN) ? BigInt(NEED_MIN) : value);
  }

  const value = BigInt(state.value) + change;
  return Number(value > BigInt(NEED_MAX) ? BigInt(NEED_MAX) : value);
}

export function refreshEnergy(state: EnergyState, at: SimTime): EnergyState {
  return {
    ...state,
    value: energyAt(state, at),
    recordedAt: at,
  };
}

export function timeUntilEnergyAtMost(
  state: EnergyState,
  target: number,
  from: SimTime,
): SimDuration | undefined {
  assertNeedValue(target, "Energy target");
  const current = energyAt(state, from);
  if (current <= target) return simDuration(0);
  if (state.mode !== "awake" || state.awakeDrainPerHour === 0) return undefined;

  const requiredDrop = BigInt(state.value - target);
  const absoluteElapsed = ceilDivPositive(
    requiredDrop * BigInt(SIM_HOUR),
    BigInt(state.awakeDrainPerHour),
  );
  const dueAt = BigInt(state.recordedAt) + absoluteElapsed;
  return simDuration(dueAt - BigInt(from));
}

export function timeUntilEnergyAtLeast(
  state: EnergyState,
  target: number,
  from: SimTime,
): SimDuration | undefined {
  assertNeedValue(target, "Energy target");
  const current = energyAt(state, from);
  if (current >= target) return simDuration(0);
  if (state.mode !== "sleeping" || state.sleepRecoveryPerHour === 0) {
    return undefined;
  }

  const requiredGain = BigInt(target - state.value);
  const absoluteElapsed = ceilDivPositive(
    requiredGain * BigInt(SIM_HOUR),
    BigInt(state.sleepRecoveryPerHour),
  );
  const dueAt = BigInt(state.recordedAt) + absoluteElapsed;
  return simDuration(dueAt - BigInt(from));
}

export function beginSleep(person: PersonState, at: SimTime): PersonState {
  if (person.energy.mode === "sleeping") {
    throw new DomainInvariantError(`Person ${person.id} is already sleeping`);
  }

  return {
    ...person,
    energy: {
      ...refreshEnergy(person.energy, at),
      mode: "sleeping",
    },
    sleepSessions: person.sleepSessions + 1,
  };
}

export function wakeUp(person: PersonState, at: SimTime): PersonState {
  if (person.energy.mode === "awake") {
    throw new DomainInvariantError(`Person ${person.id} is already awake`);
  }

  return {
    ...person,
    energy: {
      ...refreshEnergy(person.energy, at),
      mode: "awake",
    },
  };
}

export interface ConsumeFoodResult {
  readonly person: PersonState;
  readonly item: FoodItem;
  readonly hungerBefore: number;
  readonly hungerAfter: number;
}

export function consumeFood(
  person: PersonState,
  itemId: string,
  at: SimTime,
): ConsumeFoodResult {
  const index = person.inventory.findIndex((item) => item.id === itemId);
  if (index < 0) {
    throw new DomainInvariantError(
      `Person ${person.id} does not own food item ${itemId}`,
    );
  }

  const item = person.inventory[index];
  if (item === undefined) {
    throw new DomainInvariantError("Inventory index became inconsistent");
  }

  const currentHunger = refreshHunger(person.hunger, at);
  const hungerAfter = Math.max(NEED_MIN, currentHunger.value - item.satiety);
  const inventory = person.inventory.filter((_, itemIndex) => itemIndex !== index);

  return {
    person: {
      ...person,
      hunger: {
        ...currentHunger,
        value: hungerAfter,
      },
      inventory,
      mealsEaten: person.mealsEaten + 1,
    },
    item,
    hungerBefore: currentHunger.value,
    hungerAfter,
  };
}

export * from "./actions.ts";
