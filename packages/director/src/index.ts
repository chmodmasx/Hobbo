import {
  DomainInvariantError,
  addSimTime,
  asActionId,
  asAffordanceId,
  type Affordance,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";

export const WORLD_DIRECTOR_NOOP_ACTION_ID =
  asActionId("world_director.noop");
export const WORLD_DIRECTOR_SOCIAL_OPPORTUNITY_ACTION_ID =
  asActionId("world_director.social_opportunity");

export const WORLD_DIRECTOR_HARD_MAX_PEOPLE = 16;
export const WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS = 32;
export const WORLD_DIRECTOR_HARD_MAX_CANDIDATES = 8;

export interface WorldDirectorRecentEvent {
  readonly sequence: string;
  readonly simTime: string;
  readonly type: string;
  readonly actorId?: string;
  readonly targetIds: readonly string[];
}

export interface WorldDirectorSummary {
  readonly currentSimTime: SimTime;
  readonly populationCount: number;
  readonly sampledPersonIds: readonly string[];
  readonly recentEvents: readonly WorldDirectorRecentEvent[];
}

export interface WorldDirectorCognitionContext {
  readonly world: {
    readonly currentSimTime: string;
    readonly populationCount: number;
  };
  readonly sampledPersonIds: readonly string[];
  readonly recentEvents: readonly WorldDirectorRecentEvent[];
}

export type WorldDirectorAffordanceContext =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "social_opportunity";
      readonly participantIds: readonly [string, string];
      readonly dueAt: string;
    };

export type WorldDirectorProposalDraft =
  | {
      readonly status: "rejected";
      readonly kind: "none";
      readonly payload: {
        readonly reason: "no_intervention";
      };
    }
  | {
      readonly status: "accepted";
      readonly kind: "social_opportunity";
      readonly payload: {
        readonly participantIds: readonly [string, string];
        readonly dueAt: string;
      };
    };

function stableTextCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return normalized;
}

function positiveSafeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DomainInvariantError(
      `${label} must be a positive safe integer <= ${maximum}`,
    );
  }
  return value;
}

function validateSummary(summary: WorldDirectorSummary): void {
  if (
    !Number.isSafeInteger(summary.populationCount) ||
    summary.populationCount < 0
  ) {
    throw new DomainInvariantError(
      "World Director populationCount must be a non-negative safe integer",
    );
  }
  if (summary.sampledPersonIds.length > WORLD_DIRECTOR_HARD_MAX_PEOPLE) {
    throw new DomainInvariantError(
      `World Director sampled people exceed hard limit ${WORLD_DIRECTOR_HARD_MAX_PEOPLE}`,
    );
  }
  if (summary.recentEvents.length > WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS) {
    throw new DomainInvariantError(
      `World Director recent events exceed hard limit ${WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS}`,
    );
  }
  if (summary.sampledPersonIds.length > summary.populationCount) {
    throw new DomainInvariantError(
      "World Director sampled people cannot exceed populationCount",
    );
  }
  const people = new Set<string>();
  for (const personId of summary.sampledPersonIds) {
    const normalized = nonBlank(personId, "World Director person id");
    if (people.has(normalized)) {
      throw new DomainInvariantError(
        `World Director duplicate sampled person: ${normalized}`,
      );
    }
    people.add(normalized);
  }
  for (const event of summary.recentEvents) {
    nonBlank(event.sequence, "World Director event sequence");
    nonBlank(event.simTime, "World Director event simTime");
    nonBlank(event.type, "World Director event type");
    if (event.actorId !== undefined) {
      nonBlank(event.actorId, "World Director event actorId");
    }
    for (const targetId of event.targetIds) {
      nonBlank(targetId, "World Director event targetId");
    }
  }
}

