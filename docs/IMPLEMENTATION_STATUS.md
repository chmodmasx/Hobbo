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
- [x] Event append concurrency relies on the explicit world-row lock under `READ COMMITTED`; redundant `SERIALIZABLE` aborts were removed.

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

## Recurring routines and commitments completed

- [x] Generic periodic routine model expressed as `(period, phase)` rather than hardcoded calendar cases.
- [x] Concrete commitment model separated from the recurring template.
- [x] Daily, weekly and weekday-style schedules can be composed from the same primitive.
- [x] Only the next occurrence is materialized; recurring routines do not pre-fill the scheduler/database with years of future jobs.
- [x] 20-agent, 30-day routine fixture executes exactly 600 daily commitments while keeping at most 20 future jobs queued.
- [x] One-time commitments use the same scheduler path without inventing a recurrence.
- [x] PostgreSQL persistence for routine templates and concrete commitments.
- [x] Partial unique index guarantees at most one `planned` commitment per recurring routine.
- [x] Concurrent `materializeNext()` calls converge on the same concrete occurrence.
- [x] Fulfillment, domain-event append, scheduled-event completion and next-occurrence materialization are transactional.
- [x] Commitments may be fulfilled after their due time but never before it; recurring schedules stay anchored to the original phase rather than drifting after a late fulfillment.
- [x] Disabling a routine allows the already-materialized occurrence to resolve without generating another.
- [x] Destructive PostgreSQL integration fixtures are serialized at file level while explicit concurrency tests remain concurrent inside each test.

## Durable ledger economy completed

- [x] Money amounts use signed `bigint` minor units; floating point is not used for balances or postings.
- [x] Pure double-entry validation requires at least two non-zero lines whose signed sum is exactly zero.
- [x] Account balances are derived from immutable posted entries rather than a mutable `money` column.
- [x] PostgreSQL tables for ledger accounts, transactions and entries.
- [x] Deferred PostgreSQL constraint trigger prevents an unbalanced or cross-currency transaction from becoming `posted`.
- [x] Posted transactions and their entries are immutable, including against direct SQL mutation or appended lines.
- [x] Transfer repository locks affected accounts in stable ID order and checks source balance after acquiring the lock.
- [x] Non-negative accounts cannot be concurrently double-spent; only one conflicting payment can succeed.
- [x] System/credit-style accounts may explicitly allow negative balances instead of bypassing the ledger.
- [x] `(world_id, idempotency_key)` is unique and additionally serialized by an advisory transaction lock.
- [x] Same idempotency key + same semantic transfer returns the original posted transaction even from a fresh PostgreSQL pool.
- [x] Same idempotency key + changed amount/account/time/currency/type is rejected.
- [x] Currency mismatches are rejected before posting.
- [x] Migration `0003_ledger.sql`, SQL smoke checks and six real PostgreSQL ledger integration cases are green.

## Employment and crash-safe salary posting completed

- [x] Persistent employment contracts bind employer, employee, payroll accounts, currency, wage, start time and recurring work routine.
- [x] Employment terms validate distinct parties/accounts, positive integer wages and valid `(period, phase)` work schedules.
- [x] Contract creation, work-routine creation and first concrete shift materialization commit atomically.
- [x] Work shifts reuse the generic recurring commitment/scheduler path; employment does not introduce a second scheduler.
- [x] Completing a work shift and salary posting are intentionally a re-entrant saga rather than one oversized transaction.
- [x] Shift fulfillment remains durable even if payroll subsequently fails; a worker's completed work is never rolled back by employer insolvency.
- [x] Salary transaction IDs and idempotency keys are derived deterministically from `(employment, concrete shift)`.
- [x] A crash after shift fulfillment but before salary posting can resume from a fresh PostgreSQL pool and post exactly one salary.
- [x] A crash/retry after salary posting returns the original ledger transaction rather than paying twice.
- [x] Employer insolvency leaves the fulfilled shift and next work commitment intact, creates no partial salary transaction, and can be paid later by retry.
- [x] Payroll account currency mismatch aborts contract creation without leaving a routine or commitment behind.
- [x] Migration `0004_employment.sql`, SQL smoke checks and five real PostgreSQL employment integration cases are green.

