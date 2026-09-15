import type { ActionDefinition } from "@hobbo/actions";
import { asActionId } from "@hobbo/domain";
import type { PersonState } from "./index.ts";

export const CONSUME_FOOD_ACTION_ID = asActionId("inventory.consume_food");

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
