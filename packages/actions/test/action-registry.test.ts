import { describe, expect, it } from "vitest";
import {
  asActionId,
  asCorrelationId,
  asEntityId,
  simTime,
} from "@hobbo/domain";
import { ActionRegistry, type ActionRequest } from "../src/index.ts";

interface TestWorld {
  readonly hasFood: boolean;
}

const actorId = asEntityId("person-1");
const actionId = asActionId("inventory.consume_food");
const correlationId = asCorrelationId("corr-1");

function request(origin: ActionRequest["origin"]): ActionRequest {
  return {
    actionId,
    actorId,
    origin,
    requestedAt: simTime(10),
    correlationId,
    input: { itemId: "sandwich-1" },
  };
}

function registry(): ActionRegistry<TestWorld> {
  const result = new ActionRegistry<TestWorld>();
  result.register({
    id: actionId,
    label: "Eat owned food",
    validate(context, input) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("itemId" in input) ||
        typeof input.itemId !== "string"
      ) {
        return {
          ok: false,
          code: "invalid_input",
          message: "itemId is required",
        };
      }

      if (!context.worldState.hasFood) {
        return {
          ok: false,
          code: "food_unavailable",
          message: "Actor does not own edible food",
        };
      }

      return { ok: true };
    },
  });
  return result;
}

describe("ActionRegistry", () => {
  it("applies identical world validation to player and LLM requests", () => {
    const actions = registry();
    const context = {
      actorId,
      simTime: simTime(10),
      worldState: { hasFood: false },
    } as const;

    const player = actions.validate(request("player"), context);
    const llm = actions.validate(request("llm"), context);

    expect(player.ok).toBe(false);
    expect(llm.ok).toBe(false);
    if (!player.ok && !llm.ok) {
      expect(player.code).toBe("food_unavailable");
      expect(llm.code).toBe(player.code);
    }
  });

  it("accepts the same valid action regardless of decision origin", () => {
    const actions = registry();
    const context = {
      actorId,
      simTime: simTime(10),
      worldState: { hasFood: true },
    } as const;

    for (const origin of ["player", "rule", "utility", "llm", "replay"] as const) {
      expect(actions.validate(request(origin), context).ok).toBe(true);
    }
  });

  it("rejects duplicate definitions, unknown actions and actor mismatches", () => {
    const actions = registry();
    expect(() =>
      actions.register({
        id: actionId,
        label: "duplicate",
        validate: () => ({ ok: true }),
      }),
    ).toThrow(/already registered/i);

    const unknown = actions.validate(
      { ...request("player"), actionId: asActionId("does.not.exist") },
      { actorId, simTime: simTime(10), worldState: { hasFood: true } },
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown_action");

    const mismatch = actions.validate(request("player"), {
      actorId: asEntityId("person-2"),
      simTime: simTime(10),
      worldState: { hasFood: true },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("actor_mismatch");
  });
});