## Housing, tenancy and crash-safe rent completed

- [x] Housing units are persistent world entities separate from tenancy contracts.
- [x] Housing ownership is explicit and tenancy landlords must match the unit owner.
- [x] PostgreSQL guarantees at most one active tenancy per housing unit.
- [x] Tenancy creation, rent routine creation and first concrete rent commitment commit atomically.
- [x] Rent uses the generic recurring commitment/scheduler path rather than introducing another scheduler.
- [x] Rent payment is posted before commitment fulfillment, so insufficient funds never falsely mark an obligation as fulfilled.
- [x] Overdue rent may be settled after its due time without shifting the periodic rent phase.
- [x] A worker that does not own the claimed scheduler job is rejected before any money moves.
- [x] A crash after rent payment but before fulfillment can recover from a fresh PostgreSQL pool; ledger idempotency prevents a second charge.
- [x] Tenant insolvency leaves the rent commitment planned and creates no partial rent transfer; later funding allows the same obligation to settle.
- [x] Migration `0005_housing.sql`, SQL smoke checks and five real PostgreSQL housing integration cases are green.

## Private beliefs and social-state foundations completed

- [x] Objective world truth remains owned by authoritative domain systems; the social layer does not duplicate it in a generic truth table.
- [x] Perceptions are append-oriented evidence records with direct, reported or inferred channels.
- [x] Recording a perception does not automatically alter a person's belief.
- [x] Contradictory evidence can coexist without rewriting history.
- [x] Beliefs are private current-state records scoped by holder, subject and predicate.
- [x] A belief cannot cite another observer's private perception as its evidence source.
- [x] Exact perception and belief retries are idempotent; semantic reuse of the same identity with changed content is rejected.
- [x] Belief updates reject stale simulation timestamps and conflicting revisions at the same timestamp.
- [x] `learnedAt` is immutable after first persistence.
- [x] Relationships are directional multidimensional integer vectors for familiarity, trust, affection, respect, attraction, fear, resentment and dependency.
- [x] Relationship effects use durable `effectId` identities, making crash/retry application idempotent across fresh PostgreSQL pools.
- [x] Effects on the same directed relationship are serialized, preventing lost concurrent updates.
- [x] Effects older than the persisted relationship state are rejected and never recorded.
- [x] Migration `0006_social_beliefs.sql`, SQL smoke checks and seven real PostgreSQL social integration cases are green.

### Current CI gate

- [x] TypeScript typecheck green across the workspace.
- [x] 60/60 non-integration tests green across 13 files.
- [x] 37/37 PostgreSQL integration tests green across 7 files on PostgreSQL 17.
- [x] Database migrations `0001` through `0006` plus all SQL smoke checks green.

These gates prove that the deterministic/event-driven kernel can run small physiological populations, recover exactly from worker/process crashes, maintain durable recurring or one-time commitments, conserve money under concurrent spending, model employment and housing with crash-safe exactly-once financial effects, and maintain private beliefs plus directional social state without conflating them with objective world truth. They do **not** yet prove durable autobiographical memory, semantic retrieval, long-term planning, rich conversations/rumor propagation, LLM-driven ambiguous behavior or coherent long-running social lives.

## Next implementation milestones

- [ ] Memory storage/retrieval and Nomic embedding integration.
- [ ] Ambiguous-choice cognition integration using mock/replay first, Granite second.
- [ ] Conversation memory and information/rumor propagation.
- [ ] 20-agent long-running social simulation gate.
- [ ] Minimal Sprite Forge Blender fixture.

The project should not begin large-scale visual/content work before the long-running social simulation gates are met.
