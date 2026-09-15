import {
  SIM_DAY,
  SIM_HOUR,
  asEntityId,
  asEventId,
  asRoutineId,
  asWorldId,
  simDuration,
  simTime,
  type SimDuration,
  type SimTime,
} from "@hobbo/domain";
import {
  COMMITMENT_DUE_EVENT_TYPE,
  DeterministicRandom,
  DeterministicScheduler,
  InMemoryDomainEventLog,
  WorldClock,
  fulfillCommitment,
  nextRoutineCommitment,
  scheduledEventForCommitment,
  type Commitment,
  type PeriodicRoutine,
  type ScheduledEvent,
} from "@hobbo/simulation";

export const HEADLESS_ROUTINE_AGENT_COUNT = 20;
export const HEADLESS_ROUTINE_DURATION = (BigInt(SIM_DAY) * 30n) as SimDuration;

const WORLD_ID = asWorldId("headless-routine-world");

interface RoutinePayload {
  readonly activity: string;
}

export interface HeadlessRoutineAgentSummary {
  readonly id: string;
  readonly fulfilledCommitments: number;
}

export interface HeadlessRoutineSimulationResult {
  readonly seed: bigint;
  readonly agentCount: number;
  readonly finalSimTime: SimTime;
  readonly processedScheduledEvents: number;
  readonly domainEventCount: number;
  readonly maxFutureQueueSize: number;
  readonly agents: readonly HeadlessRoutineAgentSummary[];
}

export interface HeadlessRoutineSimulationOptions {
  readonly seed?: bigint;
  readonly agentCount?: number;
  readonly duration?: SimDuration;
}

function makeRoutine(
  index: number,
  random: DeterministicRandom,
): PeriodicRoutine<RoutinePayload> {
  const ownerId = asEntityId(`routine-person-${String(index + 1).padStart(2, "0")}`);
  // Keep all phases strictly inside a day so each agent has exactly one
  // occurrence in every simulated day of the default fixture.
  const phase = BigInt(SIM_HOUR) * 6n + BigInt(random.nextInt(14 * 60 * 60));

  return {
    id: asRoutineId(`daily-personal-routine:${ownerId}`),
    ownerId,
    period: simDuration(SIM_DAY),
    phase: simDuration(phase),
    kind: "routine.personal_activity",
    payload: { activity: `activity-${(index % 5) + 1}` },
  };
}

export function runHeadlessRoutineSimulation(
  options: HeadlessRoutineSimulationOptions = {},
): HeadlessRoutineSimulationResult {
  const seed = options.seed ?? 0x524f5554494e45n;
  const agentCount = options.agentCount ?? HEADLESS_ROUTINE_AGENT_COUNT;
  const duration = options.duration ?? HEADLESS_ROUTINE_DURATION;

  if (!Number.isSafeInteger(agentCount) || agentCount <= 0) {
    throw new RangeError("agentCount must be a positive safe integer");
  }

  const random = new DeterministicRandom(seed);
  const clock = new WorldClock(simTime(0));
  const scheduler = new DeterministicScheduler(clock);
  const eventLog = new InMemoryDomainEventLog();
  const endTime = simTime(BigInt(duration));

  const routines = new Map<string, PeriodicRoutine<RoutinePayload>>();
  const commitmentsByScheduledEvent = new Map<string, Commitment<RoutinePayload>>();
  const fulfilledByOwner = new Map<string, number>();
  let maxFutureQueueSize = 0;

  function scheduleNext(
    routine: PeriodicRoutine<RoutinePayload>,
    from: SimTime,
  ): void {
    const commitment = nextRoutineCommitment(routine, from, false);
    const scheduled = scheduledEventForCommitment(commitment);
    commitmentsByScheduledEvent.set(String(scheduled.id), commitment);
    scheduler.schedule(scheduled);
    maxFutureQueueSize = Math.max(maxFutureQueueSize, scheduler.queue.size);
  }

  for (let index = 0; index < agentCount; index += 1) {
    const routine = makeRoutine(index, random);
    routines.set(String(routine.id), routine);
    fulfilledByOwner.set(String(routine.ownerId), 0);
    scheduleNext(routine, simTime(0));
  }

  const processedScheduledEvents = scheduler.runUntil(
    endTime,
    (scheduled: ScheduledEvent) => {
      if (scheduled.type !== COMMITMENT_DUE_EVENT_TYPE) {
        throw new Error(`Unexpected scheduled event type: ${scheduled.type}`);
      }

      const planned = commitmentsByScheduledEvent.get(String(scheduled.id));
      if (planned === undefined) {
        throw new Error(`Missing concrete commitment for ${scheduled.id}`);
      }
      if (planned.dueAt !== scheduler.clock.now()) {
        throw new Error(`Commitment ${planned.id} executed at the wrong time`);
      }

      const fulfilled = fulfillCommitment(planned, scheduler.clock.now());
      commitmentsByScheduledEvent.delete(String(scheduled.id));
      const ownerKey = String(fulfilled.ownerId);
      fulfilledByOwner.set(ownerKey, (fulfilledByOwner.get(ownerKey) ?? 0) + 1);

      eventLog.append({
        id: asEventId(`fulfilled:${fulfilled.id}`),
        worldId: WORLD_ID,
        simTime: scheduler.clock.now(),
        type: "commitment.fulfilled",
        actorId: fulfilled.ownerId,
        payload: {
          commitmentId: String(fulfilled.id),
          routineId: fulfilled.routineId === undefined ? null : String(fulfilled.routineId),
          kind: fulfilled.kind,
        },
        correlationId: fulfilled.correlationId,
      });

      if (fulfilled.routineId === undefined) {
        throw new Error(`Routine commitment ${fulfilled.id} lost its routine id`);
      }
      const routine = routines.get(String(fulfilled.routineId));
      if (routine === undefined) {
        throw new Error(`Missing routine ${fulfilled.routineId}`);
      }
      scheduleNext(routine, fulfilled.dueAt);
    },
  );

  const agents = [...fulfilledByOwner.entries()]
    .map(([id, fulfilledCommitments]) => ({ id, fulfilledCommitments }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    seed,
    agentCount,
    finalSimTime: clock.now(),
    processedScheduledEvents,
    domainEventCount: eventLog.size,
    maxFutureQueueSize,
    agents,
  };
}
