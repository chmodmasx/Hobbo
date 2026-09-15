import {
  DomainInvariantError,
  type EntityId,
  type EventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";

export const SOCIAL_BASIS_POINTS = 10_000;

export type PerceptionChannel = "direct" | "reported" | "inferred";

export interface Claim {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
}

export interface PerceptionRecord extends Claim {
  readonly id: string;
  readonly worldId: WorldId;
  readonly observerId: EntityId;
  readonly observedAt: SimTime;
  readonly channel: PerceptionChannel;
  readonly confidenceBps: number;
  readonly sourceEntityId?: EntityId;
  readonly sourceEventId?: EventId;
}

export interface BeliefState extends Claim {
  readonly worldId: WorldId;
  readonly holderId: EntityId;
  readonly confidenceBps: number;
  readonly learnedAt: SimTime;
  readonly updatedAt: SimTime;
  readonly sourcePerceptionId?: string;
}

export interface RelationshipVector {
  readonly familiarity: number;
  readonly trust: number;
  readonly affection: number;
  readonly respect: number;
  readonly attraction: number;
  readonly fear: number;
  readonly resentment: number;
  readonly dependency: number;
}

export type RelationshipDelta = Partial<RelationshipVector>;

const SIGNED_RELATIONSHIP_FIELDS = [
  "trust",
  "affection",
  "respect",
  "attraction",
] as const;

const UNSIGNED_RELATIONSHIP_FIELDS = [
  "familiarity",
  "fear",
  "resentment",
  "dependency",
] as const;

function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return trimmed;
}

function assertBasisPoints(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > SOCIAL_BASIS_POINTS) {
    throw new DomainInvariantError(
      `${label} must be an integer between 0 and ${SOCIAL_BASIS_POINTS}`,
    );
  }
  return value;
}

function assertSignedBasisPoints(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < -SOCIAL_BASIS_POINTS ||
    value > SOCIAL_BASIS_POINTS
  ) {
    throw new DomainInvariantError(
      `${label} must be an integer between -${SOCIAL_BASIS_POINTS} and ${SOCIAL_BASIS_POINTS}`,
    );
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateClaim(claim: Claim): void {
  assertNonBlank(claim.subjectId, "Claim subject");
  assertNonBlank(claim.predicate, "Claim predicate");
}

export function validatePerception(perception: PerceptionRecord): void {
  assertNonBlank(perception.id, "Perception id");
  validateClaim(perception);
  assertBasisPoints(perception.confidenceBps, "Perception confidence");
}

export function validateBelief(belief: BeliefState): void {
  validateClaim(belief);
  assertBasisPoints(belief.confidenceBps, "Belief confidence");
  if (belief.updatedAt < belief.learnedAt) {
    throw new DomainInvariantError("Belief update time cannot precede learning time");
  }
}

/**
 * Explicitly adopts one piece of evidence as a belief. Recording a perception
 * does not call this automatically: belief revision policy remains separate.
 */
export function adoptPerceptionAsBelief(
  perception: PerceptionRecord,
): BeliefState {
  validatePerception(perception);
  return {
    worldId: perception.worldId,
    holderId: perception.observerId,
    subjectId: perception.subjectId,
    predicate: perception.predicate.trim(),
    value: perception.value,
    confidenceBps: perception.confidenceBps,
    learnedAt: perception.observedAt,
    updatedAt: perception.observedAt,
    sourcePerceptionId: perception.id,
  };
}

export function validateRelationshipVector(vector: RelationshipVector): void {
  for (const field of SIGNED_RELATIONSHIP_FIELDS) {
    assertSignedBasisPoints(vector[field], `Relationship ${field}`);
  }
  for (const field of UNSIGNED_RELATIONSHIP_FIELDS) {
    assertBasisPoints(vector[field], `Relationship ${field}`);
  }
}

export function zeroRelationshipVector(): RelationshipVector {
  return {
    familiarity: 0,
    trust: 0,
    affection: 0,
    respect: 0,
    attraction: 0,
    fear: 0,
    resentment: 0,
    dependency: 0,
  };
}

export function applyRelationshipDelta(
  current: RelationshipVector,
  delta: RelationshipDelta,
): RelationshipVector {
  validateRelationshipVector(current);

  for (const [field, value] of Object.entries(delta)) {
    if (!Number.isSafeInteger(value)) {
      throw new DomainInvariantError(`Relationship delta ${field} must be a safe integer`);
    }
  }

  const next: RelationshipVector = {
    familiarity: clamp(
      current.familiarity + (delta.familiarity ?? 0),
      0,
      SOCIAL_BASIS_POINTS,
    ),
    trust: clamp(
      current.trust + (delta.trust ?? 0),
      -SOCIAL_BASIS_POINTS,
      SOCIAL_BASIS_POINTS,
    ),
    affection: clamp(
      current.affection + (delta.affection ?? 0),
      -SOCIAL_BASIS_POINTS,
      SOCIAL_BASIS_POINTS,
    ),
    respect: clamp(
      current.respect + (delta.respect ?? 0),
      -SOCIAL_BASIS_POINTS,
      SOCIAL_BASIS_POINTS,
    ),
    attraction: clamp(
      current.attraction + (delta.attraction ?? 0),
      -SOCIAL_BASIS_POINTS,
      SOCIAL_BASIS_POINTS,
    ),
    fear: clamp(current.fear + (delta.fear ?? 0), 0, SOCIAL_BASIS_POINTS),
    resentment: clamp(
      current.resentment + (delta.resentment ?? 0),
      0,
      SOCIAL_BASIS_POINTS,
    ),
    dependency: clamp(
      current.dependency + (delta.dependency ?? 0),
      0,
      SOCIAL_BASIS_POINTS,
    ),
  };

  validateRelationshipVector(next);
  return next;
}
