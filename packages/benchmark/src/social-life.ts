import {
  deriveListenerEffects,
  deriveSpeakerMemory,
  retellStatement,
  reviseBeliefFromReportedPerception,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationStatement,
  type StatementOrigin,
} from "@hobbo/conversation";
import {
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
  asScheduledEventId,
  asWorldId,
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
  DeterministicRandom,
  DeterministicScheduler,
  InMemoryDomainEventLog,
  WorldClock,
  type ScheduledEvent,
} from "@hobbo/simulation";

export const SOCIAL_LIFE_AGENT_COUNT = 20;
export const SOCIAL_LIFE_DURATION = (BigInt(SIM_DAY) * 30n) as SimDuration;

const WORLD_ID = asWorldId("social-life-world");
const SOCIAL_EVENT_TYPE = "social.daily_conversation";
const MIN_PROPAGATION_CONFIDENCE_BPS = 2_500;

interface SocialEventPayload {
  readonly speakerId: string;
  readonly occurrence: number;
}

interface SeedClaim {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: number;
  readonly confidenceBps: number;
  readonly origin: StatementOrigin;
}

interface KnownClaim {
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: number;
  readonly confidenceBps: number;
  readonly sourceStatement?: ConversationStatement;
  readonly heardFrom?: EntityId;
  readonly originIfUnspoken?: StatementOrigin;
}

interface MutableSocialAgent {
  readonly id: EntityId;
  readonly homeId: string;
  readonly workplaceId: string;
  readonly neighborhoodId: string;
  conversationsSpoken: number;
  conversationsHeard: number;
  readonly perceptions: PerceptionRecord[];
  readonly beliefs: Map<string, BeliefState>;
  readonly memories: MemoryRecord[];
  readonly knownClaims: Map<string, KnownClaim>;
}

export interface SocialLifeAgentSummary {
  readonly id: string;
  readonly homeId: string;
  readonly workplaceId: string;
  readonly neighborhoodId: string;
  readonly conversationsSpoken: number;
  readonly conversationsHeard: number;
  readonly perceptionCount: number;
  readonly beliefCount: number;
  readonly memoryCount: number;
  readonly knownClaimCount: number;
  readonly beliefSignature: string;
}

export interface SocialLifeSimulationResult {
  readonly seed: bigint;
  readonly agentCount: number;
  readonly finalSimTime: SimTime;
  readonly processedScheduledEvents: number;
  readonly domainEventCount: number;
  readonly conversationCount: number;
  readonly statementsSpoken: number;
  readonly rumorRetellings: number;
  readonly rumorMutations: number;
  readonly totalPerceptions: number;
  readonly totalBeliefs: number;
  readonly totalMemories: number;
  readonly agentsWithBeliefs: number;
  readonly distinctBeliefSignatures: number;
  readonly familiarRelationshipEdges: number;
  readonly maxFutureQueueSize: number;
  readonly agents: readonly SocialLifeAgentSummary[];
}

export interface SocialLifeSimulationOptions {
  readonly seed?: bigint;
  readonly agentCount?: number;
  readonly duration?: SimDuration;
}

const SEED_CLAIMS: readonly SeedClaim[] = [
  {
    subjectId: "cafe-1",
    predicate: "closing_hour",
    value: 18,
    confidenceBps: 9_500,
    origin: "direct",
  },
  {
    subjectId: "park-1",
    predicate: "festival_day",
    value: 14,
    confidenceBps: 9_000,
    origin: "direct",
  },
  {
    subjectId: "bus-1",
    predicate: "delay_minutes",
    value: 10,
    confidenceBps: 8_500,
    origin: "inferred",
  },
  {
    subjectId: "company-1",
    predicate: "layoffs_count",
    value: 12,
    confidenceBps: 9_000,
    origin: "fabricated",
  },
  {
    subjectId: "market-1",
    predicate: "discount_percent",
    value: 20,
    confidenceBps: 8_800,
    origin: "reported",
  },
];

function claimKey(subjectId: string, predicate: string): string {
  return `${subjectId}\u0000${predicate}`;
}

function relationshipKey(from: EntityId, to: EntityId): string {
  return `${from}\u0000${to}`;
}

