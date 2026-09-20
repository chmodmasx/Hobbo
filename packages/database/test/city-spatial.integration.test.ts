import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  asPersonId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  PostgresCitySpatialRepository,
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const spatial = new PostgresSpatialRepository(pool);
const city = new PostgresCitySpatialRepository(pool);
const schedules = new PostgresScheduledEventRepository(pool);
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

async function seedWorld(name: string) {
  const worldId = asWorldId(name);
  const aliceId = asPersonId("alice");
  const bobId = asPersonId("bob");
  await worlds.create(worldId);
  await people.create({ worldId, person: person("alice"), at: simTime(0) });
  await people.create({ worldId, person: person("bob"), at: simTime(0) });

  await city.seedTopology({
    worldId,
    nodes: [
      { id: "building-home", kind: "building", label: "Home building" },
      {
        id: "room-home",
        kind: "room",
        parentId: "building-home",
        label: "Home room",
      },
      { id: "street-main", kind: "street", label: "Main street" },
      { id: "building-work", kind: "building", label: "Work building" },
      {
        id: "room-work",
        kind: "room",
        parentId: "building-work",
        label: "Work room",
      },
    ],
    connections: [
      {
        id: "home-door",
        fromNodeId: "room-home",
        toNodeId: "building-home",
        travelSeconds: 5,
        bidirectional: true,
      },
      {
        id: "home-street",
        fromNodeId: "building-home",
        toNodeId: "street-main",
        travelSeconds: 20,
        bidirectional: true,
      },
      {
        id: "street-work",
        fromNodeId: "street-main",
        toNodeId: "building-work",
        travelSeconds: 30,
        bidirectional: true,
      },
      {
        id: "work-door",
        fromNodeId: "building-work",
        toNodeId: "room-work",
        travelSeconds: 5,
        bidirectional: true,
      },
    ],
    rooms: [
      {
        bounds: {
          roomId: "room-home",
          minX: 0,
          maxX: 4,
          minY: 0,
          maxY: 4,
          z: 0,
        },
        blockedTiles: [{ x: 2, y: 2, z: 0 }],
      },
      {
        bounds: {
          roomId: "room-work",
          minX: 10,
          maxX: 14,
          minY: 10,
          maxY: 14,
          z: 1,
        },
      },
    ],
    resources: [
      {
        id: "home-bed",
        roomId: "room-home",
        kind: "bed",
        capacity: 1,
        x: 3,
        y: 3,
        z: 0,
      },
    ],
  });

  await spatial.place({
    worldId,
    personId: aliceId,
    roomId: "room-home",
    x: 1,
    y: 1,
    z: 0,
    facing: "S",
    at: simTime(0),
  });
  await spatial.place({
    worldId,
    personId: bobId,
    roomId: "room-home",
    x: 1,
    y: 2,
    z: 0,
    facing: "S",
    at: simTime(0),
  });

  return { worldId, aliceId, bobId };
}

