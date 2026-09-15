import {
  DomainInvariantError,
  simTime,
  type DomainEvent,
  type DomainEventDraft,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { ScheduledEvent } from "@hobbo/simulation";
import type { Pool, QueryResultRow } from "pg";
import {
  appendDomainEventsInTransaction,
} from "./event-repository.ts";
import {
  completeScheduledEventInTransaction,
  scheduleEventsInTransaction,
  type PersistedScheduledEvent,
} from "./scheduler-repository.ts";
import { withTransaction } from "./transaction.ts";
import { advanceWorldTimeInTransaction } from "./world-repository.ts";

interface ClaimedEventRow extends QueryResultRow {
  due_at: string;
}

export interface CommitScheduledEventOutcomeInput {
  readonly worldId: WorldId;
  readonly eventId: ScheduledEventId;
  readonly workerId: string;
  readonly processedAt: SimTime;
  readonly domainEvents?: readonly DomainEventDraft[];
  readonly scheduledEvents?: readonly ScheduledEvent[];
}

export interface CommittedScheduledEventOutcome {
  readonly processedAt: SimTime;
  readonly domainEvents: readonly DomainEvent[];
  readonly scheduledEvents: readonly PersistedScheduledEvent[];
}

/**
 * Atomically commits everything caused by one claimed scheduled event.
 *
 * Either the complete outcome is durable (world time, domain events, newly
 * scheduled consequences and completion of the claimed event), or none of it
 * is. This is the crash boundary for deterministic simulation workers.
 */
export async function commitScheduledEventOutcome(
  pool: Pool,
  input: CommitScheduledEventOutcomeInput,
): Promise<CommittedScheduledEventOutcome> {
  if (input.workerId.length === 0) {
    throw new DomainInvariantError("workerId cannot be empty");
  }

  const domainEvents = input.domainEvents ?? [];
  const scheduledEvents = input.scheduledEvents ?? [];

  for (const event of domainEvents) {
    if (event.worldId !== input.worldId) {
      throw new DomainInvariantError(
        `Outcome event ${event.id} belongs to world ${event.worldId}, expected ${input.worldId}`,
      );
    }
    if (event.simTime !== input.processedAt) {
      throw new DomainInvariantError(
        `Outcome event ${event.id} must occur at processedAt ${input.processedAt}, received ${event.simTime}`,
      );
    }
  }

  for (const event of scheduledEvents) {
    if (event.dueAt < input.processedAt) {
      throw new DomainInvariantError(
        `Consequence ${event.id} cannot be scheduled before processedAt ${input.processedAt}`,
      );
    }
  }

  return withTransaction(pool, async (client) => {
    const claim = await client.query<ClaimedEventRow>(
      `SELECT due_at
         FROM scheduled_events
        WHERE world_id = $1
          AND id = $2
          AND status = 'processing'
          AND locked_by = $3
        FOR UPDATE`,
      [input.worldId, input.eventId, input.workerId],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new DomainInvariantError(
        `Scheduled event ${input.eventId} is not owned by worker ${input.workerId}`,
      );
    }

    const dueAt = simTime(claimed.due_at);
    if (input.processedAt !== dueAt) {
      throw new DomainInvariantError(
        `Scheduled event ${input.eventId} must execute at dueAt ${dueAt}, received ${input.processedAt}`,
      );
    }

    await advanceWorldTimeInTransaction(client, input.worldId, input.processedAt);

    const insertedDomainEvents = await appendDomainEventsInTransaction(
      client,
      input.worldId,
      domainEvents,
    );
    const insertedScheduledEvents = await scheduleEventsInTransaction(
      client,
      input.worldId,
      scheduledEvents,
    );

    await completeScheduledEventInTransaction(
      client,
      input.worldId,
      input.eventId,
      input.workerId,
    );

    return {
      processedAt: input.processedAt,
      domainEvents: insertedDomainEvents,
      scheduledEvents: insertedScheduledEvents,
    };
  });
}
