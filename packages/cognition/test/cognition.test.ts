import { describe, expect, it } from "vitest";
import {
  DeterministicMockCognitiveProvider,
  ReplayCognitiveProvider,
} from "@hobbo/ai-provider";
import {
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asMemoryId,
  asWorldId,
  simTime,
  type Affordance,
} from "@hobbo/domain";
import type { ScoredMemory } from "@hobbo/memory";
import {
  AmbiguousChoiceEngine,
  assembleAmbiguousChoiceRequest,
  type AmbiguousChoiceContext,
  type AmbiguousChoiceInput,
} from "../src/index.ts";

const actorId = asEntityId("person-alice");
const friendId = asEntityId("person-bob");
const helpId = asAffordanceId("help_friend");
const ignoreId = asAffordanceId("ignore_friend");

const affordances: readonly Affordance[] = [
  {
    id: helpId,
    actionId: asActionId("social.help"),
    label: "Help Bob",
    context: { targetId: friendId },
  },
  {
    id: ignoreId,
    actionId: asActionId("social.ignore"),
    label: "Keep walking",
    context: { targetId: friendId },
  },
];

function memory(
  id: string,
  content: string,
  occurredAt = 90,
  scoreBps = 9_000,
): ScoredMemory {
  return {
    memory: {
      id: asMemoryId(id),
      worldId: asWorldId("world-1"),
      ownerId: actorId,
      category: "episodic",
      occurredAt: simTime(occurredAt),
      content,
      importanceBps: 7_000,
      emotionalStrengthBps: 6_000,
      relatedEntityIds: [friendId],
    },
    scoreBps,
    components: {
      semanticBps: 9_500,
      recencyBps: 8_000,
      importanceBps: 7_000,
      emotionalBps: 6_000,
    },
  };
}

interface ChoiceState {
  readonly energy: number;
  readonly cash: number;
}

function input(
  memories: readonly ScoredMemory[] = [
    memory("memory-helped", "Bob helped Alice when she was in trouble."),
  ],
): AmbiguousChoiceInput<ChoiceState> {
  return {
    id: asCognitionRequestId("choice-1"),
    actorId,
    simTime: simTime(100),
    correlationId: asCorrelationId("corr-choice-1"),
    situation: " Bob asks Alice for help carrying groceries. ",
    state: { energy: 5_000, cash: 2_000 },
    affordances,
    memories,
  };
}

describe("assembleAmbiguousChoiceRequest", () => {
  it("builds a compact deterministic context from retrieved memories", () => {
    const request = assembleAmbiguousChoiceRequest(input());

    expect(request.context.situation).toBe(
      "Bob asks Alice for help carrying groceries.",
    );
    expect(request.context.state).toEqual({ energy: 5_000, cash: 2_000 });
    expect(request.context.memories).toHaveLength(1);
    expect(request.context.memories[0]).toMatchObject({
      id: asMemoryId("memory-helped"),
      category: "episodic",
      content: "Bob helped Alice when she was in trouble.",
      scoreBps: 9_000,
    });
    expect(request.context.memories[0]).not.toHaveProperty("ownerId");
    expect(request.context.memories[0]).not.toHaveProperty("worldId");
  });

  it("requires a genuinely ambiguous choice with at least two affordances", () => {
    expect(() =>
      assembleAmbiguousChoiceRequest({
        ...input(),
        affordances: [affordances[0]!],
      }),
    ).toThrow(/at least two available affordances/i);
  });

  it("rejects duplicate affordance identities", () => {
    expect(() =>
      assembleAmbiguousChoiceRequest({
        ...input(),
        affordances: [affordances[0]!, affordances[0]!],
      }),
    ).toThrow(/duplicate affordance/i);
  });

  it("rejects future or duplicate memories before they reach a provider", () => {
    expect(() =>
      assembleAmbiguousChoiceRequest(
        input([memory("future", "This has not happened yet.", 101)]),
      ),
    ).toThrow(/future memory/i);

    const repeated = memory("same", "Repeated memory");
    expect(() =>
      assembleAmbiguousChoiceRequest(input([repeated, repeated])),
    ).toThrow(/duplicate memory/i);
  });
});

describe("AmbiguousChoiceEngine", () => {
  it("lets deterministic mock policy use retrieved memory to choose an affordance", async () => {
    const provider = new DeterministicMockCognitiveProvider<
      AmbiguousChoiceContext<ChoiceState>
    >((request) => {
      const remembersHelp = request.context.memories.some((item) =>
        item.content.includes("helped Alice"),
      );
      return {
        affordanceId: remembersHelp ? helpId : ignoreId,
        intent: remembersHelp ? "Return Bob's earlier help" : "Conserve energy",
      };
    });
    const engine = new AmbiguousChoiceEngine(provider);

    const decision = await engine.decide(input());

    expect(decision.affordanceId).toBe(helpId);
    expect(decision.intent).toBe("Return Bob's earlier help");
    expect(decision.replayed).toBe(false);
  });

  it("replays a recorded ambiguous decision without re-inferring it", async () => {
    const provider = new ReplayCognitiveProvider<
      AmbiguousChoiceContext<ChoiceState>
    >([
      [
        asCognitionRequestId("choice-1"),
        {
          affordanceId: ignoreId,
          intent: "Recorded historical choice",
        },
      ],
    ]);
    const engine = new AmbiguousChoiceEngine(provider);

    const decision = await engine.decide(input());

    expect(decision.affordanceId).toBe(ignoreId);
    expect(decision.intent).toBe("Recorded historical choice");
    expect(decision.replayed).toBe(true);
  });
});
