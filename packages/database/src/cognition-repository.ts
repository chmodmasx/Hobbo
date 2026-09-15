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
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { toJsonParameter } from "./json.ts";
import { withTransaction } from "./transaction.ts";

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

interface CognitionRequestComparisonRow extends CognitionRow {
  same_request_payload: boolean;
  same_affordances: boolean;
  same_sampling_config: boolean;
  same_schema_config: boolean;
}

interface CognitionCompletionComparisonRow extends CognitionRow {
  same_decision: boolean;
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

async function advisoryLock(
  client: PoolClient,
  worldId: WorldId,
  requestId: CognitionRequestId,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`cognition:${worldId}:${requestId}`],
  );
}

function sameRequest(
  row: CognitionRequestComparisonRow,
  input: EnqueueCognitionRun,
): boolean {
  return (
    row.actor_id === input.actorId &&
    BigInt(row.sim_time) === BigInt(input.simTime) &&
    row.correlation_id === input.correlationId &&
    row.provider_id === input.providerId &&
    row.model_id === (input.modelId ?? null) &&
    row.request_hash === input.requestHash &&
    row.same_request_payload &&
    row.same_affordances &&
    row.same_sampling_config &&
    row.same_schema_config
  );
}

function sameCompletion(
  row: CognitionCompletionComparisonRow,
  output: CompleteCognitionRun,
): boolean {
  return (
    row.same_decision &&
    row.raw_response === (output.rawResponse ?? null) &&
    row.prompt_tokens === (output.promptTokens ?? null) &&
    row.completion_tokens === (output.completionTokens ?? null) &&
    row.latency_ms === (output.latencyMs ?? null)
  );
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

    const requestPayload = toJsonParameter(
      input.requestPayload,
      "cognition request_payload",
    );
    const affordances = toJsonParameter(input.affordances, "cognition affordances");
    const samplingConfig = toJsonParameter(
      input.samplingConfig ?? {},
      "cognition sampling_config",
    );
    const schemaConfig = toJsonParameter(
      input.schemaConfig ?? {},
      "cognition schema_config",
    );

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(client, input.worldId, input.requestId);

        const existing = await client.query<CognitionRequestComparisonRow>(
          `SELECT ${COGNITION_COLUMNS},
                  request_payload IS NOT DISTINCT FROM $3::jsonb AS same_request_payload,
                  affordances IS NOT DISTINCT FROM $4::jsonb AS same_affordances,
                  sampling_config IS NOT DISTINCT FROM $5::jsonb AS same_sampling_config,
                  schema_config IS NOT DISTINCT FROM $6::jsonb AS same_schema_config
             FROM cognition_runs
            WHERE world_id = $1 AND request_id = $2`,
          [
            input.worldId,
            input.requestId,
            requestPayload,
            affordances,
            samplingConfig,
            schemaConfig,
          ],
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) {
          if (!sameRequest(existingRow, input)) {
            throw new DomainInvariantError(
              `Cognition request id ${input.requestId} was already used for different input`,
            );
          }
          return mapRun(existingRow);
        }

        const result = await client.query<CognitionRow>(
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
            requestPayload,
            affordances,
            samplingConfig,
            schemaConfig,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError("Cognition enqueue returned no row");
        }
        return mapRun(row);
      },
      "read committed",
    );
  }

  async start(
    worldId: WorldId,
    requestId: CognitionRequestId,
  ): Promise<PersistedCognitionRun> {
    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(client, worldId, requestId);
        const existing = await client.query<CognitionRow>(
          `SELECT ${COGNITION_COLUMNS}
             FROM cognition_runs
            WHERE world_id = $1 AND request_id = $2
            FOR UPDATE`,
          [worldId, requestId],
        );
        const row = existing.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(`Cognition run is missing: ${requestId}`);
        }
        if (row.status === "running" || row.status === "completed") {
          return mapRun(row);
        }
        if (row.status !== "queued") {
          throw new DomainInvariantError(
            `Cognition run cannot start from status ${row.status}: ${requestId}`,
          );
        }

        const result = await client.query<CognitionRow>(
          `UPDATE cognition_runs
              SET status = 'running',
                  started_at = COALESCE(started_at, now())
            WHERE world_id = $1 AND request_id = $2
          RETURNING ${COGNITION_COLUMNS}`,
          [worldId, requestId],
        );
        const started = result.rows[0];
        if (started === undefined) {
          throw new DomainInvariantError(`Cognition start returned no row: ${requestId}`);
        }
        return mapRun(started);
      },
      "read committed",
    );
  }

  async complete(
    worldId: WorldId,
    requestId: CognitionRequestId,
    output: CompleteCognitionRun,
  ): Promise<PersistedCognitionRun> {
    const decision = toJsonParameter(output.decision, "cognition decision");

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(client, worldId, requestId);
        const existing = await client.query<CognitionCompletionComparisonRow>(
          `SELECT ${COGNITION_COLUMNS},
                  decision IS NOT DISTINCT FROM $3::jsonb AS same_decision
             FROM cognition_runs
            WHERE world_id = $1 AND request_id = $2
            FOR UPDATE`,
          [worldId, requestId, decision],
        );
        const row = existing.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(`Cognition run is missing: ${requestId}`);
        }
        if (row.status === "completed") {
          if (!sameCompletion(row, output)) {
            throw new DomainInvariantError(
              `Completed cognition run ${requestId} conflicts with retry output`,
            );
          }
          return mapRun(row);
        }
        if (row.status !== "running") {
          throw new DomainInvariantError(
            `Cognition run is not running: ${requestId}`,
          );
        }

        const result = await client.query<CognitionRow>(
          `UPDATE cognition_runs
              SET status = 'completed',
                  decision = $3,
                  raw_response = $4,
                  prompt_tokens = $5,
                  completion_tokens = $6,
                  latency_ms = $7,
                  error_message = NULL,
                  finished_at = now()
            WHERE world_id = $1 AND request_id = $2
          RETURNING ${COGNITION_COLUMNS}`,
          [
            worldId,
            requestId,
            decision,
            output.rawResponse ?? null,
            output.promptTokens ?? null,
            output.completionTokens ?? null,
            output.latencyMs ?? null,
          ],
        );
        const completed = result.rows[0];
        if (completed === undefined) {
          throw new DomainInvariantError(
            `Cognition completion returned no row: ${requestId}`,
          );
        }
        return mapRun(completed);
      },
      "read committed",
    );
  }

  async fail(
    worldId: WorldId,
    requestId: CognitionRequestId,
    errorMessage: string,
  ): Promise<PersistedCognitionRun> {
    if (errorMessage.length === 0) {
      throw new DomainInvariantError("Cognition failure message cannot be empty");
    }

    return withTransaction(
      this.#pool,
      async (client) => {
        await advisoryLock(client, worldId, requestId);
        const existing = await client.query<CognitionRow>(
          `SELECT ${COGNITION_COLUMNS}
             FROM cognition_runs
            WHERE world_id = $1 AND request_id = $2
            FOR UPDATE`,
          [worldId, requestId],
        );
        const row = existing.rows[0];
        if (row === undefined) {
          throw new DomainInvariantError(`Cognition run is missing: ${requestId}`);
        }
        if (row.status === "failed") {
          if (row.error_message !== errorMessage) {
            throw new DomainInvariantError(
              `Failed cognition run ${requestId} conflicts with retry error`,
            );
          }
          return mapRun(row);
        }
        if (row.status === "completed") {
          throw new DomainInvariantError(
            `Completed cognition run cannot transition to failed: ${requestId}`,
          );
        }

        const result = await client.query<CognitionRow>(
          `UPDATE cognition_runs
              SET status = 'failed',
                  error_message = $3,
                  finished_at = now()
            WHERE world_id = $1 AND request_id = $2
          RETURNING ${COGNITION_COLUMNS}`,
          [worldId, requestId, errorMessage],
        );
        const failed = result.rows[0];
        if (failed === undefined) {
          throw new DomainInvariantError(
            `Cognition failure update returned no row: ${requestId}`,
          );
        }
        return mapRun(failed);
      },
      "read committed",
    );
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
