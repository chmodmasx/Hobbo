import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asCorrelationId,
  asScheduledEventId,
  simTime,
} from "@hobbo/domain";
import {
  DeterministicRandom,
  DeterministicScheduler,
  ScheduledEventQueue,
  WorldClock,
} from "../src/index.ts";

const correlationId = asCorrelationId("property-test");

function event(id: number, dueAt: number) {
  return {
    id: asScheduledEventId(`event-${id}`),
    dueAt: simTime(dueAt),
    type: "property.test",
    payload: { id },
    correlationId,
  };
}

describe("scheduler properties", () => {
  it("always executes arbitrary schedules in (time, insertion) order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 200 }),
        (times) => {
          const scheduler = new DeterministicScheduler(
            new WorldClock(simTime(0)),
          );
          times.forEach((dueAt, index) => scheduler.schedule(event(index, dueAt)));

          const observed: number[] = [];
          scheduler.runUntil(simTime(100_000), (scheduled) => {
            observed.push((scheduled.payload as { id: number }).id);
          });

          const expected = times
            .map((dueAt, insertion) => ({ dueAt, insertion }))
            .sort(
              (a, b) => a.dueAt - b.dueAt || a.insertion - b.insertion,
            )
            .map(({ insertion }) => insertion);

          expect(observed).toEqual(expected);
          expect(scheduler.queue.size).toBe(0);
          expect(scheduler.clock.now()).toBe(100_000n);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("snapshot and restore preserve the exact future pop order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 150 }),
        (times) => {
          const original = new ScheduledEventQueue();
          times.forEach((dueAt, index) => original.schedule(event(index, dueAt)));

          const restored = new ScheduledEventQueue();
          restored.restore(original.snapshot());

          const originalOrder: string[] = [];
          const restoredOrder: string[] = [];

          while (original.size > 0) {
            const next = original.pop();
            if (next !== undefined) originalOrder.push(String(next.id));
          }
          while (restored.size > 0) {
            const next = restored.pop();
            if (next !== undefined) restoredOrder.push(String(next.id));
          }

          expect(restoredOrder).toEqual(originalOrder);
        },
      ),
      { numRuns: 250 },
    );
  });
});

describe("deterministic random stream properties", () => {
  it("the same seed always produces the same stream", () => {
    fc.assert(
      fc.property(fc.bigInt(), (seed) => {
        const a = new DeterministicRandom(seed);
        const b = new DeterministicRandom(seed);

        for (let index = 0; index < 64; index += 1) {
          expect(a.nextUint64()).toBe(b.nextUint64());
        }
      }),
      { numRuns: 200 },
    );
  });

  it("restoring a snapshot reproduces the exact continuation", () => {
    fc.assert(
      fc.property(
        fc.bigInt(),
        fc.integer({ min: 0, max: 100 }),
        (seed, prefixLength) => {
          const stream = new DeterministicRandom(seed);
          for (let index = 0; index < prefixLength; index += 1) {
            stream.nextUint64();
          }

          const restored = DeterministicRandom.fromState(stream.snapshot());
          for (let index = 0; index < 64; index += 1) {
            expect(restored.nextUint64()).toBe(stream.nextUint64());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("bounded integer generation never escapes its requested range", () => {
    fc.assert(
      fc.property(
        fc.bigInt(),
        fc.integer({ min: 1, max: 1_000_000 }),
        (seed, bound) => {
          const stream = new DeterministicRandom(seed);
          for (let index = 0; index < 100; index += 1) {
            const value = stream.nextInt(bound);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(bound);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
