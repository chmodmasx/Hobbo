# Implementation status

## Bootstrap completed

- [x] Public repository initialized.
- [x] Architecture baseline documented.
- [x] Procedural Sprite Forge architecture documented.
- [x] Baseline GGUF models locked with SHA256.
- [x] Verified model download script added.
- [x] Granite schema-constrained smoke test added.
- [x] Nomic embeddings smoke test added.
- [x] Monorepo workspace initialized.
- [x] GitHub Actions model smoke workflow green on `ubuntu-latest` with real Q4_K_M GGUFs.

### Verified model contract

- Cognition: Granite 4.1 3B Q4_K_M through pinned llama.cpp commit `6011c34ce6099646ccdf0d39a61c6e681477c178`.
- Schema-constrained decision returned `affordance_id=eat_owned_food` for the deterministic hunger fixture.
- Embeddings: Nomic Embed Text v2 MoE Q4_K_M through llama.cpp's OpenAI-compatible embeddings endpoint.
- Embedding dimensionality observed in CI: 768.
- Model weights and the pinned llama.cpp CPU build are restored from GitHub Actions cache on subsequent runs.

## Deterministic core completed

- [x] Domain types package.
- [x] Deterministic bigint world clock with no wall-clock dependency.
- [x] Canonical simulation-time unit: one integer tick equals one simulated second.
- [x] Stable scheduled-event priority queue and deterministic scheduler.
- [x] Domain-event envelope, append-only in-memory log and replay primitives.
- [x] Shared action registry/validator for player, rule, utility, LLM and replay origins.
- [x] Deterministic mock cognitive provider.
- [x] Replay cognitive provider that never silently re-infers missing decisions.
- [x] Deterministic seeded random stream with persistable state.
- [x] Property-based determinism/invariant tests.
- [x] Initial PostgreSQL migration for worlds, domain events, scheduled events and cognition runs.
- [x] PostgreSQL migration smoke test on a real PostgreSQL 17 service in GitHub Actions.
- [x] Strict TypeScript core CI green.

### Core invariants currently enforced

- Simulation time cannot move backwards.
- Events scheduled for the same simulation time execute in stable insertion order.
- Handlers may schedule additional work at the current simulation time without reordering earlier queued work.
- Event history uses contiguous sequence numbers and nondecreasing simulation time.
- Duplicate event and scheduled-event identifiers are rejected.
- Scheduler snapshot/restore preserves exact future execution order.
- Equal RNG seeds and restored RNG snapshots reproduce the exact same stream.
- Player and AI action requests pass through the same action validation rules.
- Cognitive providers cannot invent affordances not supplied by the simulation.
- Replay cognition fails on missing or no-longer-valid recorded decisions rather than calling a model.
- PostgreSQL rejects negative simulation time and invalid scheduler states.

## Persistence and crash-recovery gate completed

- [x] PostgreSQL repositories for world state, domain events, scheduled events and cognition runs.
- [x] Explicit JSONB serialization at the database boundary.
- [x] Transactional event-sequence and scheduler-ordinal allocation.
- [x] Concurrent scheduler workers use `FOR UPDATE SKIP LOCKED` without duplicate ownership.
- [x] Worker leases can be recovered after a stale `processing` claim.
- [x] Scheduled-event outcomes commit world-time advancement, domain events, future consequences and job completion atomically.
- [x] Failed outcome transactions leave no partial world-time or event-history mutations.
- [x] Crash/restart integration test opens a fresh PostgreSQL pool with no in-memory scheduler state and resumes deterministically.
- [x] Continuous and crash/restarted 10-step simulations produce identical event history and final world sequence/time.
- [x] Real PostgreSQL 17 integration suite green with 9/9 tests.

## Headless physiology gates completed

### Hunger / food / inventory

- [x] Minimal hunger/food/inventory domain slice.
- [x] Hunger integrated analytically from elapsed simulation time; no per-agent physiology tick.
- [x] Exact scheduled time for hunger threshold crossings, including fractional elapsed-rate progress.
- [x] Food consumption validated through the shared action registry.
- [x] Property-based tests for need bounds and threshold timing.
- [x] 20-agent, 30-simulated-day headless food fixture.
- [x] Same seed produces an identical final result; different seeds produce different deterministic populations.
- [x] Every headless meal creates a domain event and consumes exactly one owned inventory item.

### Sleep / energy

- [x] Analytical bounded energy state with explicit `awake` and `sleeping` modes.
- [x] Awake energy drain and sleeping recovery are integrated from elapsed simulation time without ticks.
- [x] Exact first-second scheduling for sleep and recovery thresholds.
- [x] `begin_sleep` and `wake_up` pass through the shared action registry.
- [x] Sleep desirability is intentionally not a hard action invariant; policy remains separate from physical possibility.
- [x] Property-based threshold tests and transition tests.
- [x] 20-agent, 30-simulated-day sleep fixture with deterministic repeated sleep/wake cycles.
- [x] Current CI: 34/34 non-integration tests across seven files plus 9/9 PostgreSQL integration tests.

These gates prove that the deterministic/event-driven simulation kernel can run small physiological populations coherently without a global NPC tick and can recover exactly from a worker/process crash. They do **not** yet prove coherent social lives, economy, memory, planning or LLM-driven behavior.

## Next implementation milestones

- [ ] Basic recurring routines and concrete commitments using scheduled events.
- [ ] Ledger economy, employment and housing foundations.
- [ ] Belief/perception and social-state foundations.
- [ ] Memory storage/retrieval and Nomic embedding integration.
- [ ] Ambiguous-choice cognition integration using mock/replay first, Granite second.
- [ ] 20-agent long-running social simulation gate.
- [ ] Minimal Sprite Forge Blender fixture.

The project should not begin large-scale visual/content work before the long-running social simulation gates are met.
