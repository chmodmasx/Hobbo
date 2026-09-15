import { ActionRegistry, type ActionRequest } from "@hobbo/actions";
import {
  CONSUME_FOOD_ACTION_ID,
  consumeFood,
  createConsumeFoodActionDefinition,
  createEnergyState,
  createFoodItem,
  createHungerState,
  hungerAt,
  timeUntilHunger,
  type PersonState,
} from "@hobbo/agents";
import {
  DomainInvariantError,
  SIM_DAY,
  addSimTime,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";
import {
  DeterministicRandom,
  DeterministicScheduler,
  InMemoryDomainEventLog,
  WorldClock,
  type ScheduledEvent,
} from "@hobbo/simulation";

export const HEADLESS_AGENT_COUNT = 20;
export const HEADLESS_HUNGER_THRESHOLD = 7_000;
export const HEADLESS_DURATION = (BigInt(SIM_DAY) * 30n) as SimDuration;

const WORLD_ID = asWorldId("headless-world");
const HUNGER_EVENT_TYPE = "person.hunger_threshold";

interface HungerEventPayload {
  readonly personId: string;
}

export interface HeadlessAgentSummary {
  readonly id: string;
  readonly mealsEaten: number;
  readonly remainingFood: number;
  readonly finalHunger: number;
}

export interface HeadlessSimulationResult {
  readonly seed: bigint;
  readonly agentCount: number;
  readonly finalSimTime: SimTime;
  readonly processedScheduledEvents: number;
  readonly domainEventCount: number;
  readonly agents: readonly HeadlessAgentSummary[];
}

export interface HeadlessSimulationOptions {
  readonly seed?: bigint;
  readonly agentCount?: number;
  readonly duration?: SimDuration;
}

function makePerson(index: number, random: DeterministicRandom): PersonState {
  const personId = asPersonId(`person-${String(index + 1).padStart(2, "0")}`);
  const initialHunger = random.nextInt(3_500);
  const ratePerHour = 500 + random.nextInt(301);
  const inventory = Array.from({ length: 100 }, (_, foodIndex) =>
    createFoodItem(
      `${personId}:food-${foodIndex + 1}`,
      "Prepared meal",
      6_500 + random.nextInt(1_501),
    ),
  );

  return {
    id: personId,
    hunger: createHungerState(initialHunger, simTime(0), ratePerHour),
    energy: createEnergyState(8_000, simTime(0), 450, 1_800, "awake"),
    inventory,
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

function scheduleNextHungerEvent(
  person: PersonState,
  scheduler: DeterministicScheduler,
): void {
  const wait = timeUntilHunger(
    person.hunger,
    HEADLESS_HUNGER_THRESHOLD,
    scheduler.clock.now(),
  );
  if (wait === undefined) return;

  scheduler.schedule({
    id: asScheduledEventId(`hunger:${person.id}:${person.mealsEaten}`),
    dueAt: addSimTime(scheduler.clock.now(), wait),
    type: HUNGER_EVENT_TYPE,
    payload: { personId: String(person.id) } satisfies HungerEventPayload,
    correlationId: asCorrelationId(
      `hunger:${person.id}:${person.mealsEaten}`,
    ),
  });
}

export function runHeadlessFoodSimulation(
  options: HeadlessSimulationOptions = {},
): HeadlessSimulationResult {
  const seed = options.seed ?? 0x484f42424fn;
  const agentCount = options.agentCount ?? HEADLESS_AGENT_COUNT;
  const duration = options.duration ?? HEADLESS_DURATION;

  if (!Number.isSafeInteger(agentCount) || agentCount <= 0) {
    throw new DomainInvariantError("agentCount must be a positive safe integer");
  }

  const random = new DeterministicRandom(seed);
  const clock = new WorldClock(simTime(0));
  const scheduler = new DeterministicScheduler(clock);
  const events = new InMemoryDomainEventLog();
  const actions = new ActionRegistry<PersonState>();
  actions.register(createConsumeFoodActionDefinition());

  const people = new Map<string, PersonState>();
  for (let index = 0; index < agentCount; index += 1) {
    const person = makePerson(index, random);
    people.set(String(person.id), person);
    scheduleNextHungerEvent(person, scheduler);
  }

  const endTime = addSimTime(simTime(0), duration);
  const processedScheduledEvents = scheduler.runUntil(
    endTime,
    (scheduled: ScheduledEvent) => {
      if (scheduled.type !== HUNGER_EVENT_TYPE) {
        throw new DomainInvariantError(
          `Unexpected scheduled event type: ${scheduled.type}`,
        );
      }

      const payload = scheduled.payload as HungerEventPayload;
      const person = people.get(payload.personId);
      if (person === undefined) {
        throw new DomainInvariantError(
          `Scheduled hunger event references missing person: ${payload.personId}`,
        );
      }

      const hunger = hungerAt(person.hunger, scheduler.clock.now());
      if (hunger < HEADLESS_HUNGER_THRESHOLD) {
        throw new DomainInvariantError(
          `Hunger event fired before threshold for ${person.id}`,
        );
      }

      const food = person.inventory[0];
      if (food === undefined) {
        throw new DomainInvariantError(
          `Headless fixture exhausted food for ${person.id}`,
        );
      }

      const actorId = asEntityId(String(person.id));
      const correlationId = asCorrelationId(
        `meal:${person.id}:${person.mealsEaten + 1}`,
      );
      const request: ActionRequest = {
        actionId: CONSUME_FOOD_ACTION_ID,
        actorId,
        origin: "rule",
        requestedAt: scheduler.clock.now(),
        correlationId,
        input: { itemId: food.id },
      };

      const validation = actions.validate(request, {
        actorId,
        simTime: scheduler.clock.now(),
        worldState: person,
      });
      if (!validation.ok) {
        throw new DomainInvariantError(
          `Validated headless meal was rejected: ${validation.code}`,
        );
      }

      const result = consumeFood(person, food.id, scheduler.clock.now());
      people.set(String(person.id), result.person);

      events.append({
        id: asEventId(`meal:${person.id}:${result.person.mealsEaten}`),
        worldId: WORLD_ID,
        simTime: scheduler.clock.now(),
        type: "person.ate",
        actorId,
        payload: {
          itemId: result.item.id,
          hungerBefore: result.hungerBefore,
          hungerAfter: result.hungerAfter,
        },
        correlationId,
      });

      scheduleNextHungerEvent(result.person, scheduler);
    },
  );

  const agents = [...people.values()]
    .map((person) => ({
      id: String(person.id),
      mealsEaten: person.mealsEaten,
      remainingFood: person.inventory.length,
      finalHunger: hungerAt(person.hunger, endTime),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    seed,
    agentCount,
    finalSimTime: clock.now(),
    processedScheduledEvents,
    domainEventCount: events.size,
    agents,
  };
}

export * from "./sleep.ts";
export * from "./routines.ts";
export * from "./social-life.ts";
