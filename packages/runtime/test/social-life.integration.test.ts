import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresSocialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  SIM_DAY,
  SIM_HOUR,
  SIM_MINUTE,
  asEntityId,
  asPersonId,
  asWorldId,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import { CoreWorldRuntime } from "../src/index.ts";

const pool = new Pool();
const AGENT_COUNT = 20;
const FOOD_PER_AGENT = 80;
const MIDPOINT = simTime(BigInt(SIM_DAY) * 15n);
const END_TIME = simTime(BigInt(SIM_DAY) * 30n);

interface CountRow extends QueryResultRow {
  current_sim_time: string;
  conversations: string;
  messages: string;
  statements: string;
  retellings: string;
  mutations: string;
  completed_deliveries: string;
  perceptions: string;
  beliefs: string;
  memories: string;
  familiar_edges: string;
  social_deferrals: string;
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

interface MemoryRow extends QueryResultRow {
  id: string;
  owner_id: string;
  category: string;
  occurred_at: string;
  content: string;
  importance_bps: number;
  emotional_strength_bps: number;
  related_entity_ids: string[];
  metadata: unknown;
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

interface PerceptionRow extends QueryResultRow {
  id: string;
  observer_id: string;
  observed_at: string;
  channel: string;
  subject_id: string;
  predicate: string;
  value: unknown;
  confidence_bps: number;
  source_entity_id: string | null;
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

interface PhysiologyRow extends QueryResultRow {
  person_id: string;
  hunger_value: number;
  hunger_recorded_at: string;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: string;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
  version: string;
}

interface SocialSnapshot {
  readonly counts: CountRow;
  readonly beliefs: readonly BeliefRow[];
  readonly memories: readonly MemoryRow[];
  readonly relationships: readonly RelationshipRow[];
  readonly perceptions: readonly PerceptionRow[];
  readonly statements: readonly StatementRow[];
  readonly events: readonly EventRow[];
  readonly pending: readonly PendingRow[];
  readonly physiology: readonly PhysiologyRow[];
}

const SEED_CLAIMS = [
  {
    subjectId: "cafe-1",
    predicate: "closing_hour",
    value: 18,
    confidenceBps: 10_000,
    origin: "direct" as const,
  },
  {
    subjectId: "park-1",
    predicate: "festival_day",
    value: 14,
    confidenceBps: 10_000,
    origin: "direct" as const,
  },
  {
    subjectId: "bus-1",
    predicate: "delay_minutes",
    value: 10,
    confidenceBps: 9_800,
    origin: "inferred" as const,
  },
  {
    subjectId: "company-1",
    predicate: "layoffs_count",
    value: 12,
    confidenceBps: 10_000,
    origin: "fabricated" as const,
  },
  {
    subjectId: "market-1",
    predicate: "discount_percent",
    value: 20,
    confidenceBps: 9_900,
    origin: "reported" as const,
  },
];

beforeEach(async () => {
  await pool.query("TRUNCATE worlds CASCADE");
});

afterAll(async () => {
  await pool.end();
});

function personId(index: number): PersonId {
  return asPersonId(`social-runtime-person-${String(index + 1).padStart(2, "0")}`);
}

function makePerson(index: number): PersonState {
  const id = personId(index);
  return {
    id,
    hunger: createHungerState(
      400 + ((index * 173) % 2_800),
      simTime(0),
      450 + (index % 5) * 40,
    ),
    energy: createEnergyState(
      4_200 + (index % 5) * 900,
      simTime(0),
      470 + (index % 4) * 50,
      1_250 + (index % 3) * 150,
      "awake",
    ),
    inventory: Array.from({ length: FOOD_PER_AGENT }, (_, itemIndex) =>
      createFoodItem(
        `${id}:social-food-${String(itemIndex + 1).padStart(3, "0")}`,
        "Prepared meal",
        6_600 + ((index + itemIndex) % 4) * 350,
      ),
    ),
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

async function setupWorld(connection: Pool, name: string): Promise<WorldId> {
  const worldId = asWorldId(name);
  const worlds = new PostgresWorldRepository(connection);
  const people = new PostgresPersonRepository(connection);
  const social = new PostgresSocialRepository(connection);
  const runtime = new CoreWorldRuntime(connection, {
    social: { mutationModulo: 4 },
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

    const phase =
      BigInt(SIM_HOUR) * 2n +
      BigInt(SIM_MINUTE) * BigInt(index * 63);
    await runtime.scheduleInitialSocial(worldId, id, simTime(phase));
  }

  for (let from = 0; from < AGENT_COUNT; from += 1) {
    for (let to = 0; to < AGENT_COUNT; to += 1) {
      if (from === to) continue;
      const fromId = asEntityId(String(personId(from)));
      const toId = asEntityId(String(personId(to)));
      const distrust = (from * 7 + to * 11) % 5 === 0;
      await social.applyRelationshipEffect({
        worldId,
        effectId: `social-seed-trust:${fromId}->${toId}`,
        fromEntityId: fromId,
        toEntityId: toId,
        at: simTime(0),
        delta: { trust: distrust ? -8_000 : 8_000 },
      });
    }
  }

  for (let index = 0; index < SEED_CLAIMS.length; index += 1) {
    await runtime.seedSocialClaim(
      worldId,
      asEntityId(String(personId(index))),
      simTime(0),
      SEED_CLAIMS[index]!,
    );
  }

  return worldId;
}

async function snapshot(connection: Pool, worldId: WorldId): Promise<SocialSnapshot> {
  const counts = await connection.query<CountRow>(
    `SELECT
       (SELECT current_sim_time::text FROM worlds WHERE id = $1) AS current_sim_time,
       (SELECT count(*)::text FROM conversations WHERE world_id = $1) AS conversations,
       (SELECT count(*)::text FROM conversation_messages WHERE world_id = $1) AS messages,
       (SELECT count(*)::text FROM conversation_statements WHERE world_id = $1) AS statements,
       (SELECT count(*)::text FROM conversation_statements
         WHERE world_id = $1 AND source_statement_id IS NOT NULL) AS retellings,
       (SELECT count(*)::text
          FROM conversation_statements AS statement
          JOIN conversation_statements AS source
            ON source.world_id = statement.world_id
           AND source.id = statement.source_statement_id
         WHERE statement.world_id = $1
           AND statement.value <> source.value) AS mutations,
       (SELECT count(*)::text FROM conversation_deliveries
         WHERE world_id = $1 AND status = 'completed') AS completed_deliveries,
       (SELECT count(*)::text FROM perceptions WHERE world_id = $1) AS perceptions,
       (SELECT count(*)::text FROM beliefs WHERE world_id = $1) AS beliefs,
       (SELECT count(*)::text FROM memories WHERE world_id = $1) AS memories,
       (SELECT count(*)::text FROM relationships
         WHERE world_id = $1 AND familiarity > 0) AS familiar_edges,
       (SELECT count(*)::text FROM domain_events
         WHERE world_id = $1 AND type = 'social.opportunity_deferred') AS social_deferrals`,
    [worldId],
  );
  const countRow = counts.rows[0];
  if (countRow === undefined) throw new Error(`Missing social world ${worldId}`);

  const beliefs = await connection.query<BeliefRow>(
    `SELECT holder_id, subject_id, predicate, value, confidence_bps,
            learned_at::text AS learned_at, updated_at::text AS updated_at
       FROM beliefs
      WHERE world_id = $1
      ORDER BY holder_id, subject_id, predicate`,
    [worldId],
  );
  const memories = await connection.query<MemoryRow>(
    `SELECT id, owner_id, category, occurred_at::text AS occurred_at,
            content, importance_bps, emotional_strength_bps,
            related_entity_ids, metadata
       FROM memories
      WHERE world_id = $1
      ORDER BY id`,
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
  const perceptions = await connection.query<PerceptionRow>(
    `SELECT id, observer_id, observed_at::text AS observed_at, channel,
            subject_id, predicate, value, confidence_bps, source_entity_id
       FROM perceptions
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const statements = await connection.query<StatementRow>(
    `SELECT id, conversation_id, message_id, subject_id, predicate, value,
            confidence_bps, origin, source_statement_id,
            claimed_source_entity_id, hop_count
       FROM conversation_statements
      WHERE world_id = $1
      ORDER BY id`,
    [worldId],
  );
  const events = await connection.query<EventRow>(
    `SELECT sequence::text AS sequence, id, sim_time::text AS sim_time,
            type, actor_id, target_ids, payload, correlation_id
       FROM domain_events
      WHERE world_id = $1
        AND type LIKE 'social.%'
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
  const physiology = await connection.query<PhysiologyRow>(
    `SELECT person_id, hunger_value,
            hunger_recorded_at::text AS hunger_recorded_at,
            energy_value, energy_recorded_at::text AS energy_recorded_at,
            energy_mode, meals_eaten, sleep_sessions,
            updated_at_sim::text AS updated_at_sim, version::text AS version
       FROM person_physiology
      WHERE world_id = $1
      ORDER BY person_id`,
    [worldId],
  );

  return {
    counts: countRow,
    beliefs: beliefs.rows,
    memories: memories.rows,
    relationships: relationships.rows,
    perceptions: perceptions.rows,
    statements: statements.rows,
    events: events.rows,
    pending: pending.rows,
    physiology: physiology.rows,
  };
}

function beliefSignatures(rows: readonly BeliefRow[]): Map<string, string> {
  const byHolder = new Map<string, BeliefRow[]>();
  for (const row of rows) {
    const existing = byHolder.get(row.holder_id) ?? [];
    existing.push(row);
    byHolder.set(row.holder_id, existing);
  }
  return new Map(
    [...byHolder.entries()].map(([holder, beliefs]) => [
      holder,
      beliefs
        .map(
          (belief) =>
            `${belief.subject_id}:${belief.predicate}=${JSON.stringify(belief.value)}@${belief.confidence_bps}`,
        )
        .join("|"),
    ]),
  );
}

describe("durable social-life runtime", () => {
  it(
    "keeps 20 agents socially divergent and restart-equivalent over 30 days",
    async () => {
      const controlWorld = await setupWorld(pool, "runtime-social-control");
      const controlRuntime = new CoreWorldRuntime(pool, {
        social: { mutationModulo: 4 },
      });

      const firstProcessPool = new Pool();
      const restartWorld = await setupWorld(
        firstProcessPool,
        "runtime-social-restart",
      );
      const firstRuntime = new CoreWorldRuntime(firstProcessPool, {
        social: { mutationModulo: 4 },
      });

      const controlFirst = await controlRuntime.processThrough({
        worldId: controlWorld,
        through: MIDPOINT,
        workerId: "social-control-a",
      });
      const restartFirst = await firstRuntime.processThrough({
        worldId: restartWorld,
        through: MIDPOINT,
        workerId: "social-restart-a",
      });
      expect(restartFirst).toBe(controlFirst);
      expect(controlFirst).toBeGreaterThan(700);

      const abandoned = await new PostgresScheduledEventRepository(
        firstProcessPool,
      ).claimDue(restartWorld, END_TIME, "dead-social-worker", 1);
      expect(abandoned).toHaveLength(1);
      await firstProcessPool.end();

      const controlSecond = await controlRuntime.processThrough({
        worldId: controlWorld,
        through: END_TIME,
        workerId: "social-control-b",
      });
      expect(controlSecond).toBeGreaterThan(700);

      const restartedPool = new Pool();
      try {
        const restartedRuntime = new CoreWorldRuntime(restartedPool, {
          social: { mutationModulo: 4 },
        });
        expect(
          await restartedRuntime.requeueStale(
            restartWorld,
            new Date(Date.now() + 60_000),
            10,
          ),
        ).toBe(1);
        expect(
          await restartedRuntime.requeueStaleSocialDeliveries(
            restartWorld,
            new Date(Date.now() + 60_000),
            10,
          ),
        ).toBe(0);

        const restartSecond = await restartedRuntime.processThrough({
          worldId: restartWorld,
          through: END_TIME,
          workerId: "social-restart-b",
        });
        expect(restartSecond).toBe(controlSecond);

        const control = await snapshot(pool, controlWorld);
        const restarted = await snapshot(restartedPool, restartWorld);
        expect(restarted).toEqual(control);

        expect(Number(control.counts.conversations)).toBeGreaterThanOrEqual(580);
        expect(control.counts.messages).toBe(control.counts.conversations);
        expect(control.counts.completed_deliveries).toBe(control.counts.messages);
        expect(Number(control.counts.statements)).toBeGreaterThan(100);
        expect(Number(control.counts.retellings)).toBeGreaterThan(50);
        expect(Number(control.counts.mutations)).toBeGreaterThan(0);
        expect(Number(control.counts.perceptions)).toBeGreaterThan(100);
        expect(Number(control.counts.beliefs)).toBeGreaterThan(SEED_CLAIMS.length);
        expect(Number(control.counts.memories)).toBe(
          Number(control.counts.conversations) * 2 + SEED_CLAIMS.length,
        );
        expect(Number(control.counts.familiar_edges)).toBeGreaterThan(50);
        expect(Number(control.counts.social_deferrals)).toBeGreaterThan(0);

        const signatures = beliefSignatures(control.beliefs);
        expect(signatures.size).toBeGreaterThan(10);
        expect(new Set(signatures.values()).size).toBeGreaterThan(1);

        const fabricated = control.statements.filter(
          (statement) => statement.origin === "fabricated",
        );
        expect(fabricated.length).toBeGreaterThan(0);
        expect(
          control.statements.some(
            (statement) =>
              statement.source_statement_id !== null && statement.hop_count > 0,
          ),
        ).toBe(true);

        expect(control.physiology).toHaveLength(AGENT_COUNT);
        expect(
          control.pending.filter(
            (event) => event.type === "social.conversation_opportunity",
          ),
        ).toHaveLength(AGENT_COUNT);
      } finally {
        await restartedPool.end();
      }
    },
    240_000,
  );
});
