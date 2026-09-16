import { describe, expect, it } from "vitest";
import { ScheduledEventHandlerRegistry } from "../src/index.ts";

const noop = async () => {};

describe("scheduled-event handler registry", () => {
  it("registers one handler per exact event type", () => {
    const registry = new ScheduledEventHandlerRegistry();
    registry.register("person.test", noop);

    expect(registry.has("person.test")).toBe(true);
    expect(registry.get("person.test")).toBe(noop);
  });

  it("rejects blank and duplicate event types", () => {
    const registry = new ScheduledEventHandlerRegistry();
    expect(() => registry.register("   ", noop)).toThrow(/blank/i);

    registry.register("person.test", noop);
    expect(() => registry.register("person.test", noop)).toThrow(/already registered/i);
  });
});
