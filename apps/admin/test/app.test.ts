import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PersonId, WorldId } from "@hobbo/domain";
import {
  createAdminRequestHandler,
  type PersonTraceReader,
} from "../src/app.ts";

interface TraceCall {
  readonly worldId: WorldId;
  readonly personId: PersonId;
  readonly options: {
    readonly limit?: number;
    readonly offset?: number;
  };
}

const calls: TraceCall[] = [];
const reader: PersonTraceReader = {
  async inspectPerson(worldId, personId, options = {}) {
    calls.push({ worldId, personId, options });
    return undefined;
  },
};

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer(createAdminRequestHandler(reader));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
});

describe("read-only admin trace HTTP contract", () => {
  it("serves health without touching trace storage", async () => {
    const response = await fetch(baseUrl + "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      mode: "read-only",
    });
    expect(calls).toEqual([]);
  });

  it("rejects mutation methods before repository access", async () => {
    const response = await fetch(
      baseUrl + "/api/worlds/world-a/persons/person-a/trace",
      { method: "POST" },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(calls).toEqual([]);
  });

  it("decodes identifiers and delegates bounded pagination", async () => {
    const response = await fetch(
      baseUrl +
        "/api/worlds/world%20alpha/persons/person%2Falpha/trace?limit=2&offset=1",
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([
      {
        worldId: "world alpha",
        personId: "person/alpha",
        options: { limit: 2, offset: 1 },
      },
    ]);
  });

  it("rejects malformed pagination without repository access", async () => {
    const response = await fetch(
      baseUrl +
        "/api/worlds/world-a/persons/person-a/trace?limit=not-a-number",
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
