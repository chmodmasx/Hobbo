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
- The production `GraniteCognitiveProvider` is exercised against the real llama.cpp + Granite GGUF path in model CI, not only mocked HTTP.
- Embeddings: Nomic Embed Text v2 MoE Q4_K_M through llama.cpp's OpenAI-compatible embeddings endpoint.
- `NomicEmbeddingProvider` is exercised against the real llama.cpp + GGUF path in model CI rather than only against mocked HTTP.
- Query/document prefixing uses `search_query:` and `search_document:` respectively.
- Embedding dimensionality observed and enforced in CI: 768.
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
- [x] Scheduler claims are constrained to the global earliest unresolved simulation-time frontier across both `pending` and `processing` work.
- [x] Multiple workers may still claim different events at the same frontier time, but no worker can jump into a later simulation time while earlier consequences remain unresolved.

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
- [x] Generic claimed commitments may resolve as `missed` with an explicit reason while still completing the scheduler claim and materializing the next occurrence at the original phase.
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

## Durable memory and semantic retrieval completed

- [x] `@hobbo/memory` defines episodic, semantic, social, emotional, commitment, reflection and autobiographical memory categories.
- [x] Memory importance and emotional strength use bounded integer basis points rather than floating-point policy state.
- [x] Exact retrieval combines semantic similarity, recency, importance and emotional strength with explicit configurable weights.
- [x] Retrieval supports category and related-entity filters with stable deterministic tie-breaking.
- [x] Cosine similarity uses numerically stable norms and remains valid for subnormal finite components found by property testing.
- [x] Memories are append-oriented durable records and cannot be rewritten after persistence.
- [x] Embeddings are stored separately from memory content so the same memory can be re-embedded without rewriting history.
- [x] Multiple embedding models may coexist for one memory under `(world, memory, model)` identity.
- [x] Exact memory and embedding retries are idempotent; semantic reuse of an identity with changed content/vector is rejected.
- [x] PostgreSQL rejects empty, zero, non-finite and dimension-mismatched embeddings.
- [x] `PostgresMemoryRepository` filters by world, owner, model and simulation time before exact in-process ranking.
- [x] Retrieval never leaks another agent's private memories into the requesting agent's candidate set.
- [x] Re-embedding with a different model can change retrieval order without mutating the original memory.
- [x] Nomic query/document prefixes are applied automatically by `NomicEmbeddingProvider`.
- [x] The provider validates HTTP errors, response counts, response indices, dimensions and finite non-zero vectors.
- [x] Migration `0007_memory.sql`, SQL smoke checks and six real PostgreSQL memory integration cases are green.
- [x] Model CI verifies the real `NomicEmbeddingProvider -> llama.cpp -> Nomic Q4_K_M GGUF` path at 768 dimensions.

## Ambiguous cognition and durable provenance completed

- [x] `@hobbo/cognition` separates pure context assembly/decision orchestration from PostgreSQL and model adapters.
- [x] Ambiguous choices require at least two distinct available affordances.
- [x] Retrieved memories are compacted into a deterministic cognition context; future or duplicate memories are rejected before inference.
- [x] Mock and replay providers can consume the exact same ambiguous-choice request as Granite.
- [x] A deterministic fixture demonstrates memory-sensitive choice between helping a friend and ignoring the request.
- [x] `GraniteCognitiveProvider` calls llama.cpp through `/v1/chat/completions` with temperature zero and strict JSON-schema output.
- [x] The schema's `affordance_id` enum is generated exclusively from currently available simulation affordances.
- [x] Provider-side validation still rejects invented affordances, malformed JSON, extra model fields and invalid responses even if the server violates the requested schema.
- [x] Granite exposes the complete prepared request provenance before inference: provider/model, prompt payload, sampling settings and schema.
- [x] `DurableCognitionExecutor` persists the prepared request before model inference and appends decision/raw response/token/latency provenance only after inference completes.
- [x] Cognition request fingerprints are deterministic across object key insertion order while distinguishing bigint values from strings.
- [x] Fingerprints are not trusted as the sole collision guard: PostgreSQL compares the complete semantic request on every retry.
- [x] `PostgresCognitionRepository` serializes retries per `(world, request)` and rejects reuse of the same request ID with changed actor/time/correlation/provider/model/payload/affordances/sampling/schema.
- [x] `start`, `complete` and `fail` are crash/retry safe; exact completion/failure retries return the durable result while conflicting retries are rejected.
- [x] A process-style restart with a fresh PostgreSQL pool replays a completed decision without another model call.
- [x] Concurrent resumed workers obey first-durable-completion-wins semantics; a late worker cannot overwrite or convert a completed decision into failure.
- [x] Provider provenance changing between preparation and response fails closed rather than persisting an unverifiable decision.
- [x] Model CI verifies the real `GraniteCognitiveProvider -> llama.cpp -> Granite 4.1 3B Q4_K_M` path on CPU.

