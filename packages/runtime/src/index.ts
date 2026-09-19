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
  retellStatement,
  type ConversationStatement,
  type StatementOrigin,
} from "@hobbo/conversation";
import {
  commitScheduledEventOutcome,
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
  type PersistedScheduledEvent,
} from "@hobbo/database";
import {
  DomainInvariantError,
  SIM_DAY,
  SIM_HOUR,
  SIM_SECOND,
  addSimTime,
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
  simTime,
  type ActionId,
  type EntityId,
  type PersonId,
  type SimDuration,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  COMMITMENT_DUE_EVENT_TYPE,
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
    occurrence: payload.occurrence,
    anchorDueAt: payload.anchorDueAt,
  };
}

function socialOpportunityEvent(
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
    const event = socialOpportunityEvent(personId, 1, dueAt);
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

    const listenerId = await this.#pickListener(
      context.worldId,
      personId,
      payload.occurrence,
    );
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
    const next = socialOpportunityEvent(
      personId,
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

  async #pickListener(
    worldId: WorldId,
    speakerId: PersonId,
    occurrence: number,
  ): Promise<EntityId> {
    const candidates = (await this.#people.listIds(worldId))
      .filter((candidate) => candidate !== speakerId)
      .map((candidate) => asEntityId(String(candidate)));
    if (candidates.length === 0) {
      throw new DomainInvariantError(
        `Social actor ${speakerId} has no available listener`,
      );
    }
    const index =
      stableHash(`${speakerId}:${occurrence}:listener`) % candidates.length;
    return candidates[index]!;
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

      const claimed = await this.#conversations.claimPendingDeliveries(
        worldId,
        workerId,
        1,
      );
      const delivery = claimed[0];
      if (delivery === undefined) {
        throw new DomainInvariantError(
          `Social delivery ${messageId} could not be claimed`,
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

export interface CoreWorldRuntimeOptions {
  readonly physiology?: PhysiologyRuntimePolicy;
  readonly social?: Partial<SocialRuntimePolicy>;
  readonly planning?: Partial<PlanningRuntimePolicy>;
}

export class CoreWorldRuntime {
  readonly worker: DurableScheduledEventWorker;
  readonly physiology: DurablePhysiologyRuntime;
  readonly social: DurableSocialRuntime;
  readonly planning: DurablePlanningRuntime;
  readonly commitments: DurableCommitmentDispatcher;
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
    this.commitments = new DurableCommitmentDispatcher();
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
