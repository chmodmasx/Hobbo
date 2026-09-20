import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  asActionId,
  asPersonId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { SPATIAL_MOVE_ACTION_ID } from "@hobbo/spatial";
import {
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const spatial = new PostgresSpatialRepository(pool);
const events = new PostgresDomainEventRepository(pool);

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

const roomBounds = {
  roomId: "fixture-room",
  minX: 0,
  maxX: 4,
  minY: 0,
  maxY: 4,
  z: 0,
} as const;

async function seed(worldName: string) {
  const worldId = asWorldId(worldName);
  const aliceId = asPersonId("alice");
  const bobId = asPersonId("bob");
  await worlds.create(worldId);
  await people.create({ worldId, person: person("alice"), at: simTime(0) });
  await people.create({ worldId, person: person("bob"), at: simTime(0) });
  await spatial.place({
    worldId,
    personId: aliceId,
    roomId: "fixture-room",
    x: 1,
    y: 1,
    z: 0,
    facing: "S",
    at: simTime(0),
  });
  await spatial.place({
    worldId,
    personId: bobId,
    roomId: "fixture-room",
    x: 3,
    y: 1,
    z: 0,
    facing: "W",
    at: simTime(0),
  });
  return { worldId, aliceId, bobId };
}

describe("durable realtime spatial state", () => {
  it("lists deterministic room state and survives a fresh repository instance", async () => {
    const { worldId, aliceId } = await seed("spatial-room-world");
    expect((await spatial.listRoom(worldId, "fixture-room")).map((p) => p.personId))
      .toEqual(["alice", "bob"]);

    const restartedPool = new Pool();
    try {
      const restarted = new PostgresSpatialRepository(restartedPool);
      expect(await restarted.get(worldId, aliceId)).toMatchObject({
        personId: "alice",
        roomId: "fixture-room",
        x: 1,
        y: 1,
        facing: "S",
        version: 0n,
      });
    } finally {
      await restartedPool.end();
    }
  });

  it("routes player movement through ActionRegistry and persists one causal event", async () => {
    const { worldId, aliceId } = await seed("spatial-move-world");
    const result = await spatial.applyPlayerAction({
      worldId,
      personId: aliceId,
      requestId: "move-1",
      actionId: SPATIAL_MOVE_ACTION_ID,
      input: { dx: 1, dy: 0 },
      roomBounds,
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      state: {
        personId: "alice",
        x: 2,
        y: 1,
        facing: "E",
        version: 1n,
      },
      eventId: "player:move-1",
    });
    expect(await events.list(worldId)).toEqual([
      expect.objectContaining({
        id: "player:move-1",
        type: "person.moved",
        actorId: "alice",
        simTime: simTime(0),
      }),
    ]);
  });

  it("replays an exact request without duplicating movement or history", async () => {
    const { worldId, aliceId } = await seed("spatial-retry-world");
    const input = {
      worldId,
      personId: aliceId,
      requestId: "move-once",
      actionId: SPATIAL_MOVE_ACTION_ID,
      input: { dx: 1, dy: 0 },
      roomBounds,
    } as const;

    const first = await spatial.applyPlayerAction(input);
    const replay = await new PostgresSpatialRepository(pool).applyPlayerAction(input);

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      state: { x: 2, y: 1, version: 1n },
      eventId: "player:move-once",
    });
    expect((await spatial.get(worldId, aliceId))?.version).toBe(1n);
    expect(await events.list(worldId)).toHaveLength(1);
  });

  it("rejects semantic request-id reuse without mutating state", async () => {
    const { worldId, aliceId } = await seed("spatial-conflict-world");
    await spatial.applyPlayerAction({
      worldId,
      personId: aliceId,
      requestId: "same-id",
      actionId: SPATIAL_MOVE_ACTION_ID,
      input: { dx: 1, dy: 0 },
      roomBounds,
    });

    await expect(
      spatial.applyPlayerAction({
        worldId,
        personId: aliceId,
        requestId: "same-id",
        actionId: SPATIAL_MOVE_ACTION_ID,
        input: { dx: 0, dy: 1 },
        roomBounds,
      }),
    ).rejects.toThrow(/reused with different semantics/i);

    expect(await spatial.get(worldId, aliceId)).toMatchObject({
      x: 2,
      y: 1,
      version: 1n,
    });
    expect(await events.list(worldId)).toHaveLength(1);
  });

  it("rejects unknown and out-of-bounds actions before mutation", async () => {
    const { worldId, aliceId } = await seed("spatial-invalid-world");

    await expect(
      spatial.applyPlayerAction({
        worldId,
        personId: aliceId,
        requestId: "unknown",
        actionId: asActionId("spatial.teleport"),
        input: {},
        roomBounds,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unknown_action",
    });

    await spatial.applyPlayerAction({
      worldId,
      personId: aliceId,
      requestId: "move-west",
      actionId: SPATIAL_MOVE_ACTION_ID,
      input: { dx: -1, dy: 0 },
      roomBounds,
    });

    await expect(
      spatial.applyPlayerAction({
        worldId,
        personId: aliceId,
        requestId: "outside",
        actionId: SPATIAL_MOVE_ACTION_ID,
        input: { dx: -1, dy: 0 },
        roomBounds,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "out_of_bounds",
    });

    expect(await spatial.get(worldId, aliceId)).toMatchObject({
      x: 0,
      y: 1,
      version: 1n,
    });
    expect(await events.list(worldId)).toHaveLength(1);
  });

  it("serializes concurrent moves for the same person without lost updates", async () => {
    const { worldId, aliceId } = await seed("spatial-concurrent-world");

    const [east, south] = await Promise.all([
      spatial.applyPlayerAction({
        worldId,
        personId: aliceId,
        requestId: "concurrent-east",
        actionId: SPATIAL_MOVE_ACTION_ID,
        input: { dx: 1, dy: 0 },
        roomBounds,
      }),
      spatial.applyPlayerAction({
        worldId,
        personId: aliceId,
        requestId: "concurrent-south",
        actionId: SPATIAL_MOVE_ACTION_ID,
        input: { dx: 0, dy: 1 },
        roomBounds,
      }),
    ]);

    expect(east.ok && south.ok).toBe(true);
    expect(await spatial.get(worldId, aliceId)).toMatchObject({
      x: 2,
      y: 2,
      version: 2n,
    });
    expect(await events.list(worldId)).toHaveLength(2);
  });
});
