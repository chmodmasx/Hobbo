import {
  DomainInvariantError,
  asWorldId,
  simTime,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import {
  WORLD_DIRECTOR_HARD_MAX_PEOPLE,
  WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS,
  type WorldDirectorProposalDraft,
  type WorldDirectorSummary,
} from "@hobbo/director";
import type { Pool, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

interface WorldRow extends QueryResultRow {
  current_sim_time: string;
}

interface CountRow extends QueryResultRow {
  count: string;
}

interface PersonRow extends QueryResultRow {
  id: string;
}

interface EventRow extends QueryResultRow {
  sequence: string;
  sim_time: string;
  type: string;
  actor_id: string | null;
  target_ids: string[] | null;
}

interface CognitionStatusRow extends QueryResultRow {
  status: string;
}

interface ProposalRow extends QueryResultRow {
  world_id: string;
  id: string;
  trigger_event_id: string;
  cognition_request_id: string;
  affordance_id: string;
  status: "accepted" | "rejected";
  kind: "social_opportunity" | "none";
  payload: unknown;
  intent: string;
  created_at_sim: string;
  effect_event_id: string | null;
}

interface ProposalComparisonRow extends ProposalRow {
  same_payload: boolean;
}

export interface PersistedWorldDirectorProposal {
  readonly worldId: WorldId;
  readonly id: string;
  readonly triggerEventId: string;
  readonly cognitionRequestId: string;
  readonly affordanceId: string;
  readonly status: "accepted" | "rejected";
  readonly kind: "social_opportunity" | "none";
  readonly payload: unknown;
  readonly intent: string;
  readonly createdAt: SimTime;
  readonly effectEventId?: string;
}

export interface RecordWorldDirectorProposalInput {
  readonly worldId: WorldId;
  readonly id: string;
  readonly triggerEventId: string;
  readonly cognitionRequestId: string;
  readonly affordanceId: string;
  readonly proposal: WorldDirectorProposalDraft;
  readonly intent: string;
  readonly createdAt: SimTime;
  readonly effectEventId?: string;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
  return normalized;
}

function boundedLimit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DomainInvariantError(
      `${label} must be a positive safe integer <= ${maximum}`,
    );
  }
  return value;
}

function mapProposal(row: ProposalRow): PersistedWorldDirectorProposal {
  return {
    worldId: asWorldId(row.world_id),
    id: row.id,
    triggerEventId: row.trigger_event_id,
    cognitionRequestId: row.cognition_request_id,
    affordanceId: row.affordance_id,
    status: row.status,
    kind: row.kind,
    payload: row.payload,
    intent: row.intent,
    createdAt: simTime(row.created_at_sim),
    ...(row.effect_event_id === null
      ? {}
      : { effectEventId: row.effect_event_id }),
  };
}

