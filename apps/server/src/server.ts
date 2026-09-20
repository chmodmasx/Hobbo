import { Pool } from "pg";
import { createHobboServer } from "./app.ts";

const pool = new Pool();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");

if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new RangeError("PORT must be an integer between 1 and 65535");
}

const server = createHobboServer({
  pool,
  rooms: [],
});

server.listen(port, host, () => {
  process.stdout.write(`Hobbo server listening on http://${host}:${port}\n`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  await pool.end();
}

process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