export function worldDirectorCognitionContext(
  summary: WorldDirectorSummary,
): WorldDirectorCognitionContext {
  validateSummary(summary);
  return {
    world: {
      currentSimTime: summary.currentSimTime.toString(),
      populationCount: summary.populationCount,
    },
    sampledPersonIds: [...summary.sampledPersonIds],
    recentEvents: summary.recentEvents.map((event) => ({
      ...event,
      targetIds: [...event.targetIds],
    })),
  };
}

export function buildWorldDirectorAffordances(input: {
  readonly summary: WorldDirectorSummary;
  readonly effectDelay: SimDuration;
  readonly maxCandidates: number;
}): readonly Affordance<WorldDirectorAffordanceContext>[] {
  validateSummary(input.summary);
  if (input.effectDelay <= 0n) {
    throw new DomainInvariantError(
      "World Director effectDelay must be positive",
    );
  }
  positiveSafeInteger(
    input.maxCandidates,
    "World Director maxCandidates",
    WORLD_DIRECTOR_HARD_MAX_CANDIDATES,
  );

  const affordances: Affordance<WorldDirectorAffordanceContext>[] = [
    {
      id: asAffordanceId("world-director:no-intervention"),
      actionId: WORLD_DIRECTOR_NOOP_ACTION_ID,
      label: "Do not introduce a world opportunity",
      context: { kind: "none" },
    },
  ];

  const people = [...input.summary.sampledPersonIds].sort(stableTextCompare);
  const dueAt = addSimTime(input.summary.currentSimTime, input.effectDelay);
  let produced = 0;
  for (let left = 0; left < people.length && produced < input.maxCandidates; left += 1) {
    for (
      let right = left + 1;
      right < people.length && produced < input.maxCandidates;
      right += 1
    ) {
      const first = people[left];
      const second = people[right];
      if (first === undefined || second === undefined) continue;
      affordances.push({
        id: asAffordanceId(
          `world-director:social:${encodeURIComponent(first)}:${encodeURIComponent(second)}:${dueAt}`,
        ),
        actionId: WORLD_DIRECTOR_SOCIAL_OPPORTUNITY_ACTION_ID,
        label: `Create a social opportunity involving ${first} and ${second}`,
        context: {
          kind: "social_opportunity",
          participantIds: [first, second],
          dueAt: dueAt.toString(),
        },
      });
      produced += 1;
    }
  }

  return affordances;
}

export function proposalFromWorldDirectorAffordance(
  affordance: Affordance,
): WorldDirectorProposalDraft {
  if (
    affordance.actionId === WORLD_DIRECTOR_NOOP_ACTION_ID &&
    typeof affordance.context === "object" &&
    affordance.context !== null &&
    !Array.isArray(affordance.context) &&
    (affordance.context as { readonly kind?: unknown }).kind === "none"
  ) {
    return {
      status: "rejected",
      kind: "none",
      payload: { reason: "no_intervention" },
    };
  }

  if (
    affordance.actionId === WORLD_DIRECTOR_SOCIAL_OPPORTUNITY_ACTION_ID &&
    typeof affordance.context === "object" &&
    affordance.context !== null &&
    !Array.isArray(affordance.context)
  ) {
    const context = affordance.context as {
      readonly kind?: unknown;
      readonly participantIds?: unknown;
      readonly dueAt?: unknown;
    };
    if (
      context.kind === "social_opportunity" &&
      Array.isArray(context.participantIds) &&
      context.participantIds.length === 2 &&
      typeof context.participantIds[0] === "string" &&
      context.participantIds[0].trim().length > 0 &&
      typeof context.participantIds[1] === "string" &&
      context.participantIds[1].trim().length > 0 &&
      context.participantIds[0] !== context.participantIds[1] &&
      typeof context.dueAt === "string" &&
      context.dueAt.length > 0
    ) {
      return {
        status: "accepted",
        kind: "social_opportunity",
        payload: {
          participantIds: [
            context.participantIds[0],
            context.participantIds[1],
          ],
          dueAt: context.dueAt,
        },
      };
    }
  }

  throw new DomainInvariantError(
    `World Director affordance ${affordance.id} has malformed or unsupported context`,
  );
}