describe("durable hierarchical city spatial substrate", () => {
  it("round-trips topology, room grids and resources", async () => {
    const { worldId } = await seedWorld("city-topology-world");
    const topology = await city.loadTopology(worldId);
    expect(topology.nodes.map((node) => node.id)).toEqual([
      "building-home",
      "building-work",
      "room-home",
      "room-work",
      "street-main",
    ]);
    expect(topology.connections).toHaveLength(4);

    expect(await city.getRoomGrid(worldId, "room-home")).toEqual({
      bounds: {
        roomId: "room-home",
        minX: 0,
        maxX: 4,
        minY: 0,
        maxY: 4,
        z: 0,
      },
      blockedTiles: [{ x: 2, y: 2, z: 0 }],
    });
    expect(await city.listResources(worldId, "room-home")).toEqual([
      expect.objectContaining({
        id: "home-bed",
        kind: "bed",
        capacity: 1,
        enabled: true,
      }),
    ]);
  });

  it("serializes concurrent capacity claims on the same resource", async () => {
    const { worldId, aliceId, bobId } = await seedWorld("city-reservation-world");

    const results = await Promise.allSettled([
      city.reserveResource({
        worldId,
        resourceId: "home-bed",
        reservationId: "bed-alice",
        personId: aliceId,
        at: simTime(0),
      }),
      city.reserveResource({
        worldId,
        resourceId: "home-bed",
        reservationId: "bed-bob",
        personId: bobId,
        at: simTime(0),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected one rejection");
    expect(String(rejected.reason)).toMatch(/capacity/i);
  });

  it("plans a deterministic route and idempotently schedules one departure", async () => {
    const { worldId, aliceId } = await seedWorld("city-plan-world");

    const first = await city.planTravel({
      worldId,
      travelId: "home-to-work",
      personId: aliceId,
      destinationRoomId: "room-work",
      departAt: simTime(10),
    });
    const replay = await new PostgresCitySpatialRepository(pool).planTravel({
      worldId,
      travelId: "home-to-work",
      personId: aliceId,
      destinationRoomId: "room-work",
      departAt: simTime(10),
    });

    expect(first).toMatchObject({
      originRoomId: "room-home",
      destinationRoomId: "room-work",
      route: {
        nodeIds: [
          "room-home",
          "building-home",
          "street-main",
          "building-work",
          "room-work",
        ],
        totalTravelSeconds: 60,
      },
      departAt: simTime(10),
      arriveAt: simTime(70),
      status: "planned",
    });
    expect(replay).toEqual(first);
    expect((await schedules.loadPending(worldId)).map((entry) => entry.event.id))
      .toEqual(["travel:home-to-work:depart"]);
  });

  it("survives repository restart from departure through authoritative arrival", async () => {
    const { worldId, aliceId } = await seedWorld("city-travel-world");
    await city.planTravel({
      worldId,
      travelId: "trip-1",
      personId: aliceId,
      destinationRoomId: "room-work",
      departAt: simTime(10),
    });

    await schedules.claimDue(worldId, simTime(10), "travel-worker-a", 1);
    const restarted = new PostgresCitySpatialRepository(pool);
    const departed = await restarted.departTravelClaimed({
      worldId,
      travelId: "trip-1",
      scheduledEventId: "travel:trip-1:depart" as never,
      workerId: "travel-worker-a",
    });
    expect(departed).toMatchObject({ status: "travelling", version: 1n });
    expect(await spatial.get(worldId, aliceId)).toMatchObject({
      roomId: "__transit__:trip-1",
      version: 1n,
    });

    expect((await schedules.loadPending(worldId)).map((entry) => ({
      id: entry.event.id,
      dueAt: entry.event.dueAt,
    }))).toEqual([
      { id: "travel:trip-1:arrive", dueAt: simTime(70) },
    ]);

    await schedules.claimDue(worldId, simTime(70), "travel-worker-b", 1);
    const arrived = await new PostgresCitySpatialRepository(pool)
      .arriveTravelClaimed({
        worldId,
        travelId: "trip-1",
        scheduledEventId: "travel:trip-1:arrive" as never,
        workerId: "travel-worker-b",
      });

    expect(arrived).toMatchObject({ status: "arrived", version: 2n });
    expect(await spatial.get(worldId, aliceId)).toMatchObject({
      roomId: "room-work",
      x: 10,
      y: 10,
      z: 1,
      version: 2n,
    });
    expect((await events.list(worldId)).map((event) => event.type)).toEqual([
      "person.travel_departed",
      "person.travel_arrived",
    ]);
    expect((await worlds.get(worldId))?.currentSimTime).toBe(simTime(70));
  });

  it("refuses travel when the hierarchy cannot reach the destination", async () => {
    const { worldId, aliceId } = await seedWorld("city-unreachable-world");
    await pool.query(
      `UPDATE spatial_connections
          SET enabled = FALSE
        WHERE world_id = $1 AND id = 'street-work'`,
      [worldId],
    );

    await expect(
      city.planTravel({
        worldId,
        travelId: "blocked-trip",
        personId: aliceId,
        destinationRoomId: "room-work",
        departAt: simTime(10),
      }),
    ).rejects.toThrow(/unreachable_destination/i);
    expect(await schedules.loadPending(worldId)).toEqual([]);
  });
});
