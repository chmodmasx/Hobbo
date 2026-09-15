import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  asEntityId,
  asWorldId,
  simTime,
} from "@hobbo/domain";
import {
  adoptPerceptionAsBelief,
  type BeliefState,
  type PerceptionRecord,
} from "@hobbo/social";
import {
  PostgresSocialRepository,
  PostgresWorldRepository,
} from "../src/index.ts";

const pool = new Pool();
const worlds = new PostgresWorldRepository(pool);
const social = new PostgresSocialRepository(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE relationship_effects, relationships, beliefs, perceptions, tenancies, housing_units, employments, ledger_entries, ledger_transactions, ledger_accounts, commitments, routines, cognition_runs, scheduled_events, domain_events, worlds CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

async function createWorld(name: string) {
  const worldId = asWorldId(name);
  await worlds.create(worldId);
  return worldId;
}

function perception(input: {
  worldId: ReturnType<typeof asWorldId>;
  id: string;
  observer?: string;
  at?: bigint;
  value?: unknown;
  confidence?: number;
  channel?: PerceptionRecord["channel"];
  predicate?: string;
}): PerceptionRecord {
  return {
    id: input.id,
    worldId: input.worldId,
    observerId: asEntityId(input.observer ?? "person-alice"),
    observedAt: simTime(input.at ?? 100n),
    channel: input.channel ?? "reported",
    subjectId: "person-bob",
    predicate: input.predicate ?? "employment.status",
    value: input.value ?? "fired",
    confidenceBps: input.confidence ?? 6_500,
  };
}

describe("durable perceptions and private beliefs", () => {
  it("keeps contradictory evidence append-only and makes exact perception retries idempotent", async () => {
    const worldId = await createWorld("social-perception-world");
    const first = perception({ worldId, id: "p1" });
    const second = perception({
      worldId,
      id: "p2",
      at: 120n,
      value: "employed",
      confidence: 9_000,
      channel: "direct",
    });

    expect(await social.recordPerception(first)).toEqual(first);
    expect(await social.recordPerception(first)).toEqual(first);
    await social.recordPerception(second);

    const evidence = await social.listPerceptions(
      worldId,
      asEntityId("person-alice"),
    );
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.value)).toEqual(["fired", "employed"]);

    await expect(
      social.recordPerception({ ...first, confidenceBps: 7_000 }),
    ).rejects.toThrow(/already used for different evidence/i);
  });

  it("accepts newer belief revisions while rejecting stale and same-time conflicting writes", async () => {
    const worldId = await createWorld("social-belief-world");
    const firstEvidence = perception({ worldId, id: "p1", at: 100n });
    const secondEvidence = perception({
      worldId,
      id: "p2",
      at: 150n,
      value: "employed",
      confidence: 8_500,
      channel: "direct",
    });
    await social.recordPerception(firstEvidence);
    await social.recordPerception(secondEvidence);

    const firstBelief = adoptPerceptionAsBelief(firstEvidence);
    expect(await social.putBelief(firstBelief)).toEqual(firstBelief);

    const revised: BeliefState = {
      ...adoptPerceptionAsBelief(secondEvidence),
      learnedAt: firstBelief.learnedAt,
    };
    expect((await social.putBelief(revised)).value).toBe("employed");
    expect(await social.putBelief(revised)).toEqual(revised);

    await expect(
      social.putBelief({
        ...firstBelief,
        updatedAt: simTime(120),
        confidenceBps: 7_000,
      }),
    ).rejects.toThrow(/stale/i);

    await expect(
      social.putBelief({
        ...revised,
        value: "suspended",
        confidenceBps: 5_000,
      }),
    ).rejects.toThrow(/conflicting belief revision/i);

    expect(
      await social.getBelief(
        worldId,
        asEntityId("person-alice"),
        "person-bob",
        "employment.status",
      ),
    ).toEqual(revised);
  });

  it("does not allow one person's belief to cite another person's private perception", async () => {
    const worldId = await createWorld("social-private-evidence-world");
    const bobEvidence = perception({
      worldId,
      id: "bob-private-p1",
      observer: "person-bob",
      predicate: "housing.status",
      value: "evicted",
      channel: "direct",
    });
    await social.recordPerception(bobEvidence);

    const invalid: BeliefState = {
      worldId,
      holderId: asEntityId("person-alice"),
      subjectId: "person-bob",
      predicate: "housing.status",
      value: "evicted",
      confidenceBps: 9_000,
      learnedAt: simTime(100),
      updatedAt: simTime(100),
      sourcePerceptionId: bobEvidence.id,
    };

    await expect(social.putBelief(invalid)).rejects.toThrow(/belongs to person-bob/i);
    expect(
      await social.getBelief(
        worldId,
        asEntityId("person-alice"),
        "person-bob",
        "housing.status",
      ),
    ).toBeUndefined();
  });
});

