import {
  PostgresWorldRepository,
} from "@hobbo/database";
import {
  asWorldId,
  simTime,
} from "@hobbo/domain";
import { CoreWorldRuntime } from "@hobbo/runtime";
import { Pool } from "pg";

const worldRaw = process.env.HOBBO_WORLD_ID?.trim();
const throughRaw = process.env.HOBBO_THROUGH?.trim();
if (worldRaw === undefined || worldRaw.length === 0) {
  throw new Error("HOBBO_WORLD_ID is required");
}
if (throughRaw === undefined || throughRaw.length === 0) {
  throw new Error("HOBBO_THROUGH is required");
}

const maxEventsRaw = process.env.HOBBO_MAX_EVENTS?.trim();
const maxEvents =
  maxEventsRaw === undefined || maxEventsRaw.length === 0
    ? undefined
    : Number(maxEventsRaw);
if (
  maxEvents !== undefined &&
  (!Number.isSafeInteger(maxEvents) || maxEvents <= 0)
) {
  throw new RangeError("HOBBO_MAX_EVENTS must be a positive safe integer");
}

const worldId = asWorldId(worldRaw);
const through = simTime(throughRaw);
const pool = new Pool();
try {
  const runtime = new CoreWorldRuntime(pool);
  const processed = await runtime.processThrough({
    worldId,
    through,
    workerId: "cli:advance-world",
    ...(maxEvents === undefined ? {} : { maxEvents }),
  });
  const world = await new PostgresWorldRepository(pool).get(worldId);
  if (world === undefined) {
    throw new Error(`World disappeared while advancing: ${worldId}`);
  }
  process.stdout.write(
    JSON.stringify(
      {
        worldId,
        requestedThrough: through.toString(),
        currentSimTime: world.currentSimTime.toString(),
        processedEvents: processed,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}
