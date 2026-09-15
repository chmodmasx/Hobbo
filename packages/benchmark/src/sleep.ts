import { ActionRegistry, type ActionRequest } from "@hobbo/actions";
import {
  BEGIN_SLEEP_ACTION_ID,
  WAKE_UP_ACTION_ID,
  beginSleep,
  createBeginSleepActionDefinition,
  createEnergyState,
  createHungerState,
  createWakeUpActionDefinition,
  energyAt,
  timeUntilEnergyAtLeast,
  timeUntilEnergyAtMost,
  wakeUp,
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

export const HEADLESS_SLEEP_AGENT_COUNT = 20;
export const HEADLESS_SLEEP_THRESHOLD = 2_500;
export const HEADLESS_WAKE_THRESHOLD = 9_000;
export const HEADLESS_SLEEP_DURATION = (BigInt(SIM_DAY) * 30n) as SimDuration;

const WORLD_ID = asWorldId("headless-sleep-world");
const LOW_ENERGY_EVENT = "person.energy_low";
const RECOVERED_ENERGY_EVENT = "person.energy_recovered";

interface EnergyEventPayload {
  readonly personId: string;
}

export interface HeadlessSleepAgentSummary {
  readonly id: string;
  readonly sleepSessions: number;
  readonly finalEnergy: number;
  readonly finalMode: "awake" | "sleeping";
}

export interface HeadlessSleepSimulationResult {
  readonly seed: bigint;
  readonly agentCount: number;
  readonly finalSimTime: SimTime;
  readonly processedScheduledEvents: number;
  readonly domainEventCount: number;
  readonly agents: readonly HeadlessSleepAgentSummary[];
}

export interface HeadlessSleepSimulationOptions {
  readonly seed?: bigint;
  readonly agentCount?: number;
  readonly duration?: SimDuration;
}

function makePerson(index: number, random: DeterministicRandom): PersonState {
  const personId = asPersonId(`sleeper-${String(index + 1).padStart(2, "0")}`);
  const initialEnergy = 6_000 + random.nextInt(3_001);
  const awakeDrain = 450 + random.nextInt(201);
  const sleepRecovery = 1_600 + random.nextInt(601);

  return {
    id: personId,
    hunger: createHungerState(0, simTime(0), 0),
    energy: createEnergyState(
      initialEnergy,
      simTime(0),
      awakeDrain,
      sleepRecovery,
      "awake",
    ),
    inventory: [],
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

function scheduleNextTransition(
  person: PersonState,
  scheduler: DeterministicScheduler,
): void {
  if (person.energy.mode === "awake") {
    const wait = timeUntilEnergyAtMost(
      person.energy,
      HEADLESS_SLEEP_THRESHOLD,
      scheduler.clock.now(),
    );
    if (wait === undefined) return;

    const session = person.sleepSessions + 1;
    scheduler.schedule({
      id: asScheduledEventId(`sleep-trigger:${person.id}:${session}`),
      dueAt: addSimTime(scheduler.clock.now(), wait),
      type: LOW_ENERGY_EVENT,
      payload: { personId: String(person.id) } satisfies EnergyEventPayload,
      correlationId: asCorrelationId(`sleep:${person.id}:${session}`),
    });
    return;
  }

  const wait = timeUntilEnergyAtLeast(
    person.energy,
    HEADLESS_WAKE_THRESHOLD,
    scheduler.clock.now(),
  );
  if (wait === undefined) return;

  scheduler.schedule({
    id: asScheduledEventId(`wake-trigger:${person.id}:${person.sleepSessions}`),
    dueAt: addSimTime(scheduler.clock.now(), wait),
    type: RECOVERED_ENERGY_EVENT,
    payload: { personId: String(person.id) } satisfies EnergyEventPayload,
    correlationId: asCorrelationId(
      `wake:${person.id}:${person.sleepSessions}`,
    ),
  });
}

export function runHeadlessSleepSimulation(
  options: HeadlessSleepSimulationOptions = {},
): HeadlessSleepSimulationResult {
  const seed = options.seed ?? 0x534c454550n;
  const agentCount = options.agentCount ?? HEADLESS_SLEEP_AGENT_COUNT;
  const duration = options.duration ?? HEADLESS_SLEEP_DURATION;

  if (!Number.isSafeInteger(agentCount) || agentCount <= 0) {
    throw new DomainInvariantError("agentCount must be a positive safe integer");
  }

  const random = new DeterministicRandom(seed);
  const clock = new WorldClock(simTime(0));
  const scheduler = new DeterministicScheduler(clock);
  const events = new InMemoryDomainEventLog();
  const actions = new ActionRegistry<PersonState>();
  actions.register(createBeginSleepActionDefinition());
  actions.register(createWakeUpActionDefinition());

  const people = new Map<string, PersonState>();
  for (let index = 0; index < agentCount; index += 1) {
    const person = makePerson(index, random);
    people.set(String(person.id), person);
    scheduleNextTransition(person, scheduler);
  }

  const endTime = addSimTime(simTime(0), duration);
  const processedScheduledEvents = scheduler.runUntil(
    endTime,
    (scheduled: ScheduledEvent) => {
      if (
        scheduled.type !== LOW_ENERGY_EVENT &&
        scheduled.type !== RECOVERED_ENERGY_EVENT
      ) {
        throw new DomainInvariantError(
          `Unexpected energy event type: ${scheduled.type}`,
        );
      }

      const payload = scheduled.payload as EnergyEventPayload;
      const person = people.get(payload.personId);
      if (person === undefined) {
        throw new DomainInvariantError(
          `Energy event references missing person: ${payload.personId}`,
        );
      }

      const actorId = asEntityId(String(person.id));
      const currentEnergy = energyAt(person.energy, scheduler.clock.now());

      if (scheduled.type === LOW_ENERGY_EVENT) {
        if (
          person.energy.mode !== "awake" ||
          currentEnergy > HEADLESS_SLEEP_THRESHOLD
        ) {
          throw new DomainInvariantError(
            `Sleep trigger fired outside its threshold for ${person.id}`,
          );
        }

        const request: ActionRequest = {
          actionId: BEGIN_SLEEP_ACTION_ID,
          actorId,
          origin: "rule",
          requestedAt: scheduler.clock.now(),
          correlationId: scheduled.correlationId,
          input: null,
        };
        const validation = actions.validate(request, {
          actorId,
          simTime: scheduler.clock.now(),
          worldState: person,
        });
        if (!validation.ok) {
          throw new DomainInvariantError(
            `Validated sleep transition was rejected: ${validation.code}`,
          );
        }

        const sleeping = beginSleep(person, scheduler.clock.now());
        people.set(String(person.id), sleeping);
        events.append({
          id: asEventId(`sleep-start:${person.id}:${sleeping.sleepSessions}`),
          worldId: WORLD_ID,
          simTime: scheduler.clock.now(),
          type: "person.sleep_started",
          actorId,
          payload: { energy: sleeping.energy.value },
          correlationId: scheduled.correlationId,
        });
        scheduleNextTransition(sleeping, scheduler);
        return;
      }

      if (
        person.energy.mode !== "sleeping" ||
        currentEnergy < HEADLESS_WAKE_THRESHOLD
      ) {
        throw new DomainInvariantError(
          `Wake trigger fired outside its threshold for ${person.id}`,
        );
      }

      const request: ActionRequest = {
        actionId: WAKE_UP_ACTION_ID,
        actorId,
        origin: "rule",
        requestedAt: scheduler.clock.now(),
        correlationId: scheduled.correlationId,
        input: null,
      };
      const validation = actions.validate(request, {
        actorId,
        simTime: scheduler.clock.now(),
        worldState: person,
      });
      if (!validation.ok) {
        throw new DomainInvariantError(
          `Validated wake transition was rejected: ${validation.code}`,
        );
      }

      const awake = wakeUp(person, scheduler.clock.now());
      people.set(String(person.id), awake);
      events.append({
        id: asEventId(`wake:${person.id}:${awake.sleepSessions}`),
        worldId: WORLD_ID,
        simTime: scheduler.clock.now(),
        type: "person.woke_up",
        actorId,
        payload: { energy: awake.energy.value },
        correlationId: scheduled.correlationId,
      });
      scheduleNextTransition(awake, scheduler);
    },
  );

  const agents = [...people.values()]
    .map((person) => ({
      id: String(person.id),
      sleepSessions: person.sleepSessions,
      finalEnergy: energyAt(person.energy, endTime),
      finalMode: person.energy.mode,
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
