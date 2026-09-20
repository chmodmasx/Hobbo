# Immediate next step

Build the first integrated neighborhood vertical slice and playtest gate.

The architecture sequence is now complete through the optional World Director. The next phase should stop adding foundational subsystems and prove that the existing simulation, city, realtime, rendering and cognition stack works together as one coherent playable experience.

The first vertical-slice gate should:

- define one compact canonical neighborhood fixture using the existing room/building/street topology, active-area grids, housing, employment and social systems;
- include one human-controlled resident plus autonomous residents that keep using the same authoritative action/runtime paths;
- exercise a representative life loop through ordinary systems: move/travel, home, work, needs, social interaction, dialogue/memory and scheduled commitments;
- keep PostgreSQL as the only durable authority and preserve restart/reconnect/idempotency guarantees throughout the slice;
- render the neighborhood through the existing PixiJS/Sprite Forge path without introducing a second spatial or gameplay model in the client;
- expose enough read-only/debug trace context to explain why important NPC actions and World Director opportunities occurred;
- keep the World Director optional and disabled-by-default; enabling it may introduce bounded opportunities but may not be required for the base slice to function;
- add a reproducible seed/setup path so the same neighborhood can be recreated locally and in CI without hand-editing database state;
- add an end-to-end integration/playtest harness that proves the seeded neighborhood survives restart, player reconnect and continued simulation without divergent authoritative state;
- measure any obvious realtime/runtime bottlenecks encountered by the integrated slice before introducing new infrastructure.

Do not start broad content production, large maps, authentication/account systems, combat, character customization or a new simulation architecture in this gate. The goal is to turn the completed architecture into one small, coherent, inspectable playable neighborhood before expanding breadth.
