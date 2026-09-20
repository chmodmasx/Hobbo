# Hobbo authoritative server slice

This server is the authoritative realtime transport around the durable simulation.

- HTTP world/room/spatial endpoints are read-only.
- WebSocket sessions bind directly to an existing `worldId + personId`.
- Player actions use the shared `ActionRegistry` through durable repositories.
- PostgreSQL owns position/facing, topology, travel and idempotent action receipts.
- Network cadence never advances simulation time.
- Projected/isometric coordinates never enter server state.
- Production startup no longer defines an in-memory fallback room; room bounds/topology come from PostgreSQL.

## Integrated neighborhood local seed

After applying the repository migrations to the configured PostgreSQL database, create the canonical vertical-slice world:

```bash
pnpm --filter @hobbo/server seed:neighborhood
```

The default seed creates:

- world `integrated-neighborhood-v1`;
- player resident `resident-alex`;
- three autonomous residents;
- two residential rooms plus the Corner Cafe and connecting street/building topology;
- durable spatial positions/resources;
- HBC wallets/funding;
- one active tenancy and cafe employment per resident;
- physiology schedules for everyone;
- initial social/planning work for autonomous residents only.

The seed intentionally refuses to overwrite an existing world with the same ID. Set `HOBBO_WORLD_ID` to create the same canonical fixture under another world ID.

Start the server:

```bash
pnpm --filter @hobbo/server start
```

The browser client defaults to the canonical world/person. When Vite is running separately from the server, point it at the WebSocket endpoint explicitly:

```text
http://127.0.0.1:5173/?server=ws://127.0.0.1:3000/realtime
```

World/person/room can still be overridden with `worldId`, `personId` and `roomId` query parameters.

WebSocket endpoint:

```text
/realtime?worldId=<world>&personId=<person>[&roomId=<optional-room>]
```
