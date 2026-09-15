import type { Pool, PoolClient } from "pg";

export type TransactionIsolation =
  | "read committed"
  | "repeatable read"
  | "serializable";

const ISOLATION_SQL: Record<TransactionIsolation, string> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  isolation: TransactionIsolation = "serializable",
): Promise<T> {
  const client = await pool.connect();
  let began = false;

  try {
    await client.query(`BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolation]}`);
    began = true;
    const result = await operation(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        if (error instanceof Error) {
          Object.defineProperty(error, "rollbackError", {
            value: rollbackError,
            enumerable: false,
          });
        }
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
