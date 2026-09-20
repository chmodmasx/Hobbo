import { asWorldId } from "@hobbo/domain";
import { Pool } from "pg";
import {
  DEFAULT_NEIGHBORHOOD_WORLD_ID,
  seedIntegratedNeighborhood,
} from "./neighborhood-fixture.ts";

const pool = new Pool();
try {
  const configured = process.env.HOBBO_WORLD_ID?.trim();
  const seeded = await seedIntegratedNeighborhood(pool, {
    worldId:
      configured === undefined || configured.length === 0
        ? DEFAULT_NEIGHBORHOOD_WORLD_ID
        : asWorldId(configured),
  });
  process.stdout.write(
    JSON.stringify(
      {
        worldId: seeded.worldId,
        playerId: seeded.playerId,
        autonomousIds: seeded.autonomousIds,
        roomIds: seeded.roomIds,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}
