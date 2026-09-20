# Hobbo admin trace inspector

Minimal local read-only surface over `PostgresTraceRepository`.

Run with the same PostgreSQL environment variables used by the simulation:

```bash
pnpm --filter @hobbo/admin start
```

The default listener is `127.0.0.1:3001`. Override the port with `HOBBO_ADMIN_PORT`.

Endpoints:

- `GET /` — minimal inspector page.
- `GET /health` — read-only health response.
- `GET /api/worlds/:worldId/persons/:personId/trace?limit=50&offset=0` — bounded durable trace.

No mutation endpoint is implemented. SQL remains inside `@hobbo/database`; the admin app only consumes the trace repository contract.
