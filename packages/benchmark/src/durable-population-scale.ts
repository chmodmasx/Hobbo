import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Pool, type QueryResultRow } from "pg";
import {
  commitScheduledEventOutcome,
  PostgresPersonRepository,
  PostgresScheduledEventRepository,
  PostgresTraceRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  asScheduledEventId,
  asWorldId,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import { CoreWorldRuntime } from "@hobbo/runtime";
import {
  entityAffinityKey,
  type ScheduledEvent,
} from "@hobbo/simulation";

const SCALE_EVENT_TYPE = "benchmark.population_probe";
const ALLOWED_TIERS = new Set([100, 500, 1_000, 10_000]);
const DUE_AT = simTime(1);
const WORKER_COUNT = 4;
const CLAIM_LIMIT = 256;

interface CountRow extends QueryResultRow {
  people: string;
  scheduled_total: string;
  scheduled_completed: string;
  scheduled_outstanding: string;
  attempts: string;
  domain_events: string;
  min_sequence: string | null;
  max_sequence: string | null;
  distinct_sequences: string;
  current_sim_time: string;
  next_event_sequence: string;
  next_schedule_ordinal: string;
}

interface ScaleMetrics {
  readonly agents: number;
  readonly workers: number;
  readonly bootstrapMs: number;
  readonly schedulingMs: number;
  readonly processingMs: number;
  readonly verificationMs: number;
  readonly totalMs: number;
  readonly processedEvents: number;
}

function tierFromEnvironment(): number {
  const raw = process.env.HOBBO_SCALE_AGENTS ?? "";
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "HOBBO_SCALE_AGENTS must be one of 100, 500, 1000 or 10000",
    );
  }
  const value = Number(raw);
  if (!ALLOWED_TIERS.has(value)) {
    throw new Error(
      "HOBBO_SCALE_AGENTS must be one of 100, 500, 1000 or 10000",
    );
  }
  return value;
}

function personId(index: number): PersonId {
  return asPersonId(
    `scale-person-${String(index + 1).padStart(5, "0")}`,
  );
}

async function seedPopulationFixture(
  pool: Pool,
  worldId: WorldId,
  agentCount: number,
): Promise<void> {
  // Benchmark-only bulk bootstrap. The resulting rows are the exact production
  // person/physiology schema; event execution below uses only production
  // repositories/runtime boundaries.
  await pool.query(
    `INSERT INTO persons (world_id, id, created_at_sim)
     SELECT $1,
            'scale-person-' || lpad(series::text, 5, '0'),
            0
       FROM generate_series(1, $2::integer) AS series`,
    [worldId, agentCount],
  );

  await pool.query(
    `INSERT INTO person_physiology (
       world_id,
       person_id,
       hunger_value,
       hunger_recorded_at,
       hunger_rate_per_hour,
       energy_value,
       energy_recorded_at,
       energy_mode,
       awake_drain_per_hour,
       sleep_recovery_per_hour,
       meals_eaten,
       sleep_sessions,
       updated_at_sim
     )
     SELECT $1,
            'scale-person-' || lpad(series::text, 5, '0'),
            1000 + (series % 1000),
            0,
            500,
            8000 - (series % 1000),
            0,
            'awake',
            450,
            1500,
            0,
            0,
            0
       FROM generate_series(1, $2::integer) AS series`,
    [worldId, agentCount],
  );
}

function scheduledProbeEvents(agentCount: number): readonly ScheduledEvent[] {
  return Array.from({ length: agentCount }, (_, index) => {
    const id = personId(index);
    return {
      id: asScheduledEventId(`scale:probe:${id}`),
      dueAt: DUE_AT,
      type: SCALE_EVENT_TYPE,
      payload: { personId: String(id) },
      correlationId: asCorrelationId(`scale:probe:${id}`),
      affinityKeys: [entityAffinityKey(String(id))],
    };
  });
}

function personIdFromPayload(value: unknown): PersonId {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).personId !== "string"
  ) {
    throw new Error("Population scale event payload has no personId");
  }
  const valueId = (value as Record<string, unknown>).personId as string;
  if (valueId.length === 0) {
    throw new Error("Population scale event personId cannot be blank");
  }
  return asPersonId(valueId);
}

