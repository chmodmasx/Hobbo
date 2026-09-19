import {
  DomainInvariantError,
  addSimTime,
  simTime,
  type EntityId,
  type LifeGoalId,
  type PlanRevisionId,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";

export const PLANNING_BASIS_POINTS = 10_000;

export type GoalStatus = "active" | "completed" | "abandoned";
export type PlanRevisionStatus = "active" | "superseded";
export type PlanRevisionReason = "initial" | "review" | "conflict";

export interface GoalPlanningStrategy {
  readonly period: SimDuration;
  readonly phase: SimDuration;
  readonly duration: SimDuration;
  readonly intentionKind: string;
  readonly payload: unknown;
}

export interface LifeGoal {
  readonly id: LifeGoalId;
  readonly ownerId: EntityId;
  readonly title: string;
  readonly priorityBps: number;
  readonly createdAt: SimTime;
  readonly status: GoalStatus;
  readonly strategy: GoalPlanningStrategy;
}

export interface PlanningBusyWindow {
  readonly id: string;
  readonly kind: string;
  readonly start: SimTime;
  readonly end: SimTime;
}

export interface PlanIntention {
  readonly id: string;
  readonly goalId: LifeGoalId;
  readonly kind: string;
  readonly preferredStart: SimTime;
  readonly startsAt: SimTime;
  readonly endsAt: SimTime;
  readonly payload: unknown;
  readonly displacedBy: readonly string[];
}

export interface PlanRevision {
  readonly id: PlanRevisionId;
  readonly ownerId: EntityId;
  readonly revision: number;
  readonly createdAt: SimTime;
  readonly horizonEnd: SimTime;
  readonly status: PlanRevisionStatus;
  readonly reason: PlanRevisionReason;
  readonly intentions: readonly PlanIntention[];
}

function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return trimmed;
}

function assertBps(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PLANNING_BASIS_POINTS
  ) {
    throw new DomainInvariantError(
      `${label} must be an integer between 0 and ${PLANNING_BASIS_POINTS}`,
    );
  }
}

export function validateLifeGoal(goal: LifeGoal): void {
  assertNonBlank(String(goal.id), "Goal id");
  assertNonBlank(String(goal.ownerId), "Goal owner");
  assertNonBlank(goal.title, "Goal title");
  assertBps(goal.priorityBps, "Goal priority");
  if (
    goal.status !== "active" &&
    goal.status !== "completed" &&
    goal.status !== "abandoned"
  ) {
    throw new DomainInvariantError(`Unknown goal status: ${goal.status}`);
  }
  if (goal.strategy.period <= 0n) {
    throw new DomainInvariantError("Goal planning period must be positive");
  }
  if (
    goal.strategy.phase < 0n ||
    goal.strategy.phase >= goal.strategy.period
  ) {
    throw new DomainInvariantError(
      "Goal planning phase must be within its period",
    );
  }
  if (goal.strategy.duration <= 0n) {
    throw new DomainInvariantError("Goal intention duration must be positive");
  }
  assertNonBlank(goal.strategy.intentionKind, "Goal intention kind");
}

export function validateBusyWindow(window: PlanningBusyWindow): void {
  assertNonBlank(window.id, "Busy-window id");
  assertNonBlank(window.kind, "Busy-window kind");
  if (window.end <= window.start) {
    throw new DomainInvariantError(
      `Busy window ${window.id} must end after it starts`,
    );
  }
}

