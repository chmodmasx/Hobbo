import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  DeterministicTraceableCognitiveProvider,
} from "@hobbo/ai-provider/granite";
import {
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresSocialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_DAY,
  SIM_HOUR,
  asConversationId,
  asEntityId,
  asLifeGoalId,
  asPersonId,
  asWorldId,
  simDuration,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import type { LifeGoal } from "@hobbo/planning";
import {
  CoreWorldRuntime,
  type DialogueCognitionContext,
} from "../src/index.ts";

const pool = new Pool();
const AGENT_COUNT = 4;
const FOOD_PER_AGENT = 32;
const MIDPOINT = simTime(BigInt(SIM_DAY) * 3n + BigInt(SIM_HOUR) * 12n);
const END_TIME = simTime(BigInt(SIM_DAY) * 7n);

interface CountRow extends QueryResultRow {
  current_sim_time: string;
  conversations: string;
  messages: string;
  statements: string;
  retellings: string;
  completed_deliveries: string;
  cognition_completed: string;
  perceptions: string;
  beliefs: string;
  memories: string;
  familiar_edges: string;
  dialogue_completed: string;
  dialogue_deferred: string;
}

interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  ordinal: number;
  speaker_id: string;
  sent_at: string;
  text: string;
}

interface StatementRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  message_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  origin: string;
  source_statement_id: string | null;
  claimed_source_entity_id: string | null;
  hop_count: number;
}

interface CognitionRow extends QueryResultRow {
  request_id: string;
  actor_id: string;
  sim_time: string;
  provider_id: string;
  model_id: string | null;
  request_hash: string;
  request_payload: unknown;
  affordances: unknown;
  decision: unknown;
  status: string;
}

interface BeliefRow extends QueryResultRow {
  holder_id: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  learned_at: string;
  updated_at: string;
}

interface RelationshipRow extends QueryResultRow {
  from_entity_id: string;
  to_entity_id: string;
  familiarity: number;
  trust: number;
  affection: number;
  respect: number;
  attraction: number;
  fear: number;
  resentment: number;
  dependency: number;
  updated_at: string;
}

interface MemoryRow extends QueryResultRow {
  id: string;
  owner_id: string;
  category: string;
  occurred_at: string;
  content: string;
  related_entity_ids: string[];
  metadata: unknown;
}

interface EventRow extends QueryResultRow {
  sequence: string;
  id: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  target_ids: string[];
  payload: unknown;
  correlation_id: string;
}

interface PendingRow extends QueryResultRow {
  id: string;
  due_at: string;
  ordinal: string;
  type: string;
  payload: unknown;
  correlation_id: string;
}

interface DialogueSnapshot {
  readonly counts: CountRow;
  readonly messages: readonly MessageRow[];
  readonly statements: readonly StatementRow[];
  readonly cognition: readonly CognitionRow[];
  readonly beliefs: readonly BeliefRow[];
  readonly relationships: readonly RelationshipRow[];
  readonly memories: readonly MemoryRow[];
  readonly events: readonly EventRow[];
  readonly pending: readonly PendingRow[];
}

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function personId(index: number): PersonId {
  return asPersonId(
    `dialogue-runtime-person-${String(index + 1).padStart(2, "0")}`,
  );
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  return {
    id,
    hunger: createHungerState(
      600 + index * 250,
      simTime(0),
      470 + index * 20,
    ),
    energy: createEnergyState(
      index === 3 ? 3_200 : 7_600 - index * 300,
      simTime(0),
      480 + index * 20,
      1_400,
      index === 3 ? "sleeping" : "awake",
    ),
    inventory: Array.from({ length: FOOD_PER_AGENT }, (_, itemIndex) =>
      createFoodItem(
        `${id}:dialogue-food-${String(itemIndex + 1).padStart(3, "0")}`,
        "Prepared meal",
        7_000,
      ),
    ),
    mealsEaten: 0,
    sleepSessions: index === 3 ? 1 : 0,
  };
}

function goal(ownerId: PersonId, index: number): LifeGoal {
  return {
    id: asLifeGoalId(`${ownerId}:goal:connection`),
    ownerId: asEntityId(String(ownerId)),
    title: "Maintain meaningful social connections",
    priorityBps: 7_500 + index * 300,
    createdAt: simTime(0),
    status: "active",
    strategy: {
      period: SIM_DAY,
      phase: simDuration(BigInt(SIM_HOUR) * 17n),
      duration: SIM_HOUR,
      intentionKind: "goal.social_connection",
      payload: { owner: String(ownerId) },
    },
  };
}

