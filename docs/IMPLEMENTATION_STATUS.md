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
- [x] Strict TypeScript core CI green with 27 tests across six test files.

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

## First headless physiology gate completed

- [x] Minimal hunger/food/inventory domain slice.
- [x] Hunger integrated analytically from elapsed simulation time; no per-agent physiology tick.
- [x] Exact scheduled time for hunger threshold crossings.
- [x] Food consumption validated through the shared action registry.
- [x] Property-based tests for need bounds and threshold timing.
- [x] 20-agent, 30-simulated-day headless fixture.
- [x] Same seed produces an identical final result; different seeds produce different deterministic populations.
- [x] Every headless meal creates a domain event and consumes exactly one owned inventory item.

This gate proves that the deterministic/event-driven simulation kernel can run a small physiological population coherently without a global NPC tick. It does **not** yet prove coherent social lives, economy, memory, planning or LLM-driven behavior.

## Next implementation milestones

- [ ] Persistence repositories/transactions over the core PostgreSQL schema.
- [ ] Persisted scheduler recovery and event-replay integration test.
- [ ] Sleep/energy physiology slice.
- [ ] Basic routines and commitments using scheduled events.
- [ ] Ledger economy, employment and housing foundations.
- [ ] Belief/perception and social-state foundations.
- [ ] Memory storage/retrieval and Nomic embedding integration.
- [ ] Ambiguous-choice cognition integration using mock/replay first, Granite second.
- [ ] 20-agent long-running social simulation gate.
- [ ] Minimal Sprite Forge Blender fixture.

The project should not begin large-scale visual/content work before the long-running social simulation gates are met.
