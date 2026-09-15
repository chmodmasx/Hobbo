import {
  DomainInvariantError,
  FIRST_EVENT_SEQUENCE,
  eventSequence,
  nextEventSequence,
  type DomainEvent,
  type DomainEventDraft,
  type EventSequence,
} from "@hobbo/domain";

function freezeEvent<TType extends string, TPayload>(
  event: DomainEvent<TType, TPayload>,
): DomainEvent<TType, TPayload> {
  if (event.targetIds === undefined) {
    return Object.freeze({ ...event });
  }

  return Object.freeze({
    ...event,
    targetIds: Object.freeze([...event.targetIds]),
  });
}

export class InMemoryDomainEventLog {
  #events: DomainEvent[] = [];
  #eventIds = new Set<string>();
  #nextSequence: EventSequence = FIRST_EVENT_SEQUENCE;

  get size(): number {
    return this.#events.length;
  }

  nextSequence(): EventSequence {
    return this.#nextSequence;
  }

  append<TType extends string, TPayload>(
    draft: DomainEventDraft<TType, TPayload>,
  ): DomainEvent<TType, TPayload> {
    const id = String(draft.id);
    if (this.#eventIds.has(id)) {
      throw new DomainInvariantError(`Domain event id already exists: ${id}`);
    }

    const previous = this.#events.at(-1);
    if (previous !== undefined && draft.simTime < previous.simTime) {
      throw new DomainInvariantError(
        `Domain event time cannot move backwards (${draft.simTime} < ${previous.simTime})`,
      );
    }

    const event = freezeEvent({
      ...draft,
      sequence: this.#nextSequence,
    });

    this.#events.push(event);
    this.#eventIds.add(id);
    this.#nextSequence = nextEventSequence(this.#nextSequence);
    return event;
  }

  all(): readonly DomainEvent[] {
    return this.#events;
  }

  after(sequence: EventSequence): readonly DomainEvent[] {
    return this.#events.filter((event) => event.sequence > sequence);
  }

  restore(events: readonly DomainEvent[]): void {
    this.#events = [];
    this.#eventIds = new Set<string>();
    this.#nextSequence = FIRST_EVENT_SEQUENCE;

    let expected = 1n;
    let previousTime: bigint | undefined;

    for (const event of events) {
      if (event.sequence !== expected) {
        throw new DomainInvariantError(
          `Event sequence gap: expected ${expected}, received ${event.sequence}`,
        );
      }
      if (previousTime !== undefined && event.simTime < previousTime) {
        throw new DomainInvariantError(
          `Event time moved backwards at sequence ${event.sequence}`,
        );
      }
      const id = String(event.id);
      if (this.#eventIds.has(id)) {
        throw new DomainInvariantError(`Duplicate event id in restore: ${id}`);
      }

      this.#events.push(freezeEvent(event));
      this.#eventIds.add(id);
      expected += 1n;
      previousTime = event.simTime;
    }

    this.#nextSequence = eventSequence(expected);
  }
}

export type EventReducer<TState> = (
  state: Readonly<TState>,
  event: DomainEvent,
) => TState;

export function replayEvents<TState>(
  initialState: TState,
  events: readonly DomainEvent[],
  reducer: EventReducer<TState>,
): TState {
  let state = initialState;
  let expected = 1n;
  let previousTime: bigint | undefined;

  for (const event of events) {
    if (event.sequence !== expected) {
      throw new DomainInvariantError(
        `Replay requires contiguous sequence: expected ${expected}, received ${event.sequence}`,
      );
    }
    if (previousTime !== undefined && event.simTime < previousTime) {
      throw new DomainInvariantError(
        `Replay event time moved backwards at sequence ${event.sequence}`,
      );
    }

    state = reducer(state, event);
    expected += 1n;
    previousTime = event.simTime;
  }

  return state;
}