function makeProvider(counter: { value: number }) {
  return new DeterministicTraceableCognitiveProvider<DialogueCognitionContext>({
    id: "dialogue-gate-provider",
    modelId: "dialogue-gate-v1",
    strategy: (request) => {
      counter.value += 1;
      const selected = request.affordances[0];
      if (selected === undefined) {
        throw new Error("Dialogue request unexpectedly has no affordance");
      }
      return {
        affordanceId: selected.id,
        intent: selected.label.slice(0, 200),
      };
    },
  });
}

async function setupWorld(
  connection: Pool,
  name: string,
  providerCalls: { value: number },
): Promise<{ readonly worldId: WorldId; readonly runtime: CoreWorldRuntime }> {
  const worldId = asWorldId(name);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const social = new PostgresSocialRepository(connection);
  const runtime = new CoreWorldRuntime(connection, {
    dialogueProvider: makeProvider(providerCalls),
  });

  await worlds.create(worldId);

  for (let index = 0; index < AGENT_COUNT; index += 1) {
    const id = personId(index);
    await people.create({
      worldId,
      person: makePerson(index),
      at: simTime(0),
    });
    await runtime.scheduleInitialPhysiology(worldId, id, simTime(0));
    await runtime.createLifeGoal(worldId, goal(id, index));
    await runtime.scheduleInitialPlanning(
      worldId,
      id,
      simTime(BigInt(SIM_HOUR) * 6n),
    );
  }

  for (let from = 0; from < AGENT_COUNT; from += 1) {
    for (let to = 0; to < AGENT_COUNT; to += 1) {
      if (from === to) continue;
      const fromId = asEntityId(String(personId(from)));
      const toId = asEntityId(String(personId(to)));
      const distrust = (from * 5 + to * 3) % 4 === 0;
      await social.applyRelationshipEffect({
        worldId,
        effectId: `dialogue-seed-trust:${fromId}->${toId}`,
        fromEntityId: fromId,
        toEntityId: toId,
        at: simTime(0),
        delta: { trust: distrust ? -8_000 : 8_000 },
      });
    }
  }

  await runtime.seedSocialClaim(
    worldId,
    asEntityId(String(personId(0))),
    simTime(0),
    {
      subjectId: "cafe-1",
      predicate: "closing_hour",
      value: 18,
      confidenceBps: 10_000,
      origin: "direct",
    },
  );
  await runtime.seedSocialClaim(
    worldId,
    asEntityId(String(personId(1))),
    simTime(0),
    {
      subjectId: "park-1",
      predicate: "festival_day",
      value: 4,
      confidenceBps: 10_000,
      origin: "direct",
    },
  );

  const pairings: readonly (readonly [number, number])[] = [
    [0, 2],
    [1, 3],
    [2, 1],
    [3, 0],
  ];

  for (let day = 0; day < 7; day += 1) {
    for (let slot = 0; slot < 2; slot += 1) {
      const pairing = pairings[(day * 2 + slot) % pairings.length]!;
      const first = personId(pairing[0]);
      const second = personId(pairing[1]);
      const startedAt = simTime(
        BigInt(SIM_DAY) * BigInt(day) +
          BigInt(SIM_HOUR) * BigInt(12 + slot),
      );
      await runtime.startDialogue({
        worldId,
        conversationId: asConversationId(
          `dialogue:day-${day}:slot-${slot}`,
        ),
        participantIds: [first, second],
        firstSpeakerId: first,
        startedAt,
        maxTurns: 4,
        turnInterval: simDuration(10 * 60),
      });
    }
  }

  return { worldId, runtime };
}

