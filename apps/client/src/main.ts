import {
  Application,
  Assets,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import type {
  PlayerActionMessage,
  RealtimeServerMessage,
  RoomStateMessage,
  WireSpatialState,
} from "@hobbo/realtime";
import {
  applyGroundAnchor,
  frameFor,
  projectIsometric,
  sortIsometricRenderables,
  validateSpriteForgeManifest,
  type LogicalPosition,
  type SpriteForgeFrame,
  type SpriteForgeManifest,
} from "@hobbo/rendering";
import { SPATIAL_MOVE_ACTION_ID } from "@hobbo/spatial";
import "./style.css";

const MANIFEST_URL = "/sprite-forge/fixture_manifest.json";
const ASSET_ROOT = "/sprite-forge/";
const GEOMETRY = {
  tileWidth: 96,
  tileHeight: 48,
  elevationHeight: 48,
  originX: 450,
  originY: 180,
} as const;

interface RenderedEntity {
  readonly id: string;
  position: LogicalPosition;
  readonly sprite: Sprite;
}

interface ClientConfig {
  readonly worldId: string;
  readonly personId: string;
  readonly roomId?: string;
  readonly endpoint: string;
}

function requireElement<T extends HTMLElement>(
  selector: string,
): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing client element: ${selector}`);
  }
  return element;
}

function clientConfig(): ClientConfig {
  const params = new URLSearchParams(window.location.search);
  const worldId = params.get("worldId") ?? "playable-world";
  const personId = params.get("personId") ?? "player-alice";
  const roomId = params.get("roomId") ?? undefined;
  const explicit = params.get("server");

  const endpoint =
    explicit === null
      ? new URL(
          `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/realtime`,
        )
      : new URL(explicit);
  endpoint.searchParams.set("worldId", worldId);
  endpoint.searchParams.set("personId", personId);
  if (roomId !== undefined) {
    endpoint.searchParams.set("roomId", roomId);
  }

  return {
    worldId,
    personId,
    ...(roomId === undefined ? {} : { roomId }),
    endpoint: endpoint.toString(),
  };
}

async function loadManifest(): Promise<SpriteForgeManifest> {
  const response = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Sprite Forge manifest request failed: ${response.status} ${response.statusText}`,
    );
  }
  return validateSpriteForgeManifest(await response.json());
}

function subTexture(
  atlas: Texture,
  frame: SpriteForgeFrame,
): Texture {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(
      frame.atlas.x,
      frame.atlas.y,
      frame.atlas.width,
      frame.atlas.height,
    ),
  });
}

function placeSprite(
  sprite: Sprite,
  frame: SpriteForgeFrame,
  position: LogicalPosition,
): void {
  const ground = projectIsometric(position, GEOMETRY);
  const topLeft = applyGroundAnchor(ground, frame);
  sprite.position.set(topLeft.x, topLeft.y);
}

function parseServerMessage(raw: string): RealtimeServerMessage {
  const decoded = JSON.parse(raw) as unknown;
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("type" in decoded) ||
    typeof decoded.type !== "string"
  ) {
    throw new Error("Server returned an invalid realtime message");
  }
  return decoded as RealtimeServerMessage;
}

