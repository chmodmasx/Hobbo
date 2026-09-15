export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type WorldId = Brand<string, "WorldId">;
export type EntityId = Brand<string, "EntityId">;
export type PersonId = Brand<string, "PersonId">;
export type EventId = Brand<string, "EventId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type ScheduledEventId = Brand<string, "ScheduledEventId">;
export type ActionId = Brand<string, "ActionId">;
export type AffordanceId = Brand<string, "AffordanceId">;
export type CognitionRequestId = Brand<string, "CognitionRequestId">;

export type SimTime = Brand<bigint, "SimTime">;
export type SimDuration = Brand<bigint, "SimDuration">;
export type EventSequence = Brand<bigint, "EventSequence">;

export const SIM_TIME_ZERO = 0n as SimTime;
export const SIM_DURATION_ZERO = 0n as SimDuration;
export const FIRST_EVENT_SEQUENCE = 1n as EventSequence;

function assertIntegerLike(value: bigint | number | string, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a safe integer`);
    }
    return BigInt(value);
  }

  if (!/^-?\d+$/.test(value)) {
    throw new TypeError(`${label} must be an integer string`);
  }

  return BigInt(value);
}

export function simTime(value: bigint | number | string): SimTime {
  const parsed = assertIntegerLike(value, "SimTime");
  if (parsed < 0n) {
    throw new RangeError("SimTime cannot be negative");
  }
  return parsed as SimTime;
}

export function simDuration(value: bigint | number | string): SimDuration {
  const parsed = assertIntegerLike(value, "SimDuration");
  if (parsed < 0n) {
    throw new RangeError("SimDuration cannot be negative");
  }
  return parsed as SimDuration;
}

export function eventSequence(value: bigint | number | string): EventSequence {
  const parsed = assertIntegerLike(value, "EventSequence");
  if (parsed < 1n) {
    throw new RangeError("EventSequence must be >= 1");
  }
  return parsed as EventSequence;
}

export function addSimTime(time: SimTime, duration: SimDuration): SimTime {
  return (time + duration) as SimTime;
}

export function elapsedSimTime(from: SimTime, to: SimTime): SimDuration {
  if (to < from) {
    throw new RangeError("Cannot calculate a negative simulation duration");
  }
  return (to - from) as SimDuration;
}

export function compareSimTime(a: SimTime, b: SimTime): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nextEventSequence(sequence: EventSequence): EventSequence {
  return (sequence + 1n) as EventSequence;
}

export interface DomainEvent<
  TType extends string = string,
  TPayload = unknown,
> {
  readonly sequence: EventSequence;
  readonly id: EventId;
  readonly worldId: WorldId;
  readonly simTime: SimTime;
  readonly type: TType;
  readonly actorId?: EntityId;
  readonly targetIds?: readonly EntityId[];
  readonly payload: TPayload;
  readonly causationId?: EventId;
  readonly correlationId: CorrelationId;
}

export interface DomainEventDraft<
  TType extends string = string,
  TPayload = unknown,
> {
  readonly id: EventId;
  readonly worldId: WorldId;
  readonly simTime: SimTime;
  readonly type: TType;
  readonly actorId?: EntityId;
  readonly targetIds?: readonly EntityId[];
  readonly payload: TPayload;
  readonly causationId?: EventId;
  readonly correlationId: CorrelationId;
}

export interface Affordance<TContext = unknown> {
  readonly id: AffordanceId;
  readonly actionId: ActionId;
  readonly label: string;
  readonly context: TContext;
}

export class DomainInvariantError extends Error {
  override readonly name = "DomainInvariantError";

  constructor(message: string) {
    super(message);
  }
}

export function asWorldId(value: string): WorldId {
  return value as WorldId;
}

export function asEntityId(value: string): EntityId {
  return value as EntityId;
}

export function asPersonId(value: string): PersonId {
  return value as PersonId;
}

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function asCorrelationId(value: string): CorrelationId {
  return value as CorrelationId;
}

export function asScheduledEventId(value: string): ScheduledEventId {
  return value as ScheduledEventId;
}

export function asActionId(value: string): ActionId {
  return value as ActionId;
}

export function asAffordanceId(value: string): AffordanceId {
  return value as AffordanceId;
}

export function asCognitionRequestId(value: string): CognitionRequestId {
  return value as CognitionRequestId;
}
