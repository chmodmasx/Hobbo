# Immediate next step

Expose the first player-facing life actions through the authoritative realtime path.

The integrated neighborhood is now validated end-to-end in a real Chromium browser: authoritative room rendering, local movement, hierarchical travel, runtime advancement, room reconciliation and reload persistence all use the production PostgreSQL/server/Vite/PixiJS path. The next gap is that a human player can navigate but cannot yet directly perform the life actions already implemented for the simulation.

The first player-life-action gate should:

- expose bounded read-only player physiology/inventory state needed by the UI, without turning the client into a state authority;
- route `inventory.consume_food`, `physiology.begin_sleep` and `physiology.wake_up` through their existing shared `ActionDefinition` validation with origin `player`;
- resolve action time from the authoritative world clock inside the mutation transaction; network requests must never advance simulation time;
- persist each accepted player action atomically with the person/body mutation, causal domain event and any replacement physiology schedule it requires;
- make exact `requestId` retries durable and idempotent across reconnect/restart, including proving food cannot be consumed twice;
- reject semantic reuse of a request ID and reject unavailable/invalid actions without mutating person state;
- keep NPC physiology on the existing scheduled-event path and prove player actions do not fork or disable autonomous behavior;
- add compact browser controls/status for Eat and Sleep/Wake driven by authoritative state rather than optimistic local mutation;
- extend the real Chromium neighborhood playtest to eat one owned food item, enter sleep, wake again and verify PostgreSQL plus the visible browser reconcile to the same result;
- retain the existing movement/travel browser coverage in the same final gate.

Do not add a second physiology model, client-side hunger/energy simulation, broad inventory UX, crafting, new sleep-location rules or unrelated content in this slice. If bed/location requirements are added later, they must become shared world/action rules for player and NPC paths rather than browser-only restrictions.