## Durable conversations and rumor propagation completed

- [x] `@hobbo/conversation` defines finite conversations with explicit participants, turn ordinals and a hard `maxTurns` budget.
- [x] Conversation messages are append-only and the final allowed turn closes the conversation automatically without invalidating its pending delivery effects.
- [x] Structured statements carry private confidence plus explicit `direct`, `reported`, `inferred` or `fabricated` origin for internal provenance.
- [x] Retellings keep a durable source-statement lineage and hop count while allowing the claim value to mutate between speakers.
- [x] A listener receives what was said as `reported` evidence; merely hearing a statement never changes objective world truth.
- [x] The internal fact that a speaker fabricated a claim is deliberately hidden from listeners unless dialogue itself reveals it.
- [x] Speaker memories may retain private origin/lineage metadata, so an agent can remember that it invented a statement without granting that knowledge to listeners.
- [x] Listener confidence combines statement confidence, directional trust in the speaker and an explicit transmission-retention factor.
- [x] The same spoken claim can therefore become a belief for one listener while remaining only low-confidence evidence for another.
- [x] Contradictory perceptions remain append-only evidence while the listener's private current belief may revise forward in simulation time.
- [x] Belief revision preserves the original `learnedAt` timestamp and rejects stale/same-time rewrites.
- [x] Each listener gets a distinct private social memory; the speaker gets a separate first-person memory of what they said.
- [x] Conversation memories can be embedded through a structural embedding interface; the persistence layer does not depend directly on llama.cpp.
- [x] Conversation messages create deterministic bidirectional familiarity effects while preserving pre-existing trust and other relationship dimensions.
- [x] PostgreSQL persists conversations, participants, messages, structured statement lineage and per-listener durable delivery records.
- [x] Message ordinal allocation is serialized through the conversation row lock; concurrent appends cannot allocate the same turn.
- [x] Exact message retries are idempotent while semantic reuse of a message identity with changed content is rejected.
- [x] Delivery workers use `FOR UPDATE SKIP LOCKED`, but only the oldest pending/processing delivery for each listener is claimable, preserving each agent's causal information order while allowing different agents to process in parallel.
- [x] Stale delivery leases can be requeued after a worker/process crash.
- [x] Conversation side effects use deterministic perception, memory and relationship-effect identities, so a crash after partial materialization converges without duplicate social state after restart.
- [x] A fresh PostgreSQL pool test replays a partially applied conversation delivery and proves exactly one listener perception, one listener memory, one speaker memory and one familiarity effect per direction.
- [x] Migration `0008_conversations.sql`, SQL smoke checks and ten conversation-specific PostgreSQL integration cases are green.

## Durable person/body/inventory state completed

- [x] `persons` is the durable identity anchor for simulated people; current body state is not reconstructed from an RNG seed after restart.
- [x] `person_physiology` persists bounded hunger, energy, sleep mode, rates, meal/sleep counters, simulation timestamps and a monotonic state version.
- [x] `inventory_items` persists individually identifiable physical items with explicit `available` or `consumed` state; consumed food is retained as history rather than deleted.
- [x] PostgreSQL constraints enforce body ranges, non-negative counters/rates, coherent recorded/update times and valid item-consumption state.
- [x] `PostgresPersonRepository` reconstructs the pure `@hobbo/agents` `PersonState` from durable state under a repeatable-read snapshot.
- [x] Claimed eat/sleep/wake transitions reuse the pure agent functions rather than reimplementing physiology rules in SQL.
- [x] A claimed body transition atomically updates physiology/inventory, appends its domain event, schedules consequences and completes the scheduler claim.
- [x] Claimed transitions verify scheduler ownership, expected event type and target `personId`; unrelated claims cannot mutate an arbitrary person.
- [x] Failed transitions roll back body state, inventory, events, consequences and claim completion as one unit.
- [x] A 20-agent, 30-day PostgreSQL physiology gate survives a process-style restart with an abandoned scheduler lease and produces the same semantic body/inventory/event/future-scheduler state as the uninterrupted control run.
- [x] Hunger that becomes actionable while a person is sleeping is durably deferred to the wake frontier rather than allowing impossible “eat while asleep” behavior.
- [x] Migration `0009_person_state.sql`, SQL smoke checks, body transition authority tests and the durable population physiology gate are green.

