import {
  beginSleep,
  createEnergyState,
  createFoodItem,
  createHungerState,
  energyAt,
  hungerAt,
  consumeFood,
  wakeUp,
  type FoodItem,
  type PersonState,
} from "@hobbo/agents";
import {
  DomainInvariantError,
  asCorrelationId,
  asEntityId,
  asEventId,
  asPersonId,
  simTime,
  type DomainEvent,
  type PersonId,
  type ScheduledEventId,
  type SimTime,
  type WorldId,
} from "@hobbo/domain";
import type { ScheduledEvent } from "@hobbo/simulation";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { appendDomainEventsInTransaction } from "./event-repository.ts";
import { toJsonParameter } from "./json.ts";
import {
  completeScheduledEventInTransaction,
  scheduleEventsInTransaction,
} from "./scheduler-repository.ts";
import { withTransaction } from "./transaction.ts";
import {
  advanceWorldTimeInTransaction,
  lockWorld,
} from "./world-repository.ts";

export type InventoryItemStatus = "available" | "consumed";

interface PersonPhysiologyRow extends QueryResultRow {
  world_id: string;
  person_id: string;
  created_at_sim: string;
  hunger_value: number;
  hunger_recorded_at: string;
  hunger_rate_per_hour: number;
  energy_value: number;
  energy_recorded_at: string;
  energy_mode: "awake" | "sleeping";
  awake_drain_per_hour: number;
  sleep_recovery_per_hour: number;
  meals_eaten: number;
  sleep_sessions: number;
  updated_at_sim: string;
  version: string;
}

interface InventoryItemRow extends QueryResultRow {
  world_id: string;
  id: string;
  owner_id: string;
  kind: string;
  label: string;
  attributes: unknown;
  status: InventoryItemStatus;
  created_at_sim: string;
  updated_at_sim: string;
  consumed_at_sim: string | null;
}

interface ClaimedScheduledRow extends QueryResultRow {
  due_at: string;
  correlation_id: string;
  type: string;
  payload: unknown;
}

export interface PersistedInventoryItem {
  readonly worldId: WorldId;
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly status: InventoryItemStatus;
  readonly createdAt: SimTime;
  readonly updatedAt: SimTime;
  readonly consumedAt?: SimTime;
}

export interface PersistedPersonState {
  readonly worldId: WorldId;
  readonly createdAt: SimTime;
  readonly updatedAt: SimTime;
  readonly version: bigint;
  readonly person: PersonState;
}

export interface CreatePersonInput {
  readonly worldId: WorldId;
  readonly person: PersonState;
  readonly at: SimTime;
}

export interface AddFoodItemInput {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly item: FoodItem;
  readonly at: SimTime;
}

export interface ClaimedPersonTransitionInput {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly scheduledEventId: ScheduledEventId;
  readonly workerId: string;
  readonly scheduledConsequences?: readonly ScheduledEvent[];
}

export interface ClaimedConsumeFoodInput extends ClaimedPersonTransitionInput {
  readonly itemId: string;
}

