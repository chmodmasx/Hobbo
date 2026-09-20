# Immediate next step

Build the first hierarchical larger-city spatial slice.

This milestone should extend the now-playable authoritative room into a small connected world without turning every inhabitant into a frame-ticked pathfinding agent.

The first city-systems gate should:

- add durable spatial topology for rooms, buildings and streets with stable IDs and explicit traversable connections;
- keep person positions authoritative as logical world state and keep isometric projection presentation-only;
- add a small active-area tile grid for local movement while retaining a higher-level graph for travel between rooms/buildings/streets;
- plan long-distance movement hierarchically: global graph route first, local tile path only inside active areas;
- express background travel through scheduled departure/arrival consequences rather than realtime per-person ticks;
- add durable capacity/reservation primitives for interactables such as seats and beds, with concurrent claims serialized safely;
- route player and NPC navigation through shared action/validation contracts rather than client-only movement rules;
- persist route/travel intent strongly enough that disconnect/restart cannot teleport, duplicate or lose an in-progress trip;
- expose bounded room/topology state to the realtime client so room transitions come from authoritative server state;
- prove a compact fixture containing multiple rooms, at least two buildings and a connecting street;
- gate deterministic route choice, blocked/unreachable destinations, reservation contention, crash/restart during travel and arrival into a different realtime room;
- preserve simulation LOD: dormant/macro inhabitants should not require local tile pathfinding until they become spatially active.

Do not build a procedurally generated city, traffic simulation, combat, vehicles, broad content production or the optional World Director in this slice. The goal is the smallest durable hierarchy that proves room → building → street → building → room travel and capacity reservations.
