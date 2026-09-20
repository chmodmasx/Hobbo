import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  DeterministicTraceableCognitiveProvider,
} from "@hobbo/ai-provider/granite";
import {
  PostgresCognitionRepository,
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresWorldDirectorRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import type { WorldDirectorCognitionContext } from "@hobbo/director";
import {
  asPersonId,
  asWorldId,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  CoreWorldRuntime,
  WORLD_DIRECTOR_REVIEW_EVENT_TYPE,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);
const events = new PostgresDomainEventRepository(pool);
const proposals = new PostgresWorldDirectorRepository(pool);
const cognition = new PostgresCognitionRepository(pool);

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function person(id: string): PersonState {
  return {
    id: asPersonId(id),
    hunger: createHungerState(0, simTime(0), 0),
    energy: createEnergyState(10_000, simTime(0), 0, 0, "awake"),
    inventory: [],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

async function seed(name: string) {
  const worldId = asWorldId(name);
  await worlds.create(worldId);
  await people.create({
    worldId,
    person: person("alice"),
    at: simTime(0),
  });
  await people.create({
    worldId,
    person: person("bob"),
    at: simTime(0),
  });
  return worldId;
}

const policy = {
  enabled: true,
  period: simDuration(3_600),
  effectDelay: simDuration(60),
  maxPeople: 4,
  maxRecentEvents: 4,
  maxCandidates: 1,
} as const;

describe("durable bounded World Director runtime", () => {
  it("replays a persisted proposal after a crash boundary without new inference", async () => {
    const worldId = await seed("world-director-restart");
    const calls = { value: 0 };
    const provider =
      new DeterministicTraceableCognitiveProvider<WorldDirectorCognitionContext>({
        id: "world-director-test",
        modelId: "world-director-test-v1",
        strategy: (request) => {
          calls.value += 1;
          const selected = request.affordances[1];
          if (selected === undefined) {
            throw new Error("expected one social opportunity affordance");
          }
          return {
            affordanceId: selected.id,
            intent: "Introduce one bounded social opportunity",
          };
        },
      });
    const runtime = new CoreWorldRuntime(pool, {
      director: policy,
      directorProvider: provider,
    });

    const scheduled = await runtime.scheduleInitialDirector(
      worldId,
      simTime(10),
    );
    expect(scheduled?.type).toBe(WORLD_DIRECTOR_REVIEW_EVENT_TYPE);

    const pending = (await schedules.loadPending(worldId))[0];
    if (pending === undefined) throw new Error("missing director review");

    await expect(
      runtime.director.handleReview({
        worldId,
        workerId: "crashed-before-outcome",
        scheduled: pending,
      }),
    ).rejects.toThrow(/not owned by worker/i);

    expect(calls.value).toBe(1);
    const persisted = await proposals.getByTriggerEvent(
      worldId,
      String(pending.event.id),
    );
    expect(persisted).toMatchObject({
      status: "accepted",
      kind: "social_opportunity",
      effectEventId: `runtime:director:opportunity:${pending.event.id}`,
    });
    expect(
      await cognition.get(
        worldId,
        `world-director:cognition:${pending.event.id}` as never,
      ),
    ).toMatchObject({ status: "completed" });

    let forbiddenCalls = 0;
    const restarted = new CoreWorldRuntime(pool, {
      director: policy,
      directorProvider:
        new DeterministicTraceableCognitiveProvider<WorldDirectorCognitionContext>({
          id: "forbidden-after-restart",
          modelId: "forbidden-after-restart",
          strategy: () => {
            forbiddenCalls += 1;
            throw new Error("restarted Director unexpectedly inferred");
          },
        }),
    });

    expect(
      await restarted.processThrough({
        worldId,
        through: simTime(10),
        workerId: "director-restart-worker",
        maxEvents: 1,
      }),
    ).toBe(1);
    expect(forbiddenCalls).toBe(0);

    expect(
      (await schedules.loadPending(worldId)).map((entry) => ({
        id: entry.event.id,
        dueAt: entry.event.dueAt,
        type: entry.event.type,
      })),
    ).toEqual([
      {
        id: `runtime:director:opportunity:${pending.event.id}`,
        dueAt: simTime(70),
        type: "world_director.opportunity",
      },
      {
        id: "runtime:director:review-2",
        dueAt: simTime(3_610),
        type: "world_director.review",
      },
    ]);

    const beforeAlice = await people.get(worldId, asPersonId("alice"));
    const beforeBob = await people.get(worldId, asPersonId("bob"));

    expect(
      await restarted.processThrough({
        worldId,
        through: simTime(70),
        workerId: "director-effect-worker",
        maxEvents: 1,
      }),
    ).toBe(1);

    expect(await people.get(worldId, asPersonId("alice"))).toEqual(beforeAlice);
    expect(await people.get(worldId, asPersonId("bob"))).toEqual(beforeBob);
    expect((await events.list(worldId)).map((event) => event.type)).toEqual([
      "world_director.review_completed",
      "world.opportunity_available",
    ]);
  });

  it("can be disabled without inference or future director work", async () => {
    const worldId = await seed("world-director-disabled");
    const enabled = new CoreWorldRuntime(pool, {
      director: policy,
    });
    await enabled.scheduleInitialDirector(worldId, simTime(5));

    let calls = 0;
    const disabled = new CoreWorldRuntime(pool, {
      director: { enabled: false },
      directorProvider:
        new DeterministicTraceableCognitiveProvider<WorldDirectorCognitionContext>({
          strategy: () => {
            calls += 1;
            throw new Error("disabled Director inferred");
          },
        }),
    });

    expect(
      await disabled.processThrough({
        worldId,
        through: simTime(5),
        workerId: "director-disabled-worker",
        maxEvents: 1,
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(await schedules.loadPending(worldId)).toEqual([]);
    expect((await events.list(worldId)).map((event) => event.type)).toEqual([
      "world_director.review_skipped",
    ]);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cognition_runs WHERE world_id = $1",
      [worldId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });
});
