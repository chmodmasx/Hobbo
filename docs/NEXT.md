# Immediate next step

Close the first integrated neighborhood vertical slice with a real browser-level playtest.

The canonical neighborhood seed, authoritative server path, restart-safe 12-hour simulation playtest and PixiJS client build are now in place. The remaining gap is to prove the actual browser client can connect to the seeded PostgreSQL world, render authoritative room state, send player actions and survive authoritative room transitions without a test-only client standing in for the browser.

The browser-playtest gate should:

- launch the canonical `integrated-neighborhood-v1` seed through the documented production repository path;
- start the normal authoritative server and the normal Vite/PixiJS client entrypoint;
- use a real browser automation harness against the rendered client rather than substituting a raw WebSocket test client;
- prove `resident-alex` initially renders in `room-flat-a` from authoritative `room.state`;
- perform at least one local movement action through the visible client controls and confirm PostgreSQL remains authoritative;
- plan travel to the Corner Cafe through the visible client UI, advance the authoritative runtime and verify the browser reconciles into `room-cafe`;
- reconnect/reload the browser after travel and prove it binds to the persisted destination without duplicating the request;
- verify the generated Sprite Forge atlas/manifest loads in the browser and that rendering still uses logical coordinates plus isometric projection only;
- surface enough visible/debug state to make failed browser-playtest assertions diagnosable without exposing raw model prompts/responses;
- keep this gate deterministic and CI-runnable with the same seed and PostgreSQL migrations used locally.

Do not add another simulation subsystem, large-map content, authentication, combat or broad production content in this gate. The goal is to close the gap between the already-green server/runtime playtest and the actual playable browser experience.
