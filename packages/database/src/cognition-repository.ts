import {
  DomainInvariantError,
  asAffordanceId,
  asCognitionRequestId,
  asCorrelationId,
  asEntityId,
  asWorldId,
  simTime,
  type AffordanceId,
  type CognitionRequestId,
  type CorrelationId,
  type EntityId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { Pool, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";

export type CognitionRunStatus = "queued" | "running" | "completed" | "failed";

interface CognitionRow extends QueryResultRow {
  world_id: string;
  request_id: string;
  actor_id: string;
  sim_time: string;
  correlation_id: string;
  provider_id: string;
  model_id: string | null;
  request_hash: string;
  request_payload: unknown;
  affordances: unknown;
  sampling_config: unknown;
  schema_config: unknown;
  decision: unknown | null;
  raw_response: string | null;
  status: CognitionRunStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  error_message: string | null;
}

export interface PersistedCognitionRun {
  readonly worldId: WorldId;
  readonly requestId: CognitionRequestId;
  readonly actorId: EntityId;
  readonly simTime: SimTime;
  readonly correlationId: CorrelationId;
  readonly providerId: string;
  readonly modelId?: string;
  readonly requestHash: string;
  readonly requestPayload: unknown;
  readonly affordances: unknown;
  readonly samplingConfig: unknown;
  readonly schemaConfig: unknown;
  readonly decision?: unknown;
  readonly rawResponse?: string;
  readonly status: CognitionRunStatus;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
  readonly errorMessage?: string;
}

export interface EnqueueCognitionRun {
  readonly worldId: WorldId;
  readonly requestId: CognitionRequestId;
  readonly actorId: EntityId;
  readonly simTime: SimTime;
  readonly correlationId: CorrelationId;
  readonly providerId: string;
  readonly modelId?: string;
  readonly requestHash: string;
  readonly requestPayload: unknown;
  readonly affordances: unknown;
  readonly samplingConfig?: unknown;
  readonly schemaConfig?: unknown;
}

export interface CompleteCognitionRun {
  readonly decision: unknown;
  readonly rawResponse?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
}

export interface PersistedReplayDecision {
  readonly affordanceId: AffordanceId;
  readonly intent: string;
}

const COGNITION_COLUMNS = `
  world_id, request_id, actor_id, sim_time, correlation_id,
  provider_id, model_id, request_hash, request_payload, affordances,
  sampling_config, schema_config, decision, raw_response, status,
  prompt_tokens, completion_tokens, latency_ms, error_message
`;

function mapRun(row: CognitionRow): PersistedCognitionRun {
  return {
    worldId: asWorldId(row.world_id),
    requestId: asCognitionRequestId(row.request_id),
    actorId: asEntityId(row.actor_id),
    simTime: simTime(row.sim_time),
    correlationId: asCorrelationId(row.correlation_id),
    providerId: row.provider_id,
    requestHash: row.request_hash,
    requestPayload: row.request_payload,
    affordances: row.affordances,
    samplingConfig: row.sampling_config,
    schemaConfig: row.schema_config,
    status: row.status,
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.decision === null ? {} : { decision: row.decision }),
    ...(row.raw_response === null ? {} : { rawResponse: row.raw_response }),
    ...(row.prompt_tokens === null ? {} : { promptTokens: row.prompt_tokens }),
    ...(row.completion_tokens === null
      ? {}
      : { completionTokens: row.completion_tokens }),
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}

function replayDecisionFromUnknown(value: unknown): PersistedReplayDecision {
  if (
    typeof value !== "object" ||
    value === null ||
    !("affordance_id" in value) ||
    !("intent" in value) ||
    typeof value.affordance_id !== "string" ||
    value.affordance_id.length === 0 ||
    typeof value.intent !== "string" ||
    value.intent.trim().length === 0
  ) {
    throw new DomainInvariantError("Persisted cognition decision has invalid replay shape");
  }

  return {
    affordanceId: asAffordanceId(value.affordance_id),
    intent: value.intent,
  };
}

export class PostgresCognitionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async enqueue(input: EnqueueCognitionRun): Promise<PersistedCognitionRun> {
    if (input.providerId.length === 0) {
      throw new DomainInvariantError("providerId cannot be empty");
    }
    if (input.requestHash.length === 0) {
      throw new DomainInvariantError("requestHash cannot be empty");
    }

    const result = await this.#pool.query<CognitionRow>(
      `INSERT INTO cognition_runs (
         world_id, request_id, actor_id, sim_time, correlation_id,
         provider_id, model_id, request_hash, request_payload, affordances,
         sampling_config, schema_config
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${COGNITION_COLUMNS}`,
      [
        input.worldId,
        input.requestId,
        input.actorId,
        input.simTime.toString(),
        input.correlationId,
        input.providerId,
        input.modelId ?? null,
        input.requestHash,
        toJsonParameter(input.requestPayload, "cognition request_payload"),
        toJsonParameter(input.affordances, "cognition affordances"),
        toJsonParameter(input.samplingConfig ?? {}, "cognition sampling_config"),
        toJsonParameter(input.schemaConfig ?? {}, "cognition schema_config"),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError("Cognition enqueue returned no row");
    }
    return mapRun(row);
  }

  async start(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<PersistedCognitionRun> {
    const result = await this.#pool.query<CognitionRow>(
      `UPDATE cognition_runs
          SET status = 'running',
              started_at = now()
        WHERE world_id = $1
          AND request_id = $2
          AND status = 'queued'
      RETURNING ${COGNITION_COLUMNS}`,
      [worldId, requestId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(
        `Cognition run is not queued: ${requestId}`,
      );
    }
    return mapRun(row);
  }

  async complete(
    worldId: WorldId,
    requestId: CognitionRequestId,
    output: CompleteCognitionRun,
  ): Promise<PersistedCognitionRun> {
    const result = await this.#pool.query<CognitionRow>(
      `UPDATE cognition_runs
          SET status = 'completed',
              decision = $3,
              raw_response = $4,
              prompt_tokens = $5,
              completion_tokens = $6,
              latency_ms = $7,
              error_message = NULL,
              finished_at = now()
        WHERE world_id = $1
          AND request_id = $2
          AND status = 'running'
      RETURNING ${COGNITION_COLUMNS}`,
      [
        worldId,
        requestId,
        toJsonParameter(output.decision, "cognition decision"),
        output.rawResponse ?? null,
        output.promptTokens ?? null,
        output.completionTokens ?? null,
        output.latencyMs ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(
        `Cognition run is not running: ${requestId}`,
      );
    }
    return mapRun(row);
  }

  async fail(
    worldId: WorldId,
    requestId: CognitionRequestId,
    errorMessage: string,
  ): Promise<PersistedCognitionRun> {
    if (errorMessage.length === 0) {
      throw new DomainInvariantError("Cognition failure message cannot be empty");
    }

    const result = await this.#pool.query<CognitionRow>(
      `UPDATE cognition_runs
          SET status = 'failed',
              error_message = $3,
              finished_at = now()
        WHERE world_id = $1
          AND request_id = $2
          AND status IN ('queued', 'running')
      RETURNING ${COGNITION_COLUMNS}`,
      [worldId, requestId, errorMessage],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DomainInvariantError(
        `Cognition run cannot transition to failed: ${requestId}`,
      );
    }
    return mapRun(row);
  }

  async get(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<PersistedCognitionRun | undefined> {
    const result = await this.#pool.query<CognitionRow>(
      `SELECT ${COGNITION_COLUMNS}
         FROM cognition_runs
        WHERE world_id = $1
          AND request_id = $2`,
      [worldId, requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRun(row);
  }

  async loadReplayDecision(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<PersistedReplayDecision> {
    const run = await this.get(worldId, requestId);
    if (run === undefined || run.status !== "completed" || run.decision === undefined) {
      throw new DomainInvariantError(
        `Completed replay decision is missing for cognition request: ${requestId}`,
      );
    }
    return replayDecisionFromUnknown(run.decision);
  }
}