function createScaleRuntime(pool: Pool): CoreWorldRuntime {
  const runtime = new CoreWorldRuntime(pool);
  runtime.registerEventHandler(SCALE_EVENT_TYPE, async (context) => {
    const id = personIdFromPayload(context.scheduled.event.payload);
    const at = context.scheduled.event.dueAt;
    await commitScheduledEventOutcome(pool, {
      worldId: context.worldId,
      eventId: context.scheduled.event.id,
      workerId: context.workerId,
      processedAt: at,
      domainEvents: [
        {
          id: asEventId(`scale:processed:${id}`),
          worldId: context.worldId,
          simTime: at,
          type: "benchmark.population_probe.completed",
          actorId: asEntityId(String(id)),
          payload: {
            scheduledEventId: String(context.scheduled.event.id),
          },
          correlationId: context.scheduled.event.correlationId,
        },
      ],
    });
  });
  return runtime;
}

async function processWithWorkers(
  pool: Pool,
  worldId: WorldId,
): Promise<readonly number[]> {
  const runtimes = Array.from(
    { length: WORKER_COUNT },
    () => createScaleRuntime(pool),
  );
  return Promise.all(
    runtimes.map((runtime, index) =>
      runtime.processThrough({
        worldId,
        through: DUE_AT,
        workerId: `population-scale-worker-${index + 1}`,
        claimLimit: CLAIM_LIMIT,
      }),
    ),
  );
}