function makeAgent(index: number): MutableSocialAgent {
  const id = asEntityId(`social-person-${String(index + 1).padStart(2, "0")}`);
  return {
    id,
    homeId: `home-${String(Math.floor(index / 2) + 1).padStart(2, "0")}`,
    workplaceId: `workplace-${(index % 4) + 1}`,
    neighborhoodId: `neighborhood-${(index % 5) + 1}`,
    conversationsSpoken: 0,
    conversationsHeard: 0,
    perceptions: [],
    beliefs: new Map(),
    memories: [],
    knownClaims: new Map(),
  };
}

function stableBeliefSignature(agent: MutableSocialAgent): string {
  return [...agent.beliefs.values()]
    .sort((left, right) => {
      const leftKey = claimKey(left.subjectId, left.predicate);
      const rightKey = claimKey(right.subjectId, right.predicate);
      return leftKey.localeCompare(rightKey);
    })
    .map(
      (belief) =>
        `${belief.subjectId}:${belief.predicate}=${JSON.stringify(belief.value)}@${belief.confidenceBps}`,
    )
    .join("|");
}

function candidateListeners(
  speaker: MutableSocialAgent,
  agents: readonly MutableSocialAgent[],
): readonly MutableSocialAgent[] {
  const close = agents.filter(
    (candidate) =>
      candidate.id !== speaker.id &&
      (candidate.workplaceId === speaker.workplaceId ||
        candidate.neighborhoodId === speaker.neighborhoodId ||
        candidate.homeId === speaker.homeId),
  );
  return close.length > 0
    ? close
    : agents.filter((candidate) => candidate.id !== speaker.id);
}

function mutateNumericValue(value: number, random: DeterministicRandom): number {
  const magnitude = 1 + random.nextInt(3);
  return Math.max(0, value + (random.chance(1, 2) ? magnitude : -magnitude));
}

function pickKnownClaim(
  agent: MutableSocialAgent,
  random: DeterministicRandom,
): KnownClaim | undefined {
  const candidates = [...agent.knownClaims.values()].sort((left, right) =>
    claimKey(left.subjectId, left.predicate).localeCompare(
      claimKey(right.subjectId, right.predicate),
    ),
  );
  if (candidates.length === 0) return undefined;
  return candidates[random.nextInt(candidates.length)];
}

function spokenStatement(input: {
  readonly claim: KnownClaim;
  readonly statementId: ReturnType<typeof asConversationStatementId>;
  readonly random: DeterministicRandom;
}): { readonly statement: ConversationStatement; readonly mutated: boolean; readonly retold: boolean } {
  const shouldMutate = input.random.chance(1, 8);
  const value = shouldMutate
    ? mutateNumericValue(input.claim.value, input.random)
    : input.claim.value;

  if (input.claim.sourceStatement === undefined) {
    const statement: ConversationStatement = {
      id: input.statementId,
      subjectId: input.claim.subjectId,
      predicate: input.claim.predicate,
      value,
      confidenceBps: input.claim.confidenceBps,
      origin: input.claim.originIfUnspoken ?? "inferred",
      hopCount: 0,
    };
    return { statement, mutated: shouldMutate, retold: false };
  }

  const confidenceLoss = input.random.nextInt(501);
  const statement = retellStatement({
    id: input.statementId,
    source: input.claim.sourceStatement,
    confidenceBps: Math.max(3_000, input.claim.confidenceBps - confidenceLoss),
    value,
    ...(input.claim.heardFrom === undefined
      ? {}
      : { claimedSourceEntityId: input.claim.heardFrom }),
  });
  return { statement, mutated: shouldMutate, retold: true };
}