function overlaps(
  leftStart: SimTime,
  leftEnd: SimTime,
  rightStart: SimTime,
  rightEnd: SimTime,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function nextOccurrence(
  strategy: GoalPlanningStrategy,
  from: SimTime,
): SimTime {
  const period = BigInt(strategy.period);
  const phase = BigInt(strategy.phase);
  const start = BigInt(from);
  if (start <= phase) return simTime(phase);
  const delta = start - phase;
  const periods = (delta + period - 1n) / period;
  return simTime(phase + periods * period);
}

function intentionId(
  goalId: LifeGoalId,
  preferredStart: SimTime,
): string {
  return `goal:${goalId}:at:${preferredStart}`;
}

function orderedWindows(
  windows: readonly PlanningBusyWindow[],
): PlanningBusyWindow[] {
  const ids = new Set<string>();
  const copy = windows.map((window) => {
    validateBusyWindow(window);
    if (ids.has(window.id)) {
      throw new DomainInvariantError(
        `Duplicate busy-window id: ${window.id}`,
      );
    }
    ids.add(window.id);
    return { ...window };
  });
  copy.sort((left, right) => {
    if (left.start !== right.start) return left.start < right.start ? -1 : 1;
    if (left.end !== right.end) return left.end < right.end ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  return copy;
}

export function derivePlanIntentions(input: {
  readonly goals: readonly LifeGoal[];
  readonly now: SimTime;
  readonly horizonEnd: SimTime;
  readonly busyWindows?: readonly PlanningBusyWindow[];
}): readonly PlanIntention[] {
  if (input.horizonEnd <= input.now) {
    throw new DomainInvariantError("Planning horizon must end after now");
  }

  const active = input.goals
    .filter((goal) => {
      validateLifeGoal(goal);
      return goal.status === "active";
    })
    .sort((left, right) => {
      if (left.priorityBps !== right.priorityBps) {
        return right.priorityBps - left.priorityBps;
      }
      return String(left.id).localeCompare(String(right.id));
    });

  const reserved = orderedWindows(input.busyWindows ?? []);
  const intentions: PlanIntention[] = [];

  for (const goal of active) {
    let preferredStart = nextOccurrence(goal.strategy, input.now);

    while (preferredStart < input.horizonEnd) {
      let startsAt = preferredStart;
      const displacedBy = new Set<string>();

      for (;;) {
        const endsAt = addSimTime(startsAt, goal.strategy.duration);
        const conflict = reserved.find((window) =>
          overlaps(startsAt, endsAt, window.start, window.end),
        );
        if (conflict === undefined) break;
        displacedBy.add(conflict.id);
        startsAt = conflict.end;
      }

      const endsAt = addSimTime(startsAt, goal.strategy.duration);
      if (endsAt <= input.horizonEnd) {
        const id = intentionId(goal.id, preferredStart);
        const intention: PlanIntention = {
          id,
          goalId: goal.id,
          kind: goal.strategy.intentionKind.trim(),
          preferredStart,
          startsAt,
          endsAt,
          payload: goal.strategy.payload,
          displacedBy: [...displacedBy],
        };
        intentions.push(intention);
        reserved.push({
          id: `intention:${id}`,
          kind: intention.kind,
          start: intention.startsAt,
          end: intention.endsAt,
        });
        reserved.sort((left, right) => {
          if (left.start !== right.start) return left.start < right.start ? -1 : 1;
          if (left.end !== right.end) return left.end < right.end ? -1 : 1;
          return left.id.localeCompare(right.id);
        });
      }

      preferredStart = addSimTime(preferredStart, goal.strategy.period);
    }
  }

  return intentions.sort((left, right) => {
    if (left.startsAt !== right.startsAt) {
      return left.startsAt < right.startsAt ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export function validatePlanRevision(plan: PlanRevision): void {
  assertNonBlank(String(plan.id), "Plan revision id");
  assertNonBlank(String(plan.ownerId), "Plan owner");
  if (!Number.isSafeInteger(plan.revision) || plan.revision <= 0) {
    throw new DomainInvariantError(
      "Plan revision must be a positive safe integer",
    );
  }
  if (plan.horizonEnd <= plan.createdAt) {
    throw new DomainInvariantError("Plan horizon must end after creation");
  }
  if (plan.status !== "active" && plan.status !== "superseded") {
    throw new DomainInvariantError(`Unknown plan status: ${plan.status}`);
  }
  if (
    plan.reason !== "initial" &&
    plan.reason !== "review" &&
    plan.reason !== "conflict"
  ) {
    throw new DomainInvariantError(`Unknown plan reason: ${plan.reason}`);
  }

  const ids = new Set<string>();
  for (const intention of plan.intentions) {
    assertNonBlank(intention.id, "Plan intention id");
    assertNonBlank(String(intention.goalId), "Plan intention goal");
    assertNonBlank(intention.kind, "Plan intention kind");
    if (ids.has(intention.id)) {
      throw new DomainInvariantError(
        `Duplicate plan intention id: ${intention.id}`,
      );
    }
    ids.add(intention.id);
    if (intention.preferredStart < plan.createdAt) {
      throw new DomainInvariantError(
        `Plan intention ${intention.id} prefers a time before plan creation`,
      );
    }
    if (intention.startsAt < intention.preferredStart) {
      throw new DomainInvariantError(
        `Plan intention ${intention.id} cannot move before its preferred time`,
      );
    }
    if (intention.endsAt <= intention.startsAt) {
      throw new DomainInvariantError(
        `Plan intention ${intention.id} must end after it starts`,
      );
    }
    if (intention.endsAt > plan.horizonEnd) {
      throw new DomainInvariantError(
        `Plan intention ${intention.id} exceeds the plan horizon`,
      );
    }
  }
}

export function derivePlanRevision(input: {
  readonly id: PlanRevisionId;
  readonly ownerId: EntityId;
  readonly revision: number;
  readonly createdAt: SimTime;
  readonly horizonEnd: SimTime;
  readonly goals: readonly LifeGoal[];
  readonly busyWindows?: readonly PlanningBusyWindow[];
  readonly previousPlan?: PlanRevision;
  readonly forcedConflict?: boolean;
}): PlanRevision {
  const intentions = derivePlanIntentions({
    goals: input.goals,
    now: input.createdAt,
    horizonEnd: input.horizonEnd,
    ...(input.busyWindows === undefined
      ? {}
      : { busyWindows: input.busyWindows }),
  });
  const displaced = intentions.some(
    (intention) => intention.displacedBy.length > 0,
  );
  const plan: PlanRevision = {
    id: input.id,
    ownerId: input.ownerId,
    revision: input.revision,
    createdAt: input.createdAt,
    horizonEnd: input.horizonEnd,
    status: "active",
    reason:
      input.forcedConflict === true || displaced
        ? "conflict"
        : input.previousPlan === undefined
          ? "initial"
          : "review",
    intentions,
  };
  validatePlanRevision(plan);
  return plan;
}
