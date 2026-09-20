import { ActionRegistry, type ActionRequest } from "@hobbo/actions";
import {
  BEGIN_SLEEP_ACTION_ID,
  CONSUME_FOOD_ACTION_ID,
  WAKE_UP_ACTION_ID,
  beginSleep,
  consumeFood,
  createBeginSleepActionDefinition,
  createConsumeFoodActionDefinition,
  createWakeUpActionDefinition,
  energyAt,
  hungerAt,
  timeUntilEnergyAtLeast,
  timeUntilEnergyAtMost,
  timeUntilHunger,
  wakeUp,
  type PersonState,
} from "@hobbo/agents";
import {
  DeterministicTraceableCognitiveProvider,
  type TraceableCognitiveProvider,
} from "@hobbo/ai-provider/granite";
import { DurableCognitionExecutor } from "@hobbo/cognition";
import {
  retellStatement,
  type ConversationStatement,
  type StatementOrigin,
} from "@hobbo/conversation";
import {
  commitScheduledEventOutcome,
  PostgresCitySpatialRepository,
  PostgresCognitionRepository,
  PostgresConversationDeliveryProcessor,
  PostgresConversationRepository,
  PostgresEmploymentRepository,
  PostgresHousingRepository,
  PostgresMemoryRepository,
  PostgresPersonRepository,
  PostgresPlanningRepository,
  PostgresRoutineRepository,
  PostgresScheduledEventRepository,
  PostgresSocialRepository,
  PostgresWorldDirectorRepository,
  SPATIAL_TRAVEL_ARRIVE_EVENT_TYPE,
  SPATIAL_TRAVEL_DEPART_EVENT_TYPE,
  type PersistedScheduledEvent,
  type PersistedTravelIntent,
  type PersistedWorldDirectorProposal,
  type PlanTravelInput,
} from "@hobbo/database";
import {
  WORLD_DIRECTOR_HARD_MAX_CANDIDATES,
  WORLD_DIRECTOR_HARD_MAX_PEOPLE,
  WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS,
  buildWorldDirectorAffordances,
  proposalFromWorldDirectorAffordance,
  worldDirectorCognitionContext,
  type WorldDirectorCognitionContext,
} from "@hobbo/director";
import {
  DomainInvariantError,
  SIM_DAY,
  SIM_HOUR,
  SIM_SECOND,
  addSimTime,
  asActionId,
  asAffordanceId,
  asCognitionRequestId,
  asCommitmentId,
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asCorrelationId,
  asEmploymentId,
  asEntityId,
  asEventId,
  asMemoryId,
  asPersonId,
  asPlanRevisionId,
  asScheduledEventId,
  asTenancyId,
  simDuration,
  simTime,
  type ActionId,
  type Affordance,
  type ConversationId,
  type EntityId,
  type PersonId,
  type SimDuration,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  COMMITMENT_DUE_EVENT_TYPE,
  conversationAffinityKey,
  entityAffinityKey,
  type CommitmentDuePayload,
  type ScheduledEvent,
} from "@hobbo/simulation";
import {
  derivePlanRevision,
  type LifeGoal,
  type PlanningBusyWindow,
  type PlanRevision,
} from "@hobbo/planning";
import type { Pool } from "pg";

export const PERSON_HUNGER_THRESHOLD_EVENT_TYPE = "person.hunger_threshold";
export const PERSON_ENERGY_LOW_EVENT_TYPE = "person.energy_low";
export const PERSON_ENERGY_RECOVERED_EVENT_TYPE = "person.energy_recovered";

function scheduledTravelId(scheduled: PersistedScheduledEvent): string {
  const payload = scheduled.event.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("travelId" in payload) ||
    typeof payload.travelId !== "string" ||
    payload.travelId.trim().length === 0
  ) {
    throw new DomainInvariantError(
      `Scheduled event ${scheduled.event.id} has no valid travelId`,
    );
  }
  return payload.travelId;
}

export interface ScheduledEventHandlerContext {
  readonly worldId: WorldId;
  readonly workerId: string;
  readonly scheduled: PersistedScheduledEvent;
}

export type ScheduledEventHandler = (
  context: ScheduledEventHandlerContext,
) => Promise<void>;

export class ScheduledEventHandlerRegistry {
  readonly #handlers = new Map<string, ScheduledEventHandler>();

  register(type: string, handler: ScheduledEventHandler): void {
    const normalized = type.trim();
    if (normalized.length === 0) {
      throw new DomainInvariantError("Scheduled-event handler type cannot be blank");
    }
    if (this.#handlers.has(normalized)) {
      throw new DomainInvariantError(
        `Scheduled-event handler already registered: ${normalized}`,
      );
    }
    this.#handlers.set(normalized, handler);
  }

  get(type: string): ScheduledEventHandler | undefined {
    return this.#handlers.get(type);
  }

  has(type: string): boolean {
    return this.#handlers.has(type);
  }
}

export interface ProcessScheduledEventsInput {
  readonly worldId: WorldId;
  readonly through: SimTime;
  readonly workerId: string;
  readonly claimLimit?: number;
  readonly maxEvents?: number;
}

export class DurableScheduledEventWorker {
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #handlers: ScheduledEventHandlerRegistry;

  constructor(
    pool: Pool,
    handlers: ScheduledEventHandlerRegistry = new ScheduledEventHandlerRegistry(),
  ) {
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#handlers = handlers;
  }

  get handlers(): ScheduledEventHandlerRegistry {
    return this.#handlers;
  }

  async processThrough(input: ProcessScheduledEventsInput): Promise<number> {
    if (input.workerId.trim().length === 0) {
      throw new DomainInvariantError("Runtime workerId cannot be blank");
    }
    const claimLimit = input.claimLimit ?? 100;
    const maxEvents = input.maxEvents ?? 1_000_000;
    if (!Number.isSafeInteger(claimLimit) || claimLimit <= 0) {
      throw new DomainInvariantError("Runtime claimLimit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new DomainInvariantError("Runtime maxEvents must be a positive safe integer");
    }

    let processed = 0;
    while (processed < maxEvents) {
      const remaining = maxEvents - processed;
      const claimed = await this.#schedules.claimDue(
        input.worldId,
        input.through,
        input.workerId,
        Math.min(claimLimit, remaining),
      );
      if (claimed.length === 0) return processed;

      for (const scheduled of claimed) {
        const handler = this.#handlers.get(scheduled.event.type);
        if (handler === undefined) {
          // Deliberately fail closed. The claim remains leased/processing and can
          // be requeued after code/configuration is corrected; silently skipping
          // an unknown world event would destroy causal history.
          throw new DomainInvariantError(
            `No scheduled-event handler registered for ${scheduled.event.type}`,
          );
        }
        await handler({
          worldId: input.worldId,
          workerId: input.workerId,
          scheduled,
        });
        processed += 1;
      }
    }

    throw new DomainInvariantError(
      `Runtime maxEvents ${maxEvents} reached before world ${input.worldId} became idle through ${input.through}`,
    );
  }

  async requeueStale(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    return this.#schedules.requeueStale(worldId, staleBefore, limit);
  }
}

export interface PhysiologyRuntimePolicy {
  readonly hungerThreshold: number;
  readonly sleepThreshold: number;
  readonly wakeThreshold: number;
}

export const DEFAULT_PHYSIOLOGY_RUNTIME_POLICY: PhysiologyRuntimePolicy = {
  hungerThreshold: 7_000,
  sleepThreshold: 2_500,
  wakeThreshold: 9_000,
};

function assertBasisPointThreshold(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new DomainInvariantError(`${label} must be an integer in [0, 10000]`);
  }
}

function validatePhysiologyPolicy(
  policy: PhysiologyRuntimePolicy,
): PhysiologyRuntimePolicy {
  assertBasisPointThreshold(policy.hungerThreshold, "hungerThreshold");
  assertBasisPointThreshold(policy.sleepThreshold, "sleepThreshold");
  assertBasisPointThreshold(policy.wakeThreshold, "wakeThreshold");
  if (policy.wakeThreshold <= policy.sleepThreshold) {
    throw new DomainInvariantError(
      "wakeThreshold must be greater than sleepThreshold",
    );
  }
  return { ...policy };
}

function personPayload(personId: PersonId): { readonly personId: string } {
  return { personId: String(personId) };
}

function hungerScheduledEvent(
  person: PersonState,
  from: SimTime,
  policy: PhysiologyRuntimePolicy,
): ScheduledEvent | undefined {
  const wait = timeUntilHunger(person.hunger, policy.hungerThreshold, from);
  if (wait === undefined) return undefined;
  return {
    id: asScheduledEventId(
      `runtime:hunger:${person.id}:after-meal-${person.mealsEaten}`,
    ),
    dueAt: addSimTime(from, wait),
    type: PERSON_HUNGER_THRESHOLD_EVENT_TYPE,
    payload: personPayload(person.id),
    correlationId: asCorrelationId(
      `runtime:hunger:${person.id}:${person.mealsEaten}`,
    ),
    affinityKeys: [entityAffinityKey(String(person.id))],
  };
}

function sleepScheduledEvent(
  person: PersonState,
  from: SimTime,
  policy: PhysiologyRuntimePolicy,
): ScheduledEvent | undefined {
  const wait = timeUntilEnergyAtMost(person.energy, policy.sleepThreshold, from);
  if (wait === undefined) return undefined;
  const session = person.sleepSessions + 1;
  return {
    id: asScheduledEventId(`runtime:sleep:${person.id}:session-${session}`),
    dueAt: addSimTime(from, wait),
    type: PERSON_ENERGY_LOW_EVENT_TYPE,
    payload: personPayload(person.id),
    correlationId: asCorrelationId(`runtime:sleep:${person.id}:${session}`),
    affinityKeys: [entityAffinityKey(String(person.id))],
  };
}

function wakeScheduledEvent(
  person: PersonState,
  from: SimTime,
  policy: PhysiologyRuntimePolicy,
): ScheduledEvent | undefined {
  const wait = timeUntilEnergyAtLeast(person.energy, policy.wakeThreshold, from);
  if (wait === undefined) return undefined;
  return {
    id: asScheduledEventId(
      `runtime:wake:${person.id}:session-${person.sleepSessions}`,
    ),
    dueAt: addSimTime(from, wait),
    type: PERSON_ENERGY_RECOVERED_EVENT_TYPE,
    payload: personPayload(person.id),
    correlationId: asCorrelationId(
      `runtime:wake:${person.id}:${person.sleepSessions}`,
    ),
    affinityKeys: [entityAffinityKey(String(person.id))],
  };
}

function energyScheduledEvent(
  person: PersonState,
  from: SimTime,
  policy: PhysiologyRuntimePolicy,
): ScheduledEvent | undefined {
  return person.energy.mode === "awake"
    ? sleepScheduledEvent(person, from, policy)
    : wakeScheduledEvent(person, from, policy);
}

export class DurablePhysiologyRuntime {
  readonly #pool: Pool;
  readonly #people: PostgresPersonRepository;
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #policy: PhysiologyRuntimePolicy;
  readonly #actions = new ActionRegistry<PersonState>();

  constructor(
    pool: Pool,
    policy: PhysiologyRuntimePolicy = DEFAULT_PHYSIOLOGY_RUNTIME_POLICY,
  ) {
    this.#pool = pool;
    this.#people = new PostgresPersonRepository(pool);
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#policy = validatePhysiologyPolicy(policy);
    this.#actions.register(createConsumeFoodActionDefinition());
    this.#actions.register(createBeginSleepActionDefinition());
    this.#actions.register(createWakeUpActionDefinition());
  }

