import {
  DomainInvariantError,
  asCommitmentId,
  asCorrelationId,
  asScheduledEventId,
  simTime,
  type CommitmentId,
  type CorrelationId,
  type EntityId,
  type RoutineId,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";
import type { ScheduledEvent } from "./scheduler.ts";

export const COMMITMENT_DUE_EVENT_TYPE = "commitment.due";

export interface PeriodicRoutine<TPayload = unknown> {
  readonly id: RoutineId;
  readonly ownerId: EntityId;
  readonly period: SimDuration;
  readonly phase: SimDuration;
  readonly kind: string;
  readonly payload: TPayload;
}

export type CommitmentStatus =
  | "planned"
  | "fulfilled"
  | "missed"
  | "cancelled";

export interface Commitment<TPayload = unknown> {
  readonly id: CommitmentId;
  readonly ownerId: EntityId;
  readonly dueAt: SimTime;
  readonly kind: string;
  readonly payload: TPayload;
  readonly correlationId: CorrelationId;
  readonly status: CommitmentStatus;
  readonly routineId?: RoutineId;
  readonly resolvedAt?: SimTime;
}

export interface CommitmentDuePayload<TPayload = unknown> {
  readonly commitmentId: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly routineId?: string;
}

function assertRoutine(routine: PeriodicRoutine): void {
  if (String(routine.id).length === 0) {
    throw new DomainInvariantError("Routine id cannot be empty");
  }
  if (String(routine.ownerId).length === 0) {
    throw new DomainInvariantError("Routine owner id cannot be empty");
  }
  if (routine.period <= 0n) {
    throw new DomainInvariantError("Routine period must be greater than zero");
  }
  if (routine.phase < 0n || routine.phase >= routine.period) {
    throw new DomainInvariantError(
      `Routine phase must be within [0, period), received phase=${routine.phase} period=${routine.period}`,
    );
  }
  if (routine.kind.trim().length === 0) {
    throw new DomainInvariantError("Routine kind cannot be empty");
  }
}

function stableIdPart(value: string): string {
  return encodeURIComponent(value);
}

export function nextPeriodicOccurrence(
  routine: PeriodicRoutine,
  from: SimTime,
  includeCurrent = false,
): SimTime {
  assertRoutine(routine);

  const period = BigInt(routine.period);
  const phase = BigInt(routine.phase);
  const current = BigInt(from);

  if (current < phase) return simTime(phase);

  const elapsedFromPhase = current - phase;
  let occurrence = phase + (elapsedFromPhase / period) * period;
  if (occurrence < current || (!includeCurrent && occurrence === current)) {
    occurrence += period;
  }
  return simTime(occurrence);
}

export function createCommitment<TPayload>(input: {
  readonly id: CommitmentId;
  readonly ownerId: EntityId;
  readonly dueAt: SimTime;
  readonly kind: string;
  readonly payload: TPayload;
  readonly correlationId: CorrelationId;
  readonly routineId?: RoutineId;
}): Commitment<TPayload> {
  if (String(input.id).length === 0) {
    throw new DomainInvariantError("Commitment id cannot be empty");
  }
  if (String(input.ownerId).length === 0) {
    throw new DomainInvariantError("Commitment owner id cannot be empty");
  }
  if (input.kind.trim().length === 0) {
    throw new DomainInvariantError("Commitment kind cannot be empty");
  }

  return {
    ...input,
    status: "planned",
  };
}

export function materializeRoutineCommitment<TPayload>(
  routine: PeriodicRoutine<TPayload>,
  dueAt: SimTime,
): Commitment<TPayload> {
  assertRoutine(routine);
  const period = BigInt(routine.period);
  const phase = BigInt(routine.phase);
  const due = BigInt(dueAt);

  if (due < phase || (due - phase) % period !== 0n) {
    throw new DomainInvariantError(
      `Commitment time ${dueAt} is not an occurrence of routine ${routine.id}`,
    );
  }

  const encodedRoutine = stableIdPart(String(routine.id));
  const suffix = due.toString();
  return createCommitment({
    id: asCommitmentId(`routine:${encodedRoutine}:${suffix}`),
    ownerId: routine.ownerId,
    dueAt,
    kind: routine.kind,
    payload: routine.payload,
    correlationId: asCorrelationId(`routine:${encodedRoutine}:${suffix}`),
    routineId: routine.id,
  });
}

export function nextRoutineCommitment<TPayload>(
  routine: PeriodicRoutine<TPayload>,
  from: SimTime,
  includeCurrent = false,
): Commitment<TPayload> {
  return materializeRoutineCommitment(
    routine,
    nextPeriodicOccurrence(routine, from, includeCurrent),
  );
}

export function scheduledEventForCommitment<TPayload>(
  commitment: Commitment<TPayload>,
): ScheduledEvent<CommitmentDuePayload<TPayload>> {
  if (commitment.status !== "planned") {
    throw new DomainInvariantError(
      `Only planned commitments can be scheduled: ${commitment.id} is ${commitment.status}`,
    );
  }

  return {
    id: asScheduledEventId(`commitment:${stableIdPart(String(commitment.id))}`),
    dueAt: commitment.dueAt,
    type: COMMITMENT_DUE_EVENT_TYPE,
    payload: {
      commitmentId: String(commitment.id),
      ownerId: String(commitment.ownerId),
      kind: commitment.kind,
      payload: commitment.payload,
      ...(commitment.routineId === undefined
        ? {}
        : { routineId: String(commitment.routineId) }),
    },
    correlationId: commitment.correlationId,
  };
}

function resolveCommitment<TPayload>(
  commitment: Commitment<TPayload>,
  status: Exclude<CommitmentStatus, "planned">,
  at: SimTime,
): Commitment<TPayload> {
  if (commitment.status !== "planned") {
    throw new DomainInvariantError(
      `Commitment ${commitment.id} is already resolved as ${commitment.status}`,
    );
  }
  if (status === "missed" && at < commitment.dueAt) {
    throw new DomainInvariantError(
      `Commitment ${commitment.id} cannot be missed before its due time`,
    );
  }

  return {
    ...commitment,
    status,
    resolvedAt: at,
  };
}

export function fulfillCommitment<TPayload>(
  commitment: Commitment<TPayload>,
  at: SimTime,
): Commitment<TPayload> {
  return resolveCommitment(commitment, "fulfilled", at);
}

export function missCommitment<TPayload>(
  commitment: Commitment<TPayload>,
  at: SimTime,
): Commitment<TPayload> {
  return resolveCommitment(commitment, "missed", at);
}

export function cancelCommitment<TPayload>(
  commitment: Commitment<TPayload>,
  at: SimTime,
): Commitment<TPayload> {
  return resolveCommitment(commitment, "cancelled", at);
}
