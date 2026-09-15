import { describe, expect, it } from "vitest";
import {
  asCorrelationId,
  asEventId,
  asScheduledEventId,
  asWorldId,
  eventSequence,
  simDuration,
  simTime,
} from "@hobbo/domain";
import {
  DeterministicScheduler,
  InMemoryDomainEventLog,
  ScheduledEventQueue,
  WorldClock,
  replayEvents,
} from "../src/index.ts";

const correlationId = asCorrelationId("corr-1");

function scheduled(id: string, dueAt: bigint, type = id) {
  return {
    id: asScheduledEventId(id),
    dueAt: simTime(dueAt),
    type,
    payload: { id },
    correlationId,
  };
}

describe("WorldClock", () => {
  it("advances only monotonically", () => {
    const clock = new WorldClock(simTime(10));
    expect(clock.advanceBy(simDuration(5))).toBe(15n);
    expect(clock.advanceTo(simTime(20))).toBe(20n);
    expect(() => clock.advanceTo(simTime(19))).toThrow(/cannot move backwards/i);
  });
});

describe("DeterministicScheduler", () => {
  it("orders equal-time events by insertion order, including events scheduled by handlers", () => {
    const scheduler = new DeterministicScheduler(new WorldClock(simTime(0)));
    const observed: string[] = [];

    scheduler.schedule(scheduled("a", 10n));
    scheduler.schedule(scheduled("b", 10n));
    scheduler.schedule(scheduled("early", 5n));

    const processed = scheduler.runUntil(simTime(10), (event, activeScheduler) => {
      observed.push(String(event.id));
      if (String(event.id) === "a") {
        activeScheduler.schedule(scheduled("created-during-a", 10n));
      }
    });

    expect(processed).toBe(4);
    expect(observed).toEqual(["early", "a", "b", "created-during-a"]);
    expect(scheduler.clock.now()).toBe(10n);
  });

  it("rejects scheduling in the simulated past", () => {
    const scheduler = new DeterministicScheduler(new WorldClock(simTime(20)));
    expect(() => scheduler.schedule(scheduled("late", 19n))).toThrow(
      /in the past/i,
    );
  });

  it("preserves deterministic ordering across queue snapshot and restore", () => {
    const queue = new ScheduledEventQueue();
    queue.schedule(scheduled("first", 100n));
    queue.schedule(scheduled("second", 100n));
    queue.schedule(scheduled("earliest", 1n));

    const restored = new ScheduledEventQueue();
    restored.restore(queue.snapshot());

    expect(restored.pop()?.id).toBe("earliest");
    expect(restored.pop()?.id).toBe("first");
    expect(restored.pop()?.id).toBe("second");
    expect(restored.pop()).toBeUndefined();
  });
});

describe("domain event log and replay", () => {
  it("assigns contiguous sequence numbers and replays deterministically", () => {
    const log = new InMemoryDomainEventLog();
    const worldId = asWorldId("world-1");

    log.append({
      id: asEventId("event-1"),
      worldId,
      simTime: simTime(1),
      type: "counter.changed",
      payload: { delta: 2 },
      correlationId,
    });
    log.append({
      id: asEventId("event-2"),
      worldId,
      simTime: simTime(1),
      type: "counter.changed",
      payload: { delta: 3 },
      causationId: asEventId("event-1"),
      correlationId,
    });

    expect(log.all().map((event) => event.sequence)).toEqual([1n, 2n]);
    expect(log.nextSequence()).toBe(3n);
    expect(log.after(eventSequence(1))).toHaveLength(1);

    const state = replayEvents({ total: 0 }, log.all(), (current, event) => {
      if (event.type !== "counter.changed") return { ...current };
      const payload = event.payload as { delta: number };
      return { total: current.total + payload.delta };
    });

    expect(state).toEqual({ total: 5 });
  });

  it("rejects duplicate ids and backwards event time", () => {
    const log = new InMemoryDomainEventLog();
    const worldId = asWorldId("world-1");

    log.append({
      id: asEventId("event-1"),
      worldId,
      simTime: simTime(10),
      type: "test",
      payload: {},
      correlationId,
    });

    expect(() =>
      log.append({
        id: asEventId("event-1"),
        worldId,
        simTime: simTime(10),
        type: "test",
        payload: {},
        correlationId,
      }),
    ).toThrow(/already exists/i);

    expect(() =>
      log.append({
        id: asEventId("event-2"),
        worldId,
        simTime: simTime(9),
        type: "test",
        payload: {},
        correlationId,
      }),
    ).toThrow(/cannot move backwards/i);
  });
});