export interface ClaimedPersonTransitionResult {
  readonly person: PersistedPersonState;
  readonly event: DomainEvent;
  readonly scheduledConsequences: readonly ScheduledEvent[];
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainInvariantError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${label} cannot be blank`);
  }
}

function attributesRecord(value: unknown, itemId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(`Inventory item ${itemId} attributes must be an object`);
  }
  return value as Record<string, unknown>;
}

function mapInventoryItem(row: InventoryItemRow): PersistedInventoryItem {
  return {
    worldId: row.world_id as WorldId,
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    label: row.label,
    attributes: attributesRecord(row.attributes, row.id),
    status: row.status,
    createdAt: simTime(row.created_at_sim),
    updatedAt: simTime(row.updated_at_sim),
    ...(row.consumed_at_sim === null
      ? {}
      : { consumedAt: simTime(row.consumed_at_sim) }),
  };
}

function foodFromInventoryRow(row: InventoryItemRow): FoodItem {
  if (row.kind !== "food") {
    throw new DomainInvariantError(`Inventory item ${row.id} is not food`);
  }
  const attributes = attributesRecord(row.attributes, row.id);
  const satiety = attributes.satiety;
  if (typeof satiety !== "number" || !Number.isSafeInteger(satiety)) {
    throw new DomainInvariantError(`Food item ${row.id} has invalid satiety`);
  }
  return createFoodItem(row.id, row.label, satiety);
}

function validatePersonSnapshot(person: PersonState, at: SimTime): void {
  assertNonBlank(String(person.id), "Person id");
  assertNonNegativeSafeInteger(person.mealsEaten, "Meals eaten");
  assertNonNegativeSafeInteger(person.sleepSessions, "Sleep sessions");

  const hunger = createHungerState(
    person.hunger.value,
    person.hunger.recordedAt,
    person.hunger.ratePerHour,
  );
  const energy = createEnergyState(
    person.energy.value,
    person.energy.recordedAt,
    person.energy.awakeDrainPerHour,
    person.energy.sleepRecoveryPerHour,
    person.energy.mode,
  );
  hungerAt(hunger, at);
  energyAt(energy, at);

  const ids = new Set<string>();
  for (const item of person.inventory) {
    assertNonBlank(item.id, "Inventory item id");
    if (ids.has(item.id)) {
      throw new DomainInvariantError(`Duplicate inventory item id: ${item.id}`);
    }
    ids.add(item.id);
    createFoodItem(item.id, item.label, item.satiety);
  }
}

async function loadPhysiologyRow(
  client: PoolClient,
  worldId: WorldId,
  personId: PersonId,
  forUpdate: boolean,
): Promise<PersonPhysiologyRow | undefined> {
  const result = await client.query<PersonPhysiologyRow>(
    `SELECT p.world_id, p.id AS person_id, p.created_at_sim,
            physiology.hunger_value, physiology.hunger_recorded_at,
            physiology.hunger_rate_per_hour,
            physiology.energy_value, physiology.energy_recorded_at,
            physiology.energy_mode, physiology.awake_drain_per_hour,
            physiology.sleep_recovery_per_hour, physiology.meals_eaten,
            physiology.sleep_sessions, physiology.updated_at_sim,
            physiology.version
       FROM persons AS p
       JOIN person_physiology AS physiology
         ON physiology.world_id = p.world_id
        AND physiology.person_id = p.id
      WHERE p.world_id = $1 AND p.id = $2
      ${forUpdate ? "FOR UPDATE OF physiology" : ""}`,
    [worldId, personId],
  );
  return result.rows[0];
}

async function loadAvailableFoodRows(
  client: PoolClient,
  worldId: WorldId,
  personId: PersonId,
  forUpdate: boolean,
): Promise<readonly InventoryItemRow[]> {
  const result = await client.query<InventoryItemRow>(
    `SELECT world_id, id, owner_id, kind, label, attributes, status,
            created_at_sim, updated_at_sim, consumed_at_sim
       FROM inventory_items
      WHERE world_id = $1
        AND owner_id = $2
        AND kind = 'food'
        AND status = 'available'
      ORDER BY id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [worldId, personId],
  );
  return result.rows;
}

function mapPersonState(
  row: PersonPhysiologyRow,
  foodRows: readonly InventoryItemRow[],
): PersistedPersonState {
  const person: PersonState = {
    id: asPersonId(row.person_id),
    hunger: createHungerState(
      row.hunger_value,
      simTime(row.hunger_recorded_at),
      row.hunger_rate_per_hour,
    ),
    energy: createEnergyState(
      row.energy_value,
      simTime(row.energy_recorded_at),
      row.awake_drain_per_hour,
      row.sleep_recovery_per_hour,
      row.energy_mode,
    ),
    inventory: foodRows.map(foodFromInventoryRow),
    mealsEaten: row.meals_eaten,
    sleepSessions: row.sleep_sessions,
  };

  return {
    worldId: row.world_id as WorldId,
    createdAt: simTime(row.created_at_sim),
    updatedAt: simTime(row.updated_at_sim),
    version: BigInt(row.version),
    person,
  };
}

async function loadPersonStateInTransaction(
  client: PoolClient,
  worldId: WorldId,
  personId: PersonId,
  forUpdate: boolean,
): Promise<PersistedPersonState | undefined> {
  const row = await loadPhysiologyRow(client, worldId, personId, forUpdate);
  if (row === undefined) return undefined;
  const foodRows = await loadAvailableFoodRows(client, worldId, personId, forUpdate);
  return mapPersonState(row, foodRows);
}

