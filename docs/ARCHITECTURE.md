# Hobbo Architecture v0.1

## Core premise

Hobbo is a persistent social simulation with an isometric 2D presentation. The simulation is authoritative. Language models are advisory cognitive components that select or propose intentions from world-provided affordances; they do not directly mutate world state.

```text
player / NPC cognition
        │
        ▼
   action request
        │
        ▼
 action validator
        │
        ▼
 simulation core
        │
        ├── state mutation
        ├── domain events
        ├── perceptions
        ├── memories
        └── scheduled consequences
```

## Architectural rules

1. **World state is canonical.** PostgreSQL plus active in-memory state is the source of truth.
2. **LLMs never own persistent state.** Identity, needs, money, inventory, relationships, beliefs, plans and memory are external data.
3. **Reality and belief are distinct.** An NPC only receives facts it can legitimately know or perceive.
4. **Players and NPCs use the same action definitions.** The origin of a decision differs; game rules do not.
5. **Simulation is event-driven.** Background inhabitants are not ticked continuously.
6. **Cognition is budgeted.** Rules and utility AI handle obvious choices; LLM calls are reserved for ambiguity, novelty and social reasoning.
7. **Replay is a first-class requirement.** Randomness is deterministic and LLM outputs are recorded so historical simulations can be reproduced.
8. **Rendering is not simulation.** Client FPS, realtime replication, simulation scheduling and cognition cadence are independent.

## Runtime topology — initial

Start as a modular monolith plus dedicated model processes:

```text
┌─────────────────────────────┐
│ Browser client              │
│ PixiJS + React              │
└──────────────┬──────────────┘
               │ websocket/http
               ▼
┌─────────────────────────────┐
│ hobbo-server                │
│                             │
│ realtime                    │
│ simulation                  │
│ actions                     │
│ scheduler                   │
│ social/economy              │
│ memory orchestration        │
│ cognition scheduler         │
└───────────┬─────────┬───────┘
            │         │
            │         └──────────────┐
            ▼                        ▼
      PostgreSQL                llama.cpp
      + pgvector                cognition
                               llamacpp:8086
                                    │
                                    ▼
                               Granite 4.1 3B

separate embedding llama.cpp process/worker
Nomic Embed Text v2 MoE
```

The production embedding endpoint will have its own stable service identity/port; CI may use a temporary port.

## Repository target

```text
apps/
├── client/
├── server/
└── admin/

workers/
├── cognition/
└── embeddings/

packages/
├── domain/
├── simulation/
├── actions/
├── agents/
├── cognition/
├── memory/
├── social/
├── economy/
├── pathfinding/
├── world/
├── protocol/
├── database/
├── ai-provider/
├── benchmark/
└── testkit/

tools/
└── sprite-forge/

assets/
├── source/
├── definitions/
└── generated/   # build output, ignored
```

## Simulation time

Simulation time is represented independently from wall-clock time. Domain code should use a dedicated integer/bigint time type rather than JavaScript `Date` for world chronology.

Background entities use scheduled events rather than a global per-NPC tick. Example: when a person begins sleeping, schedule a wake-up event. Physiology values can be integrated analytically from the last update timestamp when queried.

## Simulation levels of detail

```text
LOD 0 DORMANT      scheduled/mathematical only
LOD 1 MACRO        routines, physiology and economics
LOD 2 EVENT        rule/utility-driven encounters and actions
LOD 3 ACTIVE       detailed spatial/action simulation
LOD 4 COGNITIVE    LLM decision allowed
LOD 5 INTERACTIVE  direct human/NPC interaction; highest priority
```

Population size must not imply proportional LLM traffic.

## Person model

A persistent person conceptually owns or references:

```text
identity
body
needs
emotions
personality
values
skills
knowledge/beliefs
memories
relationships/reputation
goals/plans/commitments
employment/finances
household/home
inventory
current activity/location
```

Most numeric simulation state should use bounded integers rather than arbitrary floating-point values where deterministic replay benefits from it.

## Knowledge model

World truth, a person's beliefs, and speech are separate concepts.