  get policy(): PhysiologyRuntimePolicy {
    return { ...this.#policy };
  }

  async scheduleInitial(
    worldId: WorldId,
    personId: PersonId,
    from: SimTime,
  ): Promise<readonly ScheduledEvent[]> {
    const current = await this.#people.get(worldId, personId);
    if (current === undefined) {
      throw new DomainInvariantError(`Person does not exist: ${personId}`);
    }
    const events = [
      hungerScheduledEvent(current.person, from, this.#policy),
      energyScheduledEvent(current.person, from, this.#policy),
    ].filter((event): event is ScheduledEvent => event !== undefined);
    await this.#schedules.scheduleMany(worldId, events);
    return events;
  }

  async handleHunger(context: ScheduledEventHandlerContext): Promise<void> {
    const personId = this.#targetPerson(context);
    const at = context.scheduled.event.dueAt;
    const current = await this.#requirePerson(context.worldId, personId);
    const hunger = hungerAt(current.person.hunger, at);
    if (hunger < this.#policy.hungerThreshold) {
      throw new DomainInvariantError(
        `Hunger event fired before threshold for ${personId}: ${hunger} < ${this.#policy.hungerThreshold}`,
      );
    }

    if (current.person.energy.mode === "sleeping") {
      const wait = timeUntilEnergyAtLeast(
        current.person.energy,
        this.#policy.wakeThreshold,
        at,
      );
      if (wait === undefined) {
        throw new DomainInvariantError(
          `Sleeping hungry person ${personId} has no wake threshold`,
        );
      }
      const retryAt = addSimTime(at, wait);
      const retry: ScheduledEvent = {
        id: asScheduledEventId(`${context.scheduled.event.id}:deferred`),
        dueAt: retryAt,
        type: PERSON_HUNGER_THRESHOLD_EVENT_TYPE,
        payload: personPayload(personId),
        correlationId: context.scheduled.event.correlationId,
        causationId: asEventId(`runtime:hunger-deferred:${context.scheduled.event.id}`),
        affinityKeys: [entityAffinityKey(String(personId))],
      };
      await commitScheduledEventOutcome(this.#pool, {
        worldId: context.worldId,
        eventId: context.scheduled.event.id,
        workerId: context.workerId,
        processedAt: at,
        domainEvents: [
          {
            id: asEventId(`runtime:hunger-deferred:${context.scheduled.event.id}`),
            worldId: context.worldId,
            simTime: at,
            type: "person.hunger_deferred",
            actorId: asEntityId(String(personId)),
            payload: { retryAt: retryAt.toString() },
            correlationId: context.scheduled.event.correlationId,
          },
        ],
        scheduledEvents: [retry],
      });
      return;
    }

    const food = current.person.inventory[0];
    if (food === undefined) {
      throw new DomainInvariantError(`Person ${personId} has no available food`);
    }
    this.#validateAction(
      current.person,
      context,
      CONSUME_FOOD_ACTION_ID,
      { itemId: food.id },
    );

    const simulated = consumeFood(current.person, food.id, at);
    const next = hungerScheduledEvent(simulated.person, at, this.#policy);
    await this.#people.consumeFoodClaimed({
      worldId: context.worldId,
      personId,
      itemId: food.id,
      scheduledEventId: context.scheduled.event.id,
      workerId: context.workerId,
      scheduledConsequences: next === undefined ? [] : [next],
    });
  }

  async handleEnergyLow(context: ScheduledEventHandlerContext): Promise<void> {
    const personId = this.#targetPerson(context);
    const at = context.scheduled.event.dueAt;
    const current = await this.#requirePerson(context.worldId, personId);
    if (current.person.energy.mode !== "awake") {
      throw new DomainInvariantError(`Energy-low event targeted sleeping person ${personId}`);
    }
    const energy = energyAt(current.person.energy, at);
    if (energy > this.#policy.sleepThreshold) {
      throw new DomainInvariantError(
        `Energy-low event fired before threshold for ${personId}: ${energy} > ${this.#policy.sleepThreshold}`,
      );
    }
    this.#validateAction(current.person, context, BEGIN_SLEEP_ACTION_ID, null);

    const simulated = beginSleep(current.person, at);
    const next = wakeScheduledEvent(simulated, at, this.#policy);
    if (next === undefined) {
      throw new DomainInvariantError(`Sleep transition produced no wake event for ${personId}`);
    }
    await this.#people.beginSleepClaimed({
      worldId: context.worldId,
      personId,
      scheduledEventId: context.scheduled.event.id,
      workerId: context.workerId,
      scheduledConsequences: [next],
    });
  }

  async handleEnergyRecovered(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const personId = this.#targetPerson(context);
    const at = context.scheduled.event.dueAt;
    const current = await this.#requirePerson(context.worldId, personId);
    if (current.person.energy.mode !== "sleeping") {
      throw new DomainInvariantError(
        `Energy-recovered event targeted awake person ${personId}`,
      );
    }
    const energy = energyAt(current.person.energy, at);
    if (energy < this.#policy.wakeThreshold) {
      throw new DomainInvariantError(
        `Energy-recovered event fired before threshold for ${personId}: ${energy} < ${this.#policy.wakeThreshold}`,
      );
    }
    this.#validateAction(current.person, context, WAKE_UP_ACTION_ID, null);

    const simulated = wakeUp(current.person, at);
    const next = sleepScheduledEvent(simulated, at, this.#policy);
    if (next === undefined) {
      throw new DomainInvariantError(`Wake transition produced no sleep event for ${personId}`);
    }
    await this.#people.wakeUpClaimed({
      worldId: context.worldId,
      personId,
      scheduledEventId: context.scheduled.event.id,
      workerId: context.workerId,
      scheduledConsequences: [next],
    });
  }

  #targetPerson(context: ScheduledEventHandlerContext): PersonId {
    const payload = context.scheduled.event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new DomainInvariantError(
        `Scheduled event ${context.scheduled.event.id} payload must be an object`,
      );
    }
    const personId = (payload as Record<string, unknown>).personId;
    if (typeof personId !== "string" || personId.length === 0) {
      throw new DomainInvariantError(
        `Scheduled event ${context.scheduled.event.id} payload has no personId`,
      );
    }
    return asPersonId(personId);
  }

  async #requirePerson(worldId: WorldId, personId: PersonId) {
    const person = await this.#people.get(worldId, personId);
    if (person === undefined) {
      throw new DomainInvariantError(`Person does not exist: ${personId}`);
    }
    return person;
  }

  #validateAction(
    person: PersonState,
    context: ScheduledEventHandlerContext,
    actionId: ActionId,
    input: unknown,
  ): void {
    const request: ActionRequest = {
      actionId,
      actorId: asEntityId(String(person.id)),
      origin: "rule",
      requestedAt: context.scheduled.event.dueAt,
      correlationId: context.scheduled.event.correlationId,
      input,
    };
    const validation = this.#actions.validate(request, {
      actorId: request.actorId,
      simTime: request.requestedAt,
      worldState: person,
    });
    if (!validation.ok) {
      throw new DomainInvariantError(
        `Runtime action ${actionId} rejected for ${person.id}: ${validation.code}`,
      );
    }
  }
}

export interface ParsedCommitmentDue {
  readonly commitmentId: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly payload: unknown;
}

function parseCommitmentDue(
  scheduled: PersistedScheduledEvent,
): ParsedCommitmentDue {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `Commitment event ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Partial<CommitmentDuePayload>;
  if (
    typeof payload.commitmentId !== "string" ||
    payload.commitmentId.length === 0 ||
    typeof payload.ownerId !== "string" ||
    payload.ownerId.length === 0 ||
    typeof payload.kind !== "string" ||
    payload.kind.length === 0 ||
    !("payload" in payload)
  ) {
    throw new DomainInvariantError(
      `Commitment event ${scheduled.event.id} payload is malformed`,
    );
  }
  return {
    commitmentId: payload.commitmentId,
    ownerId: payload.ownerId,
    kind: payload.kind,
    payload: payload.payload,
  };
}

function nestedRequiredString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(`Commitment payload must contain ${key}`);
  }
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested !== "string" || nested.length === 0) {
    throw new DomainInvariantError(`Commitment payload has no ${key}`);
  }
  return nested;
}

export type CommitmentKindHandler = (
  context: ScheduledEventHandlerContext,
  due: ParsedCommitmentDue,
) => Promise<void>;

export class DurableCommitmentDispatcher {
  readonly #kinds = new Map<string, CommitmentKindHandler>();

  register(kind: string, handler: CommitmentKindHandler): void {
    const normalized = kind.trim();
    if (normalized.length === 0) {
      throw new DomainInvariantError("Commitment kind cannot be blank");
    }
    if (this.#kinds.has(normalized)) {
      throw new DomainInvariantError(`Commitment handler already registered: ${normalized}`);
    }
    this.#kinds.set(normalized, handler);
  }

  async handle(context: ScheduledEventHandlerContext): Promise<void> {
    const due = parseCommitmentDue(context.scheduled);
    const handler = this.#kinds.get(due.kind);
    if (handler === undefined) {
      throw new DomainInvariantError(
        `No commitment handler registered for ${due.kind}`,
      );
    }
    await handler(context, due);
  }
}


export const SOCIAL_CONVERSATION_OPPORTUNITY_EVENT_TYPE =
  "social.conversation_opportunity";

export interface SocialSeedClaim {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
  readonly origin: StatementOrigin;
}

export interface SocialRuntimePolicy {
  readonly period: SimDuration;
  readonly wakeThreshold: number;
  readonly minimumRetellConfidenceBps: number;
  readonly mutationModulo: number;
}

export const DEFAULT_SOCIAL_RUNTIME_POLICY: SocialRuntimePolicy = {
  period: SIM_DAY,
  wakeThreshold: DEFAULT_PHYSIOLOGY_RUNTIME_POLICY.wakeThreshold,
  minimumRetellConfidenceBps: 3_000,
  mutationModulo: 8,
};

interface SocialOpportunityPayload {
  readonly personId: string;
  readonly listenerId?: string;
  readonly occurrence: number;
  readonly anchorDueAt: string;
}

interface SocialClaimCandidate {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
  readonly origin: StatementOrigin;
  readonly sourceStatement?: ConversationStatement;
  readonly heardFrom?: EntityId;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function socialClaimKey(subjectId: string, predicate: string): string {
  return `${subjectId}\u0000${predicate}`;
}

function socialMetadata(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseStatementOrigin(value: unknown): StatementOrigin | undefined {
  return value === "direct" ||
    value === "reported" ||
    value === "inferred" ||
    value === "fabricated"
    ? value
    : undefined;
}

function validateSocialRuntimePolicy(
  input: Partial<SocialRuntimePolicy>,
): SocialRuntimePolicy {
  const policy: SocialRuntimePolicy = {
    ...DEFAULT_SOCIAL_RUNTIME_POLICY,
    ...input,
  };
  if (policy.period <= 0n) {
    throw new DomainInvariantError("Social runtime period must be positive");
  }
  assertBasisPointThreshold(policy.wakeThreshold, "social wakeThreshold");
  assertBasisPointThreshold(
    policy.minimumRetellConfidenceBps,
    "minimumRetellConfidenceBps",
  );
  if (
    !Number.isSafeInteger(policy.mutationModulo) ||
    policy.mutationModulo < 2
  ) {
    throw new DomainInvariantError(
      "Social runtime mutationModulo must be a safe integer >= 2",
    );
  }
  return policy;
}

function parseSocialOpportunity(
  scheduled: PersistedScheduledEvent,
): SocialOpportunityPayload {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `Social event ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.personId !== "string" ||
    payload.personId.length === 0 ||
    (payload.listenerId !== undefined &&
      (typeof payload.listenerId !== "string" ||
        payload.listenerId.length === 0)) ||
    typeof payload.occurrence !== "number" ||
    !Number.isSafeInteger(payload.occurrence) ||
    payload.occurrence <= 0 ||
    typeof payload.anchorDueAt !== "string"
  ) {
    throw new DomainInvariantError(
      `Social event ${scheduled.event.id} payload is malformed`,
    );
  }
  simTime(payload.anchorDueAt);
  return {
    personId: payload.personId,
    ...(payload.listenerId === undefined
      ? {}
      : { listenerId: payload.listenerId as string }),
    occurrence: payload.occurrence,
    anchorDueAt: payload.anchorDueAt,
  };
}

function bootstrapSocialOpportunityEvent(
  personId: PersonId,
  occurrence: number,
  dueAt: SimTime,
  anchorDueAt: SimTime = dueAt,
  suffix = "",
): ScheduledEvent {
  return {
    id: asScheduledEventId(
      `runtime:social:${personId}:opportunity-${occurrence}${suffix}`,
    ),
    dueAt,
    type: SOCIAL_CONVERSATION_OPPORTUNITY_EVENT_TYPE,
    payload: {
      personId: String(personId),
      occurrence,
      anchorDueAt: anchorDueAt.toString(),
    } satisfies SocialOpportunityPayload,
    correlationId: asCorrelationId(
      `runtime:social:${personId}:${occurrence}`,
    ),
    affinityKeys: [entityAffinityKey(String(personId))],
  };
}

function socialOpportunityEvent(
  personId: PersonId,
  listenerId: EntityId,
  occurrence: number,
  dueAt: SimTime,
  anchorDueAt: SimTime = dueAt,
  suffix = "",
): ScheduledEvent {
  return {
    id: asScheduledEventId(
      `runtime:social:${personId}:opportunity-${occurrence}${suffix}`,
    ),
    dueAt,
    type: SOCIAL_CONVERSATION_OPPORTUNITY_EVENT_TYPE,
    payload: {
      personId: String(personId),
      listenerId: String(listenerId),
      occurrence,
      anchorDueAt: anchorDueAt.toString(),
    } satisfies SocialOpportunityPayload,
    correlationId: asCorrelationId(
      `runtime:social:${personId}:${occurrence}`,
    ),
    affinityKeys: [
      entityAffinityKey(String(personId)),
      entityAffinityKey(String(listenerId)),
    ],
  };
}

function mutateSocialValue(
  value: unknown,
  key: string,
  modulo: number,
): { readonly value: unknown; readonly mutated: boolean } {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    stableHash(`${key}:mutate`) % modulo !== 0
  ) {
    return { value, mutated: false };
  }
  const magnitude = 1 + (stableHash(`${key}:magnitude`) % 3);
  const direction = stableHash(`${key}:direction`) % 2 === 0 ? 1 : -1;
  return {
    value: Math.max(0, value + direction * magnitude),
    mutated: true,
  };
}