export function runSocialLifeSimulation(
  options: SocialLifeSimulationOptions = {},
): SocialLifeSimulationResult {
  const seed = options.seed ?? 0x534f4349414cn;
  const agentCount = options.agentCount ?? SOCIAL_LIFE_AGENT_COUNT;
  const duration = options.duration ?? SOCIAL_LIFE_DURATION;

  if (!Number.isSafeInteger(agentCount) || agentCount < 2) {
    throw new RangeError("social-life agentCount must be a safe integer >= 2");
  }

  const random = new DeterministicRandom(seed);
  const clock = new WorldClock(simTime(0));
  const scheduler = new DeterministicScheduler(clock);
  const eventLog = new InMemoryDomainEventLog();
  const endTime = simTime(BigInt(duration));
  const agents = Array.from({ length: agentCount }, (_, index) => makeAgent(index));
  const byId = new Map(agents.map((agent) => [String(agent.id), agent] as const));
  const relationships = new Map<string, RelationshipVector>();

  for (const from of agents) {
    for (const to of agents) {
      if (from.id === to.id) continue;
      relationships.set(relationshipKey(from.id, to.id), {
        ...zeroRelationshipVector(),
        trust: random.nextInt(16_001) - 8_000,
        affection: random.nextInt(6_001) - 3_000,
        respect: random.nextInt(6_001) - 3_000,
      });
    }
  }

  for (let index = 0; index < Math.min(agents.length, SEED_CLAIMS.length); index += 1) {
    const agent = agents[index]!;
    const seedClaim = SEED_CLAIMS[index]!;
    agent.knownClaims.set(claimKey(seedClaim.subjectId, seedClaim.predicate), {
      ...seedClaim,
      originIfUnspoken: seedClaim.origin,
    });
  }

  let maxFutureQueueSize = 0;
  let conversationCount = 0;
  let statementsSpoken = 0;
  let rumorRetellings = 0;
  let rumorMutations = 0;

  function scheduleSocialEvent(
    agent: MutableSocialAgent,
    occurrence: number,
    dueAt: SimTime,
  ): void {
    scheduler.schedule({
      id: asScheduledEventId(`social:${agent.id}:${occurrence}`),
      dueAt,
      type: SOCIAL_EVENT_TYPE,
      payload: {
        speakerId: String(agent.id),
        occurrence,
      } satisfies SocialEventPayload,
      correlationId: asCorrelationId(`social:${agent.id}:${occurrence}`),
    });
    maxFutureQueueSize = Math.max(maxFutureQueueSize, scheduler.queue.size);
  }

  for (let index = 0; index < agents.length; index += 1) {
    const phase =
      BigInt(SIM_HOUR) * 11n +
      BigInt(index % 10) * BigInt(SIM_MINUTE) * 17n +
      BigInt(random.nextInt(10 * 60));
    scheduleSocialEvent(agents[index]!, 1, simTime(phase));
  }

  const processedScheduledEvents = scheduler.runUntil(
    endTime,
    (scheduled: ScheduledEvent) => {
      if (scheduled.type !== SOCIAL_EVENT_TYPE) {
        throw new Error(`Unexpected social-life event: ${scheduled.type}`);
      }
      const payload = scheduled.payload as SocialEventPayload;
      const speaker = byId.get(payload.speakerId);
      if (speaker === undefined) {
        throw new Error(`Missing social-life speaker ${payload.speakerId}`);
      }

      const listeners = candidateListeners(speaker, agents);
      const listener = listeners[random.nextInt(listeners.length)]!;
      const relationship =
        relationships.get(relationshipKey(listener.id, speaker.id)) ??
        zeroRelationshipVector();

      const conversationId = asConversationId(
        `social-conversation:${speaker.id}:${payload.occurrence}`,
      );
      const messageId = asConversationMessageId(
        `social-message:${speaker.id}:${payload.occurrence}`,
      );
      const conversation: ConversationRecord = {
        id: conversationId,
        worldId: WORLD_ID,
        participantIds: [speaker.id, listener.id],
        startedAt: scheduler.clock.now(),
        maxTurns: 1,
        status: "open",
      };

      const selected = pickKnownClaim(speaker, random);
      let statements: readonly ConversationStatement[] = [];
      if (selected !== undefined) {
        const utterance = spokenStatement({
          claim: selected,
          statementId: asConversationStatementId(
            `social-statement:${speaker.id}:${payload.occurrence}`,
          ),
          random,
        });
        statements = [utterance.statement];
        statementsSpoken += 1;
        if (utterance.retold) rumorRetellings += 1;
        if (utterance.mutated) rumorMutations += 1;
        speaker.knownClaims.set(
          claimKey(utterance.statement.subjectId, utterance.statement.predicate),
          {
            subjectId: utterance.statement.subjectId,
            predicate: utterance.statement.predicate,
            value: Number(utterance.statement.value),
            confidenceBps: utterance.statement.confidenceBps,
            sourceStatement: utterance.statement,
          },
        );
      }

      const message: ConversationMessage = {
        id: messageId,
        worldId: WORLD_ID,
        conversationId,
        ordinal: 1,
        speakerId: speaker.id,
        sentAt: scheduler.clock.now(),
        text:
          statements.length === 0
            ? "We exchanged ordinary small talk."
            : `I heard something about ${statements[0]!.subjectId}.`,
        statements,
      };

      const effects = deriveListenerEffects(
        conversation,
        message,
        listener.id,
        relationship,
      );
      speaker.memories.push(deriveSpeakerMemory(conversation, message));
      speaker.conversationsSpoken += 1;
      listener.conversationsHeard += 1;
      listener.memories.push(effects.memory);
      listener.perceptions.push(...effects.perceptions);

      for (let index = 0; index < effects.beliefCandidates.length; index += 1) {
        const candidate = effects.beliefCandidates[index]!;
        const key = claimKey(candidate.subjectId, candidate.predicate);
        const revision = reviseBeliefFromReportedPerception(
          listener.beliefs.get(key),
          candidate,
        );
        if (revision !== undefined) listener.beliefs.set(key, revision);
      }

      for (let index = 0; index < effects.perceptions.length; index += 1) {
        const perception = effects.perceptions[index]!;
        const sourceStatement = statements[index];
        if (
          sourceStatement === undefined ||
          perception.confidenceBps < MIN_PROPAGATION_CONFIDENCE_BPS
        ) {
          continue;
        }
        const numericValue = Number(sourceStatement.value);
        if (!Number.isFinite(numericValue)) continue;
        listener.knownClaims.set(
          claimKey(sourceStatement.subjectId, sourceStatement.predicate),
          {
            subjectId: sourceStatement.subjectId,
            predicate: sourceStatement.predicate,
            value: numericValue,
            confidenceBps: perception.confidenceBps,
            sourceStatement,
            heardFrom: speaker.id,
          },
        );
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

      eventLog.append({
        id: asEventId(`social-event:${speaker.id}:${payload.occurrence}`),
        worldId: WORLD_ID,
        simTime: scheduler.clock.now(),
        type: "conversation.message",
        actorId: speaker.id,
        targetIds: [listener.id],
        payload: {
          conversationId: String(conversationId),
          messageId: String(messageId),
          statementIds: statements.map((statement) => String(statement.id)),
        },
        correlationId: scheduled.correlationId,
      });
      conversationCount += 1;

      const nextDue = addSimTime(
        scheduler.clock.now(),
        SIM_DAY as SimDuration,
      );
      scheduleSocialEvent(speaker, payload.occurrence + 1, nextDue);
    },
  );

  const summaries = agents
    .map<SocialLifeAgentSummary>((agent) => ({
      id: String(agent.id),
      homeId: agent.homeId,
      workplaceId: agent.workplaceId,
      neighborhoodId: agent.neighborhoodId,
      conversationsSpoken: agent.conversationsSpoken,
      conversationsHeard: agent.conversationsHeard,
      perceptionCount: agent.perceptions.length,
      beliefCount: agent.beliefs.size,
      memoryCount: agent.memories.length,
      knownClaimCount: agent.knownClaims.size,
      beliefSignature: stableBeliefSignature(agent),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const totalPerceptions = summaries.reduce(
    (sum, agent) => sum + agent.perceptionCount,
    0,
  );
  const totalBeliefs = summaries.reduce((sum, agent) => sum + agent.beliefCount, 0);
  const totalMemories = summaries.reduce((sum, agent) => sum + agent.memoryCount, 0);
  const familiarRelationshipEdges = [...relationships.values()].filter(
    (relationship) => relationship.familiarity > 0,
  ).length;

  return {
    seed,
    agentCount,
    finalSimTime: clock.now(),
    processedScheduledEvents,
    domainEventCount: eventLog.size,
    conversationCount,
    statementsSpoken,
    rumorRetellings,
    rumorMutations,
    totalPerceptions,
    totalBeliefs,
    totalMemories,
    agentsWithBeliefs: summaries.filter((agent) => agent.beliefCount > 0).length,
    distinctBeliefSignatures: new Set(
      summaries.map((agent) => agent.beliefSignature),
    ).size,
    familiarRelationshipEdges,
    maxFutureQueueSize,
    agents: summaries,
  };
}
