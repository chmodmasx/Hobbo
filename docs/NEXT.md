# Immediate next step

Build the first authoritative playable-human realtime multiplayer slice.

This milestone should prove that a browser player can join a running Hobbo world, submit the same validated action requests used by simulation-controlled people, and receive authoritative realtime state without making the client or render loop a source of world truth.

The first playable/realtime gate should:

- add a minimal `apps/server` HTTP/WebSocket entrypoint around the existing authoritative simulation/runtime packages;
- bind each connected player session to an existing world/person identity rather than creating a parallel player-only state model;
- route player intents through the shared action registry/validator before any world mutation;
- keep simulation time and scheduler semantics independent from wall-clock/network cadence;
- introduce only the smallest spatial state needed for a playable room: orthogonal `(x, y, z)` position plus facing/direction;
- keep isometric projection exclusively in `@hobbo/rendering`; the server never stores projected screen coordinates;
- render connected people in the existing PixiJS client using the generated Sprite Forge manifest/atlas;
- replicate authoritative bounded room state from server to clients and treat client-side interpolation/presentation as cosmetic only;
- prove two simultaneous browser/client sessions can inhabit the same tiny room and converge on the same authoritative state;
- include reconnect/retry identities that cannot duplicate an already-applied player action;
- add integration coverage for invalid actions, duplicate action retries, disconnect/reconnect and two-client state convergence;
- keep PostgreSQL authoritative for durable state and avoid introducing a second in-memory source of truth.

Do not add authentication/accounts, matchmaking, large maps, pathfinding, combat, character customization or broad city systems in this slice. The gate is only the smallest end-to-end path from human input → validated authoritative action → durable world state → realtime replication → PixiJS presentation.