async function verifyScaleResult(
  pool: Pool,
  worldId: WorldId,
  agentCount: number,
): Promise<void> {
  const counts = await pool.query<CountRow>(
    `SELECT
       (SELECT count(*)::text
          FROM persons
         WHERE world_id = $1) AS people,
       (SELECT count(*)::text
          FROM scheduled_events
         WHERE world_id = $1) AS scheduled_total,
       (SELECT count(*)::text
          FROM scheduled_events
         WHERE world_id = $1
           AND status = 'completed') AS scheduled_completed,
       (SELECT count(*)::text
          FROM scheduled_events
         WHERE world_id = $1
           AND status IN ('pending','processing')) AS scheduled_outstanding,
       (SELECT COALESCE(sum(attempts), 0)::text
          FROM scheduled_events
         WHERE world_id = $1) AS attempts,
       (SELECT count(*)::text
          FROM domain_events
         WHERE world_id = $1
           AND type = 'benchmark.population_probe.completed') AS domain_events,
       (SELECT min(sequence)::text
          FROM domain_events
         WHERE world_id = $1) AS min_sequence,
       (SELECT max(sequence)::text
          FROM domain_events
         WHERE world_id = $1) AS max_sequence,
       (SELECT count(DISTINCT sequence)::text
          FROM domain_events
         WHERE world_id = $1) AS distinct_sequences,
       (SELECT current_sim_time::text
          FROM worlds
         WHERE id = $1) AS current_sim_time,
       (SELECT next_event_sequence::text
          FROM worlds
         WHERE id = $1) AS next_event_sequence,
       (SELECT next_schedule_ordinal::text
          FROM worlds
         WHERE id = $1) AS next_schedule_ordinal`,
    [worldId],
  );
  const row = counts.rows[0];
  if (row === undefined) throw new Error("Population scale world disappeared");

  const expected = String(agentCount);
  if (row.people !== expected) {
    throw new Error(`Expected ${expected} people, got ${row.people}`);
  }
  if (
    row.scheduled_total !== expected ||
    row.scheduled_completed !== expected ||
    row.scheduled_outstanding !== "0"
  ) {
    throw new Error(
      `Unexpected scheduler counts: total=${row.scheduled_total}, completed=${row.scheduled_completed}, outstanding=${row.scheduled_outstanding}`,
    );
  }
  if (row.attempts !== expected) {
    throw new Error(
      `Expected exactly one attempt per event, got ${row.attempts}`,
    );
  }
  if (
    row.domain_events !== expected ||
    row.distinct_sequences !== expected ||
    row.min_sequence !== "1" ||
    row.max_sequence !== expected
  ) {
    throw new Error(
      `Domain event sequence is not contiguous: count=${row.domain_events}, distinct=${row.distinct_sequences}, range=${row.min_sequence}..${row.max_sequence}`,
    );
  }
  if (
    row.current_sim_time !== "1" ||
    row.next_event_sequence !== String(agentCount + 1) ||
    row.next_schedule_ordinal !== expected
  ) {
    throw new Error(
      `Unexpected world cursors: time=${row.current_sim_time}, event=${row.next_event_sequence}, schedule=${row.next_schedule_ordinal}`,
    );
  }

  const people = new PostgresPersonRepository(pool);
  const ids = await people.listIds(worldId);
  if (ids.length !== agentCount) {
    throw new Error(
      `Production roster returned ${ids.length} ids, expected ${agentCount}`,
    );
  }
  if (
    String(ids[0]) !== String(personId(0)) ||
    String(ids[ids.length - 1]) !== String(personId(agentCount - 1))
  ) {
    throw new Error("Production roster ordering is not deterministic");
  }

  const tracePerson = personId(Math.floor(agentCount / 2));
  const trace = await new PostgresTraceRepository(pool).inspectPerson(
    worldId,
    tracePerson,
    { limit: 5 },
  );
  if (trace === undefined) {
    throw new Error(`Trace missing for ${tracePerson}`);
  }
  if (
    trace.currentSimTime !== "1" ||
    trace.events.length !== 1 ||
    trace.events[0]?.type !== "benchmark.population_probe.completed" ||
    trace.events[0]?.actorId !== String(tracePerson) ||
    trace.scheduledEvents.length !== 0
  ) {
    throw new Error(
      `Unexpected bounded trace for ${tracePerson}: ${JSON.stringify(trace)}`,
    );
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeSummary(metrics: ScaleMetrics): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.length === 0) return;
  appendFileSync(
    summaryPath,
    [
      `### Durable population scale — ${metrics.agents} agents`,
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      `| Workers | ${metrics.workers} |`,
      `| Processed events | ${metrics.processedEvents} |`,
      `| Bootstrap | ${metrics.bootstrapMs} ms |`,
      `| Schedule persistence | ${metrics.schedulingMs} ms |`,
      `| Runtime processing | ${metrics.processingMs} ms |`,
      `| Verification | ${metrics.verificationMs} ms |`,
      `| Total | ${metrics.totalMs} ms |`,
      "",
      "Workload: one same-frontier durable entity-affinity event and one causal domain event per persisted person. No model inference.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const agentCount = tierFromEnvironment();
  const pool = new Pool({ max: 12 });
  const worldId = asWorldId(`population-scale-${agentCount}`);
  const totalStart = performance.now();

  try {
    const bootstrapStart = performance.now();
    await new PostgresWorldRepository(pool).create(worldId);
    await seedPopulationFixture(pool, worldId, agentCount);
    const bootstrapMs = performance.now() - bootstrapStart;

    const schedulingStart = performance.now();
    const scheduled = await new PostgresScheduledEventRepository(
      pool,
    ).scheduleMany(worldId, scheduledProbeEvents(agentCount));
    if (scheduled.length !== agentCount) {
      throw new Error(
        `Persisted ${scheduled.length} scale events, expected ${agentCount}`,
      );
    }
    const schedulingMs = performance.now() - schedulingStart;

    const processingStart = performance.now();
    const processedByWorker = await processWithWorkers(pool, worldId);
    const processingMs = performance.now() - processingStart;
    const processedEvents = processedByWorker.reduce(
      (sum, count) => sum + count,
      0,
    );
    if (processedEvents !== agentCount) {
      throw new Error(
        `Workers processed ${processedEvents} events, expected ${agentCount}`,
      );
    }

    const verificationStart = performance.now();
    await verifyScaleResult(pool, worldId, agentCount);
    const verificationMs = performance.now() - verificationStart;

    const metrics: ScaleMetrics = {
      agents: agentCount,
      workers: WORKER_COUNT,
      bootstrapMs: roundMs(bootstrapMs),
      schedulingMs: roundMs(schedulingMs),
      processingMs: roundMs(processingMs),
      verificationMs: roundMs(verificationMs),
      totalMs: roundMs(performance.now() - totalStart),
      processedEvents,
    };

    writeSummary(metrics);
    process.stdout.write(JSON.stringify(metrics) + "\n");
  } finally {
    await pool.end();
  }
}

await main();