describe("durable multidimensional relationships", () => {
  it("keeps relationships directional", async () => {
    const worldId = await createWorld("social-direction-world");
    const alice = asEntityId("person-alice");
    const bob = asEntityId("person-bob");

    await social.applyRelationshipEffect({
      worldId,
      effectId: "alice-trusts-bob",
      fromEntityId: alice,
      toEntityId: bob,
      at: simTime(100),
      delta: { familiarity: 1_000, trust: 2_000 },
    });
    await social.applyRelationshipEffect({
      worldId,
      effectId: "bob-distrusts-alice",
      fromEntityId: bob,
      toEntityId: alice,
      at: simTime(100),
      delta: { familiarity: 500, trust: -3_000 },
    });

    expect((await social.getRelationship(worldId, alice, bob))?.vector.trust).toBe(
      2_000,
    );
    expect((await social.getRelationship(worldId, bob, alice))?.vector.trust).toBe(
      -3_000,
    );
  });

  it("retries the same relationship effect across a fresh pool without applying it twice", async () => {
    const worldId = await createWorld("social-effect-retry-world");
    const input = {
      worldId,
      effectId: "conversation-positive-1",
      fromEntityId: asEntityId("person-alice"),
      toEntityId: asEntityId("person-bob"),
      at: simTime(200),
      delta: { familiarity: 700, trust: 500, affection: 250 },
    } as const;

    const first = await social.applyRelationshipEffect(input);
    expect(first.vector.trust).toBe(500);

    const freshPool = new Pool();
    try {
      const freshSocial = new PostgresSocialRepository(freshPool);
      const retry = await freshSocial.applyRelationshipEffect(input);
      expect(retry.vector).toEqual(first.vector);
    } finally {
      await freshPool.end();
    }

    const counts = await pool.query<{ effects: string; trust: number }>(
      `SELECT
         (SELECT count(*)::text FROM relationship_effects
           WHERE world_id = $1 AND effect_id = $2) AS effects,
         (SELECT trust FROM relationships
           WHERE world_id = $1 AND from_entity_id = $3 AND to_entity_id = $4) AS trust`,
      [worldId, input.effectId, input.fromEntityId, input.toEntityId],
    );
    expect(counts.rows[0]).toEqual({ effects: "1", trust: 500 });

    await expect(
      social.applyRelationshipEffect({ ...input, delta: { trust: 900 } }),
    ).rejects.toThrow(/already used for a different effect/i);
  });

  it("serializes concurrent effects on the same directed pair without losing either update", async () => {
    const worldId = await createWorld("social-concurrent-world");
    const alice = asEntityId("person-alice");
    const bob = asEntityId("person-bob");

    await Promise.all([
      social.applyRelationshipEffect({
        worldId,
        effectId: "effect-trust",
        fromEntityId: alice,
        toEntityId: bob,
        at: simTime(300),
        delta: { trust: 1_000 },
      }),
      social.applyRelationshipEffect({
        worldId,
        effectId: "effect-affection",
        fromEntityId: alice,
        toEntityId: bob,
        at: simTime(300),
        delta: { affection: 2_000 },
      }),
    ]);

    const relationship = await social.getRelationship(worldId, alice, bob);
    expect(relationship?.vector.trust).toBe(1_000);
    expect(relationship?.vector.affection).toBe(2_000);

    const effectCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM relationship_effects
        WHERE world_id = $1`,
      [worldId],
    );
    expect(effectCount.rows[0]?.count).toBe("2");
  });

  it("rejects a relationship effect older than the already-persisted social state", async () => {
    const worldId = await createWorld("social-stale-effect-world");
    const alice = asEntityId("person-alice");
    const bob = asEntityId("person-bob");

    await social.applyRelationshipEffect({
      worldId,
      effectId: "newer-effect",
      fromEntityId: alice,
      toEntityId: bob,
      at: simTime(500),
      delta: { trust: 800 },
    });

    await expect(
      social.applyRelationshipEffect({
        worldId,
        effectId: "older-effect",
        fromEntityId: alice,
        toEntityId: bob,
        at: simTime(499),
        delta: { trust: 100 },
      }),
    ).rejects.toThrow(/stale/i);

    expect((await social.getRelationship(worldId, alice, bob))?.vector.trust).toBe(800);
    const effectCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM relationship_effects
        WHERE world_id = $1`,
      [worldId],
    );
    expect(effectCount.rows[0]?.count).toBe("1");
  });
});