export class DurableSocialRuntime {
  readonly #pool: Pool;
  readonly #people: PostgresPersonRepository;
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #conversations: PostgresConversationRepository;
  readonly #deliveries: PostgresConversationDeliveryProcessor;
  readonly #memories: PostgresMemoryRepository;
  readonly #social: PostgresSocialRepository;
  readonly #policy: SocialRuntimePolicy;

  constructor(pool: Pool, policy: Partial<SocialRuntimePolicy> = {}) {
    this.#pool = pool;
    this.#people = new PostgresPersonRepository(pool);
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#conversations = new PostgresConversationRepository(pool);
    this.#deliveries = new PostgresConversationDeliveryProcessor(pool);
    this.#memories = new PostgresMemoryRepository(pool);
    this.#social = new PostgresSocialRepository(pool);
    this.#policy = validateSocialRuntimePolicy(policy);
  }

  get policy(): SocialRuntimePolicy {
    return { ...this.#policy };
  }

  async seedClaim(
    worldId: WorldId,
    ownerId: EntityId,
    at: SimTime,
    claim: SocialSeedClaim,
  ): Promise<void> {
    const subjectId = claim.subjectId.trim();
    const predicate = claim.predicate.trim();
    if (subjectId.length === 0 || predicate.length === 0) {
      throw new DomainInvariantError("Social seed claim identity cannot be blank");
    }
    assertBasisPointThreshold(claim.confidenceBps, "Social seed confidence");

    await this.#social.putBelief({
      worldId,
      holderId: ownerId,
      subjectId,
      predicate,
      value: claim.value,
      confidenceBps: claim.confidenceBps,
      learnedAt: at,
      updatedAt: at,
    });
    await this.#memories.createMemory({
      id: asMemoryId(
        `social:seed:${ownerId}:${subjectId}:${predicate}`,
      ),
      worldId,
      ownerId,
      category: "semantic",
      occurredAt: at,
      content: `Known claim: ${subjectId} ${predicate}`,
      importanceBps: 7_000,
      emotionalStrengthBps: 0,
      relatedEntityIds: [],
      metadata: {
        kind: "social.seed_claim",
        subjectId,
        predicate,
        origin: claim.origin,
      },
    });
  }

  async scheduleInitial(
    worldId: WorldId,
    personId: PersonId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent> {
    if ((await this.#people.get(worldId, personId)) === undefined) {
      throw new DomainInvariantError(
        `Cannot schedule social opportunity for missing person ${personId}`,
      );
    }
    const listenerId = await this.#pickListenerIfAvailable(
      worldId,
      personId,
      1,
    );
    const event =
      listenerId === undefined
        ? bootstrapSocialOpportunityEvent(personId, 1, dueAt)
        : socialOpportunityEvent(personId, listenerId, 1, dueAt);
    await this.#schedules.schedule(worldId, event);
    return event;
  }

  async handleOpportunity(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const payload = parseSocialOpportunity(context.scheduled);
    const personId = asPersonId(payload.personId);
    const at = context.scheduled.event.dueAt;
    const anchorDueAt = simTime(payload.anchorDueAt);
    const person = await this.#people.get(context.worldId, personId);
    if (person === undefined) {
      throw new DomainInvariantError(
        `Social opportunity targets missing person ${personId}`,
      );
    }

    if (payload.listenerId === undefined) {
      // Events persisted before scheduler affinity existed only carried the
      // speaker identity. Upgrade them atomically before any listener state is
      // touched so the replacement is claimed with both entity resources.
      const listenerId = await this.#pickListener(
        context.worldId,
        personId,
        payload.occurrence,
      );
      const upgraded = socialOpportunityEvent(
        personId,
        listenerId,
        payload.occurrence,
        at,
        anchorDueAt,
        `:affinity-upgrade:${context.scheduled.event.id}`,
      );
      await commitScheduledEventOutcome(this.#pool, {
        worldId: context.worldId,
        eventId: context.scheduled.event.id,
        workerId: context.workerId,
        processedAt: at,
        domainEvents: [
          {
            id: asEventId(
              `runtime:social-affinity-upgraded:${context.scheduled.event.id}`,
            ),
            worldId: context.worldId,
            simTime: at,
            type: "social.opportunity_affinity_upgraded",
            actorId: asEntityId(String(personId)),
            targetIds: [listenerId],
            payload: {
              occurrence: payload.occurrence,
              replacementEventId: String(upgraded.id),
            },
            correlationId: context.scheduled.event.correlationId,
          },
        ],
        scheduledEvents: [upgraded],
      });
      return;
    }

    const listenerId = asEntityId(payload.listenerId);

    if (person.person.energy.mode === "sleeping") {
      const wait = timeUntilEnergyAtLeast(
        person.person.energy,
        this.#policy.wakeThreshold,
        at,
      );
      if (wait === undefined) {
        throw new DomainInvariantError(
          `Sleeping social actor ${personId} has no wake threshold`,
        );
      }
      const retryAt = addSimTime(
        at,
        wait === 0n ? SIM_SECOND : wait,
      );
      const retry = socialOpportunityEvent(
        personId,
        listenerId,
        payload.occurrence,
        retryAt,
        anchorDueAt,
        `:deferred:${context.scheduled.event.id}`,
      );
      const eventId = asEventId(
        `runtime:social-deferred:${context.scheduled.event.id}`,
      );
      await commitScheduledEventOutcome(this.#pool, {
        worldId: context.worldId,
        eventId: context.scheduled.event.id,
        workerId: context.workerId,
        processedAt: at,
        domainEvents: [
          {
            id: eventId,
            worldId: context.worldId,
            simTime: at,
            type: "social.opportunity_deferred",
            actorId: asEntityId(String(personId)),
            payload: {
              occurrence: payload.occurrence,
              retryAt: retryAt.toString(),
            },
            correlationId: context.scheduled.event.correlationId,
          },
        ],
        scheduledEvents: [retry],
      });
      return;
    }

    if (
      (await this.#people.get(
        context.worldId,
        asPersonId(String(listenerId)),
      )) === undefined
    ) {
      throw new DomainInvariantError(
        `Social opportunity listener is missing: ${listenerId}`,
      );
    }
    const conversationId = asConversationId(
      `runtime:social:conversation:${personId}:${payload.occurrence}`,
    );
    const messageId = asConversationMessageId(
      `runtime:social:message:${personId}:${payload.occurrence}`,
    );
    const sourceEventId = asEventId(
      `runtime:social-conversation:${personId}:${payload.occurrence}`,
    );

    await this.#conversations.createConversation({
      id: conversationId,
      worldId: context.worldId,
      participantIds: [asEntityId(String(personId)), listenerId],
      startedAt: at,
      maxTurns: 1,
    });

    const claim = await this.#pickClaim(
      context.worldId,
      asEntityId(String(personId)),
      payload.occurrence,
    );
    const utterance =
      claim === undefined
        ? undefined
        : this.#statementFromClaim(personId, payload.occurrence, claim);

    await this.#conversations.appendMessage({
      id: messageId,
      worldId: context.worldId,
      conversationId,
      speakerId: asEntityId(String(personId)),
      sentAt: at,
      text:
        utterance === undefined
          ? "We exchanged ordinary small talk."
          : `I heard something about ${utterance.statement.subjectId}.`,
      statements: utterance === undefined ? [] : [utterance.statement],
    });
    await this.#ensureMessageDelivery(
      context.worldId,
      messageId,
      context.workerId,
    );

    let nextOccurrence = payload.occurrence + 1;
    let nextAnchor = addSimTime(anchorDueAt, this.#policy.period);
    while (nextAnchor <= at) {
      nextAnchor = addSimTime(nextAnchor, this.#policy.period);
      nextOccurrence += 1;
    }
    const nextListenerId = await this.#pickListener(
      context.worldId,
      personId,
      nextOccurrence,
    );
    const next = socialOpportunityEvent(
      personId,
      nextListenerId,
      nextOccurrence,
      nextAnchor,
      nextAnchor,
    );

    await commitScheduledEventOutcome(this.#pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: at,
      domainEvents: [
        {
          id: sourceEventId,
          worldId: context.worldId,
          simTime: at,
          type: "social.conversation_completed",
          actorId: asEntityId(String(personId)),
          targetIds: [listenerId],
          payload: {
            conversationId: String(conversationId),
            messageId: String(messageId),
            occurrence: payload.occurrence,
            statementCount: utterance === undefined ? 0 : 1,
            retold: utterance?.retold ?? false,
            mutated: utterance?.mutated ?? false,
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
      scheduledEvents: [next],
    });
  }

  async requeueStaleDeliveries(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    return this.#conversations.requeueStaleDeliveries(
      worldId,
      staleBefore,
      limit,
    );
  }

  async #pickListenerIfAvailable(
    worldId: WorldId,
    speakerId: PersonId,
    occurrence: number,
  ): Promise<EntityId | undefined> {
    const candidates = (await this.#people.listIds(worldId))
      .filter((candidate) => candidate !== speakerId)
      .map((candidate) => asEntityId(String(candidate)));
    if (candidates.length === 0) return undefined;
    const index =
      stableHash(`${speakerId}:${occurrence}:listener`) % candidates.length;
    return candidates[index]!;
  }

  async #pickListener(
    worldId: WorldId,
    speakerId: PersonId,
    occurrence: number,
  ): Promise<EntityId> {
    const listener = await this.#pickListenerIfAvailable(
      worldId,
      speakerId,
      occurrence,
    );
    if (listener === undefined) {
      throw new DomainInvariantError(
        `Social actor ${speakerId} has no available listener`,
      );
    }
    return listener;
  }

  async #pickClaim(
    worldId: WorldId,
    speakerId: EntityId,
    occurrence: number,
  ): Promise<SocialClaimCandidate | undefined> {
    const beliefs = await this.#social.listBeliefs(worldId, speakerId);
    const beliefByKey = new Map(
      beliefs
        .filter(
          (belief) =>
            belief.confidenceBps >= this.#policy.minimumRetellConfidenceBps,
        )
        .map((belief) => [
          socialClaimKey(belief.subjectId, belief.predicate),
          belief,
        ] as const),
    );
    if (beliefByKey.size === 0) return undefined;

    const memories = await this.#memories.listMemories(worldId, speakerId);
    const heard: SocialClaimCandidate[] = [];
    const seeded: SocialClaimCandidate[] = [];

    for (const memory of memories) {
      const metadata = socialMetadata(memory.metadata);
      if (metadata === undefined) continue;

      if (metadata.kind === "social.seed_claim") {
        const subjectId = metadata.subjectId;
        const predicate = metadata.predicate;
        const origin = parseStatementOrigin(metadata.origin);
        if (
          typeof subjectId !== "string" ||
          typeof predicate !== "string" ||
          origin === undefined
        ) {
          continue;
        }
        const belief = beliefByKey.get(socialClaimKey(subjectId, predicate));
        if (belief === undefined) continue;
        seeded.push({
          subjectId: belief.subjectId,
          predicate: belief.predicate,
          value: belief.value,
          confidenceBps: belief.confidenceBps,
          origin,
        });
        continue;
      }

      if (
        metadata.role !== "listener" ||
        typeof metadata.messageId !== "string"
      ) {
        continue;
      }
      const message = await this.#conversations.getMessage(
        worldId,
        asConversationMessageId(metadata.messageId),
      );
      if (message === undefined) continue;
      for (const statement of message.statements) {
        const belief = beliefByKey.get(
          socialClaimKey(statement.subjectId, statement.predicate),
        );
        if (belief === undefined) continue;
        heard.push({
          subjectId: statement.subjectId,
          predicate: statement.predicate,
          value: statement.value,
          confidenceBps: belief.confidenceBps,
          origin: "reported",
          sourceStatement: statement,
          heardFrom: message.speakerId,
        });
      }
    }

    const candidates = heard.length > 0 ? heard : seeded;
    candidates.sort((left, right) => {
      const leftKey =
        left.sourceStatement === undefined
          ? socialClaimKey(left.subjectId, left.predicate)
          : String(left.sourceStatement.id);
      const rightKey =
        right.sourceStatement === undefined
          ? socialClaimKey(right.subjectId, right.predicate)
          : String(right.sourceStatement.id);
      return leftKey.localeCompare(rightKey);
    });
    if (candidates.length === 0) return undefined;
    return candidates[
      stableHash(`${speakerId}:${occurrence}:claim`) % candidates.length
    ];
  }

  #statementFromClaim(
    speakerId: PersonId,
    occurrence: number,
    claim: SocialClaimCandidate,
  ): {
    readonly statement: ConversationStatement;
    readonly retold: boolean;
    readonly mutated: boolean;
  } {
    const id = asConversationStatementId(
      `runtime:social:statement:${speakerId}:${occurrence}`,
    );
    const mutation = mutateSocialValue(
      claim.value,
      `${speakerId}:${occurrence}`,
      this.#policy.mutationModulo,
    );

    if (claim.sourceStatement === undefined) {
      return {
        statement: {
          id,
          subjectId: claim.subjectId,
          predicate: claim.predicate,
          value: mutation.value,
          confidenceBps: claim.confidenceBps,
          origin: claim.origin,
          hopCount: 0,
        },
        retold: false,
        mutated: mutation.mutated,
      };
    }

    const confidenceLoss =
      stableHash(`${speakerId}:${occurrence}:confidence-loss`) % 501;
    return {
      statement: retellStatement({
        id,
        source: claim.sourceStatement,
        confidenceBps: Math.max(
          this.#policy.minimumRetellConfidenceBps,
          claim.confidenceBps - confidenceLoss,
        ),
        value: mutation.value,
        ...(claim.heardFrom === undefined
          ? {}
          : { claimedSourceEntityId: claim.heardFrom }),
      }),
      retold: true,
      mutated: mutation.mutated,
    };
  }

  async #ensureMessageDelivery(
    worldId: WorldId,
    messageId: ReturnType<typeof asConversationMessageId>,
    workerId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const deliveries = await this.#conversations.listDeliveries(
        worldId,
        messageId,
      );
      if (deliveries.length !== 1) {
        throw new DomainInvariantError(
          `Expected one delivery for social message ${messageId}, found ${deliveries.length}`,
        );
      }
      const target = deliveries[0]!;
      if (target.status === "completed") return;

      if (target.status === "processing") {
        if (target.lockedBy !== workerId) {
          throw new DomainInvariantError(
            `Social delivery ${messageId} is leased by ${target.lockedBy ?? "another worker"}`,
          );
        }
        await this.#deliveries.processClaim(target, workerId);
        continue;
      }

      const delivery = await this.#conversations.claimDelivery(
        worldId,
        messageId,
        target.listenerId,
        workerId,
      );
      if (delivery === undefined) {
        throw new DomainInvariantError(
          `Social delivery ${messageId}:${target.listenerId} could not be claimed in listener order`,
        );
      }
      await this.#deliveries.processClaim(delivery, workerId);
    }
    throw new DomainInvariantError(
      `Social delivery ${messageId} did not converge after 100 claims`,
    );
  }
}


