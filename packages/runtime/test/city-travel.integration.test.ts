import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresDomainEventRepository,
  PostgresPersonRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  asPersonId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { CoreWorldRuntime } from "../src/index.ts";

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

describe("hierarchical city travel runtime", () => {
  it("restarts cleanly and completes scheduled room-to-room travel", async () => {
    const worldId = asWorldId("runtime-city-travel");
    const personId = asPersonId("alice");
    await worlds.create(worldId);
    await people.create({
      worldId,
      person: person("alice"),
      at: simTime(0),
    });

    const seedRuntime = new CoreWorldRuntime(pool);
    await seedRuntime.city.seedTopology({
      worldId,
      nodes: [
        { id: "building-home", kind: "building", label: "Home" },
        {
          id: "room-home",
          kind: "room",
          parentId: "building-home",
          label: "Home room",
        },
        { id: "street-main", kind: "street", label: "Main street" },
        { id: "building-work", kind: "building", label: "Work" },
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
    });
    await spatial.place({
      worldId,
      personId,
      roomId: "room-home",
      x: 1,
      y: 1,
      z: 0,
      facing: "E",
      at: simTime(0),
    });

    await seedRuntime.planTravel({
      worldId,
      travelId: "commute-1",
      personId,
      destinationRoomId: "room-work",
      departAt: simTime(10),
    });

    const restartedPool = new Pool();
    try {
      const restarted = new CoreWorldRuntime(restartedPool);
      expect(
        await restarted.processThrough({
          worldId,
          through: simTime(70),
          workerId: "city-runtime-worker",
        }),
      ).toBe(2);

      expect(await new PostgresSpatialRepository(restartedPool).get(worldId, personId))
        .toMatchObject({
          roomId: "room-work",
          x: 10,
          y: 10,
          z: 1,
          version: 2n,
        });
      expect(await restarted.city.getTravel(worldId, "commute-1"))
        .toMatchObject({
          status: "arrived",
          version: 2n,
          arriveAt: simTime(70),
        });
    } finally {
      await restartedPool.end();
    }

    expect((await events.list(worldId)).map((event) => event.type)).toEqual([
      "person.travel_departed",
      "person.travel_arrived",
    ]);
    expect((await worlds.get(worldId))?.currentSimTime).toBe(simTime(70));
  });
});