## Durable 20-agent economy population gate completed

- [x] Twenty agents execute 30 daily work shifts each while paying a periodic rent obligation through the same durable scheduler/commitment/ledger infrastructure.
- [x] A process restart after an intentionally abandoned day-15 shift claim converges to the exact same balances, commitments, domain-event counts and future schedule as an uninterrupted 30-day control run.
- [x] The restarted run records exactly one additional scheduler claim attempt while semantic state remains identical.
- [x] The gate exercises 600 salary postings, 20 rent postings and 620 fulfilled commitments without duplicate financial effects.

## Production scheduled-event runtime and durable integrated-life gate completed

- [x] `@hobbo/runtime` is a separate orchestration package; persistence remains in `@hobbo/database` and pure simulation/domain rules remain outside the runtime.
- [x] `DurableScheduledEventWorker` repeatedly claims only the scheduler's current temporal frontier and dispatches through an explicit event-type registry.
- [x] Unknown event types fail closed: the worker throws and leaves the claimed lease recoverable instead of silently discarding causal work.
- [x] `DurableCommitmentDispatcher` routes generic `commitment.due` events to kind-specific handlers without hardcoding every future commitment type into the scheduler.
- [x] Physiology handlers reuse the shared action registry plus pure `@hobbo/agents` transitions for eat/sleep/wake decisions.
- [x] Runtime hunger events that arrive during sleep produce a durable `person.hunger_deferred` event and retry at the wake frontier.
- [x] Employment shifts now interact with body state: a shift due while the employee is sleeping resolves as `commitment.missed` and does not post salary; awake shifts settle normally.
- [x] Rent remains an independent economic obligation and is settled regardless of sleep state.
- [x] The runtime integration gate drives 20 durable agents for 30 simulated days through one production-style dispatcher, combining physiology, inventory, work, missed shifts, salary, housing, rent, commitments, domain events and future scheduling.
- [x] The gate intentionally abandons one scheduler lease at the midpoint, closes the process pool, requeues from a fresh pool and proves exact semantic equality with the uninterrupted control run.
- [x] Restart equality covers world time, body state, inventory consumption, balances, all commitments, ledger transactions, exact domain-event history and pending future scheduler state; only the expected single extra operational claim attempt differs.
- [x] The gate proves both fulfilled and missed work occur, salary count equals fulfilled shifts, all twenty rent obligations settle, hunger deferrals occur, body bounds remain valid and physical item totals are conserved.
- [x] `@hobbo/runtime` is now part of normal workspace typecheck/unit CI and has a dedicated PostgreSQL runtime-integration step after repository integration tests.

## Durable social-life runtime gate completed

- [x] `social.conversation_opportunity` is a first-class durable scheduled event handled by `@hobbo/runtime`; social simulation no longer depends on the old in-memory benchmark loop.
- [x] Every social opportunity resolves through persistent people, conversations, deliveries, perceptions, beliefs, memories and directional relationships already owned by `@hobbo/database`.
- [x] Social opportunity scheduling is phase-stable across days and derives listener/claim choices deterministically from durable identities rather than transient RNG state.
- [x] Sleeping actors do not converse magically: their opportunity emits `social.opportunity_deferred` and is retried after the physiology wake frontier.
- [x] Conversation messages are one-listener durable units for this first production gate; delivery side effects are processed through `PostgresConversationDeliveryProcessor`, preserving its existing crash-safe/idempotent semantics.
- [x] Seed knowledge is represented as private durable belief + semantic memory rather than objective world truth.
- [x] Heard claims may be retold with explicit source-statement lineage and hop counts; deterministic numeric distortion provides a reproducible rumor-mutation path.
- [x] Listener trust still controls private belief adoption through the existing conversation propagation policy, so agents exposed to the same social world can end with different beliefs.
- [x] `PostgresPersonRepository.listIds()` provides the runtime a deterministic persisted population roster without introducing runtime-owned SQL.
- [x] A 20-agent, 30-day PostgreSQL gate drives physiology and social opportunities together, producing hundreds of durable conversations while exercising sleep deferrals, rumor retellings/mutations, private beliefs, memories and relationship familiarity.
- [x] The gate runs uninterrupted and crash/restarted worlds, deliberately abandons a midpoint scheduler lease, recreates the PostgreSQL pool, requeues it and proves exact semantic equality at day 30.
- [x] No migration was required; the gate reuses migrations `0006` social/beliefs, `0007` memory, `0008` conversations and `0009` person state.
- [x] Core simulation CI run #207 is green for the social-runtime milestone.