function claimedPayloadPersonId(value: unknown, eventId: ScheduledEventId): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainInvariantError(`Scheduled event ${eventId} payload must be an object`);
  }
  const personId = (value as Record<string, unknown>).personId;
  if (typeof personId !== "string" || personId.length === 0) {
    throw new DomainInvariantError(`Scheduled event ${eventId} payload has no personId`);
  }
  return personId;
}

async function lockClaimedEvent(
  client: PoolClient,
  worldId: WorldId,
  scheduledEventId: ScheduledEventId,
  workerId: string,
  expectedType: string,
  personId: PersonId,
): Promise<{ readonly dueAt: SimTime; readonly correlationId: ReturnType<typeof asCorrelationId> }> {
  if (workerId.length === 0) {
    throw new DomainInvariantError("workerId cannot be empty");
  }
  const result = await client.query<ClaimedScheduledRow>(
    `SELECT due_at, correlation_id, type, payload
       FROM scheduled_events
      WHERE world_id = $1
        AND id = $2
        AND status = 'processing'
        AND locked_by = $3
      FOR UPDATE`,
    [worldId, scheduledEventId, workerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainInvariantError(
      `Scheduled event ${scheduledEventId} is not owned by worker ${workerId}`,
    );
  }
  if (row.type !== expectedType) {
    throw new DomainInvariantError(
      `Scheduled event ${scheduledEventId} has type ${row.type}, expected ${expectedType}`,
    );
  }
  const claimedPersonId = claimedPayloadPersonId(row.payload, scheduledEventId);
  if (claimedPersonId !== String(personId)) {
    throw new DomainInvariantError(
      `Scheduled event ${scheduledEventId} targets ${claimedPersonId}, expected ${personId}`,
    );
  }
  return {
    dueAt: simTime(row.due_at),
    correlationId: asCorrelationId(row.correlation_id),
  };
}

async function updatePhysiology(
  client: PoolClient,
  worldId: WorldId,
  person: PersonState,
  at: SimTime,
): Promise<void> {
  const result = await client.query(
    `UPDATE person_physiology
        SET hunger_value = $3,
            hunger_recorded_at = $4,
            hunger_rate_per_hour = $5,
            energy_value = $6,
            energy_recorded_at = $7,
            energy_mode = $8,
            awake_drain_per_hour = $9,
            sleep_recovery_per_hour = $10,
            meals_eaten = $11,
            sleep_sessions = $12,
            updated_at_sim = $13,
            version = version + 1,
            updated_at = now()
      WHERE world_id = $1 AND person_id = $2`,
    [
      worldId,
      person.id,
      person.hunger.value,
      person.hunger.recordedAt.toString(),
      person.hunger.ratePerHour,
      person.energy.value,
      person.energy.recordedAt.toString(),
      person.energy.mode,
      person.energy.awakeDrainPerHour,
      person.energy.sleepRecoveryPerHour,
      person.mealsEaten,
      person.sleepSessions,
      at.toString(),
    ],
  );
  if (result.rowCount !== 1) {
    throw new DomainInvariantError(`Person physiology disappeared: ${person.id}`);
  }
}

export class PostgresPersonRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(input: CreatePersonInput): Promise<PersistedPersonState> {
    validatePersonSnapshot(input.person, input.at);

    return withTransaction(this.#pool, async (client) => {
      const world = await lockWorld(client, input.worldId);
      if (input.at !== world.currentSimTime) {
        throw new DomainInvariantError(
          `Person creation time ${input.at} must equal world time ${world.currentSimTime}`,
        );
      }

      await client.query(
        `INSERT INTO persons (world_id, id, created_at_sim)
         VALUES ($1,$2,$3)`,
        [input.worldId, input.person.id, input.at.toString()],
      );
      await client.query(
        `INSERT INTO person_physiology (
           world_id, person_id,
           hunger_value, hunger_recorded_at, hunger_rate_per_hour,
           energy_value, energy_recorded_at, energy_mode,
           awake_drain_per_hour, sleep_recovery_per_hour,
           meals_eaten, sleep_sessions, updated_at_sim
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.worldId,
          input.person.id,
          input.person.hunger.value,
          input.person.hunger.recordedAt.toString(),
          input.person.hunger.ratePerHour,
          input.person.energy.value,
          input.person.energy.recordedAt.toString(),
          input.person.energy.mode,
          input.person.energy.awakeDrainPerHour,
          input.person.energy.sleepRecoveryPerHour,
          input.person.mealsEaten,
          input.person.sleepSessions,
          input.at.toString(),
        ],
      );

      for (const item of input.person.inventory) {
        await client.query(
          `INSERT INTO inventory_items (
             world_id, id, owner_id, kind, label, attributes,
             status, created_at_sim, updated_at_sim
           ) VALUES ($1,$2,$3,'food',$4,$5,'available',$6,$6)`,
          [
            input.worldId,
            item.id,
            input.person.id,
            item.label,
            toJsonParameter({ satiety: item.satiety }, `inventory item ${item.id} attributes`),
            input.at.toString(),
          ],
        );
      }

      const persisted = await loadPersonStateInTransaction(
        client,
        input.worldId,
        input.person.id,
        false,
      );
      if (persisted === undefined) {
        throw new DomainInvariantError(`Created person could not be reloaded: ${input.person.id}`);
      }
      return persisted;
    }, "read committed");
  }

  async get(
    worldId: WorldId,
    personId: PersonId,
  ): Promise<PersistedPersonState | undefined> {
    return withTransaction(
      this.#pool,
      (client) => loadPersonStateInTransaction(client, worldId, personId, false),
      "repeatable read",
    );
  }

  async listIds(worldId: WorldId): Promise<readonly PersonId[]> {
    const result = await this.#pool.query<{ id: string }>(
      `SELECT id
         FROM persons
        WHERE world_id = $1
        ORDER BY id ASC`,
      [worldId],
    );
    return result.rows.map((row) => asPersonId(row.id));
  }

  async listInventory(
    worldId: WorldId,
    ownerId: string,
    includeConsumed = false,
  ): Promise<readonly PersistedInventoryItem[]> {
    const result = await this.#pool.query<InventoryItemRow>(
      `SELECT world_id, id, owner_id, kind, label, attributes, status,
              created_at_sim, updated_at_sim, consumed_at_sim
         FROM inventory_items
        WHERE world_id = $1
          AND owner_id = $2
          AND ($3::boolean OR status = 'available')
        ORDER BY id`,
      [worldId, ownerId, includeConsumed],
    );
    return result.rows.map(mapInventoryItem);
  }

  async addFoodItem(input: AddFoodItemInput): Promise<PersistedInventoryItem> {
    createFoodItem(input.item.id, input.item.label, input.item.satiety);

    return withTransaction(this.#pool, async (client) => {
      const world = await lockWorld(client, input.worldId);
      if (input.at !== world.currentSimTime) {
        throw new DomainInvariantError(
          `Inventory mutation time ${input.at} must equal world time ${world.currentSimTime}`,
        );
      }
      const person = await loadPhysiologyRow(
        client,
        input.worldId,
        input.personId,
        true,
      );
      if (person === undefined) {
        throw new DomainInvariantError(`Person does not exist: ${input.personId}`);
      }

      const result = await client.query<InventoryItemRow>(
        `INSERT INTO inventory_items (
           world_id, id, owner_id, kind, label, attributes,
           status, created_at_sim, updated_at_sim
         ) VALUES ($1,$2,$3,'food',$4,$5,'available',$6,$6)
         RETURNING world_id, id, owner_id, kind, label, attributes, status,
                   created_at_sim, updated_at_sim, consumed_at_sim`,
        [
          input.worldId,
          input.item.id,
          input.personId,
          input.item.label,
          toJsonParameter(
            { satiety: input.item.satiety },
            `inventory item ${input.item.id} attributes`,
          ),
          input.at.toString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new DomainInvariantError(`Inventory insert returned no row: ${input.item.id}`);
      }
      return mapInventoryItem(row);
    }, "read committed");
  }

  async consumeFoodClaimed(
    input: ClaimedConsumeFoodInput,
  ): Promise<ClaimedPersonTransitionResult> {
    return this.#commitClaimedTransition(
      input,
      "person.hunger_threshold",
      async (client, current, at) => {
        const transition = consumeFood(current.person, input.itemId, at);
        await updatePhysiology(client, input.worldId, transition.person, at);
        const itemUpdate = await client.query(
          `UPDATE inventory_items
              SET status = 'consumed',
                  consumed_at_sim = $4,
                  updated_at_sim = $4,
                  updated_at = now()
            WHERE world_id = $1
              AND id = $2
              AND owner_id = $3
              AND status = 'available'`,
          [input.worldId, input.itemId, input.personId, at.toString()],
        );
        if (itemUpdate.rowCount !== 1) {
          throw new DomainInvariantError(`Food item is not available: ${input.itemId}`);
        }
        return {
          person: transition.person,
          eventType: "person.ate",
          payload: {
            itemId: transition.item.id,
            hungerBefore: transition.hungerBefore,
            hungerAfter: transition.hungerAfter,
          },
        };
      },
    );
  }

  async beginSleepClaimed(
    input: ClaimedPersonTransitionInput,
  ): Promise<ClaimedPersonTransitionResult> {
    return this.#commitClaimedTransition(
      input,
      "person.energy_low",
      async (client, current, at) => {
        const person = beginSleep(current.person, at);
        await updatePhysiology(client, input.worldId, person, at);
        return {
          person,
          eventType: "person.sleep_started",
          payload: {
            energy: person.energy.value,
            sleepSessions: person.sleepSessions,
          },
        };
      },
    );
  }

  async wakeUpClaimed(
    input: ClaimedPersonTransitionInput,
  ): Promise<ClaimedPersonTransitionResult> {
    return this.#commitClaimedTransition(
      input,
      "person.energy_recovered",
      async (client, current, at) => {
        const person = wakeUp(current.person, at);
        await updatePhysiology(client, input.worldId, person, at);
        return {
          person,
          eventType: "person.woke_up",
          payload: {
            energy: person.energy.value,
            sleepSessions: person.sleepSessions,
          },
        };
      },
    );
  }

  async #commitClaimedTransition(
    input: ClaimedPersonTransitionInput,
    expectedScheduledType: string,
    transition: (
      client: PoolClient,
      current: PersistedPersonState,
      at: SimTime,
    ) => Promise<{
      readonly person: PersonState;
      readonly eventType: string;
      readonly payload: unknown;
    }>,
  ): Promise<ClaimedPersonTransitionResult> {
    const consequences = input.scheduledConsequences ?? [];

    return withTransaction(this.#pool, async (client) => {
      const claim = await lockClaimedEvent(
        client,
        input.worldId,
        input.scheduledEventId,
        input.workerId,
        expectedScheduledType,
        input.personId,
      );
      await advanceWorldTimeInTransaction(client, input.worldId, claim.dueAt);

      const current = await loadPersonStateInTransaction(
        client,
        input.worldId,
        input.personId,
        true,
      );
      if (current === undefined) {
        throw new DomainInvariantError(`Person does not exist: ${input.personId}`);
      }

      const applied = await transition(client, current, claim.dueAt);
      const eventDraft = {
        id: asEventId(`physiology:${input.scheduledEventId}`),
        worldId: input.worldId,
        simTime: claim.dueAt,
        type: applied.eventType,
        actorId: asEntityId(String(input.personId)),
        payload: applied.payload,
        correlationId: claim.correlationId,
      };
      const events = await appendDomainEventsInTransaction(
        client,
        input.worldId,
        [eventDraft],
      );
      await scheduleEventsInTransaction(client, input.worldId, consequences);
      await completeScheduledEventInTransaction(
        client,
        input.worldId,
        input.scheduledEventId,
        input.workerId,
      );

      const persisted = await loadPersonStateInTransaction(
        client,
        input.worldId,
        input.personId,
        false,
      );
      const event = events[0];
      if (persisted === undefined || event === undefined) {
        throw new DomainInvariantError("Claimed person transition failed to materialize");
      }

      return {
        person: persisted,
        event,
        scheduledConsequences: consequences,
      };
    }, "read committed");
  }
}