export const PLANNING_REVIEW_EVENT_TYPE = "planning.review";

export interface PlanningRuntimePolicy {
  readonly period: SimDuration;
  readonly horizon: SimDuration;
  readonly reflectionLookback: SimDuration;
  readonly employmentBusyDuration: SimDuration;
  readonly socialBusyDuration: SimDuration;
  readonly wakeThreshold: number;
}

export const DEFAULT_PLANNING_RUNTIME_POLICY: PlanningRuntimePolicy = {
  period: SIM_DAY,
  horizon: (BigInt(SIM_DAY) * 7n) as SimDuration,
  reflectionLookback: SIM_DAY,
  employmentBusyDuration: (BigInt(SIM_HOUR) * 4n) as SimDuration,
  socialBusyDuration: SIM_HOUR,
  wakeThreshold: DEFAULT_PHYSIOLOGY_RUNTIME_POLICY.wakeThreshold,
};

interface PlanningReviewPayload {
  readonly personId: string;
  readonly occurrence: number;
  readonly anchorDueAt: string;
  readonly deferredBy: readonly string[];
}

function validatePlanningRuntimePolicy(
  input: Partial<PlanningRuntimePolicy>,
): PlanningRuntimePolicy {
  const policy: PlanningRuntimePolicy = {
    ...DEFAULT_PLANNING_RUNTIME_POLICY,
    ...input,
  };
  if (policy.period <= 0n) {
    throw new DomainInvariantError("Planning review period must be positive");
  }
  if (policy.horizon <= 0n) {
    throw new DomainInvariantError("Planning horizon must be positive");
  }
  if (policy.reflectionLookback <= 0n) {
    throw new DomainInvariantError(
      "Planning reflection lookback must be positive",
    );
  }
  if (policy.employmentBusyDuration <= 0n) {
    throw new DomainInvariantError(
      "Planning employment busy duration must be positive",
    );
  }
  if (policy.socialBusyDuration <= 0n) {
    throw new DomainInvariantError(
      "Planning social busy duration must be positive",
    );
  }
  assertBasisPointThreshold(policy.wakeThreshold, "planning wakeThreshold");
  return policy;
}

function parsePlanningReview(
  scheduled: PersistedScheduledEvent,
): PlanningReviewPayload {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `Planning event ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Record<string, unknown>;
  const deferredBy = payload.deferredBy;
  if (
    typeof payload.personId !== "string" ||
    payload.personId.length === 0 ||
    typeof payload.occurrence !== "number" ||
    !Number.isSafeInteger(payload.occurrence) ||
    payload.occurrence <= 0 ||
    typeof payload.anchorDueAt !== "string" ||
    !Array.isArray(deferredBy) ||
    deferredBy.some((item) => typeof item !== "string")
  ) {
    throw new DomainInvariantError(
      `Planning event ${scheduled.event.id} payload is malformed`,
    );
  }
  simTime(payload.anchorDueAt);
  return {
    personId: payload.personId,
    occurrence: payload.occurrence,
    anchorDueAt: payload.anchorDueAt,
    deferredBy: deferredBy as string[],
  };
}

function planningReviewEvent(
  personId: PersonId,
  occurrence: number,
  dueAt: SimTime,
  anchorDueAt: SimTime = dueAt,
  deferredBy: readonly string[] = [],
  suffix = "",
): ScheduledEvent {
  return {
    id: asScheduledEventId(
      `runtime:planning:${personId}:review-${occurrence}${suffix}`,
    ),
    dueAt,
    type: PLANNING_REVIEW_EVENT_TYPE,
    payload: {
      personId: String(personId),
      occurrence,
      anchorDueAt: anchorDueAt.toString(),
      deferredBy: [...deferredBy],
    } satisfies PlanningReviewPayload,
    correlationId: asCorrelationId(
      `runtime:planning:${personId}:${occurrence}`,
    ),
    affinityKeys: [entityAffinityKey(String(personId))],
  };
}

function scheduledPersonId(event: PersistedScheduledEvent): string | undefined {
  const payload = event.event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const personId = (payload as Record<string, unknown>).personId;
  return typeof personId === "string" && personId.length > 0
    ? personId
    : undefined;
}

export class DurablePlanningRuntime {
  readonly #pool: Pool;
  readonly #people: PostgresPersonRepository;
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #routines: PostgresRoutineRepository;
  readonly #planning: PostgresPlanningRepository;
  readonly #memories: PostgresMemoryRepository;
  readonly #policy: PlanningRuntimePolicy;

  constructor(
    pool: Pool,
    policy: Partial<PlanningRuntimePolicy> = {},
  ) {
    this.#pool = pool;
    this.#people = new PostgresPersonRepository(pool);
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#routines = new PostgresRoutineRepository(pool);
    this.#planning = new PostgresPlanningRepository(pool);
    this.#memories = new PostgresMemoryRepository(pool);
    this.#policy = validatePlanningRuntimePolicy(policy);
  }

  get policy(): PlanningRuntimePolicy {
    return { ...this.#policy };
  }

  async createGoal(
    worldId: WorldId,
    goal: LifeGoal,
  ): Promise<void> {
    const person = await this.#people.get(
      worldId,
      asPersonId(String(goal.ownerId)),
    );
    if (person === undefined) {
      throw new DomainInvariantError(
        `Planning goal owner is not a persisted person: ${goal.ownerId}`,
      );
    }
    await this.#planning.createGoal(worldId, goal);
  }

  async scheduleInitial(
    worldId: WorldId,
    personId: PersonId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent> {
    if ((await this.#people.get(worldId, personId)) === undefined) {
      throw new DomainInvariantError(
        `Cannot schedule planning review for missing person ${personId}`,
      );
    }
    const event = planningReviewEvent(personId, 1, dueAt);
    await this.#schedules.schedule(worldId, event);
    return event;
  }

  async handleReview(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const payload = parsePlanningReview(context.scheduled);
    const personId = asPersonId(payload.personId);
    const ownerId = asEntityId(payload.personId);
    const at = context.scheduled.event.dueAt;
    const anchorDueAt = simTime(payload.anchorDueAt);
    const person = await this.#people.get(context.worldId, personId);
    if (person === undefined) {
      throw new DomainInvariantError(
        `Planning review targets missing person ${personId}`,
      );
    }

    if (person.person.energy.mode === "sleeping") {
      const wait = timeUntilEnergyAtLeast(
        person.person.energy,
        this.#policy.wakeThreshold,
        at,
      );
      if (wait === undefined) {
        throw new DomainInvariantError(
          `Sleeping planning actor ${personId} has no wake threshold`,
        );
      }
      const retryAt = addSimTime(
        at,
        wait === 0n ? SIM_SECOND : wait,
      );
      const deferredBy = [...new Set([
        ...payload.deferredBy,
        "physiology.sleep",
      ])];
      const retry = planningReviewEvent(
        personId,
        payload.occurrence,
        retryAt,
        anchorDueAt,
        deferredBy,
        `:deferred-${retryAt}`,
      );
      await commitScheduledEventOutcome(this.#pool, {
        worldId: context.worldId,
        eventId: context.scheduled.event.id,
        workerId: context.workerId,
        processedAt: at,
        domainEvents: [
          {
            id: asEventId(
              `runtime:planning-deferred:${context.scheduled.event.id}`,
            ),
            worldId: context.worldId,
            simTime: at,
            type: "planning.review_deferred",
            actorId: ownerId,
            payload: {
              occurrence: payload.occurrence,
              retryAt: retryAt.toString(),
              reason: "physiology.sleep",
            },
            correlationId: context.scheduled.event.correlationId,
          },
        ],
        scheduledEvents: [retry],
      });
      return;
    }

    const existing = await this.#planning.getPlanByTriggerEvent(
      context.worldId,
      context.scheduled.event.id,
    );
    let plan: PlanRevision;

    if (existing !== undefined) {
      plan = existing.plan;
    } else {
      const goals = (
        await this.#planning.listGoals(
          context.worldId,
          ownerId,
          "active",
        )
      ).map((persisted) => persisted.goal);
      const previous = await this.#planning.getActivePlan(
        context.worldId,
        ownerId,
      );
      const horizonEnd = addSimTime(at, this.#policy.horizon);
      const busyWindows = await this.#busyWindows(
        context.worldId,
        person.person,
        at,
        horizonEnd,
      );

      plan = derivePlanRevision({
        id: asPlanRevisionId(
          `runtime:planning:plan:${personId}:review-${payload.occurrence}`,
        ),
        ownerId,
        revision: payload.occurrence,
        createdAt: at,
        horizonEnd,
        goals,
        busyWindows,
        ...(previous === undefined
          ? {}
          : { previousPlan: previous.plan }),
        forcedConflict: payload.deferredBy.length > 0,
      });
      await this.#planning.putPlanRevision({
        worldId: context.worldId,
        plan,
        triggerEventId: context.scheduled.event.id,
      });
    }

    await this.#writeReflection(
      context.worldId,
      ownerId,
      payload.occurrence,
      at,
      plan,
      context.scheduled.event.id,
    );

    let nextOccurrence = payload.occurrence + 1;
    let nextAnchor = addSimTime(anchorDueAt, this.#policy.period);
    while (nextAnchor <= at) {
      nextAnchor = addSimTime(nextAnchor, this.#policy.period);
      nextOccurrence += 1;
    }
    const next = planningReviewEvent(
      personId,
      nextOccurrence,
      nextAnchor,
      nextAnchor,
    );
    const displacedIntentions = plan.intentions.filter(
      (intention) => intention.displacedBy.length > 0,
    ).length;

    await commitScheduledEventOutcome(this.#pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: at,
      domainEvents: [
        {
          id: asEventId(
            `runtime:planning-reviewed:${personId}:${payload.occurrence}`,
          ),
          worldId: context.worldId,
          simTime: at,
          type: "planning.review_completed",
          actorId: ownerId,
          payload: {
            occurrence: payload.occurrence,
            planRevisionId: String(plan.id),
            reason: plan.reason,
            intentionCount: plan.intentions.length,
            displacedIntentions,
            deferredBy: [...payload.deferredBy],
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
      scheduledEvents: [next],
    });
  }

  async #busyWindows(
    worldId: WorldId,
    person: PersonState,
    from: SimTime,
    through: SimTime,
  ): Promise<readonly PlanningBusyWindow[]> {
    const ownerId = asEntityId(String(person.id));
    const windows: PlanningBusyWindow[] = [];

    const commitments = await this.#routines.listPlannedForOwner({
      worldId,
      ownerId,
      from,
      through,
    });
    for (const persisted of commitments) {
      const commitment = persisted.commitment;
      if (commitment.kind !== "employment.shift") continue;
      windows.push({
        id: `commitment:${commitment.id}`,
        kind: commitment.kind,
        start: commitment.dueAt,
        end: addSimTime(
          commitment.dueAt,
          this.#policy.employmentBusyDuration,
        ),
      });
    }

    const outstanding = await this.#schedules.loadOutstanding(worldId);
    for (const scheduled of outstanding) {
      const event = scheduled.event;
      if (
        event.dueAt < from ||
        event.dueAt > through ||
        scheduledPersonId(scheduled) !== String(person.id)
      ) {
        continue;
      }

      if (event.type === SOCIAL_CONVERSATION_OPPORTUNITY_EVENT_TYPE) {
        windows.push({
          id: `social:${event.id}`,
          kind: event.type,
          start: event.dueAt,
          end: addSimTime(event.dueAt, this.#policy.socialBusyDuration),
        });
        continue;
      }

      if (event.type === PERSON_ENERGY_LOW_EVENT_TYPE) {
        const sleeping = beginSleep(person, event.dueAt);
        const wait = timeUntilEnergyAtLeast(
          sleeping.energy,
          this.#policy.wakeThreshold,
          event.dueAt,
        );
        if (wait !== undefined && wait > 0n) {
          windows.push({
            id: `physiology:${event.id}`,
            kind: "physiology.sleep",
            start: event.dueAt,
            end: addSimTime(event.dueAt, wait),
          });
        }
      }
    }

    return windows;
  }

  async #writeReflection(
    worldId: WorldId,
    ownerId: EntityId,
    occurrence: number,
    at: SimTime,
    plan: PlanRevision,
    triggerEventId: ReturnType<typeof asScheduledEventId>,
  ): Promise<void> {
    const lowerBoundValue =
      BigInt(at) > BigInt(this.#policy.reflectionLookback)
        ? BigInt(at) - BigInt(this.#policy.reflectionLookback)
        : 0n;
    const lowerBound = simTime(lowerBoundValue);
    const memories = await this.#memories.listMemories(worldId, ownerId);
    const recent = memories.filter(
      (memory) =>
        memory.category !== "reflection" &&
        memory.occurredAt >= lowerBound &&
        memory.occurredAt <= at,
    );
    const categories = [...new Set(recent.map((memory) => memory.category))]
      .sort();
    const sourceMemoryIds = recent
      .slice(Math.max(0, recent.length - 8))
      .map((memory) => String(memory.id));
    const displacedIntentions = plan.intentions.filter(
      (intention) => intention.displacedBy.length > 0,
    ).length;

    await this.#memories.createMemory({
      id: asMemoryId(
        `planning:reflection:${ownerId}:review-${occurrence}`,
      ),
      worldId,
      ownerId,
      category: "reflection",
      occurredAt: at,
      content:
        `Reviewed ${recent.length} durable memories` +
        ` across ${categories.length === 0 ? "no categories" : categories.join(", ")};` +
        ` plan revision ${plan.revision} carries ${plan.intentions.length}` +
        ` intention(s), ${displacedIntentions} displaced by conflicts.`,
      importanceBps: 6_000,
      emotionalStrengthBps: 0,
      relatedEntityIds: [],
      metadata: {
        kind: "planning.reflection",
        occurrence,
        triggerEventId: String(triggerEventId),
        planRevisionId: String(plan.id),
        planReason: plan.reason,
        sourceMemoryIds,
        displacedIntentions,
      },
    });
  }
}


export const DIALOGUE_TURN_EVENT_TYPE = "dialogue.turn";

export interface DialogueRuntimePolicy {
  readonly turnInterval: SimDuration;
  readonly wakeThreshold: number;
  readonly maxVisibleMemories: number;
  readonly maxHistoryTurns: number;
  readonly maxBeliefAffordances: number;
  readonly maxUtteranceChars: number;
}

export const DEFAULT_DIALOGUE_RUNTIME_POLICY: DialogueRuntimePolicy = {
  turnInterval: simDuration(10 * 60),
  wakeThreshold: DEFAULT_PHYSIOLOGY_RUNTIME_POLICY.wakeThreshold,
  maxVisibleMemories: 8,
  maxHistoryTurns: 8,
  maxBeliefAffordances: 6,
  maxUtteranceChars: 280,
};

export interface DialogueVisibleBelief {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
}

export interface DialogueVisibleMemory {
  readonly category: string;
  readonly occurredAt: string;
  readonly content: string;
  readonly relatedEntityIds: readonly string[];
}

export interface DialogueVisibleStatement {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly confidenceBps: number;
}

export interface DialogueVisibleTurn {
  readonly ordinal: number;
  readonly speakerId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly statements: readonly DialogueVisibleStatement[];
}

export interface DialogueVisiblePlan {
  readonly revision: number;
  readonly reason: string;
  readonly intentions: readonly {
    readonly kind: string;
    readonly startsAt: string;
    readonly endsAt: string;
  }[];
}

export interface DialogueCognitionContext {
  readonly conversationId: string;
  readonly turnOrdinal: number;
  readonly speakerId: string;
  readonly listenerId: string;
  readonly relationship: Readonly<Record<string, number>> | null;
  readonly beliefs: readonly DialogueVisibleBelief[];
  readonly memories: readonly DialogueVisibleMemory[];
  readonly history: readonly DialogueVisibleTurn[];
  readonly activePlan: DialogueVisiblePlan | null;
}

interface DialogueTurnPayload {
  readonly conversationId: string;
  readonly turnOrdinal: number;
  readonly firstSpeakerId: string;
  readonly turnInterval: string;
}

interface DialogueShareCandidate {
  readonly affordance: Affordance;
  readonly belief: DialogueVisibleBelief;
  readonly sourceStatement?: ConversationStatement;
  readonly heardFrom?: EntityId;
  readonly origin?: StatementOrigin;
}

interface DialogueTurnChoices {
  readonly context: DialogueCognitionContext;
  readonly affordances: readonly Affordance[];
  readonly shareByAffordanceId: ReadonlyMap<string, DialogueShareCandidate>;
}

function validateDialogueRuntimePolicy(
  input: Partial<DialogueRuntimePolicy>,
): DialogueRuntimePolicy {
  const policy: DialogueRuntimePolicy = {
    ...DEFAULT_DIALOGUE_RUNTIME_POLICY,
    ...input,
  };
  if (policy.turnInterval <= 0n) {
    throw new DomainInvariantError("Dialogue turn interval must be positive");
  }
  assertBasisPointThreshold(policy.wakeThreshold, "dialogue wakeThreshold");
  for (const [label, value] of [
    ["maxVisibleMemories", policy.maxVisibleMemories],
    ["maxHistoryTurns", policy.maxHistoryTurns],
    ["maxBeliefAffordances", policy.maxBeliefAffordances],
    ["maxUtteranceChars", policy.maxUtteranceChars],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new DomainInvariantError(
        `Dialogue ${label} must be a positive safe integer`,
      );
    }
  }
  return policy;
}

function parseDialogueTurn(
  scheduled: PersistedScheduledEvent,
): DialogueTurnPayload {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `Dialogue event ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.conversationId !== "string" ||
    payload.conversationId.length === 0 ||
    typeof payload.turnOrdinal !== "number" ||
    !Number.isSafeInteger(payload.turnOrdinal) ||
    payload.turnOrdinal <= 0 ||
    typeof payload.firstSpeakerId !== "string" ||
    payload.firstSpeakerId.length === 0 ||
    typeof payload.turnInterval !== "string"
  ) {
    throw new DomainInvariantError(
      `Dialogue event ${scheduled.event.id} payload is malformed`,
    );
  }
  simDuration(payload.turnInterval);
  return {
    conversationId: payload.conversationId,
    turnOrdinal: payload.turnOrdinal,
    firstSpeakerId: payload.firstSpeakerId,
    turnInterval: payload.turnInterval,
  };
}