## Durable goals, planning and reflection gate completed

- [x] Added a pure `@hobbo/planning` domain package. Goal validation, priority ordering, periodic intention generation and conflict displacement are deterministic rules outside the runtime and outside any model provider.
- [x] Added nominal `LifeGoalId` and `PlanRevisionId` identities in `@hobbo/domain`.
- [x] Migration `0010_planning.sql` persists life goals and append-style plan revisions, with at most one active revision per owner.
- [x] `PostgresPlanningRepository` owns durable goal and plan state; `@hobbo/runtime` does not issue planning SQL directly.
- [x] Plan revisions are idempotent by durable review event and supersede the prior active revision without rewriting its semantic contents.
- [x] `planning.review` is a first-class scheduled event handled by the production runtime.
- [x] Reviews build a seven-day intention horizon from active goals and currently materialized durable conflicts.
- [x] Employment commitments reserve work windows; social opportunities reserve social windows; pending physiology sleep transitions reserve the predicted sleep interval using the same pure energy model as the physiology runtime.
- [x] Higher-priority goals reserve time first; lower-priority intentions move after conflicting durable windows rather than overlapping them.
- [x] Reviews attempted while the person is asleep emit `planning.review_deferred`, retry at the wake frontier and mark the resulting plan as conflict-driven.
- [x] Reflections are append-only `memory.category = "reflection"` records derived from already durable recent memories. They do not rewrite event history, beliefs, conversations or source memories.
- [x] The first planning slice is deliberately model-independent: an LLM may later propose language or choices, but it is not authoritative for goal/plan persistence or conflict resolution.
- [x] The runtime gate drives 8 agents for 14 simulated days with physiology, employment, conversations, goals, planning and reflection on the same production dispatcher.
- [x] The gate deliberately abandons a scheduler lease at the midpoint, closes the PostgreSQL pool, requeues from a fresh pool and proves exact semantic equality with the uninterrupted control run.
- [x] The gate proves durable work/social/physiology conflicts displace intentions, sleep causes deferred reviews, reflections cite prior durable memories, and each person finishes with exactly one active plan.
- [x] Core simulation CI run #225 is green for the planning/reflection milestone.

### Planning scope boundary

- [x] Medium-term plans are intentionally provisional. The planner blocks currently materialized commitments and scheduled events; recurring obligations that have not yet been materialized are incorporated by subsequent daily reviews rather than predicted as hidden future facts.
- [ ] Plan intentions are not yet executable commitments/actions. A later slice must decide which intentions become commitments and how cancellation/completion feeds back into goals.
- [x] LLM-generated dialogue text is connected only through constrained affordances; planning and all authoritative state transitions remain deterministic.

## Durable model-driven dialogue gate completed

- [x] `dialogue.turn` is a first-class scheduled event handled by `@hobbo/runtime`; there is no parallel dialogue simulator.
- [x] Dialogue conversations reuse the durable conversation substrate: participants, messages, statements, deliveries, private perceptions/beliefs, memories and directional relationship effects remain owned by `@hobbo/database`.
- [x] Every generated turn is backed by a durable cognition request with request hash, provider/model identity, visible context, affordances, schema/sampling configuration, decision and raw-response provenance.
- [x] The deterministic long-run gate uses `DurableCognitionExecutor` plus a traceable mock provider, so the exact persistence/replay path used by Granite is exercised without making CI depend on model stochasticity.
- [x] A dedicated crash-boundary gate persists cognition first, simulates a process loss before message persistence, restarts with a provider that throws if called, and proves the turn completes through replay with zero new inference calls.
- [x] Existing persisted messages and completed deliveries are idempotent recovery boundaries: a retried scheduled turn does not regenerate or duplicate already durable conversation state.
- [x] Model-visible context is assembled from the speaker's private beliefs, directional relationship vector, recent visible memories, prior visible turns and active plan.
- [x] Hidden statement provenance and memory metadata are withheld from the model context; `origin`, `sourceStatementId`, `claimedSourceEntityId`, `hopCount` and raw memory metadata remain simulation-internal.
- [x] The runtime converts a selected share-belief affordance back into a validated durable `ConversationStatement`; rumor lineage remains explicit internally through `retellStatement`.
- [x] Sleeping speakers or listeners defer the turn to the physiology wake frontier via `dialogue.turn_deferred`.
- [x] The sustained gate runs 4 agents for 7 simulated days across 14 two-person conversations / 56 generated turns while physiology, planning, private belief propagation, memories and relationship effects remain active.
- [x] The sustained gate deliberately abandons a scheduler lease at the midpoint, closes the PostgreSQL pool, requeues from a fresh pool and proves exact semantic equality against the uninterrupted control run.
- [x] `GraniteCognitiveProvider` now has an explicit `dialogue` mode: the model must select one supplied dialogue affordance and the `intent` field is defined as the exact spoken utterance, schema-bounded to 280 characters.
- [x] Model Smoke CI run #22 proves the real locked Granite GGUF through pinned llama.cpp can consume the production dialogue context/affordance shape while preserving the prompt privacy boundary.
- [x] Core simulation CI run #246 is green for the durable dialogue milestone.

