import {
  createEnergyState,
  createFoodItem,
  createHungerState,
  type PersonState,
} from "@hobbo/agents";
import {
  PostgresEmploymentRepository,
  PostgresHousingRepository,
  PostgresLedgerRepository,
  PostgresPersonRepository,
  PostgresSpatialRepository,
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  DomainInvariantError,
  SIM_DAY,
  SIM_HOUR,
  asEmploymentId,
  asEntityId,
  asHousingUnitId,
  asLedgerAccountId,
  asLedgerTransactionId,
  asPersonId,
  asTenancyId,
  asWorldId,
  simDuration,
  simTime,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import { CoreWorldRuntime } from "@hobbo/runtime";
import type { Pool } from "pg";

export const DEFAULT_NEIGHBORHOOD_WORLD_ID =
  asWorldId("integrated-neighborhood-v1");
export const NEIGHBORHOOD_PLAYER_ID = asPersonId("resident-alex");
export const NEIGHBORHOOD_AUTONOMOUS_IDS = [
  asPersonId("resident-bea"),
  asPersonId("resident-carlos"),
  asPersonId("resident-dina"),
] as const;

export const NEIGHBORHOOD_ROOM_IDS = {
  flatA: "room-flat-a",
  flatB: "room-flat-b",
  cafe: "room-cafe",
} as const;

export interface SeedIntegratedNeighborhoodOptions {
  readonly worldId?: WorldId;
}

export interface SeededIntegratedNeighborhood {
  readonly worldId: WorldId;
  readonly playerId: PersonId;
  readonly autonomousIds: readonly PersonId[];
  readonly residentIds: readonly PersonId[];
  readonly roomIds: typeof NEIGHBORHOOD_ROOM_IDS;
}

function resident(id: PersonId, index: number): PersonState {
  return {
    id,
    hunger: createHungerState(
      900 + index * 180,
      simTime(0),
      520 + index * 20,
    ),
    energy: createEnergyState(
      8_800 - index * 250,
      simTime(0),
      360 + index * 10,
      1_800,
      "awake",
    ),
    inventory: Array.from({ length: 10 }, (_, mealIndex) =>
      createFoodItem(
        `${id}:meal-${String(mealIndex + 1).padStart(2, "0")}`,
        "Prepared neighborhood meal",
        6_500,
      ),
    ),
    mealsEaten: 0,
    sleepSessions: 0,
  };
}

export async function seedIntegratedNeighborhood(
  pool: Pool,
  options: SeedIntegratedNeighborhoodOptions = {},
): Promise<SeededIntegratedNeighborhood> {
  const worldId = options.worldId ?? DEFAULT_NEIGHBORHOOD_WORLD_ID;
  const worlds = new PostgresWorldRepository(pool);
  if ((await worlds.get(worldId)) !== undefined) {
    throw new DomainInvariantError(
      `Integrated neighborhood world already exists: ${worldId}`,
    );
  }

  const residents = [
    NEIGHBORHOOD_PLAYER_ID,
    ...NEIGHBORHOOD_AUTONOMOUS_IDS,
  ] as const;
  const people = new PostgresPersonRepository(pool);
  const spatial = new PostgresSpatialRepository(pool);
  const ledger = new PostgresLedgerRepository(pool);
  const housing = new PostgresHousingRepository(pool);
  const employment = new PostgresEmploymentRepository(pool);
  const runtime = new CoreWorldRuntime(pool);

  await worlds.create(worldId, simTime(0));

  for (let index = 0; index < residents.length; index += 1) {
    const personId = residents[index];
    if (personId === undefined) continue;
    await people.create({
      worldId,
      person: resident(personId, index),
      at: simTime(0),
    });
  }

  await runtime.city.seedTopology({
    worldId,
    nodes: [
      {
        id: "building-residential",
        kind: "building",
        label: "Maple Apartments",
      },
      {
        id: NEIGHBORHOOD_ROOM_IDS.flatA,
        kind: "room",
        parentId: "building-residential",
        label: "Flat A",
      },
      {
        id: NEIGHBORHOOD_ROOM_IDS.flatB,
        kind: "room",
        parentId: "building-residential",
        label: "Flat B",
      },
      {
        id: "street-main",
        kind: "street",
        label: "Main Street",
      },
      {
        id: "building-cafe",
        kind: "building",
        label: "Corner Cafe",
      },
      {
        id: NEIGHBORHOOD_ROOM_IDS.cafe,
        kind: "room",
        parentId: "building-cafe",
        label: "Cafe Floor",
      },
    ],
    connections: [
      {
        id: "flat-a-door",
        fromNodeId: NEIGHBORHOOD_ROOM_IDS.flatA,
        toNodeId: "building-residential",
        travelSeconds: 5,
        bidirectional: true,
      },
      {
        id: "flat-b-door",
        fromNodeId: NEIGHBORHOOD_ROOM_IDS.flatB,
        toNodeId: "building-residential",
        travelSeconds: 5,
        bidirectional: true,
      },
      {
        id: "residential-main",
        fromNodeId: "building-residential",
        toNodeId: "street-main",
        travelSeconds: 20,
        bidirectional: true,
      },
      {
        id: "main-cafe",
        fromNodeId: "street-main",
        toNodeId: "building-cafe",
        travelSeconds: 30,
        bidirectional: true,
      },
      {
        id: "cafe-door",
        fromNodeId: "building-cafe",
        toNodeId: NEIGHBORHOOD_ROOM_IDS.cafe,
        travelSeconds: 5,
        bidirectional: true,
      },
    ],
    rooms: [
      {
        bounds: {
          roomId: NEIGHBORHOOD_ROOM_IDS.flatA,
          minX: 0,
          maxX: 5,
          minY: 0,
          maxY: 5,
          z: 0,
        },
      },
      {
        bounds: {
          roomId: NEIGHBORHOOD_ROOM_IDS.flatB,
          minX: 8,
          maxX: 13,
          minY: 0,
          maxY: 5,
          z: 0,
        },
      },
      {
        bounds: {
          roomId: NEIGHBORHOOD_ROOM_IDS.cafe,
          minX: 20,
          maxX: 27,
          minY: 0,
          maxY: 7,
          z: 0,
        },
        blockedTiles: [{ x: 24, y: 3, z: 0 }],
      },
    ],
    resources: [
      {
        id: "bed-alex",
        roomId: NEIGHBORHOOD_ROOM_IDS.flatA,
        kind: "bed",
        capacity: 1,
        x: 1,
        y: 1,
        z: 0,
      },
      {
        id: "beds-flat-b",
        roomId: NEIGHBORHOOD_ROOM_IDS.flatB,
        kind: "bed",
        capacity: 3,
        x: 9,
        y: 1,
        z: 0,
      },
      {
        id: "cafe-table",
        roomId: NEIGHBORHOOD_ROOM_IDS.cafe,
        kind: "seat",
        capacity: 4,
        x: 22,
        y: 2,
        z: 0,
      },
    ],
  });

  const placements = [
    {
      personId: NEIGHBORHOOD_PLAYER_ID,
      roomId: NEIGHBORHOOD_ROOM_IDS.flatA,
      x: 2,
      y: 2,
      facing: "E" as const,
    },
    {
      personId: NEIGHBORHOOD_AUTONOMOUS_IDS[0],
      roomId: NEIGHBORHOOD_ROOM_IDS.flatB,
      x: 9,
      y: 2,
      facing: "S" as const,
    },
    {
      personId: NEIGHBORHOOD_AUTONOMOUS_IDS[1],
      roomId: NEIGHBORHOOD_ROOM_IDS.flatB,
      x: 10,
      y: 2,
      facing: "W" as const,
    },
    {
      personId: NEIGHBORHOOD_AUTONOMOUS_IDS[2],
      roomId: NEIGHBORHOOD_ROOM_IDS.flatB,
      x: 11,
      y: 2,
      facing: "N" as const,
    },
  ];
  for (const placement of placements) {
    await spatial.place({
      worldId,
      personId: placement.personId,
      roomId: placement.roomId,
      x: placement.x,
      y: placement.y,
      z: 0,
      facing: placement.facing,
      at: simTime(0),
    });
  }

  const systemAccount = asLedgerAccountId("neighborhood-system");
  const landlordAccount = asLedgerAccountId("neighborhood-landlord-wallet");
  const employerAccount = asLedgerAccountId("neighborhood-cafe-wallet");
  await ledger.createAccount({
    id: systemAccount,
    worldId,
    currency: "HBC",
    kind: "system",
    allowNegative: true,
    label: "Neighborhood bootstrap source",
  });
  await ledger.createAccount({
    id: landlordAccount,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "business-landlord",
    label: "Maple Apartments",
  });
  await ledger.createAccount({
    id: employerAccount,
    worldId,
    currency: "HBC",
    kind: "asset",
    allowNegative: false,
    ownerId: "business-cafe",
    label: "Corner Cafe",
  });

  const residentWallets = new Map<PersonId, ReturnType<typeof asLedgerAccountId>>();
  for (const personId of residents) {
    const wallet = asLedgerAccountId(`wallet:${personId}`);
    residentWallets.set(personId, wallet);
    await ledger.createAccount({
      id: wallet,
      worldId,
      currency: "HBC",
      kind: "asset",
      allowNegative: false,
      ownerId: String(personId),
      label: `${personId} wallet`,
    });
  }

  await ledger.transfer({
    worldId,
    transactionId: asLedgerTransactionId("bootstrap:cafe"),
    simTime: simTime(0),
    currency: "HBC",
    fromAccountId: systemAccount,
    toAccountId: employerAccount,
    amount: 100_000n,
    idempotencyKey: "bootstrap:cafe",
    type: "bootstrap.funding",
  });
  for (const personId of residents) {
    const wallet = residentWallets.get(personId);
    if (wallet === undefined) {
      throw new DomainInvariantError(
        `Missing wallet while seeding resident ${personId}`,
      );
    }
    const key = `bootstrap:resident:${personId}`;
    await ledger.transfer({
      worldId,
      transactionId: asLedgerTransactionId(key),
      simTime: simTime(0),
      currency: "HBC",
      fromAccountId: systemAccount,
      toAccountId: wallet,
      amount: 10_000n,
      idempotencyKey: key,
      type: "bootstrap.funding",
    });
  }

  for (let index = 0; index < residents.length; index += 1) {
    const personId = residents[index];
    if (personId === undefined) continue;
    const wallet = residentWallets.get(personId);
    if (wallet === undefined) {
      throw new DomainInvariantError(
        `Missing wallet while creating resident commitments: ${personId}`,
      );
    }
    const unitId = asHousingUnitId(`unit:${personId}`);
    await housing.createUnit({
      id: unitId,
      worldId,
      ownerId: asEntityId("business-landlord"),
      label: `Maple lease for ${personId}`,
    });
    await housing.createTenancy({
      id: asTenancyId(`tenancy:${personId}`),
      worldId,
      housingUnitId: unitId,
      landlordId: asEntityId("business-landlord"),
      tenantId: asEntityId(String(personId)),
      landlordAccountId: landlordAccount,
      tenantAccountId: wallet,
      currency: "HBC",
      rentPerPeriod: 1_200n,
      rentPeriod: simDuration(BigInt(SIM_DAY) * 30n),
      rentPhase: simDuration(BigInt(SIM_DAY) * 5n + BigInt(SIM_HOUR) * BigInt(index)),
      startsAt: simTime(0),
    });
    await employment.create({
      id: asEmploymentId(`cafe-job:${personId}`),
      worldId,
      employerId: asEntityId("business-cafe"),
      employeeId: asEntityId(String(personId)),
      employerAccountId: employerAccount,
      employeeAccountId: wallet,
      currency: "HBC",
      wagePerShift: 250n,
      workPeriod: simDuration(SIM_DAY),
      workPhase: simDuration(BigInt(SIM_HOUR) * BigInt(8 + index)),
      startsAt: simTime(0),
    });
    await runtime.scheduleInitialPhysiology(worldId, personId, simTime(0));
  }

  for (let index = 0; index < NEIGHBORHOOD_AUTONOMOUS_IDS.length; index += 1) {
    const personId = NEIGHBORHOOD_AUTONOMOUS_IDS[index];
    if (personId === undefined) continue;
    await runtime.seedSocialClaim(
      worldId,
      asEntityId(String(personId)),
      simTime(0),
      {
        subjectId: "business-cafe",
        predicate: "is_gathering_place",
        value: true,
        confidenceBps: 8_500,
        origin: "direct",
      },
    );
    await runtime.scheduleInitialSocial(
      worldId,
      personId,
      simTime(BigInt(SIM_HOUR) + BigInt(index) * 900n),
    );
    await runtime.scheduleInitialPlanning(
      worldId,
      personId,
      simTime(BigInt(SIM_HOUR) * 2n + BigInt(index) * 900n),
    );
  }

  return {
    worldId,
    playerId: NEIGHBORHOOD_PLAYER_ID,
    autonomousIds: [...NEIGHBORHOOD_AUTONOMOUS_IDS],
    residentIds: [...residents],
    roomIds: NEIGHBORHOOD_ROOM_IDS,
  };
}
