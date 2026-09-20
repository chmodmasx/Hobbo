import { createServer } from "node:http";
import { Pool } from "pg";
import { PostgresTraceRepository } from "@hobbo/database";
import { createAdminRequestHandler } from "./app.ts";

function adminPort(): number {
  const raw = process.env.HOBBO_ADMIN_PORT ?? "3001";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error("HOBBO_ADMIN_PORT must be an integer from 1 to 65535");
  }
  return value;
}

const pool = new Pool();
const traces = new PostgresTraceRepository(pool);
const server = createServer(createAdminRequestHandler(traces));
const port = adminPort();

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    "Hobbo read-only trace inspector: http://127.0.0.1:" + port + "\n",
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