```text
world proposition
    │
    ├── observed by A -> belief(A, proposition, confidence=high)
    ├── told to B     -> belief(B, proposition, source=A)
    └── unknown to C  -> absent from C's cognitive context
```

An utterance never automatically becomes truth. Trust, source, contradictions and later evidence may update belief confidence.

## Memory model

Initial memory categories:

- episodic;
- semantic;
- social;
- emotional;
- commitment;
- reflection;
- autobiographical.

Retrieval combines structured filters with semantic similarity, recency, importance, emotional strength, goal relevance and social relevance. Vector similarity alone is insufficient.

For the first implementation, prefer exact vector search within one agent's filtered memories before introducing a global ANN index. This keeps retrieval semantics understandable while populations are still small enough for exact scans.

## Cognition routing

```text
trigger
  ↓
rules
  ↓
utility scoring
  ↓
low uncertainty? ── yes ──> action
  │
  no
  ↓
LLM cognitive request
  ↓
schema-constrained decision
  ↓
action validator
```

The model normally selects from affordances already validated as potentially available by the world. Do not expose the entire game action surface on every prompt.

## Cognitive request boundary

A request may include only information available to the person:

```text
identity summary
body/need snapshot
emotion snapshot
relevant personality/values
current goals
current perceptions
relevant relationships
retrieved memories
known beliefs
available affordances
```

No global database dump and no private facts belonging to other agents.

## Model contracts

Cognition baseline:

```text
Granite 4.1 3B Q4_K_M
OpenAI-compatible llama.cpp server
schema-constrained JSON response
```

Memory embeddings baseline:

```text
Nomic Embed Text v2 MoE Q4_K_M
OpenAI-compatible llama.cpp embeddings endpoint
```

Model files are external runtime dependencies described by `models/models.lock.json`; they are never committed to Git.

## Events and replay

Every meaningful state transition emits a domain event with at least:

```text
sequence
id
world_id
sim_time
type
actor_id (optional)
target_ids (optional)
payload
causation_id
correlation_id
```

LLM calls store enough metadata to replay without re-inference:

```text
request hash
model id/version
sampling/schema configuration
parsed output
raw response when needed
latency/token metadata
```

A replay provider returns the stored cognitive result rather than calling the model again.

## Persistence

Use a hybrid model:

- normalized current-state tables for fast reads;
- append-only domain-event history for causality/debugging;
- scheduled-event table for durable future work;
- cognition job/run tables for model scheduling and replay;
- pgvector columns for memory embeddings.

Event history can be partitioned later when data volume warrants it.

## Cognitive scheduling

Initial priorities:

```text
100 player conversation
 90 immediate social conflict
 80 critical personal decision
 60 replanning
 40 reflection
 20 background cognition
  5 optional world-director work
```

A PostgreSQL queue using row locking/`SKIP LOCKED` is sufficient for the first worker implementation. Introduce an external broker only after measurement demonstrates a need.

## Spatial world

Store logical positions in orthogonal `(x, y, z)` coordinates. Isometric perspective is a render transform only.

Use hierarchical navigation:

- global graph between rooms/buildings/streets;
- local tile-based pathfinding inside active areas;
- reservations for seats, beds and other capacity-limited interactables.

## Rendering

PixiJS renders generated 2D assets. React renders application UI, not individual world sprites.

Avatar art is generated through the Sprite Forge pipeline documented in `ASSET_PIPELINE.md`. Runtime atlases are generated build artifacts, not the authoring format.

## Development sequence

1. architecture/domain contracts;
2. deterministic simulation kernel and scheduler;
3. physiology/sleep/food/inventory using mock cognition;
4. ledger economy, employment, housing;
5. social state, beliefs and perception;
6. memory/embedding retrieval;
7. cognitive scheduler and real Granite integration;
8. 20-agent, 30-day headless experiment;
9. admin/trace inspector;
10. 100→500→1000→10000 population scale tests;
11. Sprite Forge and isometric renderer integration;
12. playable human/realtime multiplayer;
13. larger city systems;
14. optional World Director.

The project does not advance to large-scale content production until the 20-agent long-running simulation demonstrates coherent, diverse and causally explainable lives.