function dialogueTurnEvent(input: {
  readonly conversationId: ConversationId;
  readonly participantIds: readonly EntityId[];
  readonly turnOrdinal: number;
  readonly firstSpeakerId: EntityId;
  readonly dueAt: SimTime;
  readonly turnInterval: SimDuration;
  readonly suffix?: string;
}): ScheduledEvent {
  return {
    id: asScheduledEventId(
      `runtime:dialogue:${input.conversationId}:turn-${input.turnOrdinal}${input.suffix ?? ""}`,
    ),
    dueAt: input.dueAt,
    type: DIALOGUE_TURN_EVENT_TYPE,
    payload: {
      conversationId: String(input.conversationId),
      turnOrdinal: input.turnOrdinal,
      firstSpeakerId: String(input.firstSpeakerId),
      turnInterval: input.turnInterval.toString(),
    } satisfies DialogueTurnPayload,
    correlationId: asCorrelationId(
      `runtime:dialogue:${input.conversationId}:turn-${input.turnOrdinal}`,
    ),
    affinityKeys: [
      conversationAffinityKey(String(input.conversationId)),
      ...input.participantIds.map((id) => entityAffinityKey(String(id))),
    ],
  };
}

function dialogueMessageId(
  conversationId: ConversationId,
  turnOrdinal: number,
): ReturnType<typeof asConversationMessageId> {
  return asConversationMessageId(
    `runtime:dialogue:message:${conversationId}:turn-${turnOrdinal}`,
  );
}

function dialogueRequestId(
  conversationId: ConversationId,
  turnOrdinal: number,
): ReturnType<typeof asCognitionRequestId> {
  return asCognitionRequestId(
    `runtime:dialogue:decision:${conversationId}:turn-${turnOrdinal}`,
  );
}

function dialogueStatementId(
  conversationId: ConversationId,
  turnOrdinal: number,
): ReturnType<typeof asConversationStatementId> {
  return asConversationStatementId(
    `runtime:dialogue:statement:${conversationId}:turn-${turnOrdinal}`,
  );
}

function dialogueSpeakerPair(
  participantIds: readonly EntityId[],
  firstSpeakerId: EntityId,
  turnOrdinal: number,
): { readonly speakerId: EntityId; readonly listenerId: EntityId } {
  if (participantIds.length !== 2) {
    throw new DomainInvariantError(
      "Durable dialogue currently requires exactly two participants",
    );
  }
  if (!participantIds.includes(firstSpeakerId)) {
    throw new DomainInvariantError(
      `Dialogue first speaker is not a participant: ${firstSpeakerId}`,
    );
  }
  const other = participantIds.find((id) => id !== firstSpeakerId);
  if (other === undefined) {
    throw new DomainInvariantError(
      "Dialogue participants must contain two distinct entities",
    );
  }
  return turnOrdinal % 2 === 1
    ? { speakerId: firstSpeakerId, listenerId: other }
    : { speakerId: other, listenerId: firstSpeakerId };
}

function visibleRelationship(
  vector: {
    readonly familiarity: number;
    readonly trust: number;
    readonly affection: number;
    readonly respect: number;
    readonly attraction: number;
    readonly fear: number;
    readonly resentment: number;
    readonly dependency: number;
  } | undefined,
): Readonly<Record<string, number>> | null {
  if (vector === undefined) return null;
  return {
    familiarity: vector.familiarity,
    trust: vector.trust,
    affection: vector.affection,
    respect: vector.respect,
    attraction: vector.attraction,
    fear: vector.fear,
    resentment: vector.resentment,
    dependency: vector.dependency,
  };
}

function visiblePlan(
  plan: PlanRevision | undefined,
): DialogueVisiblePlan | null {
  if (plan === undefined) return null;
  return {
    revision: plan.revision,
    reason: plan.reason,
    intentions: plan.intentions.map((intention) => ({
      kind: intention.kind,
      startsAt: intention.startsAt.toString(),
      endsAt: intention.endsAt.toString(),
    })),
  };
}

function validateUtterance(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new DomainInvariantError("Dialogue utterance cannot be blank");
  }
  if (trimmed.length > maxChars) {
    throw new DomainInvariantError(
      `Dialogue utterance exceeds ${maxChars} characters`,
    );
  }
  return trimmed;
}

export class DurableDialogueRuntime {
  readonly #pool: Pool;
  readonly #people: PostgresPersonRepository;
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #conversations: PostgresConversationRepository;
  readonly #deliveries: PostgresConversationDeliveryProcessor;
  readonly #social: PostgresSocialRepository;
  readonly #memories: PostgresMemoryRepository;
  readonly #planning: PostgresPlanningRepository;
  readonly #executor: DurableCognitionExecutor<DialogueCognitionContext>;
  readonly #policy: DialogueRuntimePolicy;

