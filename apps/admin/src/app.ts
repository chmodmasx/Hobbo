import type { RequestListener, ServerResponse } from "node:http";
import {
  asPersonId,
  asWorldId,
  DomainInvariantError,
  type PersonId,
  type WorldId,
} from "@hobbo/domain";
import type {
  PersonTraceSnapshot,
  TracePageOptions,
} from "@hobbo/database";

export interface PersonTraceReader {
  inspectPerson(
    worldId: WorldId,
    personId: PersonId,
    options?: TracePageOptions,
  ): Promise<PersonTraceSnapshot | undefined>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  value: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(value);
}

function integerQuery(
  url: URL,
  name: string,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new DomainInvariantError(
      name + " must be a non-negative integer",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new DomainInvariantError(
      name + " must be a safe integer",
    );
  }
  return value;
}

function decodePathPart(value: string): string {
  const decoded = decodeURIComponent(value).trim();
  if (decoded.length === 0) {
    throw new DomainInvariantError("Trace path identifiers cannot be blank");
  }
  return decoded;
}

const INDEX_HTML = [
  "<!doctype html>",
  "<html lang='en'>",
  "<head>",
  "  <meta charset='utf-8'>",
  "  <meta name='viewport' content='width=device-width,initial-scale=1'>",
  "  <title>Hobbo Trace Inspector</title>",
  "  <style>",
  "    body { font: 14px system-ui, sans-serif; margin: 2rem; max-width: 1100px; }",
  "    form { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }",
  "    input { padding: .5rem; min-width: 16rem; }",
  "    button { padding: .5rem .9rem; }",
  "    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111; color: #eee; padding: 1rem; border-radius: .4rem; }",
  "    .hint { color: #666; }",
  "  </style>",
  "</head>",
  "<body>",
  "  <h1>Hobbo Trace Inspector</h1>",
  "  <p class='hint'>Read-only durable person trace. No simulation mutations are exposed here.</p>",
  "  <form id='trace-form'>",
  "    <input id='world' required placeholder='world id' autocomplete='off'>",
  "    <input id='person' required placeholder='person id' autocomplete='off'>",
  "    <input id='limit' type='number' min='1' max='100' value='50' aria-label='limit'>",
  "    <button type='submit'>Inspect</button>",
  "  </form>",
  "  <pre id='output'>Enter a world and person id.</pre>",
  "  <script>",
  "    const form = document.getElementById('trace-form');",
  "    const output = document.getElementById('output');",
  "    form.addEventListener('submit', async (event) => {",
  "      event.preventDefault();",
  "      const world = encodeURIComponent(document.getElementById('world').value);",
  "      const person = encodeURIComponent(document.getElementById('person').value);",
  "      const limit = encodeURIComponent(document.getElementById('limit').value);",
  "      output.textContent = 'Loading…';",
  "      try {",
  "        const response = await fetch('/api/worlds/' + world + '/persons/' + person + '/trace?limit=' + limit);",
  "        const data = await response.json();",
  "        output.textContent = JSON.stringify(data, null, 2);",
  "      } catch (error) {",
  "        output.textContent = String(error);",
  "      }",
  "    });",
  "  </script>",
  "</body>",
  "</html>",
].join("\n");

export function createAdminRequestHandler(
  traces: PersonTraceReader,
): RequestListener {
  return async (request, response) => {
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { error: "read-only admin: GET required" });
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", mode: "read-only" });
        return;
      }
      if (url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", INDEX_HTML);
        return;
      }

      const match =
        /^\/api\/worlds\/([^/]+)\/persons\/([^/]+)\/trace$/.exec(
          url.pathname,
        );
      if (match === null) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const worldPart = match[1];
      const personPart = match[2];
      if (worldPart === undefined || personPart === undefined) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const limit = integerQuery(url, "limit");
      const offset = integerQuery(url, "offset");
      const options: TracePageOptions = {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      };
      const snapshot = await traces.inspectPerson(
        asWorldId(decodePathPart(worldPart)),
        asPersonId(decodePathPart(personPart)),
        options,
      );
      if (snapshot === undefined) {
        sendJson(response, 404, { error: "world/person not found" });
        return;
      }
      sendJson(response, 200, snapshot);
    } catch (error) {
      if (
        error instanceof DomainInvariantError ||
        error instanceof URIError
      ) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const message =
        error instanceof Error ? error.message : "unknown inspector error";
      sendJson(response, 500, { error: message });
    }
  };
}
