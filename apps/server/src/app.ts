import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  PostgresCitySpatialRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
  type PersistedSpatialState,
  type PlayerActionResult,
} from "@hobbo/database";
import {
  DomainInvariantError,
  asActionId,
  asPersonId,
  asWorldId,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import {
  RealtimeProtocolError,
  encodeRealtimeMessage,
  parseRealtimeClientMessage,
  type PlayerActionResultMessage,
  type RealtimeErrorMessage,
  type RealtimeServerMessage,
  type RoomStateMessage,
  type WireSpatialState,
} from "@hobbo/realtime";
import {
  SPATIAL_TRAVEL_ACTION_ID,
  isTravelActionInput,
  type RoomBounds,
} from "@hobbo/spatial";
import type { Pool } from "pg";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

export interface HobboServerOptions {
  readonly pool: Pool;
  readonly rooms: readonly RoomBounds[];
}

interface ParsedRealtimeSession {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly requestedRoomId?: string;
}

interface RealtimeSession {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  roomId: string;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", "*");
  response.end(JSON.stringify(body));
}

function roomKey(worldId: WorldId, roomId: string): string {
  return `${worldId}\u0000${roomId}`;
}

function wireState(state: PersistedSpatialState): WireSpatialState {
  return {
    personId: state.personId,
    roomId: state.roomId,
    x: state.x,
    y: state.y,
    z: state.z,
    facing: state.facing,
    version: state.version.toString(),
  };
}

function send(socket: WebSocket, message: RealtimeServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(encodeRealtimeMessage(message));
  }
}