  constructor(
    pool: Pool,
    options: {
      readonly policy?: Partial<DialogueRuntimePolicy>;
      readonly provider?: TraceableCognitiveProvider<DialogueCognitionContext>;
    } = {},
  ) {
    this.#pool = pool;
    this.#people = new PostgresPersonRepository(pool);
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#conversations = new PostgresConversationRepository(pool);
    this.#deliveries = new PostgresConversationDeliveryProcessor(pool);
    this.#social = new PostgresSocialRepository(pool);
    this.#memories = new PostgresMemoryRepository(pool);
    this.#planning = new PostgresPlanningRepository(pool);
    this.#policy = validateDialogueRuntimePolicy(options.policy ?? {});
    const provider =
      options.provider ??
      new DeterministicTraceableCognitiveProvider<DialogueCognitionContext>({
        id: "dialogue-mock-traceable",
        modelId: "dialogue-mock-v1",
      });
    this.#executor = new DurableCognitionExecutor(
      new PostgresCognitionRepository(pool),
      provider,
    );
  }

  get policy(): DialogueRuntimePolicy {
    return { ...this.#policy };
  }

  async startConversation(input: {
    readonly worldId: WorldId;
    readonly conversationId: ConversationId;
    readonly participantIds: readonly [PersonId, PersonId];
    readonly firstSpeakerId: PersonId;
    readonly startedAt: SimTime;
    readonly maxTurns: number;
    readonly turnInterval?: SimDuration;
  }): Promise<ScheduledEvent> {
    if (
      input.participantIds[0] === input.participantIds[1] ||
      !input.participantIds.includes(input.firstSpeakerId)
    ) {
      throw new DomainInvariantError(
        "Dialogue requires two distinct participants and a participating first speaker",
      );
    }
    if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns <= 0) {
      throw new DomainInvariantError(
        "Dialogue maxTurns must be a positive safe integer",
      );
    }
    for (const personId of input.participantIds) {
      if ((await this.#people.get(input.worldId, personId)) === undefined) {
        throw new DomainInvariantError(
          `Dialogue participant is not a persisted person: ${personId}`,
        );
      }
    }

    await this.#conversations.createConversation({
      id: input.conversationId,
      worldId: input.worldId,
      participantIds: input.participantIds.map((id) => asEntityId(String(id))),
      startedAt: input.startedAt,
      maxTurns: input.maxTurns,
    });

    const participantIds = input.participantIds.map((id) =>
      asEntityId(String(id))
    );
    const event = dialogueTurnEvent({
      conversationId: input.conversationId,
      participantIds,
      turnOrdinal: 1,
      firstSpeakerId: asEntityId(String(input.firstSpeakerId)),
      dueAt: input.startedAt,
      turnInterval: input.turnInterval ?? this.#policy.turnInterval,
    });
    await this.#schedules.schedule(input.worldId, event);
    return event;
  }

  async handleTurn(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const payload = parseDialogueTurn(context.scheduled);
    const conversationId = asConversationId(payload.conversationId);
    const conversation = await this.#conversations.getConversation(
      context.worldId,
      conversationId,
    );
    if (conversation === undefined) {
      throw new DomainInvariantError(
        `Dialogue conversation does not exist: ${conversationId}`,
      );
    }
    if (payload.turnOrdinal > conversation.maxTurns) {
      throw new DomainInvariantError(
        `Dialogue turn ${payload.turnOrdinal} exceeds maxTurns ${conversation.maxTurns}`,
      );
    }

    const firstSpeakerId = asEntityId(payload.firstSpeakerId);
    const pair = dialogueSpeakerPair(
      conversation.participantIds,
      firstSpeakerId,
      payload.turnOrdinal,
    );
    const messageId = dialogueMessageId(
      conversationId,
      payload.turnOrdinal,
    );
    const existing = await this.#conversations.getMessage(
      context.worldId,
      messageId,
    );

    if (existing === undefined) {
      const defer = await this.#availabilityDelay(
        context.worldId,
        [pair.speakerId, pair.listenerId],
        context.scheduled.event.dueAt,
      );
      if (defer !== undefined) {
        const retryAt = addSimTime(
          context.scheduled.event.dueAt,
          defer.wait === 0n ? SIM_SECOND : defer.wait,
        );
        const retry = dialogueTurnEvent({
          conversationId,
          participantIds: conversation.participantIds,
          turnOrdinal: payload.turnOrdinal,
          firstSpeakerId,
          dueAt: retryAt,
          turnInterval: simDuration(payload.turnInterval),
          suffix: `:deferred-${retryAt}`,
        });
        await commitScheduledEventOutcome(this.#pool, {
          worldId: context.worldId,
          eventId: context.scheduled.event.id,
          workerId: context.workerId,
          processedAt: context.scheduled.event.dueAt,
          domainEvents: [
            {
              id: asEventId(
                `runtime:dialogue-deferred:${context.scheduled.event.id}`,
              ),
              worldId: context.worldId,
              simTime: context.scheduled.event.dueAt,
              type: "dialogue.turn_deferred",
              actorId: pair.speakerId,
              targetIds: [pair.listenerId],
              payload: {
                conversationId: String(conversationId),
                turnOrdinal: payload.turnOrdinal,
                retryAt: retryAt.toString(),
                unavailablePersonIds: defer.personIds,
              },
              correlationId: context.scheduled.event.correlationId,
            },
          ],
          scheduledEvents: [retry],
        });
        return;
      }

      const choices = await this.#turnChoices(
        context.worldId,
        conversationId,
        payload.turnOrdinal,
        pair.speakerId,
        pair.listenerId,
        context.scheduled.event.dueAt,
      );
      const requestId = dialogueRequestId(
        conversationId,
        payload.turnOrdinal,
      );
      const decision = await this.#executor.decide(context.worldId, {
        id: requestId,
        actorId: pair.speakerId,
        simTime: context.scheduled.event.dueAt,
        correlationId: context.scheduled.event.correlationId,
        context: choices.context,
        affordances: choices.affordances,
      });
      const text = validateUtterance(
        decision.intent,
        this.#policy.maxUtteranceChars,
      );
      const share = choices.shareByAffordanceId.get(
        String(decision.affordanceId),
      );
      const statements =
        share === undefined
          ? []
          : [
              this.#statementForShare(
                conversationId,
                payload.turnOrdinal,
                share,
              ),
            ];

      await this.#conversations.appendMessage({
        id: messageId,
        worldId: context.worldId,
        conversationId,
        speakerId: pair.speakerId,
        sentAt: context.scheduled.event.dueAt,
        text,
        statements,
      });
    }

    await this.#ensureMessageDelivery(
      context.worldId,
      messageId,
      context.workerId,
    );
    await this.#completeTurn(
      context,
      conversationId,
      firstSpeakerId,
      payload,
      pair,
    );
  }

  async #availabilityDelay(
    worldId: WorldId,
    participantIds: readonly EntityId[],
    at: SimTime,
  ): Promise<
    | {
        readonly wait: SimDuration;
        readonly personIds: readonly string[];
      }
    | undefined
  > {
    let maxWait = 0n as SimDuration;
    const unavailable: string[] = [];
    for (const entityId of participantIds) {
      const person = await this.#people.get(
        worldId,
        asPersonId(String(entityId)),
      );
      if (person === undefined) {
        throw new DomainInvariantError(
          `Dialogue participant is not a persisted person: ${entityId}`,
        );
      }
      if (person.person.energy.mode !== "sleeping") continue;
      const wait = timeUntilEnergyAtLeast(
        person.person.energy,
        this.#policy.wakeThreshold,
        at,
      );
      if (wait === undefined) {
        throw new DomainInvariantError(
          `Sleeping dialogue participant ${entityId} has no wake threshold`,
        );
      }
      unavailable.push(String(entityId));
      if (wait > maxWait) maxWait = wait;
    }
    return unavailable.length === 0
      ? undefined
      : { wait: maxWait, personIds: unavailable };
  }

  async #turnChoices(
    worldId: WorldId,
    conversationId: ConversationId,
    turnOrdinal: number,
    speakerId: EntityId,
    listenerId: EntityId,
    at: SimTime,
  ): Promise<DialogueTurnChoices> {
    const beliefs = (await this.#social.listBeliefs(worldId, speakerId))
      .slice()
      .sort((left, right) => {
        if (left.confidenceBps !== right.confidenceBps) {
          return right.confidenceBps - left.confidenceBps;
        }
        const leftKey = socialClaimKey(left.subjectId, left.predicate);
        const rightKey = socialClaimKey(right.subjectId, right.predicate);
        return leftKey.localeCompare(rightKey);
      })
      .slice(0, this.#policy.maxBeliefAffordances);

    const visibleBeliefs: DialogueVisibleBelief[] = beliefs.map((belief) => ({
      subjectId: belief.subjectId,
      predicate: belief.predicate,
      value: belief.value,
      confidenceBps: belief.confidenceBps,
    }));

    const memories = (await this.#memories.listMemories(worldId, speakerId))
      .filter((memory) => memory.occurredAt <= at);
    const visibleMemories: DialogueVisibleMemory[] = memories
      .slice(Math.max(0, memories.length - this.#policy.maxVisibleMemories))
      .map((memory) => ({
        category: memory.category,
        occurredAt: memory.occurredAt.toString(),
        content: memory.content,
        relatedEntityIds: memory.relatedEntityIds.map(String),
      }));

    const history = (
      await this.#conversations.listMessages(worldId, conversationId)
    )
      .filter((message) => message.ordinal < turnOrdinal)
      .slice(-this.#policy.maxHistoryTurns)
      .map<DialogueVisibleTurn>((message) => ({
        ordinal: message.ordinal,
        speakerId: String(message.speakerId),
        sentAt: message.sentAt.toString(),
        text: message.text,
        statements: message.statements.map((statement) => ({
          subjectId: statement.subjectId,
          predicate: statement.predicate,
          value: statement.value,
          confidenceBps: statement.confidenceBps,
        })),
      }));

    const relationship = await this.#social.getRelationship(
      worldId,
      speakerId,
      listenerId,
    );
    const activePlan = await this.#planning.getActivePlan(
      worldId,
      speakerId,
    );

    const shareByAffordanceId = new Map<string, DialogueShareCandidate>();
    const affordances: Affordance[] = [];
    for (let index = 0; index < beliefs.length; index += 1) {
      const belief = beliefs[index]!;
      const visible = visibleBeliefs[index]!;
      const source = await this.#sourceForBelief(
        worldId,
        speakerId,
        belief.subjectId,
        belief.predicate,
        memories,
      );
      const affordance: Affordance = {
        id: asAffordanceId(
          `dialogue.share-belief.${String(index + 1).padStart(2, "0")}`,
        ),
        actionId: asActionId("dialogue.speak"),
        label:
          `Tell ${listenerId} that ${belief.subjectId} ${belief.predicate} ` +
          `${JSON.stringify(belief.value)}`,
        context: {
          subjectId: belief.subjectId,
          predicate: belief.predicate,
          value: belief.value,
          confidenceBps: belief.confidenceBps,
        },
      };
      const candidate: DialogueShareCandidate = {
        affordance,
        belief: visible,
        ...(source.statement === undefined
          ? {}
          : { sourceStatement: source.statement }),
        ...(source.heardFrom === undefined
          ? {}
          : { heardFrom: source.heardFrom }),
        ...(source.origin === undefined
          ? {}
          : { origin: source.origin }),
      };
      affordances.push(affordance);
      shareByAffordanceId.set(String(affordance.id), candidate);
    }

    affordances.push({
      id: asAffordanceId("dialogue.small-talk"),
      actionId: asActionId("dialogue.speak"),
      label: `Make ordinary small talk with ${listenerId}`,
      context: {},
    });

    return {
      context: {
        conversationId: String(conversationId),
        turnOrdinal,
        speakerId: String(speakerId),
        listenerId: String(listenerId),
        relationship: visibleRelationship(relationship?.vector),
        beliefs: visibleBeliefs,
        memories: visibleMemories,
        history,
        activePlan: visiblePlan(activePlan?.plan),
      },
      affordances,
      shareByAffordanceId,
    };
  }

  async #sourceForBelief(
    worldId: WorldId,
    speakerId: EntityId,
    subjectId: string,
    predicate: string,
    memories: readonly Awaited<
      ReturnType<PostgresMemoryRepository["listMemories"]>
    >[number][],
  ): Promise<{
    readonly statement?: ConversationStatement;
    readonly heardFrom?: EntityId;
    readonly origin?: StatementOrigin;
  }> {
    for (let index = memories.length - 1; index >= 0; index -= 1) {
      const memory = memories[index]!;
      const metadata = socialMetadata(memory.metadata);
      if (metadata === undefined) continue;

      if (
        metadata.kind === "social.seed_claim" &&
        metadata.subjectId === subjectId &&
        metadata.predicate === predicate
      ) {
        const origin = parseStatementOrigin(metadata.origin);
        return origin === undefined ? {} : { origin };
      }

      if (
        metadata.role !== "listener" ||
        typeof metadata.messageId !== "string"
      ) {
        continue;
      }
      const message = await this.#conversations.getMessage(
        worldId,
        asConversationMessageId(metadata.messageId),
      );
      const statement = message?.statements.find(
        (candidate) =>
          candidate.subjectId === subjectId &&
          candidate.predicate === predicate,
      );
      if (statement !== undefined && message !== undefined) {
        return {
          statement,
          heardFrom: message.speakerId,
          origin: "reported",
        };
      }
    }
    return {};
  }

  #statementForShare(
    conversationId: ConversationId,
    turnOrdinal: number,
    share: DialogueShareCandidate,
  ): ConversationStatement {
    const id = dialogueStatementId(conversationId, turnOrdinal);
    if (share.sourceStatement !== undefined) {
      return retellStatement({
        id,
        source: share.sourceStatement,
        confidenceBps: share.belief.confidenceBps,
        value: share.belief.value,
        ...(share.heardFrom === undefined
          ? {}
          : { claimedSourceEntityId: share.heardFrom }),
      });
    }
    return {
      id,
      subjectId: share.belief.subjectId,
      predicate: share.belief.predicate,
      value: share.belief.value,
      confidenceBps: share.belief.confidenceBps,
      origin: share.origin ?? "inferred",
      hopCount: 0,
    };
  }

  async #ensureMessageDelivery(
    worldId: WorldId,
    messageId: ReturnType<typeof asConversationMessageId>,
    workerId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const deliveries = await this.#conversations.listDeliveries(
        worldId,
        messageId,
      );
      if (deliveries.length !== 1) {
        throw new DomainInvariantError(
          `Expected one delivery for dialogue message ${messageId}, found ${deliveries.length}`,
        );
      }
      const target = deliveries[0]!;
      if (target.status === "completed") return;
      if (target.status === "processing") {
        if (target.lockedBy !== workerId) {
          throw new DomainInvariantError(
            `Dialogue delivery ${messageId} is leased by ${target.lockedBy ?? "another worker"}`,
          );
        }
        await this.#deliveries.processClaim(target, workerId);
        continue;
      }

      const delivery = await this.#conversations.claimDelivery(
        worldId,
        messageId,
        target.listenerId,
        workerId,
      );
      if (delivery === undefined) {
        throw new DomainInvariantError(
          `Dialogue delivery ${messageId}:${target.listenerId} could not be claimed in listener order`,
        );
      }
      await this.#deliveries.processClaim(delivery, workerId);
    }
    throw new DomainInvariantError(
      `Dialogue delivery ${messageId} did not converge after 100 claims`,
    );
  }

  async #completeTurn(
    context: ScheduledEventHandlerContext,
    conversationId: ConversationId,
    firstSpeakerId: EntityId,
    payload: DialogueTurnPayload,
    pair: { readonly speakerId: EntityId; readonly listenerId: EntityId },
  ): Promise<void> {
    const turnInterval = simDuration(payload.turnInterval);
    const next =
      payload.turnOrdinal >=
      (
        await this.#conversations.getConversation(
          context.worldId,
          conversationId,
        )
      )!.maxTurns
        ? []
        : [
            dialogueTurnEvent({
              conversationId,
              participantIds: [pair.speakerId, pair.listenerId],
              turnOrdinal: payload.turnOrdinal + 1,
              firstSpeakerId,
              dueAt: addSimTime(
                context.scheduled.event.dueAt,
                turnInterval,
              ),
              turnInterval,
            }),
          ];

    await commitScheduledEventOutcome(this.#pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: context.scheduled.event.dueAt,
      domainEvents: [
        {
          id: asEventId(
            `runtime:dialogue-completed:${conversationId}:turn-${payload.turnOrdinal}`,
          ),
          worldId: context.worldId,
          simTime: context.scheduled.event.dueAt,
          type: "dialogue.turn_completed",
          actorId: pair.speakerId,
          targetIds: [pair.listenerId],
          payload: {
            conversationId: String(conversationId),
            turnOrdinal: payload.turnOrdinal,
            messageId: String(
              dialogueMessageId(conversationId, payload.turnOrdinal),
            ),
            cognitionRequestId: String(
              dialogueRequestId(conversationId, payload.turnOrdinal),
            ),
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
      scheduledEvents: next,
    });
  }
}


