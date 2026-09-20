import { once } from "node:events";
import type { AddressInfo } from "node:net";
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
import type { RealtimeServerMessage } from "@hobbo/realtime";
import { SPATIAL_MOVE_ACTION_ID } from "@hobbo/spatial";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createHobboServer } from "../src/app.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const people = new PostgresPersonRepository(pool);
const spatial = new PostgresSpatialRepository(pool);
const events = new PostgresDomainEventRepository(pool);

const room = {
  roomId: "fixture-room",
  minX: 0,
  maxX: 4,
  minY: 0,
  maxY: 4,
  z: 0,
} as const;

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
        reject(new Error("Timed out waiting for realtime message"));
      }, 5_000);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }
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

function roomStateFor(
  inbox: Inbox,
  personId: string,
  x: number,
  y: number,
): Promise<RealtimeServerMessage> {
  return inbox.take(
    (message) =>
      message.type === "room.state" &&
      message.people.some(
        (person) =>
          person.personId === personId &&
          person.x === x &&
          person.y === y,
      ),
  );
}

describe("authoritative realtime server", () => {
  it("converges two clients and preserves idempotency across reconnect", async () => {
    const worldId = asWorldId("realtime-world");
    const aliceId = asPersonId("alice");
    const bobId = asPersonId("bob");

    await worlds.create(worldId);
    await people.create({ worldId, person: person("alice"), at: simTime(0) });
    await people.create({ worldId, person: person("bob"), at: simTime(0) });
    await spatial.place({
      worldId,
      personId: aliceId,
      roomId: room.roomId,
      x: 1,
      y: 1,
      z: 0,
      facing: "S",
      at: simTime(0),
    });
    await spatial.place({
      worldId,
      personId: bobId,
      roomId: room.roomId,
      x: 3,
      y: 1,
      z: 0,
      facing: "W",
      at: simTime(0),
    });

    const server = createHobboServer({ pool, rooms: [room] });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `ws://127.0.0.1:${port}/realtime?worldId=${worldId}&roomId=${room.roomId}`;

    let alice = await openClient(`${base}&personId=alice`);
    const bob = await openClient(`${base}&personId=bob`);

    try {
      await alice.inbox.take((message) => message.type === "session.ready");
      await bob.inbox.take((message) => message.type === "session.ready");
      await roomStateFor(alice.inbox, "alice", 1, 1);
      await roomStateFor(bob.inbox, "alice", 1, 1);

      alice.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "alice-east",
          actionId: String(SPATIAL_MOVE_ACTION_ID),
          input: { dx: 1, dy: 0 },
        }),
      );
      const aliceResult = await alice.inbox.take(
        (message) =>
          message.type === "player.action_result" &&
          message.requestId === "alice-east",
      );
      expect(aliceResult).toMatchObject({
        type: "player.action_result",
        ok: true,
        replayed: false,
        state: { personId: "alice", x: 2, y: 1, facing: "E", version: "1" },
      });

      const [aliceView, bobView] = await Promise.all([
        roomStateFor(alice.inbox, "alice", 2, 1),
        roomStateFor(bob.inbox, "alice", 2, 1),
      ]);
      expect(aliceView).toEqual(bobView);

      bob.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "bob-south",
          actionId: String(SPATIAL_MOVE_ACTION_ID),
          input: { dx: 0, dy: 1 },
        }),
      );
      await bob.inbox.take(
        (message) =>
          message.type === "player.action_result" &&
          message.requestId === "bob-south" &&
          message.ok,
      );
      const [aliceAfterBob, bobAfterBob] = await Promise.all([
        roomStateFor(alice.inbox, "bob", 3, 2),
        roomStateFor(bob.inbox, "bob", 3, 2),
      ]);
      expect(aliceAfterBob).toEqual(bobAfterBob);

      bob.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "bad-action",
          actionId: "spatial.teleport",
          input: {},
        }),
      );
      expect(
        await bob.inbox.take(
          (message) =>
            message.type === "player.action_result" &&
            message.requestId === "bad-action",
        ),
      ).toMatchObject({
        type: "player.action_result",
        ok: false,
        code: "unknown_action",
      });

      await closeClient(alice.socket);
      alice = await openClient(`${base}&personId=alice`);
      await alice.inbox.take((message) => message.type === "session.ready");
      await roomStateFor(alice.inbox, "bob", 3, 2);

      alice.socket.send(
        JSON.stringify({
          type: "player.action",
          requestId: "alice-east",
          actionId: String(SPATIAL_MOVE_ACTION_ID),
          input: { dx: 1, dy: 0 },
        }),
      );
      expect(
        await alice.inbox.take(
          (message) =>
            message.type === "player.action_result" &&
            message.requestId === "alice-east",
        ),
      ).toMatchObject({
        type: "player.action_result",
        ok: true,
        replayed: true,
        state: { personId: "alice", x: 2, y: 1, version: "1" },
      });

      expect(await spatial.get(worldId, aliceId)).toMatchObject({
        x: 2,
        y: 1,
        version: 1n,
      });
      expect(await spatial.get(worldId, bobId)).toMatchObject({
        x: 3,
        y: 2,
        version: 1n,
      });
      expect(await events.list(worldId)).toHaveLength(2);

      const response = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/rooms/${room.roomId}/state`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        type: "room.state",
        people: [
          { personId: "alice", x: 2, y: 1 },
          { personId: "bob", x: 3, y: 2 },
        ],
      });

      const rejectedPost = await fetch(
        `http://127.0.0.1:${port}/api/worlds/${worldId}/rooms/${room.roomId}/state`,
        { method: "POST" },
      );
      expect(rejectedPost.status).toBe(405);
    } finally {
      await closeClient(alice.socket);
      await closeClient(bob.socket);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
