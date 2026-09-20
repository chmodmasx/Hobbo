# Immediate next step

Build the first read-only admin/trace inspector over Hobbo's durable simulation state.

This milestone should make the already-proven causal model observable without introducing a second source of truth.

The first inspector slice should:

- add a reusable read-only trace query layer rather than issuing ad-hoc SQL from UI code;
- inspect one world/person at a time;
- expose the current persisted person/body state plus inventory summary;
- show recent domain events involving the person as actor or target, preserving sequence, sim time, causation and correlation IDs;
- show outstanding scheduled events that reserve the person through durable affinity keys;
- show private beliefs, recent memories, directional relationships and recent conversation messages visible in persisted state;
- show cognition runs for that person with provider/model, replay status/decision and request-hash provenance, without requiring model re-inference;
- provide bounded pagination/limits so the inspector cannot accidentally dump an entire world;
- add a minimal local admin surface/API that is strictly read-only;
- prove through PostgreSQL integration tests that the assembled trace is stable, ordered and world/person isolated.

Keep PostgreSQL authoritative. The inspector must not mutate simulation state, complete jobs, requeue leases or call Granite/Nomic.

Do not build the playable Pixi/React client in this slice. This is observability tooling needed before the 100 → 500 → 1000 → 10000 population scale gates.