function protocolError(
  error: unknown,
  requestId?: string,
): RealtimeErrorMessage {
  if (error instanceof RealtimeProtocolError) {
    return {
      type: "error",
      code: error.code,
      message: error.message,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  if (error instanceof DomainInvariantError) {
    return {
      type: "error",
      code: "domain_conflict",
      message: error.message,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  return {
    type: "error",
    code: "internal_error",
    message: "Realtime action failed",
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function parseSession(request: IncomingMessage): ParsedRealtimeSession | undefined {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/realtime") return undefined;

  const worldId = url.searchParams.get("worldId");
  const personId = url.searchParams.get("personId");
  const roomId = url.searchParams.get("roomId");
  if (
    worldId === null ||
    worldId.trim().length === 0 ||
    personId === null ||
    personId.trim().length === 0
  ) {
    return undefined;
  }
  if (roomId !== null && roomId.trim().length === 0) {
    return undefined;
  }

  return {
    worldId: asWorldId(worldId),
    personId: asPersonId(personId),
    ...(roomId === null ? {} : { requestedRoomId: roomId }),
  };
}

export function createHobboServer(options: HobboServerOptions): Server {
  const spatial = new PostgresSpatialRepository(options.pool);
  const city = new PostgresCitySpatialRepository(options.pool);
  const worlds = new PostgresWorldRepository(options.pool);
  const roomBounds = new Map(
    options.rooms.map((room) => [room.roomId, room] as const),
  );
  const subscriptions = new Map<string, Set<WebSocket>>();
  const wss = new WebSocketServer({ noServer: true });

  async function resolveRoomNavigation(
    worldId: WorldId,
    roomId: string,
  ): Promise<
    | {
        readonly bounds: RoomBounds;
        readonly blockedTiles: readonly {
          readonly x: number;
          readonly y: number;
          readonly z: number;
        }[];
      }
    | undefined
  > {
    const configured = roomBounds.get(roomId);
    if (configured !== undefined) {
      return { bounds: configured, blockedTiles: [] };
    }
    const grid = await city.getRoomGrid(worldId, roomId);
    if (grid === undefined) return undefined;
    return {
      bounds: grid.bounds,
      blockedTiles: grid.blockedTiles,
    };
  }

  function subscribe(socket: WebSocket, session: RealtimeSession): void {
    const key = roomKey(session.worldId, session.roomId);
    let sockets = subscriptions.get(key);
    if (sockets === undefined) {
      sockets = new Set<WebSocket>();
      subscriptions.set(key, sockets);
    }
    sockets.add(socket);
  }

  function unsubscribe(socket: WebSocket, session: RealtimeSession): void {
    const key = roomKey(session.worldId, session.roomId);
    const sockets = subscriptions.get(key);
    sockets?.delete(socket);
    if (sockets?.size === 0) subscriptions.delete(key);
  }

  async function roomMessage(
    worldId: WorldId,
    roomId: string,
  ): Promise<RoomStateMessage> {
    const [world, people] = await Promise.all([
      worlds.get(worldId),
      spatial.listRoom(worldId, roomId),
    ]);
    if (world === undefined) {
      throw new DomainInvariantError(`World does not exist: ${worldId}`);
    }
    return {
      type: "room.state",
      worldId: String(worldId),
      roomId,
      simTime: world.currentSimTime.toString(),
      people: people.map(wireState),
    };
  }

  async function broadcastRoom(
    worldId: WorldId,
    roomId: string,
  ): Promise<void> {
    const sockets = subscriptions.get(roomKey(worldId, roomId));
    if (sockets === undefined || sockets.size === 0) return;
    const message = await roomMessage(worldId, roomId);
    for (const socket of sockets) send(socket, message);
  }

  function actionResultMessage(
    result: PlayerActionResult,
  ): PlayerActionResultMessage {
    if (!result.ok) {
      return {
        type: "player.action_result",
        requestId: result.requestId,
        ok: false,
        code: result.code,
        message: result.message,
      };
    }
    return {
      type: "player.action_result",
      requestId: result.requestId,
      ok: true,
      replayed: result.replayed,
      eventId: result.eventId,
      simTime: result.simTime.toString(),
      state: wireState(result.state),
    };
  }

  async function handleMessage(
    socket: WebSocket,
    session: RealtimeSession,
    raw: RawData,
  ): Promise<void> {
    let requestId: string | undefined;
    try {
      const message = parseRealtimeClientMessage(raw.toString());
      requestId = message.requestId;

      const authoritative = await spatial.get(session.worldId, session.personId);
      if (authoritative === undefined) {
        throw new DomainInvariantError(
          `Spatial state does not exist for person ${session.personId}`,
        );
      }
      if (authoritative.roomId.startsWith("__transit__:")) {
        throw new DomainInvariantError(
          `Person ${session.personId} is currently in transit`,
        );
      }
      if (authoritative.roomId !== session.roomId) {
        unsubscribe(socket, session);
        session.roomId = authoritative.roomId;
        const rebound = await resolveRoomNavigation(
          session.worldId,
          session.roomId,
        );
        if (rebound === undefined) {
          throw new DomainInvariantError(
            `Authoritative room has no active-area bounds: ${session.roomId}`,
          );
        }
        subscribe(socket, session);
        send(socket, {
          type: "session.ready",
          worldId: String(session.worldId),
          personId: String(session.personId),
          roomId: session.roomId,
        });
        send(socket, await roomMessage(session.worldId, session.roomId));
      }

      if (message.actionId === String(SPATIAL_TRAVEL_ACTION_ID)) {
        if (!isTravelActionInput(message.input)) {
          throw new RealtimeProtocolError(
            "invalid_message",
            "spatial.travel requires a non-empty destinationRoomId",
          );
        }
        const travel = await city.planTravel({
          worldId: session.worldId,
          travelId: message.requestId,
          personId: session.personId,
          destinationRoomId: message.input.destinationRoomId,
          origin: "player",
        });
        send(socket, {
          type: "player.travel_planned",
          requestId: message.requestId,
          travelId: travel.id,
          destinationRoomId: travel.destinationRoomId,
          departAt: travel.departAt.toString(),
          arriveAt: travel.arriveAt.toString(),
          status: travel.status,
        });
        return;
      }

      const navigation = await resolveRoomNavigation(
        session.worldId,
        session.roomId,
      );
      if (navigation === undefined) {
        throw new DomainInvariantError(
          `Realtime room is not configured: ${session.roomId}`,
        );
      }

      const result = await spatial.applyPlayerAction({
        worldId: session.worldId,
        personId: session.personId,
        requestId: message.requestId,
        actionId: asActionId(message.actionId),
        input: message.input,
        roomBounds: navigation.bounds,
        blockedTiles: navigation.blockedTiles,
      });
      send(socket, actionResultMessage(result));
      if (result.ok) {
        await broadcastRoom(session.worldId, session.roomId);
      }
    } catch (error) {
      send(socket, protocolError(error, requestId));
    }
  }

  async function acceptConnection(
    socket: WebSocket,
    parsed: ParsedRealtimeSession,
  ): Promise<void> {
    try {
      const state = await spatial.get(parsed.worldId, parsed.personId);
      if (state === undefined || state.roomId.startsWith("__transit__:")) {
        socket.close(1008, "person is not placed in an active room");
        return;
      }
      if (
        parsed.requestedRoomId !== undefined &&
        parsed.requestedRoomId !== state.roomId
      ) {
        socket.close(1008, "requested room does not match authoritative room");
        return;
      }
      const navigation = await resolveRoomNavigation(
        parsed.worldId,
        state.roomId,
      );
      if (navigation === undefined) {
        socket.close(1008, "room not configured");
        return;
      }

      const session: RealtimeSession = {
        worldId: parsed.worldId,
        personId: parsed.personId,
        roomId: state.roomId,
      };
      subscribe(socket, session);
      socket.once("close", () => {
        unsubscribe(socket, session);
      });
      socket.on("message", (raw) => {
        void handleMessage(socket, session, raw);
      });

      send(socket, {
        type: "session.ready",
        worldId: String(session.worldId),
        personId: String(session.personId),
        roomId: session.roomId,
      });
      send(socket, await roomMessage(session.worldId, session.roomId));
    } catch {
      socket.close(1011, "session initialization failed");
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");

      if (method !== "GET") {
        response.setHeader("allow", "GET");
        json(response, 405, { error: "method_not_allowed" });
        return;
      }

      if (url.pathname === "/health") {
        json(response, 200, { ok: true });
        return;
      }

      const topologyMatch = /^\/api\/worlds\/([^/]+)\/topology$/.exec(
        url.pathname,
      );
      if (topologyMatch !== null) {
        const worldPart = topologyMatch[1];
        if (worldPart === undefined) {
          json(response, 400, { error: "invalid_path" });
          return;
        }
        json(
          response,
          200,
          await city.loadTopology(asWorldId(decodeURIComponent(worldPart))),
        );
        return;
      }

      const personSpatialMatch =
        /^\/api\/worlds\/([^/]+)\/persons\/([^/]+)\/spatial$/.exec(
          url.pathname,
        );
      if (personSpatialMatch !== null) {
        const worldPart = personSpatialMatch[1];
        const personPart = personSpatialMatch[2];
        if (worldPart === undefined || personPart === undefined) {
          json(response, 400, { error: "invalid_path" });
          return;
        }
        const worldId = asWorldId(decodeURIComponent(worldPart));
        const personId = asPersonId(decodeURIComponent(personPart));
        const state = await spatial.get(worldId, personId);
        if (state === undefined) {
          json(response, 404, { error: "not_found" });
          return;
        }
        json(response, 200, {
          worldId: String(worldId),
          state: wireState(state),
        });
        return;
      }

      const match = /^\/api\/worlds\/([^/]+)\/rooms\/([^/]+)\/state$/.exec(
        url.pathname,
      );
      if (match !== null) {
        const worldPart = match[1];
        const roomPart = match[2];
        if (worldPart === undefined || roomPart === undefined) {
          json(response, 400, { error: "invalid_path" });
          return;
        }
        try {
          json(
            response,
            200,
            await roomMessage(
              asWorldId(decodeURIComponent(worldPart)),
              decodeURIComponent(roomPart),
            ),
          );
        } catch (error) {
          if (error instanceof DomainInvariantError) {
            json(response, 404, { error: "not_found", message: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      json(response, 404, { error: "not_found" });
    })().catch(() => {
      if (!response.headersSent) {
        json(response, 500, { error: "internal_error" });
      } else {
        response.end();
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const session = parseSession(request);
    if (session === undefined) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      void acceptConnection(webSocket, session);
    });
  });

  server.once("close", () => {
    for (const sockets of subscriptions.values()) {
      for (const socket of sockets) socket.close(1001, "server closing");
    }
    subscriptions.clear();
    wss.close();
  });

  return server;
}