export const WORLD_DIRECTOR_REVIEW_EVENT_TYPE = "world_director.review";
export const WORLD_DIRECTOR_OPPORTUNITY_EVENT_TYPE =
  "world_director.opportunity";

export interface WorldDirectorRuntimePolicy {
  readonly enabled: boolean;
  readonly period: SimDuration;
  readonly effectDelay: SimDuration;
  readonly maxPeople: number;
  readonly maxRecentEvents: number;
  readonly maxCandidates: number;
}

export const DEFAULT_WORLD_DIRECTOR_RUNTIME_POLICY: WorldDirectorRuntimePolicy = {
  enabled: false,
  period: SIM_DAY,
  effectDelay: SIM_HOUR,
  maxPeople: 8,
  maxRecentEvents: 16,
  maxCandidates: 4,
};

interface WorldDirectorReviewPayload {
  readonly occurrence: number;
  readonly anchorDueAt: string;
}

interface WorldDirectorOpportunityPayload {
  readonly proposalId: string;
  readonly participantIds: readonly [string, string];
}

function validateWorldDirectorRuntimePolicy(
  input: Partial<WorldDirectorRuntimePolicy>,
): WorldDirectorRuntimePolicy {
  const policy: WorldDirectorRuntimePolicy = {
    ...DEFAULT_WORLD_DIRECTOR_RUNTIME_POLICY,
    ...input,
  };
  if (policy.period < SIM_HOUR) {
    throw new DomainInvariantError(
      "World Director period must be at least one simulated hour",
    );
  }
  if (policy.effectDelay <= 0n || policy.effectDelay > policy.period) {
    throw new DomainInvariantError(
      "World Director effectDelay must be positive and no greater than period",
    );
  }
  const bounded = (
    value: number,
    label: string,
    maximum: number,
  ): number => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new DomainInvariantError(
        `${label} must be a positive safe integer <= ${maximum}`,
      );
    }
    return value;
  };
  bounded(
    policy.maxPeople,
    "World Director maxPeople",
    WORLD_DIRECTOR_HARD_MAX_PEOPLE,
  );
  bounded(
    policy.maxRecentEvents,
    "World Director maxRecentEvents",
    WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS,
  );
  bounded(
    policy.maxCandidates,
    "World Director maxCandidates",
    WORLD_DIRECTOR_HARD_MAX_CANDIDATES,
  );
  return policy;
}

function worldDirectorReviewEvent(
  occurrence: number,
  dueAt: SimTime,
  anchorDueAt: SimTime = dueAt,
): ScheduledEvent<WorldDirectorReviewPayload> {
  if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
    throw new DomainInvariantError(
      "World Director review occurrence must be a positive safe integer",
    );
  }
  return {
    id: asScheduledEventId(`runtime:director:review-${occurrence}`),
    dueAt,
    type: WORLD_DIRECTOR_REVIEW_EVENT_TYPE,
    payload: {
      occurrence,
      anchorDueAt: anchorDueAt.toString(),
    },
    correlationId: asCorrelationId(`runtime:director:review-${occurrence}`),
    affinityKeys: ["world-director"],
  };
}