async function main(): Promise<void> {
  const config = clientConfig();
  const status = requireElement<HTMLSpanElement>("#status");
  const worldLabel = requireElement<HTMLElement>("#world-label");
  const personLabel = requireElement<HTMLElement>("#person-label");
  const roomLabel = requireElement<HTMLElement>("#room-label");
  const worldHost = requireElement<HTMLElement>("#world");
  const moveButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-dx][data-dy]"),
  ];

  worldLabel.textContent = config.worldId;
  personLabel.textContent = config.personId;
  roomLabel.textContent = config.roomId ?? "authoritative";

  const app = new Application();
  await app.init({
    width: 900,
    height: 600,
    backgroundColor: 0x171d25,
    antialias: false,
    resolution: 1,
  });
  worldHost.appendChild(app.canvas);

  const manifest = await loadManifest();
  const atlas = await Assets.load<Texture>(ASSET_ROOT + manifest.atlas.file);
  atlas.source.scaleMode = "nearest";

  const mannequinFrames = new Map(
    manifest.directions.map((direction) => {
      const frame = frameFor(manifest, "mannequin_idle", direction);
      return [
        direction,
        {
          frame,
          texture: subTexture(atlas, frame),
        },
      ] as const;
    }),
  );

  const chairFrame = frameFor(manifest, "chair", "E");
  const chair: RenderedEntity = {
    id: "fixture-chair",
    position: { x: 2, y: 1, z: 0 },
    sprite: new Sprite(subTexture(atlas, chairFrame)),
  };
  placeSprite(chair.sprite, chairFrame, chair.position);
  app.stage.addChild(chair.sprite);

  const renderedPeople = new Map<string, RenderedEntity>();

  function resort(): void {
    const ordered = sortIsometricRenderables([
      chair,
      ...renderedPeople.values(),
    ]);
    for (const entry of ordered) app.stage.addChild(entry.sprite);
  }

  function updatePerson(person: WireSpatialState): void {
    const visual = mannequinFrames.get(person.facing);
    if (visual === undefined) {
      throw new Error(
        `Generated mannequin frame missing for direction ${person.facing}`,
      );
    }

    let rendered = renderedPeople.get(person.personId);
    if (rendered === undefined) {
      rendered = {
        id: `person:${person.personId}`,
        position: { x: person.x, y: person.y, z: person.z },
        sprite: new Sprite(visual.texture),
      };
      renderedPeople.set(person.personId, rendered);
      app.stage.addChild(rendered.sprite);
    } else {
      rendered.position = { x: person.x, y: person.y, z: person.z };
      rendered.sprite.texture = visual.texture;
    }

    placeSprite(rendered.sprite, visual.frame, rendered.position);
  }

  function renderRoom(message: RoomStateMessage): void {
    const present = new Set(message.people.map((person) => person.personId));
    for (const person of message.people) updatePerson(person);

    for (const [personId, rendered] of renderedPeople) {
      if (present.has(personId)) continue;
      app.stage.removeChild(rendered.sprite);
      rendered.sprite.destroy();
      renderedPeople.delete(personId);
    }
    resort();
    status.textContent =
      `connected · sim ${message.simTime} · ${message.people.length} people · atlas ${manifest.atlas.width}×${manifest.atlas.height}`;
  }

  const pending = new Map<string, PlayerActionMessage>();
  let socket: WebSocket | undefined;
  let sessionReady = false;
  let stopped = false;

  function setControls(enabled: boolean): void {
    for (const button of moveButtons) button.disabled = !enabled;
  }

  function flushPending(): void {
    if (
      !sessionReady ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    for (const message of pending.values()) {
      socket.send(JSON.stringify(message));
    }
  }

  function queueMove(dx: -1 | 0 | 1, dy: -1 | 0 | 1): void {
    const requestId = `${config.personId}:${crypto.randomUUID()}`;
    const message: PlayerActionMessage = {
      type: "player.action",
      requestId,
      actionId: String(SPATIAL_MOVE_ACTION_ID),
      input: { dx, dy },
    };
    pending.set(requestId, message);
    flushPending();
  }

  function handleMessage(message: RealtimeServerMessage): void {
    switch (message.type) {
      case "session.ready":
        sessionReady = true;
        roomLabel.textContent = message.roomId;
        setControls(true);
        flushPending();
        return;
      case "room.state":
        renderRoom(message);
        return;
      case "player.action_result":
        pending.delete(message.requestId);
        if (!message.ok) {
          status.textContent =
            `action rejected: ${message.code} · ${message.message}`;
        } else if (message.replayed) {
          status.textContent =
            `request replayed safely · ${message.requestId}`;
        }
        return;
      case "player.travel_planned":
        pending.delete(message.requestId);
        status.textContent =
          `travel ${message.status} · ${message.destinationRoomId} · arrival sim ${message.arriveAt}`;
        return;
      case "error":
        if (
          message.requestId !== undefined &&
          message.code !== "internal_error"
        ) {
          pending.delete(message.requestId);
        }
        status.textContent = `${message.code}: ${message.message}`;
        return;
    }
  }

  function connect(): void {
    if (stopped) return;
    sessionReady = false;
    setControls(false);
    status.textContent = "connecting to authoritative server…";

    const next = new WebSocket(config.endpoint);
    socket = next;

    next.addEventListener("open", () => {
      status.textContent = "socket open · waiting for authoritative session…";
    });
    next.addEventListener("message", (event) => {
      try {
        handleMessage(parseServerMessage(String(event.data)));
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });
    next.addEventListener("close", () => {
      if (socket !== next) return;
      sessionReady = false;
      setControls(false);
      if (!stopped) {
        status.textContent = "disconnected · reconnecting…";
        window.setTimeout(connect, 1_000);
      }
    });
    next.addEventListener("error", () => {
      status.textContent = "realtime socket error";
    });
  }

  for (const button of moveButtons) {
    button.addEventListener("click", () => {
      const dx = Number(button.dataset.dx);
      const dy = Number(button.dataset.dy);
      if (
        (dx === -1 || dx === 0 || dx === 1) &&
        (dy === -1 || dy === 0 || dy === 1) &&
        (dx !== 0 || dy !== 0)
      ) {
        queueMove(dx, dy);
      }
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const movement: Record<string, readonly [-1 | 0 | 1, -1 | 0 | 1]> = {
      ArrowUp: [0, -1],
      w: [0, -1],
      W: [0, -1],
      ArrowRight: [1, 0],
      d: [1, 0],
      D: [1, 0],
      ArrowDown: [0, 1],
      s: [0, 1],
      S: [0, 1],
      ArrowLeft: [-1, 0],
      a: [-1, 0],
      A: [-1, 0],
    };
    const delta = movement[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    queueMove(delta[0], delta[1]);
  });

  window.addEventListener("beforeunload", () => {
    stopped = true;
    socket?.close();
  });

  setControls(false);
  connect();
}

void main().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>("#status");
  if (status !== null) {
    status.textContent =
      error instanceof Error ? error.message : String(error);
  }
  throw error;
});
