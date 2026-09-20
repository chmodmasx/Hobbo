# Hobbo authoritative server slice

This is the first playable/realtime transport around the existing simulation authority.

- HTTP is read-only in this slice (`/health` and bounded room state).
- WebSocket sessions bind directly to an existing `worldId + personId + roomId`.
- Player actions use the shared `ActionRegistry` through the durable spatial repository.
- PostgreSQL owns position/facing and idempotent player-action receipts.
- Network cadence never advances simulation time.
- Projected/isometric coordinates never enter server state.

Default fixture room: `fixture-room`, logical bounds `0..7 × 0..7`, `z=0`.

WebSocket endpoint:

```text
/realtime?worldId=<world>&personId=<person>&roomId=fixture-room
```
