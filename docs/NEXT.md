# Immediate next step

Build the durable population scale ladder: 100 → 500 → 1000 → 10000 persisted people.

This gate must measure Hobbo's real PostgreSQL scheduler/runtime path, not the old in-memory benchmark loops and not a second simulator.

The first scale slice should deliberately model LOD-style background population rather than pretending that 10,000 people are all in LOD 4/5 simultaneously:

- seed each tier as real `persons` + `person_physiology` rows in PostgreSQL;
- give every person one same-frontier durable scheduled event with its own entity affinity key;
- execute those events through `CoreWorldRuntime` / `DurableScheduledEventWorker` with multiple workers;
- commit one real domain event per processed person through the normal atomic scheduled-outcome boundary;
- verify exact person count, scheduler completion/attempt counts, contiguous domain-event sequence growth, world-time advancement and zero outstanding leases;
- verify `PostgresPersonRepository.listIds()` remains deterministic at 10,000 people;
- sample the read-only trace inspector after the run to prove one person's causal trace stays bounded and world-local at population scale;
- report bootstrap/scheduling/processing/verification timings as CI metrics, but use the workflow timeout rather than a fragile millisecond assertion as the performance ceiling;
- run 100, 500, 1000 and 10000 as isolated PostgreSQL matrix jobs so one tier cannot contaminate another;
- keep the 10,000-person gate free of Granite/Nomic calls and O(N²) relationship seeding.

Do not claim that this proves 10,000 simultaneous detailed/social/cognitive agents. It proves the intended event-driven dormant/macro population substrate at 10,000 durable people. Higher-LOD density gets separate measured gates later.

After this ladder is green, move to Sprite Forge/PixiJS isometric renderer integration.
