import {
  DomainInvariantError,
  type CorrelationId,
  type EventId,
  type ScheduledEventId,
  type SimTime,
} from "@hobbo/domain";
import { WorldClock } from "./clock.ts";

export interface ScheduledEvent<TPayload = unknown> {
  readonly id: ScheduledEventId;
  readonly dueAt: SimTime;
  readonly type: string;
  readonly payload: TPayload;
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId;
}

interface QueueEntry<TPayload = unknown> extends ScheduledEvent<TPayload> {
  readonly ordinal: bigint;
}

export interface ScheduledEventQueueSnapshot {
  readonly nextOrdinal: bigint;
  readonly events: readonly QueueEntry[];
}

function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.dueAt < b.dueAt) return -1;
  if (a.dueAt > b.dueAt) return 1;
  if (a.ordinal < b.ordinal) return -1;
  if (a.ordinal > b.ordinal) return 1;
  return String(a.id).localeCompare(String(b.id));
}

export class ScheduledEventQueue {
  #heap: QueueEntry[] = [];
  #ids = new Set<string>();
  #nextOrdinal = 0n;

  get size(): number {
    return this.#heap.length;
  }

  schedule<TPayload>(event: ScheduledEvent<TPayload>): void {
    const key = String(event.id);
    if (this.#ids.has(key)) {
      throw new DomainInvariantError(`Scheduled event id already exists: ${key}`);
    }

    const entry: QueueEntry = {
      ...event,
      ordinal: this.#nextOrdinal,
    };
    this.#nextOrdinal += 1n;
    this.#ids.add(key);
    this.#heap.push(entry);
    this.#siftUp(this.#heap.length - 1);
  }

  peek(): ScheduledEvent | undefined {
    return this.#heap[0];
  }

  pop(): ScheduledEvent | undefined {
    const first = this.#heap[0];
    if (first === undefined) return undefined;

    const last = this.#heap.pop();
    this.#ids.delete(String(first.id));

    if (this.#heap.length > 0 && last !== undefined) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }

    return this.#stripOrdinal(first);
  }

  cancel(id: ScheduledEventId): boolean {
    const key = String(id);
    if (!this.#ids.has(key)) return false;

    const index = this.#heap.findIndex((entry) => String(entry.id) === key);
    if (index < 0) {
      throw new DomainInvariantError(
        `Scheduled event id index is inconsistent: ${key}`,
      );
    }

    const last = this.#heap.pop();
    this.#ids.delete(key);

    if (index < this.#heap.length && last !== undefined) {
      this.#heap[index] = last;
      this.#siftDown(index);
      this.#siftUp(index);
    }

    return true;
  }

  popDue(now: SimTime): ScheduledEvent[] {
    const due: ScheduledEvent[] = [];
    while (true) {
      const next = this.peek();
      if (next === undefined || next.dueAt > now) break;
      const popped = this.pop();
      if (popped !== undefined) due.push(popped);
    }
    return due;
  }

  snapshot(): ScheduledEventQueueSnapshot {
    return {
      nextOrdinal: this.#nextOrdinal,
      events: [...this.#heap]
        .sort(compareEntries)
        .map((event) => ({ ...event })),
    };
  }

  restore(snapshot: ScheduledEventQueueSnapshot): void {
    this.#heap = [];
    this.#ids = new Set<string>();
    this.#nextOrdinal = snapshot.nextOrdinal;

    for (const entry of snapshot.events) {
      const key = String(entry.id);
      if (this.#ids.has(key)) {
        throw new DomainInvariantError(
          `Snapshot contains duplicate scheduled event id: ${key}`,
        );
      }
      if (entry.ordinal >= snapshot.nextOrdinal) {
        throw new DomainInvariantError(
          `Snapshot ordinal ${entry.ordinal} must be below nextOrdinal ${snapshot.nextOrdinal}`,
        );
      }
      this.#ids.add(key);
      this.#heap.push({ ...entry });
    }

    for (let index = Math.floor(this.#heap.length / 2) - 1; index >= 0; index -= 1) {
      this.#siftDown(index);
    }
  }

  #stripOrdinal(entry: QueueEntry): ScheduledEvent {
    const { ordinal: _ordinal, ...event } = entry;
    return event;
  }

  #siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.#heap[index];
      const parentEntry = this.#heap[parent];
      if (current === undefined || parentEntry === undefined) break;
      if (compareEntries(current, parentEntry) >= 0) break;
      this.#heap[index] = parentEntry;
      this.#heap[parent] = current;
      index = parent;
    }
  }

  #siftDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      const current = this.#heap[smallest];
      const leftEntry = this.#heap[left];
      if (
        current !== undefined &&
        leftEntry !== undefined &&
        compareEntries(leftEntry, current) < 0
      ) {
        smallest = left;
      }

      const smallestEntry = this.#heap[smallest];
      const rightEntry = this.#heap[right];
      if (
        smallestEntry !== undefined &&
        rightEntry !== undefined &&
        compareEntries(rightEntry, smallestEntry) < 0
      ) {
        smallest = right;
      }

      if (smallest === index) break;
      const a = this.#heap[index];
      const b = this.#heap[smallest];
      if (a === undefined || b === undefined) break;
      this.#heap[index] = b;
      this.#heap[smallest] = a;
      index = smallest;
    }
  }
}

export type ScheduledEventHandler = (
  event: ScheduledEvent,
  scheduler: DeterministicScheduler,
) => void;

export class DeterministicScheduler {
  readonly clock: WorldClock;
  readonly queue: ScheduledEventQueue;

  constructor(clock: WorldClock, queue = new ScheduledEventQueue()) {
    this.clock = clock;
    this.queue = queue;
  }

  schedule<TPayload>(event: ScheduledEvent<TPayload>): void {
    if (event.dueAt < this.clock.now()) {
      throw new DomainInvariantError(
        `Cannot schedule event ${event.id} in the past (${event.dueAt} < ${this.clock.now()})`,
      );
    }
    this.queue.schedule(event);
  }

  runNext(handler: ScheduledEventHandler): ScheduledEvent | undefined {
    const event = this.queue.pop();
    if (event === undefined) return undefined;
    this.clock.advanceTo(event.dueAt);
    handler(event, this);
    return event;
  }

  runUntil(target: SimTime, handler: ScheduledEventHandler): number {
    if (target < this.clock.now()) {
      throw new DomainInvariantError(
        `Scheduler cannot run backwards (${target} < ${this.clock.now()})`,
      );
    }

    let processed = 0;
    while (true) {
      const next = this.queue.peek();
      if (next === undefined || next.dueAt > target) break;
      this.runNext(handler);
      processed += 1;
    }

    this.clock.advanceTo(target);
    return processed;
  }
}
