# Hobbo realtime client

PixiJS renders the authoritative room snapshot; the client does not own gameplay state.

The browser loads the generated Sprite Forge atlas/manifest from:

```text
/public/sprite-forge/
```

and connects to the Hobbo WebSocket server. Session identity comes from query parameters:

```text
?worldId=playable-world&personId=player-alice
```

When Vite and the server run on different ports, pass the WebSocket endpoint explicitly:

```text
?server=ws://127.0.0.1:3000/realtime&worldId=playable-world&personId=player-alice
```

Movement buttons and arrow/WASD keys send `spatial.move` requests. The travel selector is populated from the server's authoritative topology and sends `spatial.travel` through the same player-action channel. The room is resolved from PostgreSQL on connect/reconnect; `roomId` may still be supplied as an optional expected-room check.

Unacknowledged request IDs remain pending and are resent unchanged after reconnect, relying on durable server-side idempotency rather than client-side authority.

Isometric projection, anchors, frame lookup and depth sorting remain in `@hobbo/rendering`; the network only transports logical `(x, y, z)` positions plus facing.
