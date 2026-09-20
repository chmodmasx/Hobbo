import type { SpatialDirection } from "@hobbo/spatial";

export interface PlayerActionMessage {
  readonly type: "player.action";
  readonly requestId: string;
  readonly actionId: string;
  readonly input: unknown;
}

export type RealtimeClientMessage = PlayerActionMessage;

export interface WireSpatialState {
  readonly personId: string;
  readonly roomId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: SpatialDirection;
  readonly version: string;
}

export interface SessionReadyMessage {
  readonly type: "session.ready";
  readonly worldId: string;
  readonly personId: string;
  readonly roomId: string;
}

export interface RoomStateMessage {
  readonly type: "room.state";
  readonly worldId: string;
  readonly roomId: string;
  readonly simTime: string;
  readonly people: readonly WireSpatialState[];
}

export type PlayerActionResultMessage =
  | {
      readonly type: "player.action_result";
      readonly requestId: string;
      readonly ok: true;
      readonly replayed: boolean;
      readonly eventId: string;
      readonly simTime: string;
      readonly state: WireSpatialState;
    }
  | {
      readonly type: "player.action_result";
      readonly requestId: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export interface RealtimeErrorMessage {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

export type RealtimeServerMessage =
  | SessionReadyMessage
  | RoomStateMessage
  | PlayerActionResultMessage
  | RealtimeErrorMessage;

export class RealtimeProtocolError extends Error {
  override readonly name = "RealtimeProtocolError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RealtimeProtocolError(
      "invalid_message",
      "Realtime message must be a JSON object",
    );
  }
  return value as Record<string, unknown>;
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RealtimeProtocolError(
      "invalid_message",
      `${label} must be a non-blank string`,
    );
  }
  return value;
}

export function parseRealtimeClientMessage(
  raw: string,
): RealtimeClientMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new RealtimeProtocolError(
      "invalid_json",
      "Realtime message must contain valid JSON",
    );
  }

  const source = record(decoded);
  const type = nonBlankString(source.type, "type");
  if (type !== "player.action") {
    throw new RealtimeProtocolError(
      "unsupported_message",
      `Unsupported realtime message type: ${type}`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(source, "input")) {
    throw new RealtimeProtocolError(
      "invalid_message",
      "player.action must include input",
    );
  }

  return {
    type: "player.action",
    requestId: nonBlankString(source.requestId, "requestId"),
    actionId: nonBlankString(source.actionId, "actionId"),
    input: source.input,
  };
}

export function encodeRealtimeMessage(message: RealtimeServerMessage): string {
  return JSON.stringify(message);
}
