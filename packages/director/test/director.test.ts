import { describe, expect, it } from "vitest";
import {
  WORLD_DIRECTOR_HARD_MAX_CANDIDATES,
  buildWorldDirectorAffordances,
  proposalFromWorldDirectorAffordance,
  worldDirectorCognitionContext,
} from "../src/index.ts";
import { asWorldId, simDuration, simTime } from "@hobbo/domain";

const summary = {
  currentSimTime: simTime(100),
  populationCount: 3,
  sampledPersonIds: ["charlie", "alice", "bob"],
  recentEvents: [
    {
      sequence: "7",
      simTime: "90",
      type: "person.travel_arrived",
      actorId: "alice",
      targetIds: [],
    },
  ],
};

describe("World Director contracts", () => {
  it("builds bounded deterministic affordances with no direct mutation", () => {
    const first = buildWorldDirectorAffordances({
      summary,
      effectDelay: simDuration(60),
      maxCandidates: 2,
    });
    const second = buildWorldDirectorAffordances({
      summary,
      effectDelay: simDuration(60),
      maxCandidates: 2,
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first[0]).toMatchObject({
      id: "world-director:no-intervention",
      context: { kind: "none" },
    });
    expect(first.slice(1).map((affordance) => affordance.context)).toEqual([
      {
        kind: "social_opportunity",
        participantIds: ["alice", "bob"],
        dueAt: "160",
      },
      {
        kind: "social_opportunity",
        participantIds: ["alice", "charlie"],
        dueAt: "160",
      },
    ]);
  });

  it("maps selected affordances into explicit accepted/rejected proposal drafts", () => {
    const affordances = buildWorldDirectorAffordances({
      summary,
      effectDelay: simDuration(30),
      maxCandidates: 1,
    });
    expect(proposalFromWorldDirectorAffordance(affordances[0]!)).toEqual({
      status: "rejected",
      kind: "none",
      payload: { reason: "no_intervention" },
    });
    expect(proposalFromWorldDirectorAffordance(affordances[1]!)).toEqual({
      status: "accepted",
      kind: "social_opportunity",
      payload: {
        participantIds: ["alice", "bob"],
        dueAt: "130",
      },
    });
  });

  it("enforces hard budgets and bounded serializable context", () => {
    expect(
      worldDirectorCognitionContext({
        ...summary,
        currentSimTime: simTime(123),
      }),
    ).toMatchObject({
      world: {
        currentSimTime: "123",
        populationCount: 3,
      },
    });

    expect(() =>
      buildWorldDirectorAffordances({
        summary,
        effectDelay: simDuration(60),
        maxCandidates: WORLD_DIRECTOR_HARD_MAX_CANDIDATES + 1,
      }),
    ).toThrow(/hard|maxCandidates|<=/i);

    expect(() =>
      buildWorldDirectorAffordances({
        summary: {
          ...summary,
          sampledPersonIds: ["alice", "alice"],
          populationCount: 2,
        },
        effectDelay: simDuration(60),
        maxCandidates: 1,
      }),
    ).toThrow(/duplicate sampled person/i);
  });
});
