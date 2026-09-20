import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_HOUR,
  asPersonId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import type { RealtimeServerMessage } from "@hobbo/realtime";
import { CoreWorldRuntime } from "@hobbo/runtime";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createHobboServer } from "../src/app.ts";
import {
  NEIGHBORHOOD_PLAYER_ID,
  seedIntegratedNeighborhood,
} from "../src/neighborhood-fixture.ts";

class Inbox {
  readonly #queue: RealtimeServerMessage[] = [];
  readonly #waiters: Array<{
    predicate: (message: RealtimeServerMessage) => boolean;
    resolve: (message: RealtimeServerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as RealtimeServerMessage;
      const index = this.#waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (index >= 0) {
        const waiter = this.#waiters.splice(index, 1)[0];
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return;
        }
      }
      this.#queue.push(message);
    });
  }

  take(
    predicate: (message: RealtimeServerMessage) => boolean,
  ): Promise<RealtimeServerMessage> {
    const index = this.#queue.findIndex(predicate);
    if (index >= 0) {
      const message = this.#queue.splice(index, 1)[0];
      if (message !== undefined) return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Timed out waiting for neighborhood playtest message"));
      }, 5_000);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

async function startServer(pool: Pool): Promise<{
  readonly server: Server;
  readonly port: number;
}> {
  const server = createHobboServer({ pool, rooms: [] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    port: (server.address() as AddressInfo).port,
  };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function openClient(url: string): Promise<{
  readonly socket: WebSocket;
  readonly inbox: Inbox;
}> {
  const socket = new WebSocket(url);
  const inbox = new Inbox(socket);
  await once(socket, "open");
  return { socket, inbox };
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await once(socket, "close");
}

describe("integrated neighborhood playtest", () => {
  it("survives travel, full process restart and a representative 12h life slice", async () => {
    const worldId = asWorldId("integrated-neighborhood-playtest");
    const initialPool = new Pool();
    let initialServer: Server | undefined;
    let initialClient: WebSocket | undefined;

    try {
      await initialPool.query("TRUNCATE worlds CASCADE");
      await seedIntegratedNeighborhood(initialPool, { worldId });
      const initialRuntime = new CoreWorldRuntime(initialPool);
      const started = await startServer(initialPool);
      initialServer = started.server;

      const url =
        `ws://127.0.0.1:${started.port}/realtime?worldId=${worldId}&personId=${NEIGHBORHOOD_PLAYER_ID}`;
      const client = await openClient(url);
      initialClient = client.socket;

      expect(
        await client.inbox.take((message) => message.type === "session.ready"),
      ).toMatchObject({
        type: "session.ready",
        roomId: "room-flat-a",
      });

      client.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "playtest-trip",
          actionId: "spatial.travel",
          input: { destinationRoomId: "room-cafe" },
        }),
      );
      expect(
        await client.inbox.take(
          (message) =>
            message.type === "player.travel_planned" &&
            message.requestId === "playtest-trip",
        ),
      ).toMatchObject({
        type: "player.travel_planned",
        travelId: "playtest-trip",
        destinationRoomId: "room-cafe",
        departAt: "0",
        arriveAt: "60",
        status: "planned",
      });

      await initialRuntime.processThrough({
        worldId,
        through: simTime(60),
        workerId: "neighborhood-pre-restart",
      });

      expect(
        await new PostgresSpatialRepository(initialPool).get(
          worldId,
          NEIGHBORHOOD_PLAYER_ID,
        ),
      ).toMatchObject({
        roomId: "room-cafe",
        x: 20,
        y: 0,
        z: 0,
      });

      await closeClient(client.socket);
      initialClient = undefined;
      await stopServer(started.server);
      initialServer = undefined;
    } finally {
      if (initialClient !== undefined) await closeClient(initialClient);
      if (initialServer !== undefined) await stopServer(initialServer);
      await initialPool.end();
    }

    const freshPool = new Pool();
    let freshServer: Server | undefined;
    let freshClient: WebSocket | undefined;
    try {
      const freshRuntime = new CoreWorldRuntime(freshPool);
      const started = await startServer(freshPool);
      freshServer = started.server;
      const url =
        `ws://127.0.0.1:${started.port}/realtime?worldId=${worldId}&personId=${NEIGHBORHOOD_PLAYER_ID}`;
      const client = await openClient(url);
      freshClient = client.socket;

      expect(
        await client.inbox.take((message) => message.type === "session.ready"),
      ).toMatchObject({
        type: "session.ready",
        roomId: "room-cafe",
      });

      client.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "playtest-trip",
          actionId: "spatial.travel",
          input: { destinationRoomId: "room-cafe" },
        }),
      );
      expect(
        await client.inbox.take(
          (message) =>
            message.type === "player.travel_planned" &&
            message.requestId === "playtest-trip",
        ),
      ).toMatchObject({
        type: "player.travel_planned",
        travelId: "playtest-trip",
        destinationRoomId: "room-cafe",
        departAt: "0",
        arriveAt: "60",
        status: "arrived",
      });

      await freshRuntime.processThrough({
        worldId,
        through: simTime(BigInt(SIM_HOUR) * 12n),
        workerId: "neighborhood-post-restart",
      });

      const durable = await freshPool.query<{
        salaries: string;
        travels: string;
        conversations: string;
        memories: string;
        meals: string;
        pending: string;
      }>(
        `SELECT
           (SELECT count(*)::text
              FROM ledger_transactions
             WHERE world_id = $1 AND type = 'employment.salary') AS salaries,
           (SELECT count(*)::text
              FROM spatial_travel_intents
             WHERE world_id = $1) AS travels,
           (SELECT count(*)::text
              FROM conversations
             WHERE world_id = $1) AS conversations,
           (SELECT count(*)::text
              FROM memories
             WHERE world_id = $1) AS memories,
           (SELECT coalesce(sum(meals_eaten), 0)::text
              FROM person_physiology
             WHERE world_id = $1) AS meals,
           (SELECT count(*)::text
              FROM scheduled_events
             WHERE world_id = $1 AND status = 'pending') AS pending`,
        [worldId],
      );
      const snapshot = durable.rows[0];
      expect(snapshot).toBeDefined();
      expect(snapshot?.salaries).toBe("4");
      expect(snapshot?.travels).toBe("1");
      expect(Number(snapshot?.conversations ?? "0")).toBeGreaterThan(0);
      expect(Number(snapshot?.memories ?? "0")).toBeGreaterThan(3);
      expect(Number(snapshot?.meals ?? "0")).toBeGreaterThan(0);
      expect(Number(snapshot?.pending ?? "0")).toBeGreaterThan(0);

      expect(
        await new PostgresSpatialRepository(freshPool).get(
          worldId,
          asPersonId("resident-alex"),
        ),
      ).toMatchObject({
        roomId: "room-cafe",
        x: 20,
        y: 0,
        z: 0,
      });

      expect(
        await new PostgresWorldRepository(freshPool).get(worldId),
      ).toMatchObject({
        id: worldId,
      });
    } finally {
      if (freshClient !== undefined) await closeClient(freshClient);
      if (freshServer !== undefined) await stopServer(freshServer);
      await freshPool.end();
    }
  });
});
