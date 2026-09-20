import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  createEnergyState,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresPersonRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  asPersonId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import type { RealtimeServerMessage } from "@hobbo/realtime";
import { CoreWorldRuntime } from "@hobbo/runtime";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createHobboServer } from "../src/app.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const spatial = new PostgresSpatialRepository(pool);

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

class Inbox {
  readonly #queue: RealtimeServerMessage[] = [];
  readonly #waiters: Array<{
    predicate: (message: RealtimeServerMessage) => boolean;
    resolve: (message: RealtimeServerMessage) => void;
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
        reject(new Error("Timed out waiting for realtime message"));
      }, 5_000);
      this.#waiters.push({ predicate, resolve, timer });
    });
  }
}

async function open(url: string): Promise<{
  readonly socket: WebSocket;
  readonly inbox: Inbox;
}> {
  const socket = new WebSocket(url);
  const inbox = new Inbox(socket);
  await once(socket, "open");
  return { socket, inbox };
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await once(socket, "close");
}

describe("authoritative city realtime binding", () => {
  it("binds reconnect to PostgreSQL room state after durable travel", async () => {
    const worldId = asWorldId("city-realtime-world");
    const personId = asPersonId("alice");
    await worlds.create(worldId);
    await people.create({ worldId, person: person("alice"), at: simTime(0) });

    const runtime = new CoreWorldRuntime(pool);
    await runtime.city.seedTopology({
      worldId,
      nodes: [
        { id: "building-home", kind: "building", label: "Home" },
        { id: "room-home", kind: "room", parentId: "building-home", label: "Home room" },
        { id: "street-main", kind: "street", label: "Main street" },
        { id: "building-work", kind: "building", label: "Work" },
        { id: "room-work", kind: "room", parentId: "building-work", label: "Work room" },
      ],
      connections: [
        { id: "home-door", fromNodeId: "room-home", toNodeId: "building-home", travelSeconds: 5, bidirectional: true },
        { id: "home-street", fromNodeId: "building-home", toNodeId: "street-main", travelSeconds: 20, bidirectional: true },
        { id: "street-work", fromNodeId: "street-main", toNodeId: "building-work", travelSeconds: 30, bidirectional: true },
        { id: "work-door", fromNodeId: "building-work", toNodeId: "room-work", travelSeconds: 5, bidirectional: true },
      ],
      rooms: [
        { bounds: { roomId: "room-home", minX: 0, maxX: 4, minY: 0, maxY: 4, z: 0 } },
        { bounds: { roomId: "room-work", minX: 10, maxX: 14, minY: 10, maxY: 14, z: 1 } },
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

    const server = createHobboServer({ pool, rooms: [] });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `ws://127.0.0.1:${port}/realtime?worldId=${worldId}&personId=alice`;

    let client = await open(base);
    try {
      expect(
        await client.inbox.take(
          (message) => message.type === "session.ready",
        ),
      ).toMatchObject({
        type: "session.ready",
        roomId: "room-home",
      });

      const topologyResponse = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/topology`,
      );
      expect(topologyResponse.status).toBe(200);
      expect(await topologyResponse.json()).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "room-home", kind: "room" }),
          expect.objectContaining({ id: "street-main", kind: "street" }),
          expect.objectContaining({ id: "room-work", kind: "room" }),
        ]),
      });

      client.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "realtime-trip",
          actionId: "spatial.travel",
          input: { destinationRoomId: "room-work" },
        }),
      );
      expect(
        await client.inbox.take(
          (message) =>
            message.type === "player.travel_planned" &&
            message.requestId === "realtime-trip",
        ),
      ).toMatchObject({
        type: "player.travel_planned",
        travelId: "realtime-trip",
        destinationRoomId: "room-work",
        departAt: "0",
        arriveAt: "60",
        status: "planned",
      });

      await runtime.processThrough({
        worldId,
        through: simTime(60),
        workerId: "city-realtime-worker",
      });

      const spatialResponse = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/persons/alice/spatial`,
      );
      expect(spatialResponse.status).toBe(200);
      expect(await spatialResponse.json()).toMatchObject({
        state: {
          personId: "alice",
          roomId: "room-work",
          x: 10,
          y: 10,
          z: 1,
        },
      });

      await close(client.socket);
      client = await open(base);
      expect(
        await client.inbox.take(
          (message) => message.type === "session.ready",
        ),
      ).toMatchObject({
        type: "session.ready",
        roomId: "room-work",
      });
      expect(
        await client.inbox.take(
          (message) =>
            message.type === "room.state" &&
            message.roomId === "room-work",
        ),
      ).toMatchObject({
        type: "room.state",
        roomId: "room-work",
        people: [
          expect.objectContaining({
            personId: "alice",
            x: 10,
            y: 10,
            z: 1,
          }),
        ],
      });

      client.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "realtime-trip",
          actionId: "spatial.travel",
          input: { destinationRoomId: "room-work" },
        }),
      );
      expect(
        await client.inbox.take(
          (message) =>
            message.type === "player.travel_planned" &&
            message.requestId === "realtime-trip",
        ),
      ).toMatchObject({
        type: "player.travel_planned",
        travelId: "realtime-trip",
        destinationRoomId: "room-work",
        departAt: "0",
        arriveAt: "60",
        status: "arrived",
      });
      expect(await runtime.city.getTravel(worldId, "realtime-trip"))
        .toMatchObject({
          status: "arrived",
          version: 2n,
        });
    } finally {
      await close(client.socket);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