function parseWorldDirectorReview(
  scheduled: PersistedScheduledEvent,
): WorldDirectorReviewPayload {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `World Director review ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.occurrence !== "number" ||
    !Number.isSafeInteger(payload.occurrence) ||
    payload.occurrence <= 0 ||
    typeof payload.anchorDueAt !== "string"
  ) {
    throw new DomainInvariantError(
      `World Director review ${scheduled.event.id} payload is malformed`,
    );
  }
  simTime(payload.anchorDueAt);
  return {
    occurrence: payload.occurrence,
    anchorDueAt: payload.anchorDueAt,
  };
}

function parseWorldDirectorOpportunity(
  scheduled: PersistedScheduledEvent,
): WorldDirectorOpportunityPayload {
  const value = scheduled.event.payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(
      `World Director opportunity ${scheduled.event.id} payload must be an object`,
    );
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.proposalId !== "string" ||
    payload.proposalId.trim().length === 0 ||
    !Array.isArray(payload.participantIds) ||
    payload.participantIds.length !== 2 ||
    typeof payload.participantIds[0] !== "string" ||
    payload.participantIds[0].trim().length === 0 ||
    typeof payload.participantIds[1] !== "string" ||
    payload.participantIds[1].trim().length === 0 ||
    payload.participantIds[0] === payload.participantIds[1]
  ) {
    throw new DomainInvariantError(
      `World Director opportunity ${scheduled.event.id} payload is malformed`,
    );
  }
  return {
    proposalId: payload.proposalId,
    participantIds: [
      payload.participantIds[0],
      payload.participantIds[1],
    ],
  };
}

function worldDirectorProposalDetails(
  proposal: PersistedWorldDirectorProposal,
): {
  readonly participantIds: readonly [string, string];
  readonly dueAt: SimTime;
} {
  if (
    proposal.status !== "accepted" ||
    proposal.kind !== "social_opportunity" ||
    proposal.effectEventId === undefined ||
    typeof proposal.payload !== "object" ||
    proposal.payload === null ||
    Array.isArray(proposal.payload)
  ) {
    throw new DomainInvariantError(
      `World Director proposal ${proposal.id} is not an accepted social opportunity`,
    );
  }
  const payload = proposal.payload as Record<string, unknown>;
  if (
    !Array.isArray(payload.participantIds) ||
    payload.participantIds.length !== 2 ||
    typeof payload.participantIds[0] !== "string" ||
    payload.participantIds[0].trim().length === 0 ||
    typeof payload.participantIds[1] !== "string" ||
    payload.participantIds[1].trim().length === 0 ||
    payload.participantIds[0] === payload.participantIds[1] ||
    typeof payload.dueAt !== "string"
  ) {
    throw new DomainInvariantError(
      `World Director proposal ${proposal.id} payload is malformed`,
    );
  }
  return {
    participantIds: [
      payload.participantIds[0],
      payload.participantIds[1],
    ],
    dueAt: simTime(payload.dueAt),
  };
}

function worldDirectorOpportunityEvent(
  proposal: PersistedWorldDirectorProposal,
): ScheduledEvent<WorldDirectorOpportunityPayload> {
  const details = worldDirectorProposalDetails(proposal);
  if (proposal.effectEventId === undefined) {
    throw new DomainInvariantError(
      `World Director proposal ${proposal.id} has no effect event id`,
    );
  }
  return {
    id: asScheduledEventId(proposal.effectEventId),
    dueAt: details.dueAt,
    type: WORLD_DIRECTOR_OPPORTUNITY_EVENT_TYPE,
    payload: {
      proposalId: proposal.id,
      participantIds: details.participantIds,
    },
    correlationId: asCorrelationId(`world-director:${proposal.id}`),
    affinityKeys: details.participantIds.map((id) => entityAffinityKey(id)),
  };
}

export class DurableWorldDirectorRuntime {
  readonly #pool: Pool;
  readonly #repository: PostgresWorldDirectorRepository;
  readonly #schedules: PostgresScheduledEventRepository;
  readonly #people: PostgresPersonRepository;
  readonly #executor: DurableCognitionExecutor<WorldDirectorCognitionContext>;
  readonly #policy: WorldDirectorRuntimePolicy;

  constructor(
    pool: Pool,
    options: {
      readonly policy?: Partial<WorldDirectorRuntimePolicy>;
      readonly provider?: TraceableCognitiveProvider<WorldDirectorCognitionContext>;
    } = {},
  ) {
    this.#pool = pool;
    this.#repository = new PostgresWorldDirectorRepository(pool);
    this.#schedules = new PostgresScheduledEventRepository(pool);
    this.#people = new PostgresPersonRepository(pool);
    this.#policy = validateWorldDirectorRuntimePolicy(options.policy ?? {});
    const provider =
      options.provider ??
      new DeterministicTraceableCognitiveProvider<WorldDirectorCognitionContext>({
        id: "world-director-mock-traceable",
        modelId: "world-director-mock-v1",
      });
    this.#executor = new DurableCognitionExecutor(
      new PostgresCognitionRepository(pool),
      provider,
    );
  }

  get policy(): WorldDirectorRuntimePolicy {
    return { ...this.#policy };
  }

  async scheduleInitial(
    worldId: WorldId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent | undefined> {
    if (!this.#policy.enabled) return undefined;
    const event = worldDirectorReviewEvent(1, dueAt);
    await this.#schedules.schedule(worldId, event);
    return event;
  }

  async handleReview(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const payload = parseWorldDirectorReview(context.scheduled);
    const at = context.scheduled.event.dueAt;
    const anchorDueAt = simTime(payload.anchorDueAt);

    if (!this.#policy.enabled) {
      await commitScheduledEventOutcome(this.#pool, {
        worldId: context.worldId,
        eventId: context.scheduled.event.id,
        workerId: context.workerId,
        processedAt: at,
        domainEvents: [
          {
            id: asEventId(
              `runtime:director-skipped:${context.scheduled.event.id}`,
            ),
            worldId: context.worldId,
            simTime: at,
            type: "world_director.review_skipped",
            payload: {
              occurrence: payload.occurrence,
              reason: "disabled",
            },
            correlationId: context.scheduled.event.correlationId,
          },
        ],
      });
      return;
    }

    let proposal = await this.#repository.getByTriggerEvent(
      context.worldId,
      String(context.scheduled.event.id),
    );

    if (proposal === undefined) {
      const observed = await this.#repository.loadSummary(context.worldId, {
        maxPeople: this.#policy.maxPeople,
        maxRecentEvents: this.#policy.maxRecentEvents,
      });
      if (observed.currentSimTime > at) {
        throw new DomainInvariantError(
          `World Director review ${context.scheduled.event.id} is behind authoritative world time`,
        );
      }
      const summary = {
        ...observed,
        currentSimTime: at,
      };
      const affordances = buildWorldDirectorAffordances({
        summary,
        effectDelay: this.#policy.effectDelay,
        maxCandidates: this.#policy.maxCandidates,
      });
      const requestId = asCognitionRequestId(
        `world-director:cognition:${context.scheduled.event.id}`,
      );
      const decision = await this.#executor.decide(context.worldId, {
        id: requestId,
        actorId: asEntityId("__world_director__"),
        simTime: at,
        correlationId: context.scheduled.event.correlationId,
        context: worldDirectorCognitionContext(summary),
        affordances,
      });
      const selected = affordances.find(
        (affordance) => affordance.id === decision.affordanceId,
      );
      if (selected === undefined) {
        throw new DomainInvariantError(
          `World Director selected unavailable affordance ${decision.affordanceId}`,
        );
      }
      const draft = proposalFromWorldDirectorAffordance(selected);
      const proposalId =
        `world-director:proposal:${context.scheduled.event.id}`;
      const effectEventId =
        draft.status === "accepted"
          ? `runtime:director:opportunity:${context.scheduled.event.id}`
          : undefined;
      proposal = await this.#repository.record({
        worldId: context.worldId,
        id: proposalId,
        triggerEventId: String(context.scheduled.event.id),
        cognitionRequestId: String(requestId),
        affordanceId: String(decision.affordanceId),
        proposal: draft,
        intent: decision.intent,
        createdAt: at,
        ...(effectEventId === undefined ? {} : { effectEventId }),
      });
    }

    let nextOccurrence = payload.occurrence + 1;
    let nextAnchor = addSimTime(anchorDueAt, this.#policy.period);
    while (nextAnchor <= at) {
      nextAnchor = addSimTime(nextAnchor, this.#policy.period);
      nextOccurrence += 1;
    }
    const scheduledEvents: ScheduledEvent[] = [
      worldDirectorReviewEvent(nextOccurrence, nextAnchor, nextAnchor),
    ];
    if (proposal.status === "accepted") {
      const effect = worldDirectorOpportunityEvent(proposal);
      if (effect.dueAt < at) {
        throw new DomainInvariantError(
          `World Director proposal ${proposal.id} effect precedes review time`,
        );
      }
      scheduledEvents.push(effect);
    }

    await commitScheduledEventOutcome(this.#pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: at,
      domainEvents: [
        {
          id: asEventId(
            `runtime:director-reviewed:${context.scheduled.event.id}`,
          ),
          worldId: context.worldId,
          simTime: at,
          type: "world_director.review_completed",
          payload: {
            occurrence: payload.occurrence,
            proposalId: proposal.id,
            status: proposal.status,
            kind: proposal.kind,
            cognitionRequestId: proposal.cognitionRequestId,
            affordanceId: proposal.affordanceId,
            effectEventId: proposal.effectEventId ?? null,
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
      scheduledEvents,
    });
  }

  async handleOpportunity(
    context: ScheduledEventHandlerContext,
  ): Promise<void> {
    const payload = parseWorldDirectorOpportunity(context.scheduled);
    const proposal = await this.#repository.get(
      context.worldId,
      payload.proposalId,
    );
    if (proposal === undefined) {
      throw new DomainInvariantError(
        `World Director proposal does not exist: ${payload.proposalId}`,
      );
    }
    if (proposal.effectEventId !== String(context.scheduled.event.id)) {
      throw new DomainInvariantError(
        `World Director opportunity event does not match proposal ${proposal.id}`,
      );
    }
    const details = worldDirectorProposalDetails(proposal);
    if (
      details.participantIds[0] !== payload.participantIds[0] ||
      details.participantIds[1] !== payload.participantIds[1] ||
      details.dueAt !== context.scheduled.event.dueAt
    ) {
      throw new DomainInvariantError(
        `World Director opportunity ${context.scheduled.event.id} does not match persisted proposal`,
      );
    }

    const participants = await Promise.all(
      details.participantIds.map((id) =>
        this.#people.get(context.worldId, asPersonId(id)),
      ),
    );
    const available = participants.every((person) => person !== undefined);

    await commitScheduledEventOutcome(this.#pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: context.scheduled.event.dueAt,
      domainEvents: [
        {
          id: asEventId(
            `runtime:director-opportunity:${proposal.id}`,
          ),
          worldId: context.worldId,
          simTime: context.scheduled.event.dueAt,
          type: available
            ? "world.opportunity_available"
            : "world.opportunity_expired",
          targetIds: details.participantIds.map((id) => asEntityId(id)),
          payload: {
            proposalId: proposal.id,
            kind: proposal.kind,
            participantIds: [...details.participantIds],
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
    });
  }
}

export interface CoreWorldRuntimeOptions {
  readonly physiology?: PhysiologyRuntimePolicy;
  readonly social?: Partial<SocialRuntimePolicy>;
  readonly planning?: Partial<PlanningRuntimePolicy>;
  readonly dialogue?: Partial<DialogueRuntimePolicy>;
  readonly dialogueProvider?: TraceableCognitiveProvider<DialogueCognitionContext>;
  readonly director?: Partial<WorldDirectorRuntimePolicy>;
  readonly directorProvider?: TraceableCognitiveProvider<WorldDirectorCognitionContext>;
}

export class CoreWorldRuntime {
  readonly worker: DurableScheduledEventWorker;
  readonly physiology: DurablePhysiologyRuntime;
  readonly social: DurableSocialRuntime;
  readonly planning: DurablePlanningRuntime;
  readonly dialogue: DurableDialogueRuntime;
  readonly director: DurableWorldDirectorRuntime;
  readonly commitments: DurableCommitmentDispatcher;
  readonly city: PostgresCitySpatialRepository;
  readonly #people: PostgresPersonRepository;
  readonly #routines: PostgresRoutineRepository;
  readonly #employment: PostgresEmploymentRepository;
  readonly #housing: PostgresHousingRepository;

  constructor(pool: Pool, options: CoreWorldRuntimeOptions = {}) {
    const registry = new ScheduledEventHandlerRegistry();
    this.worker = new DurableScheduledEventWorker(pool, registry);
    this.physiology = new DurablePhysiologyRuntime(
      pool,
      options.physiology ?? DEFAULT_PHYSIOLOGY_RUNTIME_POLICY,
    );
    this.social = new DurableSocialRuntime(pool, {
      ...options.social,
      wakeThreshold:
        options.social?.wakeThreshold ?? this.physiology.policy.wakeThreshold,
    });
    this.planning = new DurablePlanningRuntime(pool, {
      ...options.planning,
      wakeThreshold:
        options.planning?.wakeThreshold ?? this.physiology.policy.wakeThreshold,
    });
    this.dialogue = new DurableDialogueRuntime(pool, {
      policy: {
        ...options.dialogue,
        wakeThreshold:
          options.dialogue?.wakeThreshold ?? this.physiology.policy.wakeThreshold,
      },
      ...(options.dialogueProvider === undefined
        ? {}
        : { provider: options.dialogueProvider }),
    });
    this.director = new DurableWorldDirectorRuntime(pool, {
      ...(options.director === undefined
        ? {}
        : { policy: options.director }),
      ...(options.directorProvider === undefined
        ? {}
        : { provider: options.directorProvider }),
    });
    this.commitments = new DurableCommitmentDispatcher();
    this.city = new PostgresCitySpatialRepository(pool);
    this.#people = new PostgresPersonRepository(pool);
    this.#routines = new PostgresRoutineRepository(pool);
    this.#employment = new PostgresEmploymentRepository(pool);
    this.#housing = new PostgresHousingRepository(pool);

    registry.register(PERSON_HUNGER_THRESHOLD_EVENT_TYPE, (context) =>
      this.physiology.handleHunger(context),
    );
    registry.register(PERSON_ENERGY_LOW_EVENT_TYPE, (context) =>
      this.physiology.handleEnergyLow(context),
    );
    registry.register(PERSON_ENERGY_RECOVERED_EVENT_TYPE, (context) =>
      this.physiology.handleEnergyRecovered(context),
    );
    registry.register(COMMITMENT_DUE_EVENT_TYPE, (context) =>
      this.commitments.handle(context),
    );
    registry.register(SOCIAL_CONVERSATION_OPPORTUNITY_EVENT_TYPE, (context) =>
      this.social.handleOpportunity(context),
    );
    registry.register(PLANNING_REVIEW_EVENT_TYPE, (context) =>
      this.planning.handleReview(context),
    );
    registry.register(DIALOGUE_TURN_EVENT_TYPE, (context) =>
      this.dialogue.handleTurn(context),
    );
    registry.register(WORLD_DIRECTOR_REVIEW_EVENT_TYPE, (context) =>
      this.director.handleReview(context),
    );
    registry.register(WORLD_DIRECTOR_OPPORTUNITY_EVENT_TYPE, (context) =>
      this.director.handleOpportunity(context),
    );
    registry.register(SPATIAL_TRAVEL_DEPART_EVENT_TYPE, async (context) => {
      await this.city.departTravelClaimed({
        worldId: context.worldId,
        travelId: scheduledTravelId(context.scheduled),
        scheduledEventId: context.scheduled.event.id,
        workerId: context.workerId,
      });
    });
    registry.register(SPATIAL_TRAVEL_ARRIVE_EVENT_TYPE, async (context) => {
      await this.city.arriveTravelClaimed({
        worldId: context.worldId,
        travelId: scheduledTravelId(context.scheduled),
        scheduledEventId: context.scheduled.event.id,
        workerId: context.workerId,
      });
    });

    this.commitments.register("employment.shift", async (context, due) => {
      const person = await this.#people.get(
        context.worldId,
        asPersonId(due.ownerId),
      );
      if (person !== undefined && person.person.energy.mode === "sleeping") {
        await this.#routines.missClaimedAndScheduleNext({
          worldId: context.worldId,
          commitmentId: asCommitmentId(due.commitmentId),
          workerId: context.workerId,
          at: context.scheduled.event.dueAt,
          reason: "sleeping",
        });
        return;
      }

      await this.#employment.settleShift({
        worldId: context.worldId,
        employmentId: asEmploymentId(
          nestedRequiredString(due.payload, "employmentId"),
        ),
        commitmentId: asCommitmentId(due.commitmentId),
        workerId: context.workerId,
        at: context.scheduled.event.dueAt,
      });
    });

    this.commitments.register("tenancy.rent_due", async (context, due) => {
      await this.#housing.settleRent({
        worldId: context.worldId,
        tenancyId: asTenancyId(nestedRequiredString(due.payload, "tenancyId")),
        commitmentId: asCommitmentId(due.commitmentId),
        workerId: context.workerId,
        at: context.scheduled.event.dueAt,
      });
    });
  }

  async scheduleInitialPhysiology(
    worldId: WorldId,
    personId: PersonId,
    from: SimTime,
  ): Promise<readonly ScheduledEvent[]> {
    return this.physiology.scheduleInitial(worldId, personId, from);
  }

  async scheduleInitialSocial(
    worldId: WorldId,
    personId: PersonId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent> {
    return this.social.scheduleInitial(worldId, personId, dueAt);
  }

  async seedSocialClaim(
    worldId: WorldId,
    ownerId: EntityId,
    at: SimTime,
    claim: SocialSeedClaim,
  ): Promise<void> {
    return this.social.seedClaim(worldId, ownerId, at, claim);
  }

  async createLifeGoal(
    worldId: WorldId,
    goal: LifeGoal,
  ): Promise<void> {
    return this.planning.createGoal(worldId, goal);
  }

  async scheduleInitialPlanning(
    worldId: WorldId,
    personId: PersonId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent> {
    return this.planning.scheduleInitial(worldId, personId, dueAt);
  }

  async scheduleInitialDirector(
    worldId: WorldId,
    dueAt: SimTime,
  ): Promise<ScheduledEvent | undefined> {
    return this.director.scheduleInitial(worldId, dueAt);
  }

  async startDialogue(input: {
    readonly worldId: WorldId;
    readonly conversationId: ConversationId;
    readonly participantIds: readonly [PersonId, PersonId];
    readonly firstSpeakerId: PersonId;
    readonly startedAt: SimTime;
    readonly maxTurns: number;
    readonly turnInterval?: SimDuration;
  }): Promise<ScheduledEvent> {
    return this.dialogue.startConversation(input);
  }

  async planTravel(input: PlanTravelInput): Promise<PersistedTravelIntent> {
    return this.city.planTravel(input);
  }

  async processThrough(input: ProcessScheduledEventsInput): Promise<number> {
    return this.worker.processThrough(input);
  }

  async requeueStale(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    return this.worker.requeueStale(worldId, staleBefore, limit);
  }

  async requeueStaleSocialDeliveries(
    worldId: WorldId,
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    return this.social.requeueStaleDeliveries(worldId, staleBefore, limit);
  }

  registerEventHandler(type: string, handler: ScheduledEventHandler): void {
    this.worker.handlers.register(type, handler);
  }

  registerCommitmentHandler(kind: string, handler: CommitmentKindHandler): void {
    this.commitments.register(kind, handler);
  }
}