### Dialogue scope boundary

- [x] PostgreSQL state and deterministic validation remain authoritative. The model can select only supplied dialogue affordances and generate utterance text; it cannot directly mutate beliefs, relationships, plans, inventory, money, physiology or world state.
- [x] The expensive live-GGUF CI path is intentionally a focused dialogue-contract smoke. The sustained 56-turn / 7-day gate is deterministic/replay; GitHub-hosted CPU runners are not used for a week-long real-model quality benchmark.
- [ ] The first production dialogue runtime is two-person only. Group conversations, spatial/proximity participant selection and interruption by richer activity/location state remain future work.
- [ ] Dialogue affordances currently cover private-belief sharing and small talk; richer question/answer, topic management, promises and executable social actions require later domain slices.

### Runtime concurrency boundary

- [x] The production gate proves the safe/default sequential worker path over the durable scheduler.
- [ ] Multi-worker handling of simultaneous events that can mutate the same person is not yet claimed safe. Before enabling that mode, the runtime needs explicit person/entity affinity or equivalent conflict serialization on top of the scheduler's same-frontier parallelism.

### Current CI gate

- [x] TypeScript typecheck green across the 15-project workspace, including `@hobbo/runtime` and `@hobbo/planning`.
- [x] 115/115 non-integration tests green across 22 files, including deterministic planning and Granite dialogue-mode contracts.
- [x] 71/71 PostgreSQL database integration tests green on PostgreSQL 17, including durable planning persistence.
- [x] 6/6 PostgreSQL runtime integration tests green across 4 files, including integrated-life, social-life, multi-day planning, sustained dialogue and cognition-replay crash gates.
- [x] Database migrations `0001` through `0010` plus all SQL smoke checks green.
- [x] 20-agent, 30-day durable physiology restart gate green.
- [x] 20-agent, 30-day durable employment/rent restart gate green.
- [x] 20-agent, 30-day durable integrated runtime gate green.
- [x] Scheduler temporal-frontier concurrency gate green.
- [x] Real Granite cognition and Nomic embedding GGUF smoke tests green through pinned llama.cpp.
- [x] Real Granite cognition smoke passes through `GraniteCognitiveProvider`, not only the raw endpoint request.
- [x] Real Granite dialogue-mode smoke consumes the production visible dialogue context and affordance contract through pinned llama.cpp.
- [x] Real Nomic embedding smoke passes through `NomicEmbeddingProvider`, not only the raw endpoint request.

The deterministic/event-driven kernel is now proven across body/inventory, work, missed obligations, salary, housing/rent, commitments, conversations, model-driven utterances, rumor propagation, private beliefs, memories, relationships, long-term goals, conflict-aware plans, reflections, event history and future scheduling with restart-equivalent durable gates. The next major infrastructure gap is explicit same-person/entity affinity or equivalent conflict serialization before enabling multi-worker production runtime mode.

## Next implementation milestones

- [x] Memory storage/retrieval and Nomic embedding integration.
- [x] Ambiguous-choice cognition integration using mock/replay first, Granite second.
- [x] Conversation memory and information/rumor propagation.
- [x] Durable person/body/inventory persistence and 20-agent restart gate.
- [x] Production scheduled-event dispatcher/worker shared by integrated simulation runs.
- [x] 20-agent durable integrated-life gate combining physiology, employment, housing and commitments on one timeline.
- [x] 20-agent long-running social simulation gate driven by `@hobbo/runtime`.
- [x] Long-term goals/plans and reflection over multi-day histories.
- [x] Sustained model-generated dialogue using the durable conversation substrate, with real Granite contract smoke.
- [ ] Explicit same-person affinity/serialization before multi-worker runtime mode.
- [ ] Minimal Sprite Forge Blender fixture.

The long-running deterministic, social, planning/reflection and durable model/replay dialogue gates are now met. The default sequential runtime remains the supported production mode; multi-worker execution must stay disabled until same-person/entity conflicts are explicitly serialized.
