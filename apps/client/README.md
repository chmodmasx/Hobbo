# Hobbo realtime client

PixiJS renders the authoritative room snapshot; the client does not own gameplay state.

The browser loads the generated Sprite Forge atlas/manifest from:

```text
/public/sprite-forge/
```

and connects to the Hobbo WebSocket server. Session identity comes from query parameters:

```text
?worldId=playable-world&personId=player-alice&roomId=fixture-room
```

When Vite and the server run on different ports, pass the WebSocket endpoint explicitly:

```text
?server=ws://127.0.0.1:3000/realtime&worldId=playable-world&personId=player-alice&roomId=fixture-room
```

Movement buttons and arrow/WASD keys send `spatial.move` requests. Unacknowledged request IDs remain pending and are resent unchanged after reconnect, relying on the server's durable idempotency receipt rather than client-side authority.

Isometric projection, anchors, frame lookup and depth sorting remain in `@hobbo/rendering`; the network only transports logical `(x, y, z)` positions plus facing.
