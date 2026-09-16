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
  commitScheduledEventOutcome,
  PostgresEmploymentRepository,
  PostgresHousingRepository,
  PostgresPersonRepository,
  PostgresRoutineRepository,
  PostgresScheduledEventRepository,
  type PersistedScheduledEvent,
} from "@hobbo/database";
import {
  DomainInvariantError,
  addSimTime,
  asCommitmentId,
  asCorrelationId,
  asEmploymentId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asTenancyId,
  type ActionId,
  type PersonId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  COMMITMENT_DUE_EVENT_TYPE,
  type CommitmentDuePayload,
  type ScheduledEvent,
} from "@hobbo/simulation";
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

export interface CoreWorldRuntimeOptions {
  readonly physiology?: PhysiologyRuntimePolicy;
}

export class CoreWorldRuntime {
  readonly worker: DurableScheduledEventWorker;
  readonly physiology: DurablePhysiologyRuntime;
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

  registerEventHandler(type: string, handler: ScheduledEventHandler): void {
    this.worker.handlers.register(type, handler);
  }

  registerCommitmentHandler(kind: string, handler: CommitmentKindHandler): void {
    this.commitments.register(kind, handler);
  }
}