async function snapshot(
  connection: Pool,
  worldId: WorldId,
): Promise<DialogueSnapshot> {
  const counts = await connection.query<CountRow>(
    `SELECT
       (SELECT current_sim_time::text FROM worlds WHERE id = $1) AS current_sim_time,
       (SELECT count(*)::text FROM conversations WHERE world_id = $1) AS conversations,
       (SELECT count(*)::text FROM conversation_messages WHERE world_id = $1) AS messages,
       (SELECT count(*)::text FROM conversation_statements WHERE world_id = $1) AS statements,
       (SELECT count(*)::text FROM conversation_statements
         WHERE world_id = $1 AND source_statement_id IS NOT NULL) AS retellings,
       (SELECT count(*)::text FROM conversation_deliveries
         WHERE world_id = $1 AND status = 'completed') AS completed_deliveries,
       (SELECT count(*)::text FROM cognition_runs
         WHERE world_id = $1 AND status = 'completed'
           AND request_id LIKE 'runtime:dialogue:decision:%') AS cognition_completed,
       (SELECT count(*)::text FROM perceptions WHERE world_id = $1) AS perceptions,
       (SELECT count(*)::text FROM beliefs WHERE world_id = $1) AS beliefs,
       (SELECT count(*)::text FROM memories WHERE world_id = $1) AS memories,
       (SELECT count(*)::text FROM relationships
         WHERE world_id = $1 AND familiarity > 0) AS familiar_edges,
       (SELECT count(*)::text FROM domain_events
         WHERE world_id = $1 AND type = 'dialogue.turn_completed') AS dialogue_completed,
       (SELECT count(*)::text FROM domain_events
         WHERE world_id = $1 AND type = 'dialogue.turn_deferred') AS dialogue_deferred`,
    [worldId],
  );
  const countRow = counts.rows[0];
  if (countRow === undefined) throw new Error(`Missing dialogue world ${worldId}`);

  const messages = await connection.query<MessageRow>(
    `SELECT id, conversation_id, ordinal, speaker_id,
            sent_at::text AS sent_at, text
       FROM conversation_messages
      WHERE world_id = $1
      ORDER BY conversation_id, ordinal`,
    [worldId],
  );
  const statements = await connection.query<StatementRow>(
    `SELECT id, conversation_id, message_id, subject_id, predicate,
            value, confidence_bps, origin, source_statement_id,
            claimed_source_entity_id, hop_count
       FROM conversation_statements
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const cognition = await connection.query<CognitionRow>(
    `SELECT request_id, actor_id, sim_time::text AS sim_time,
            provider_id, model_id, request_hash, request_payload,
            affordances, decision, status
       FROM cognition_runs
      WHERE world_id = $1
        AND request_id LIKE 'runtime:dialogue:decision:%'
      ORDER BY request_id`,
    [worldId],
  );
  const beliefs = await connection.query<BeliefRow>(
    `SELECT holder_id, subject_id, predicate, value, confidence_bps,
            learned_at::text AS learned_at, updated_at::text AS updated_at
       FROM beliefs
      WHERE world_id = $1
      ORDER BY holder_id, subject_id, predicate`,
    [worldId],
  );
  const relationships = await connection.query<RelationshipRow>(
    `SELECT from_entity_id, to_entity_id, familiarity, trust, affection,
            respect, attraction, fear, resentment, dependency,
            updated_at::text AS updated_at
       FROM relationships
      WHERE world_id = $1
      ORDER BY from_entity_id, to_entity_id`,
    [worldId],
  );
  const memories = await connection.query<MemoryRow>(
    `SELECT id, owner_id, category, occurred_at::text AS occurred_at,
            content, related_entity_ids, metadata
       FROM memories
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const events = await connection.query<EventRow>(
    `SELECT sequence::text AS sequence, id, sim_time::text AS sim_time,
            type, actor_id, target_ids, payload, correlation_id
       FROM domain_events
      WHERE world_id = $1 AND type LIKE 'dialogue.%'
      ORDER BY sequence`,
    [worldId],
  );
  const pending = await connection.query<PendingRow>(
    `SELECT id, due_at::text AS due_at, ordinal::text AS ordinal,
            type, payload, correlation_id
       FROM scheduled_events
      WHERE world_id = $1 AND status = 'pending'
      ORDER BY due_at, ordinal`,
    [worldId],
  );

  return {
    counts: countRow,
    messages: messages.rows,
    statements: statements.rows,
    cognition: cognition.rows,
    beliefs: beliefs.rows,
    relationships: relationships.rows,
    memories: memories.rows,
    events: events.rows,
    pending: pending.rows,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("durable model-driven dialogue runtime", () => {
  it(
    "keeps multi-turn generated dialogue private, replayable and restart-equivalent across a week",
    async () => {
      const controlCalls = { value: 0 };
      const controlSetup = await setupWorld(
        pool,
        "runtime-dialogue-control",
        controlCalls,
      );

      const firstCalls = { value: 0 };
      const firstProcessPool = new Pool();
      const restartSetup = await setupWorld(
        firstProcessPool,
        "runtime-dialogue-restart",
        firstCalls,
      );

      const controlFirst = await controlSetup.runtime.processThrough({
        worldId: controlSetup.worldId,
        through: MIDPOINT,
        workerId: "dialogue-control-a",
      });
      const restartFirst = await restartSetup.runtime.processThrough({
        worldId: restartSetup.worldId,
        through: MIDPOINT,
        workerId: "dialogue-restart-a",
      });
      expect(restartFirst).toBe(controlFirst);
      expect(controlFirst).toBeGreaterThan(150);

      const abandoned = await new PostgresScheduledEventRepository(
        firstProcessPool,
      ).claimDue(
        restartSetup.worldId,
        END_TIME,
        "dead-dialogue-worker",
        1,
      );
      expect(abandoned).toHaveLength(1);
      await firstProcessPool.end();

      const controlSecond = await controlSetup.runtime.processThrough({
        worldId: controlSetup.worldId,
        through: END_TIME,
        workerId: "dialogue-control-b",
      });
      expect(controlSecond).toBeGreaterThan(100);

      const restartedCalls = { value: 0 };
      const restartedPool = new Pool();
      try {
        const restartedRuntime = new CoreWorldRuntime(restartedPool, {
          dialogueProvider: makeProvider(restartedCalls),
        });
        expect(
          await restartedRuntime.requeueStale(
            restartSetup.worldId,
            new Date(Date.now() + 60_000),
            10,
          ),
        ).toBe(1);

        const restartSecond = await restartedRuntime.processThrough({
          worldId: restartSetup.worldId,
          through: END_TIME,
          workerId: "dialogue-restart-b",
        });
        expect(restartSecond).toBe(controlSecond);

        const control = await snapshot(pool, controlSetup.worldId);
        const restarted = await snapshot(restartedPool, restartSetup.worldId);
        expect(restarted).toEqual(control);

        expect(Number(control.counts.conversations)).toBe(14);
        expect(Number(control.counts.messages)).toBe(56);
        expect(control.counts.completed_deliveries).toBe(control.counts.messages);
        expect(control.counts.cognition_completed).toBe(control.counts.messages);
        expect(control.counts.dialogue_completed).toBe(control.counts.messages);
        expect(Number(control.counts.statements)).toBeGreaterThan(20);
        expect(Number(control.counts.retellings)).toBeGreaterThan(5);
        expect(Number(control.counts.perceptions)).toBeGreaterThan(20);
        expect(Number(control.counts.beliefs)).toBeGreaterThan(2);
        expect(Number(control.counts.familiar_edges)).toBeGreaterThan(4);
        expect(Number(control.counts.dialogue_deferred)).toBeGreaterThan(0);

        expect(controlCalls.value).toBe(Number(control.counts.messages));
        expect(firstCalls.value + restartedCalls.value).toBe(controlCalls.value);

        expect(
          control.statements.some(
            (statement) =>
              statement.source_statement_id !== null &&
              statement.hop_count > 0,
          ),
        ).toBe(true);

        const payloads = control.cognition.map((row) =>
          serialized(row.request_payload),
        );
        expect(payloads.some((payload) => payload.includes('"activePlan":{'))).toBe(
          true,
        );
        for (const payload of payloads) {
          expect(payload).not.toContain('"sourceStatementId"');
          expect(payload).not.toContain('"claimedSourceEntityId"');
          expect(payload).not.toContain('"hopCount"');
          expect(payload).not.toContain('"origin"');
          expect(payload).not.toContain('"metadata"');
        }

        const holderSignatures = new Map<string, string[]>();
        for (const belief of control.beliefs) {
          const list = holderSignatures.get(belief.holder_id) ?? [];
          list.push(
            `${belief.subject_id}:${belief.predicate}=${JSON.stringify(belief.value)}`,
          );
          holderSignatures.set(belief.holder_id, list);
        }
        expect(holderSignatures.size).toBe(AGENT_COUNT);
        expect(
          new Set(
            [...holderSignatures.values()].map((items) =>
              items.sort().join("|"),
            ),
          ).size,
        ).toBeGreaterThan(1);
      } finally {
        await restartedPool.end();
      }
    },
    240_000,
  );
});