export class PostgresWorldDirectorRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async loadSummary(
    worldId: WorldId,
    input: {
      readonly maxPeople: number;
      readonly maxRecentEvents: number;
      readonly sampleOrdinal: number;
    },
  ): Promise<WorldDirectorSummary> {
    const maxPeople = boundedLimit(
      input.maxPeople,
      "World Director maxPeople",
      WORLD_DIRECTOR_HARD_MAX_PEOPLE,
    );
    const maxRecentEvents = boundedLimit(
      input.maxRecentEvents,
      "World Director maxRecentEvents",
      WORLD_DIRECTOR_HARD_MAX_RECENT_EVENTS,
    );
    if (!Number.isSafeInteger(input.sampleOrdinal) || input.sampleOrdinal <= 0) {
      throw new DomainInvariantError(
        "World Director sampleOrdinal must be a positive safe integer",
      );
    }

    return withTransaction(this.#pool, async (client) => {
      const worldResult = await client.query<WorldRow>(
        `SELECT current_sim_time::text AS current_sim_time
           FROM worlds
          WHERE id = $1`,
        [worldId],
      );
      const world = worldResult.rows[0];
      if (world === undefined) {
        throw new DomainInvariantError(`World does not exist: ${worldId}`);
      }

      const countResult = await client.query<CountRow>(
        `SELECT count(*)::text AS count
           FROM persons
          WHERE world_id = $1`,
        [worldId],
      );
      const populationCount = Number(countResult.rows[0]?.count ?? "0");
      if (!Number.isSafeInteger(populationCount) || populationCount < 0) {
        throw new DomainInvariantError(
          "World Director population count exceeded safe integer range",
        );
      }

      const sampleCount = Math.min(maxPeople, populationCount);
      const sampleOffset =
        populationCount <= maxPeople || populationCount === 0
          ? 0
          : Number(
              (BigInt(input.sampleOrdinal - 1) * BigInt(maxPeople)) %
                BigInt(populationCount),
            );
      const firstPeople = await client.query<PersonRow>(
        `SELECT id
           FROM persons
          WHERE world_id = $1
          ORDER BY id ASC
          LIMIT $2 OFFSET $3`,
        [worldId, sampleCount, sampleOffset],
      );
      const sampledPeople = [...firstPeople.rows];
      if (sampledPeople.length < sampleCount) {
        const wrapped = await client.query<PersonRow>(
          `SELECT id
             FROM persons
            WHERE world_id = $1
            ORDER BY id ASC
            LIMIT $2`,
          [worldId, sampleCount - sampledPeople.length],
        );
        sampledPeople.push(...wrapped.rows);
      }

      const eventsResult = await client.query<EventRow>(
        `SELECT sequence::text AS sequence,
                sim_time::text AS sim_time,
                type,
                actor_id,
                target_ids
           FROM domain_events
          WHERE world_id = $1
          ORDER BY sequence DESC
          LIMIT $2`,
        [worldId, maxRecentEvents],
      );

      return {
        currentSimTime: simTime(world.current_sim_time),
        populationCount,
        sampledPersonIds: sampledPeople.map((row) => row.id),
        recentEvents: eventsResult.rows
          .slice()
          .reverse()
          .map((row) => ({
            sequence: row.sequence,
            simTime: row.sim_time,
            type: row.type,
            ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
            targetIds: row.target_ids ?? [],
          })),
      };
    }, "repeatable read");
  }

  async get(
    worldId: WorldId,
    proposalId: string,
  ): Promise<PersistedWorldDirectorProposal | undefined> {
    const result = await this.#pool.query<ProposalRow>(
      `SELECT world_id, id, trigger_event_id, cognition_request_id,
              affordance_id, status, kind, payload, intent,
              created_at_sim::text AS created_at_sim, effect_event_id
         FROM world_director_proposals
        WHERE world_id = $1 AND id = $2`,
      [worldId, proposalId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapProposal(row);
  }

  async getByTriggerEvent(
    worldId: WorldId,
    triggerEventId: string,
  ): Promise<PersistedWorldDirectorProposal | undefined> {
    const result = await this.#pool.query<ProposalRow>(
      `SELECT world_id, id, trigger_event_id, cognition_request_id,
              affordance_id, status, kind, payload, intent,
              created_at_sim::text AS created_at_sim, effect_event_id
         FROM world_director_proposals
        WHERE world_id = $1 AND trigger_event_id = $2`,
      [worldId, triggerEventId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapProposal(row);
  }

  async record(
    input: RecordWorldDirectorProposalInput,
  ): Promise<PersistedWorldDirectorProposal> {
    nonBlank(input.id, "World Director proposal id");
    nonBlank(input.triggerEventId, "World Director trigger event id");
    nonBlank(input.cognitionRequestId, "World Director cognition request id");
    nonBlank(input.affordanceId, "World Director affordance id");
    nonBlank(input.intent, "World Director intent");

    if (
      (input.proposal.status === "accepted" &&
        input.effectEventId === undefined) ||
      (input.proposal.status === "rejected" &&
        input.effectEventId !== undefined)
    ) {
      throw new DomainInvariantError(
        "World Director effect event presence must match proposal status",
      );
    }

    const payload = toJsonParameter(
      input.proposal.payload,
      "World Director proposal payload",
    );

    return withTransaction(this.#pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`world-director:${input.worldId}:${input.triggerEventId}`],
      );

      const cognition = await client.query<CognitionStatusRow>(
        `SELECT status
           FROM cognition_runs
          WHERE world_id = $1 AND request_id = $2
          FOR SHARE`,
        [input.worldId, input.cognitionRequestId],
      );
      const cognitionRow = cognition.rows[0];
      if (cognitionRow === undefined) {
        throw new DomainInvariantError(
          `World Director cognition run does not exist: ${input.cognitionRequestId}`,
        );
      }
      if (cognitionRow.status !== "completed") {
        throw new DomainInvariantError(
          `World Director cognition run is not completed: ${input.cognitionRequestId}`,
        );
      }

      const existing = await client.query<ProposalComparisonRow>(
        `SELECT world_id, id, trigger_event_id, cognition_request_id,
                affordance_id, status, kind, payload, intent,
                created_at_sim::text AS created_at_sim, effect_event_id,
                payload IS NOT DISTINCT FROM $3::jsonb AS same_payload
           FROM world_director_proposals
          WHERE world_id = $1 AND trigger_event_id = $2
          FOR UPDATE`,
        [input.worldId, input.triggerEventId, payload],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        const same =
          row.id === input.id &&
          row.cognition_request_id === input.cognitionRequestId &&
          row.affordance_id === input.affordanceId &&
          row.status === input.proposal.status &&
          row.kind === input.proposal.kind &&
          row.same_payload &&
          row.intent === input.intent &&
          BigInt(row.created_at_sim) === BigInt(input.createdAt) &&
          row.effect_event_id === (input.effectEventId ?? null);
        if (!same) {
          throw new DomainInvariantError(
            `World Director trigger ${input.triggerEventId} was already recorded with different semantics`,
          );
        }
        return mapProposal(row);
      }

      const inserted = await client.query<ProposalRow>(
        `INSERT INTO world_director_proposals (
           world_id, id, trigger_event_id, cognition_request_id,
           affordance_id, status, kind, payload, intent,
           created_at_sim, effect_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
         RETURNING world_id, id, trigger_event_id, cognition_request_id,
                   affordance_id, status, kind, payload, intent,
                   created_at_sim::text AS created_at_sim, effect_event_id`,
        [
          input.worldId,
          input.id,
          input.triggerEventId,
          input.cognitionRequestId,
          input.affordanceId,
          input.proposal.status,
          input.proposal.kind,
          payload,
          input.intent,
          input.createdAt.toString(),
          input.effectEventId ?? null,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        throw new DomainInvariantError(
          "World Director proposal insert returned no row",
        );
      }
      return mapProposal(insertedRow);
    }, "read committed");
  }
}
