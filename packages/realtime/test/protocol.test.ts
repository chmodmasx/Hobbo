import { describe, expect, it } from "vitest";
import {
  RealtimeProtocolError,
  parseRealtimeClientMessage,
} from "../src/index.ts";

describe("realtime wire protocol", () => {
  it("parses a player action without interpreting action-specific input", () => {
    expect(
      parseRealtimeClientMessage(
        JSON.stringify({
          type: "player.action",
          requestId: "move-1",
          actionId: "spatial.move",
          input: { dx: 1, dy: 0 },
        }),
      ),
    ).toEqual({
      type: "player.action",
      requestId: "move-1",
      actionId: "spatial.move",
      input: { dx: 1, dy: 0 },
    });
  });

  it("rejects invalid JSON, missing identity and unsupported message types", () => {
    for (const raw of [
      "{",
      JSON.stringify({ type: "player.action", actionId: "spatial.move", input: {} }),
      JSON.stringify({ type: "player.action", requestId: "x", actionId: "", input: {} }),
      JSON.stringify({ type: "world.mutate" }),
    ]) {
      expect(() => parseRealtimeClientMessage(raw)).toThrow(
        RealtimeProtocolError,
      );
    }
  });
});
