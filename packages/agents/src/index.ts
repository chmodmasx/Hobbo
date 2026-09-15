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

export interface FoodItem {
  readonly id: string;
  readonly kind: "food";
  readonly label: string;
  readonly satiety: number;
}

export interface PersonState {
  readonly id: PersonId;
  readonly hunger: HungerState;
  readonly inventory: readonly FoodItem[];
  readonly mealsEaten: number;
}

function assertNeedValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < NEED_MIN || value > NEED_MAX) {
    throw new DomainInvariantError(
      `${label} must be an integer between ${NEED_MIN} and ${NEED_MAX}`,
    );
  }
}

function assertRate(ratePerHour: number): void {
  if (!Number.isSafeInteger(ratePerHour) || ratePerHour < 0) {
    throw new DomainInvariantError("Hunger rate must be a non-negative integer");
  }
}

export function createHungerState(
  value: number,
  recordedAt: SimTime,
  ratePerHour: number,
): HungerState {
  assertNeedValue(value, "Hunger");
  assertRate(ratePerHour);
  return { value, recordedAt, ratePerHour };
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

  const remaining = BigInt(target - current);
  const numerator = remaining * BigInt(SIM_HOUR);
  const denominator = BigInt(state.ratePerHour);
  const seconds = (numerator + denominator - 1n) / denominator;
  return simDuration(seconds);
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
