import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresCitySpatialRepository,
  PostgresLedgerRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  asLedgerAccountId,
  asPersonId,
  asWorldId,
} from "@hobbo/domain";
import { Pool } from "pg";
import {
  DEFAULT_NEIGHBORHOOD_WORLD_ID,
  NEIGHBORHOOD_PLAYER_ID,
  NEIGHBORHOOD_ROOM_IDS,
  seedIntegratedNeighborhood,
} from "../src/neighborhood-fixture.ts";
import { createHobboServer } from "../src/app.ts";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const pool = new Pool();

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("integrated neighborhood fixture", () => {
  it("seeds one reproducible authoritative neighborhood through production repositories", async () => {
    const seeded = await seedIntegratedNeighborhood(pool);
    expect(seeded.worldId).toBe(DEFAULT_NEIGHBORHOOD_WORLD_ID);
    expect(seeded.playerId).toBe(NEIGHBORHOOD_PLAYER_ID);
    expect(seeded.residentIds).toHaveLength(4);
    expect(seeded.autonomousIds).toHaveLength(3);

    const worlds = new PostgresWorldRepository(pool);
    expect(await worlds.get(seeded.worldId)).toMatchObject({
      currentSimTime: 0n,
    });

    const city = new PostgresCitySpatialRepository(pool);
    const topology = await city.loadTopology(seeded.worldId);
    expect(topology.nodes.map((node) => node.id)).toEqual([
      "building-cafe",
      "building-residential",
      "room-cafe",
      "room-flat-a",
      "room-flat-b",
      "street-main",
    ]);
    expect(topology.connections).toHaveLength(5);
    expect(await city.getRoomGrid(
      seeded.worldId,
      NEIGHBORHOOD_ROOM_IDS.cafe,
    )).toMatchObject({
      bounds: {
        roomId: NEIGHBORHOOD_ROOM_IDS.cafe,
        minX: 20,
        maxX: 27,
        minY: 0,
        maxY: 7,
        z: 0,
      },
      blockedTiles: [{ x: 24, y: 3, z: 0 }],
    });
    expect(await city.listResources(
      seeded.worldId,
      NEIGHBORHOOD_ROOM_IDS.cafe,
    )).toEqual([
      expect.objectContaining({
        id: "cafe-table",
        kind: "seat",
        capacity: 4,
      }),
    ]);

    const spatial = new PostgresSpatialRepository(pool);
    expect(
      await spatial.get(seeded.worldId, asPersonId("resident-alex")),
    ).toMatchObject({
      roomId: "room-flat-a",
      x: 2,
      y: 2,
      z: 0,
      facing: "E",
    });
    expect(await spatial.listRoom(
      seeded.worldId,
      NEIGHBORHOOD_ROOM_IDS.flatB,
    )).toHaveLength(3);

    const ledger = new PostgresLedgerRepository(pool);
    expect(
      await ledger.getBalance(
        seeded.worldId,
        asLedgerAccountId("neighborhood-cafe-wallet"),
      ),
    ).toBe(100_000n);
    expect(
      await ledger.getBalance(
        seeded.worldId,
        asLedgerAccountId("wallet:resident-alex"),
      ),
    ).toBe(10_000n);

    const counts = await pool.query<{
      persons: string;
      employments: string;
      tenancies: string;
      beliefs: string;
      memories: string;
      pending: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM persons WHERE world_id = $1) AS persons,
         (SELECT count(*)::text FROM employments WHERE world_id = $1) AS employments,
         (SELECT count(*)::text FROM tenancies WHERE world_id = $1) AS tenancies,
         (SELECT count(*)::text FROM beliefs WHERE world_id = $1) AS beliefs,
         (SELECT count(*)::text FROM memories WHERE world_id = $1) AS memories,
         (SELECT count(*)::text FROM scheduled_events WHERE world_id = $1 AND status = 'pending') AS pending`,
      [seeded.worldId],
    );
    expect(counts.rows[0]).toMatchObject({
      persons: "4",
      employments: "4",
      tenancies: "4",
      beliefs: "3",
      memories: "3",
    });
    expect(Number(counts.rows[0]?.pending ?? "0")).toBeGreaterThan(10);

    await expect(seedIntegratedNeighborhood(pool)).rejects.toThrow(
      /already exists/i,
    );
  });

  it("is immediately consumable by the authoritative HTTP server", async () => {
    const worldId = asWorldId("integrated-neighborhood-server");
    const seeded = await seedIntegratedNeighborhood(pool, { worldId });
    const server = createHobboServer({ pool, rooms: [] });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const topologyResponse = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/topology`,
      );
      expect(topologyResponse.status).toBe(200);
      expect(await topologyResponse.json()).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "room-flat-a", kind: "room" }),
          expect.objectContaining({ id: "room-cafe", kind: "room" }),
        ]),
      });

      const playerResponse = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/persons/${seeded.playerId}/spatial`,
      );
      expect(playerResponse.status).toBe(200);
      expect(await playerResponse.json()).toMatchObject({
        state: {
          personId: "resident-alex",
          roomId: "room-flat-a",
          x: 2,
          y: 2,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
