import type { ActionDefinition } from "@hobbo/actions";
import { asActionId } from "@hobbo/domain";
import type { PersonState } from "./index.ts";

export const CONSUME_FOOD_ACTION_ID = asActionId("inventory.consume_food");
export const BEGIN_SLEEP_ACTION_ID = asActionId("physiology.begin_sleep");
export const WAKE_UP_ACTION_ID = asActionId("physiology.wake_up");

export interface ConsumeFoodActionInput {
  readonly itemId: string;
}

export function isConsumeFoodActionInput(
  input: unknown,
): input is ConsumeFoodActionInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "itemId" in input &&
    typeof input.itemId === "string" &&
    input.itemId.length > 0
  );
}

function isEmptyActionInput(input: unknown): boolean {
  return (
    input === null ||
    input === undefined ||
    (typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0)
  );
}

export function createConsumeFoodActionDefinition(): ActionDefinition<PersonState> {
  return {
    id: CONSUME_FOOD_ACTION_ID,
    label: "Eat owned food",
    description: "Consume one edible item currently owned by the actor.",
    validate(context, input) {
      if (!isConsumeFoodActionInput(input)) {
        return {
          ok: false,
          code: "invalid_input",
          message: "consume_food requires a non-empty itemId",
        };
      }

      if (!context.worldState.inventory.some((item) => item.id === input.itemId)) {
        return {
          ok: false,
          code: "food_unavailable",
          message: `Food item is not owned: ${input.itemId}`,
        };
      }

      return { ok: true };
    },
  };
}

export function createBeginSleepActionDefinition(): ActionDefinition<PersonState> {
  return {
    id: BEGIN_SLEEP_ACTION_ID,
    label: "Begin sleeping",
    description: "Transition an awake person into the sleeping physiology mode.",
    validate(context, input) {
      if (!isEmptyActionInput(input)) {
        return {
          ok: false,
          code: "invalid_input",
          message: "begin_sleep does not accept action input",
        };
      }
      if (context.worldState.energy.mode === "sleeping") {
        return {
          ok: false,
          code: "already_sleeping",
          message: "Person is already sleeping",
        };
      }
      return { ok: true };
    },
  };
}

export function createWakeUpActionDefinition(): ActionDefinition<PersonState> {
  return {
    id: WAKE_UP_ACTION_ID,
    label: "Wake up",
    description: "Transition a sleeping person back into the awake physiology mode.",
    validate(context, input) {
      if (!isEmptyActionInput(input)) {
        return {
          ok: false,
          code: "invalid_input",
          message: "wake_up does not accept action input",
        };
      }
      if (context.worldState.energy.mode === "awake") {
        return {
          ok: false,
          code: "already_awake",
          message: "Person is already awake",
        };
      }
      return { ok: true };
    },
  };
}
