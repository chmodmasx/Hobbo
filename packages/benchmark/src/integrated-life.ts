import { ActionRegistry, type ActionRequest } from "@hobbo/actions";
import {
  BEGIN_SLEEP_ACTION_ID,
  CONSUME_FOOD_ACTION_ID,
  WAKE_UP_ACTION_ID,
  beginSleep,
  consumeFood,
  createBeginSleepActionDefinition,
  createConsumeFoodActionDefinition,
  createEnergyState,
  createFoodItem,
  createHungerState,
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
  deriveListenerEffects,
  deriveSpeakerMemory,
  reviseBeliefFromReportedPerception,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationStatement,
} from "@hobbo/conversation";
import {
  DomainInvariantError,
  SIM_DAY,
  SIM_HOUR,
  SIM_MINUTE,
  addSimTime,
  asConversationId,
  asConversationMessageId,
  asConversationStatementId,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asRoutineId,
  asScheduledEventId,
  asWorldId,
  simDuration,
  simTime,
  type EntityId,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";
import type { MemoryRecord } from "@hobbo/memory";
import {
  applyRelationshipDelta,
  zeroRelationshipVector,
  type BeliefState,
  type PerceptionRecord,
  type RelationshipVector,
} from "@hobbo/social";
import {
  COMMITMENT_DUE_EVENT_TYPE,
  DeterministicRandom,
  DeterministicScheduler,
  InMemoryDomainEventLog,
  WorldClock,
  nextRoutineCommitment,
  scheduledEventForCommitment,
  type Commitment,
  type PeriodicRoutine,
  type ScheduledEvent,
} from "@hobbo/simulation";

export const INTEGRATED_LIFE_AGENT_COUNT = 20;
export const INTEGRATED_LIFE_DURATION = (BigInt(SIM_DAY) * 30n) as SimDuration;
export const INTEGRATED_HUNGER_THRESHOLD = 7_000;
export const INTEGRATED_SLEEP_THRESHOLD = 2_500;
export const INTEGRATED_WAKE_THRESHOLD = 9_000;

const WORLD_ID = asWorldId("integrated-life-world");
const HUNGER_EVENT = "integrated.hunger";
const LOW_ENERGY_EVENT = "integrated.energy_low";
const RECOVERED_ENERGY_EVENT = "integrated.energy_recovered";
const SOCIAL_EVENT = "integrated.social_opportunity";

interface PersonPayload {
  readonly personId: string;
}

interface SocialPayload extends PersonPayload {
  readonly occurrence: number;
}

interface RoutinePayload {
  readonly activity: "work";
}

interface MutableLifeAgent {
  person: PersonState;
  readonly entityId: EntityId;
  readonly homeId: string;
  readonly workplaceId: string;
  readonly neighborhoodId: string;
  hungerScheduleSerial: number;
  routinesFulfilled: number;
  routinesMissed: number;
  socialOpportunities: number;
  conversationsSpoken: number;
  conversationsHeard: number;
  socialSkippedSleeping: number;
  readonly perceptions: PerceptionRecord[];
  readonly beliefs: Map<string, BeliefState>;
  readonly memories: MemoryRecord[];
}

export interface IntegratedLifeAgentSummary {
  readonly id: string;
  readonly homeId: string;
  readonly workplaceId: string;
  readonly neighborhoodId: string;
  readonly mealsEaten: number;
  readonly sleepSessions: number;
  readonly routinesFulfilled: number;
  readonly routinesMissed: number;
  readonly socialOpportunities: number;
  readonly conversationsSpoken: number;
  readonly conversationsHeard: number;
  readonly socialSkippedSleeping: number;
  readonly perceptionCount: number;
  readonly beliefCount: number;
  readonly memoryCount: number;
  readonly finalHunger: number;
  readonly finalEnergy: number;
  readonly finalEnergyMode: "awake" | "sleeping";
  readonly beliefSignature: string;
}

export interface IntegratedLifeSimulationResult {
  readonly seed: bigint;
  readonly agentCount: number;
  readonly finalSimTime: SimTime;
  readonly processedScheduledEvents: number;
  readonly domainEventCount: number;
  readonly mealsEaten: number;
  readonly sleepSessions: number;
  readonly routineOpportunities: number;
  readonly routinesFulfilled: number;
  readonly routinesMissed: number;
  readonly socialOpportunities: number;
  readonly conversationCount: number;
  readonly socialSkippedSleeping: number;
  readonly totalPerceptions: number;
  readonly totalBeliefs: number;
  readonly totalMemories: number;
  readonly distinctBeliefSignatures: number;
  readonly familiarRelationshipEdges: number;
  readonly maxFutureQueueSize: number;
  readonly agents: readonly IntegratedLifeAgentSummary[];
}

export interface IntegratedLifeSimulationOptions {
  readonly seed?: bigint;
  readonly agentCount?: number;
  readonly duration?: SimDuration;
}

function beliefKey(subjectId: string, predicate: string): string {
  return `${subjectId}\u0000${predicate}`;
}

function relationshipKey(from: EntityId, to: EntityId): string {
  return `${from}\u0000${to}`;
}

function makeAgent(index: number, random: DeterministicRandom): MutableLifeAgent {
  const personId = asPersonId(`life-person-${String(index + 1).padStart(2, "0")}`);
  const entityId = asEntityId(String(personId));
  const inventory = Array.from({ length: 120 }, (_, foodIndex) =>
    createFoodItem(
      `${personId}:food-${foodIndex + 1}`,
      "Prepared meal",
      6_500 + random.nextInt(1_501),
    ),
  );

  return {
    person: {
      id: personId,
      hunger: createHungerState(
        random.nextInt(3_500),
        simTime(0),
        500 + random.nextInt(301),
      ),
      energy: createEnergyState(
        6_000 + random.nextInt(3_001),
        simTime(0),
        450 + random.nextInt(201),
        1_600 + random.nextInt(601),
        "awake",
      ),
      inventory,
      mealsEaten: 0,
      sleepSessions: 0,
    },
    entityId,
    homeId: `home-${String(Math.floor(index / 2) + 1).padStart(2, "0")}`,
    workplaceId: `workplace-${(index % 4) + 1}`,
    neighborhoodId: `neighborhood-${(index % 5) + 1}`,
    hungerScheduleSerial: 0,
    routinesFulfilled: 0,
    routinesMissed: 0,
    socialOpportunities: 0,
    conversationsSpoken: 0,
    conversationsHeard: 0,
    socialSkippedSleeping: 0,
    perceptions: [],
    beliefs: new Map(),
    memories: [],
  };
}

function makeRoutine(index: number, ownerId: EntityId): PeriodicRoutine<RoutinePayload> {
  return {
    id: asRoutineId(`integrated-work:${ownerId}`),
    ownerId,
    period: simDuration(SIM_DAY),
    phase: simDuration(
      BigInt(SIM_HOUR) * 9n + BigInt(index % 10) * BigInt(SIM_MINUTE) * 7n,
    ),
    kind: "routine.work",
    payload: { activity: "work" },
  };
}

function stableBeliefSignature(agent: MutableLifeAgent): string {
  return [...agent.beliefs.values()]
    .sort((left, right) =>
      beliefKey(left.subjectId, left.predicate).localeCompare(
        beliefKey(right.subjectId, right.predicate),
      ),
    )
    .map(
      (belief) =>
        `${belief.subjectId}:${belief.predicate}=${JSON.stringify(belief.value)}@${belief.confidenceBps}`,
    )
    .join("|");
}

function physicallyAwake(agent: MutableLifeAgent): boolean {
  return agent.person.energy.mode === "awake";
}

export function runIntegratedLifeSimulation(
  options: IntegratedLifeSimulationOptions = {},
): IntegratedLifeSimulationResult {
  const seed = options.seed ?? 0x4c494645n;
  const agentCount = options.agentCount ?? INTEGRATED_LIFE_AGENT_COUNT;
  const duration = options.duration ?? INTEGRATED_LIFE_DURATION;

  if (!Number.isSafeInteger(agentCount) || agentCount < 2) {
    throw new DomainInvariantError("integrated-life agentCount must be a safe integer >= 2");
  }

  const random = new DeterministicRandom(seed);
  const clock = new WorldClock(simTime(0));
  const scheduler = new DeterministicScheduler(clock);
  const events = new InMemoryDomainEventLog();
  const actions = new ActionRegistry<PersonState>();
  actions.register(createConsumeFoodActionDefinition());
  actions.register(createBeginSleepActionDefinition());
  actions.register(createWakeUpActionDefinition());

  const agents = Array.from({ length: agentCount }, (_, index) =>
    makeAgent(index, random),
  );
  const byId = new Map(agents.map((agent) => [String(agent.entityId), agent] as const));
  const routines = new Map<string, PeriodicRoutine<RoutinePayload>>();
  const commitments = new Map<string, Commitment<RoutinePayload>>();
  const relationships = new Map<string, RelationshipVector>();
  const endTime = addSimTime(simTime(0), duration);

  let maxFutureQueueSize = 0;
  let routineOpportunities = 0;
  let socialOpportunities = 0;
  let conversationCount = 0;

  for (const from of agents) {
    for (const to of agents) {
      if (from.entityId === to.entityId) continue;
      relationships.set(relationshipKey(from.entityId, to.entityId), {
        ...zeroRelationshipVector(),
        trust: random.nextInt(16_001) - 8_000,
        affection: random.nextInt(4_001) - 2_000,
        respect: random.nextInt(4_001) - 2_000,
      });
    }
  }

  function recordQueueSize(): void {
    maxFutureQueueSize = Math.max(maxFutureQueueSize, scheduler.queue.size);
  }

  function scheduleHunger(agent: MutableLifeAgent, from: SimTime): void {
    const wait = timeUntilHunger(
      agent.person.hunger,
      INTEGRATED_HUNGER_THRESHOLD,
      from,
    );
    if (wait === undefined) return;
    agent.hungerScheduleSerial += 1;
    scheduler.schedule({
      id: asScheduledEventId(
        `integrated-hunger:${agent.entityId}:${agent.hungerScheduleSerial}`,
      ),
      dueAt: addSimTime(from, wait),
      type: HUNGER_EVENT,
      payload: { personId: String(agent.entityId) } satisfies PersonPayload,
      correlationId: asCorrelationId(
        `integrated-hunger:${agent.entityId}:${agent.hungerScheduleSerial}`,
      ),
    });
    recordQueueSize();
  }

  function scheduleEnergyTransition(agent: MutableLifeAgent, from: SimTime): void {
    if (agent.person.energy.mode === "awake") {
      const wait = timeUntilEnergyAtMost(
        agent.person.energy,
        INTEGRATED_SLEEP_THRESHOLD,
        from,
      );
      if (wait === undefined) return;
      scheduler.schedule({
        id: asScheduledEventId(
          `integrated-sleep:${agent.entityId}:${agent.person.sleepSessions + 1}`,
        ),
        dueAt: addSimTime(from, wait),
        type: LOW_ENERGY_EVENT,
        payload: { personId: String(agent.entityId) } satisfies PersonPayload,
        correlationId: asCorrelationId(
          `integrated-sleep:${agent.entityId}:${agent.person.sleepSessions + 1}`,
        ),
      });
      recordQueueSize();
      return;
    }

    const wait = timeUntilEnergyAtLeast(
      agent.person.energy,
      INTEGRATED_WAKE_THRESHOLD,
      from,
    );
    if (wait === undefined) return;
    scheduler.schedule({
      id: asScheduledEventId(
        `integrated-wake:${agent.entityId}:${agent.person.sleepSessions}`,
      ),
      dueAt: addSimTime(from, wait),
      type: RECOVERED_ENERGY_EVENT,
      payload: { personId: String(agent.entityId) } satisfies PersonPayload,
      correlationId: asCorrelationId(
        `integrated-wake:${agent.entityId}:${agent.person.sleepSessions}`,
      ),
    });
    recordQueueSize();
  }

  function scheduleRoutine(
    routine: PeriodicRoutine<RoutinePayload>,
    from: SimTime,
  ): void {
    const commitment = nextRoutineCommitment(routine, from, false);
    const scheduled = scheduledEventForCommitment(commitment);
    commitments.set(String(scheduled.id), commitment);
    scheduler.schedule(scheduled);
    recordQueueSize();
  }

  function scheduleSocial(
    agent: MutableLifeAgent,
    occurrence: number,
    dueAt: SimTime,
  ): void {
    scheduler.schedule({
      id: asScheduledEventId(`integrated-social:${agent.entityId}:${occurrence}`),
      dueAt,
      type: SOCIAL_EVENT,
      payload: {
        personId: String(agent.entityId),
        occurrence,
      } satisfies SocialPayload,
      correlationId: asCorrelationId(
        `integrated-social:${agent.entityId}:${occurrence}`,
      ),
    });
    recordQueueSize();
  }

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!;
    scheduleHunger(agent, simTime(0));
    scheduleEnergyTransition(agent, simTime(0));

    const routine = makeRoutine(index, agent.entityId);
    routines.set(String(routine.id), routine);
    scheduleRoutine(routine, simTime(0));

    const socialPhase = simTime(
      BigInt(SIM_HOUR) * 18n + BigInt(index % 10) * BigInt(SIM_MINUTE) * 5n,
    );
    scheduleSocial(agent, 1, socialPhase);
  }

  const processedScheduledEvents = scheduler.runUntil(
    endTime,
    (scheduled: ScheduledEvent) => {
      if (scheduled.type === HUNGER_EVENT) {
        const payload = scheduled.payload as PersonPayload;
        const agent = byId.get(payload.personId);
        if (agent === undefined) throw new Error(`Missing hunger agent ${payload.personId}`);

        if (!physicallyAwake(agent)) {
          const wait = timeUntilEnergyAtLeast(
            agent.person.energy,
            INTEGRATED_WAKE_THRESHOLD,
            scheduler.clock.now(),
          );
          if (wait === undefined) {
            throw new DomainInvariantError(
              `Sleeping hungry agent ${agent.entityId} has no wake transition`,
            );
          }
          agent.hungerScheduleSerial += 1;
          scheduler.schedule({
            id: asScheduledEventId(
              `integrated-hunger:${agent.entityId}:${agent.hungerScheduleSerial}`,
            ),
            dueAt: addSimTime(scheduler.clock.now(), wait),
            type: HUNGER_EVENT,
            payload: { personId: String(agent.entityId) } satisfies PersonPayload,
            correlationId: scheduled.correlationId,
          });
          recordQueueSize();
          return;
        }

        if (hungerAt(agent.person.hunger, scheduler.clock.now()) < INTEGRATED_HUNGER_THRESHOLD) {
          throw new DomainInvariantError(
            `Integrated hunger event fired before threshold for ${agent.entityId}`,
          );
        }
        const food = agent.person.inventory[0];
        if (food === undefined) {
          throw new DomainInvariantError(
            `Integrated fixture exhausted food for ${agent.entityId}`,
          );
        }
        const request: ActionRequest = {
          actionId: CONSUME_FOOD_ACTION_ID,
          actorId: agent.entityId,
          origin: "rule",
          requestedAt: scheduler.clock.now(),
          correlationId: scheduled.correlationId,
          input: { itemId: food.id },
        };
        const validation = actions.validate(request, {
          actorId: agent.entityId,
          simTime: scheduler.clock.now(),
          worldState: agent.person,
        });
        if (!validation.ok) {
          throw new DomainInvariantError(
            `Integrated meal rejected: ${validation.code}`,
          );
        }
        const consumed = consumeFood(agent.person, food.id, scheduler.clock.now());
        agent.person = consumed.person;
        events.append({
          id: asEventId(`integrated-meal:${agent.entityId}:${agent.person.mealsEaten}`),
          worldId: WORLD_ID,
          simTime: scheduler.clock.now(),
          type: "person.ate",
          actorId: agent.entityId,
          payload: {
            itemId: consumed.item.id,
            hungerBefore: consumed.hungerBefore,
            hungerAfter: consumed.hungerAfter,
          },
          correlationId: scheduled.correlationId,
        });
        scheduleHunger(agent, scheduler.clock.now());
        return;
      }

      if (scheduled.type === LOW_ENERGY_EVENT) {
        const payload = scheduled.payload as PersonPayload;
        const agent = byId.get(payload.personId);
        if (agent === undefined) throw new Error(`Missing sleep agent ${payload.personId}`);
        if (
          agent.person.energy.mode !== "awake" ||
          energyAt(agent.person.energy, scheduler.clock.now()) > INTEGRATED_SLEEP_THRESHOLD
        ) {
          throw new DomainInvariantError(
            `Integrated sleep trigger fired outside threshold for ${agent.entityId}`,
          );
        }
        const request: ActionRequest = {
          actionId: BEGIN_SLEEP_ACTION_ID,
          actorId: agent.entityId,
          origin: "rule",
          requestedAt: scheduler.clock.now(),
          correlationId: scheduled.correlationId,
          input: null,
        };
        const validation = actions.validate(request, {
          actorId: agent.entityId,
          simTime: scheduler.clock.now(),
          worldState: agent.person,
        });
        if (!validation.ok) {
          throw new DomainInvariantError(
            `Integrated sleep rejected: ${validation.code}`,
          );
        }
        agent.person = beginSleep(agent.person, scheduler.clock.now());
        events.append({
          id: asEventId(
            `integrated-sleep:${agent.entityId}:${agent.person.sleepSessions}`,
          ),
          worldId: WORLD_ID,
          simTime: scheduler.clock.now(),
          type: "person.sleep_started",
          actorId: agent.entityId,
          payload: { energy: agent.person.energy.value },
          correlationId: scheduled.correlationId,
        });
        scheduleEnergyTransition(agent, scheduler.clock.now());
        return;
      }

      if (scheduled.type === RECOVERED_ENERGY_EVENT) {
        const payload = scheduled.payload as PersonPayload;
        const agent = byId.get(payload.personId);
        if (agent === undefined) throw new Error(`Missing wake agent ${payload.personId}`);
        if (
          agent.person.energy.mode !== "sleeping" ||
          energyAt(agent.person.energy, scheduler.clock.now()) < INTEGRATED_WAKE_THRESHOLD
        ) {
          throw new DomainInvariantError(
            `Integrated wake trigger fired outside threshold for ${agent.entityId}`,
          );
        }
        const request: ActionRequest = {
          actionId: WAKE_UP_ACTION_ID,
          actorId: agent.entityId,
          origin: "rule",
          requestedAt: scheduler.clock.now(),
          correlationId: scheduled.correlationId,
          input: null,
        };
        const validation = actions.validate(request, {
          actorId: agent.entityId,
          simTime: scheduler.clock.now(),
          worldState: agent.person,
        });
        if (!validation.ok) {
          throw new DomainInvariantError(
            `Integrated wake rejected: ${validation.code}`,
          );
        }
        agent.person = wakeUp(agent.person, scheduler.clock.now());
        events.append({
          id: asEventId(
            `integrated-wake:${agent.entityId}:${agent.person.sleepSessions}`,
          ),
          worldId: WORLD_ID,
          simTime: scheduler.clock.now(),
          type: "person.woke_up",
          actorId: agent.entityId,
          payload: { energy: agent.person.energy.value },
          correlationId: scheduled.correlationId,
        });
        scheduleEnergyTransition(agent, scheduler.clock.now());
        return;
      }

      if (scheduled.type === COMMITMENT_DUE_EVENT_TYPE) {
        const commitment = commitments.get(String(scheduled.id));
        if (commitment === undefined) {
          throw new DomainInvariantError(`Missing integrated commitment ${scheduled.id}`);
        }
        commitments.delete(String(scheduled.id));
        const agent = byId.get(String(commitment.ownerId));
        if (agent === undefined) {
          throw new DomainInvariantError(
            `Integrated commitment owner missing: ${commitment.ownerId}`,
          );
        }
        routineOpportunities += 1;
        if (physicallyAwake(agent)) {
          agent.routinesFulfilled += 1;
          events.append({
            id: asEventId(`integrated-work:${commitment.id}`),
            worldId: WORLD_ID,
            simTime: scheduler.clock.now(),
            type: "commitment.fulfilled",
            actorId: agent.entityId,
            payload: { commitmentId: String(commitment.id), kind: commitment.kind },
            correlationId: commitment.correlationId,
          });
        } else {
          agent.routinesMissed += 1;
          events.append({
            id: asEventId(`integrated-work-missed:${commitment.id}`),
            worldId: WORLD_ID,
            simTime: scheduler.clock.now(),
            type: "commitment.missed",
            actorId: agent.entityId,
            payload: { commitmentId: String(commitment.id), reason: "sleeping" },
            correlationId: commitment.correlationId,
          });
        }
        if (commitment.routineId === undefined) {
          throw new DomainInvariantError(
            `Integrated recurring commitment ${commitment.id} lost routine id`,
          );
        }
        const routine = routines.get(String(commitment.routineId));
        if (routine === undefined) {
          throw new DomainInvariantError(`Missing integrated routine ${commitment.routineId}`);
        }
        scheduleRoutine(routine, commitment.dueAt);
        return;
      }

      if (scheduled.type === SOCIAL_EVENT) {
        const payload = scheduled.payload as SocialPayload;
        const speaker = byId.get(payload.personId);
        if (speaker === undefined) {
          throw new DomainInvariantError(`Missing integrated social speaker ${payload.personId}`);
        }
        socialOpportunities += 1;
        speaker.socialOpportunities += 1;

        if (!physicallyAwake(speaker)) {
          speaker.socialSkippedSleeping += 1;
          events.append({
            id: asEventId(`integrated-social-skip:${speaker.entityId}:${payload.occurrence}`),
            worldId: WORLD_ID,
            simTime: scheduler.clock.now(),
            type: "conversation.skipped",
            actorId: speaker.entityId,
            payload: { reason: "speaker_sleeping" },
            correlationId: scheduled.correlationId,
          });
        } else {
          const candidates = agents.filter(
            (candidate) =>
              candidate.entityId !== speaker.entityId &&
              physicallyAwake(candidate) &&
              (candidate.workplaceId === speaker.workplaceId ||
                candidate.neighborhoodId === speaker.neighborhoodId ||
                candidate.homeId === speaker.homeId),
          );
          if (candidates.length === 0) {
            speaker.socialSkippedSleeping += 1;
            events.append({
              id: asEventId(
                `integrated-social-skip:${speaker.entityId}:${payload.occurrence}`,
              ),
              worldId: WORLD_ID,
              simTime: scheduler.clock.now(),
              type: "conversation.skipped",
              actorId: speaker.entityId,
              payload: { reason: "no_awake_listener" },
              correlationId: scheduled.correlationId,
            });
          } else {
            const listener = candidates[random.nextInt(candidates.length)]!;
            const conversationId = asConversationId(
              `integrated-conversation:${speaker.entityId}:${payload.occurrence}`,
            );
            const statement: ConversationStatement = {
              id: asConversationStatementId(
                `integrated-statement:${speaker.entityId}:${payload.occurrence}`,
              ),
              subjectId: String(speaker.entityId),
              predicate: "prefers_cafe",
              value: `cafe-${(Number(String(speaker.entityId).slice(-2)) % 3) + 1}`,
              confidenceBps: 8_500,
              origin: "direct",
              hopCount: 0,
            };
            const conversation: ConversationRecord = {
              id: conversationId,
              worldId: WORLD_ID,
              participantIds: [speaker.entityId, listener.entityId],
              startedAt: scheduler.clock.now(),
              maxTurns: 1,
              status: "open",
            };
            const message: ConversationMessage = {
              id: asConversationMessageId(
                `integrated-message:${speaker.entityId}:${payload.occurrence}`,
              ),
              worldId: WORLD_ID,
              conversationId,
              ordinal: 1,
              speakerId: speaker.entityId,
              sentAt: scheduler.clock.now(),
              text: `I prefer ${statement.value}.`,
              statements: [statement],
            };
            const relationship =
              relationships.get(relationshipKey(listener.entityId, speaker.entityId)) ??
              zeroRelationshipVector();
            const effects = deriveListenerEffects(
              conversation,
              message,
              listener.entityId,
              relationship,
            );
            speaker.memories.push(deriveSpeakerMemory(conversation, message));
            speaker.conversationsSpoken += 1;
            listener.conversationsHeard += 1;
            listener.memories.push(effects.memory);
            listener.perceptions.push(...effects.perceptions);
            for (const candidate of effects.beliefCandidates) {
              const key = beliefKey(candidate.subjectId, candidate.predicate);
              const revision = reviseBeliefFromReportedPerception(
                listener.beliefs.get(key),
                candidate,
              );
              if (revision !== undefined) listener.beliefs.set(key, revision);
            }
            for (const effect of effects.relationshipEffects) {
              const key = relationshipKey(effect.fromEntityId, effect.toEntityId);
              relationships.set(
                key,
                applyRelationshipDelta(
                  relationships.get(key) ?? zeroRelationshipVector(),
                  effect.delta,
                ),
              );
            }
            conversationCount += 1;
            events.append({
              id: asEventId(
                `integrated-conversation-event:${speaker.entityId}:${payload.occurrence}`,
              ),
              worldId: WORLD_ID,
              simTime: scheduler.clock.now(),
              type: "conversation.message",
              actorId: speaker.entityId,
              targetIds: [listener.entityId],
              payload: { conversationId: String(conversationId) },
              correlationId: scheduled.correlationId,
            });
          }
        }

        scheduleSocial(
          speaker,
          payload.occurrence + 1,
          addSimTime(scheduler.clock.now(), simDuration(SIM_DAY)),
        );
        return;
      }

      throw new DomainInvariantError(
        `Unexpected integrated-life event type: ${scheduled.type}`,
      );
    },
  );

  const summaries = agents
    .map<IntegratedLifeAgentSummary>((agent) => ({
      id: String(agent.entityId),
      homeId: agent.homeId,
      workplaceId: agent.workplaceId,
      neighborhoodId: agent.neighborhoodId,
      mealsEaten: agent.person.mealsEaten,
      sleepSessions: agent.person.sleepSessions,
      routinesFulfilled: agent.routinesFulfilled,
      routinesMissed: agent.routinesMissed,
      socialOpportunities: agent.socialOpportunities,
      conversationsSpoken: agent.conversationsSpoken,
      conversationsHeard: agent.conversationsHeard,
      socialSkippedSleeping: agent.socialSkippedSleeping,
      perceptionCount: agent.perceptions.length,
      beliefCount: agent.beliefs.size,
      memoryCount: agent.memories.length,
      finalHunger: hungerAt(agent.person.hunger, endTime),
      finalEnergy: energyAt(agent.person.energy, endTime),
      finalEnergyMode: agent.person.energy.mode,
      beliefSignature: stableBeliefSignature(agent),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    seed,
    agentCount,
    finalSimTime: clock.now(),
    processedScheduledEvents,
    domainEventCount: events.size,
    mealsEaten: summaries.reduce((sum, agent) => sum + agent.mealsEaten, 0),
    sleepSessions: summaries.reduce((sum, agent) => sum + agent.sleepSessions, 0),
    routineOpportunities,
    routinesFulfilled: summaries.reduce(
      (sum, agent) => sum + agent.routinesFulfilled,
      0,
    ),
    routinesMissed: summaries.reduce((sum, agent) => sum + agent.routinesMissed, 0),
    socialOpportunities,
    conversationCount,
    socialSkippedSleeping: summaries.reduce(
      (sum, agent) => sum + agent.socialSkippedSleeping,
      0,
    ),
    totalPerceptions: summaries.reduce(
      (sum, agent) => sum + agent.perceptionCount,
      0,
    ),
    totalBeliefs: summaries.reduce((sum, agent) => sum + agent.beliefCount, 0),
    totalMemories: summaries.reduce((sum, agent) => sum + agent.memoryCount, 0),
    distinctBeliefSignatures: new Set(
      summaries.map((agent) => agent.beliefSignature),
    ).size,
    familiarRelationshipEdges: [...relationships.values()].filter(
      (relationship) => relationship.familiarity > 0,
    ).length,
    maxFutureQueueSize,
    agents: summaries,
  };
}
