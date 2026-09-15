# Architecture decisions

## ADR-001 — LLMs propose intentions; simulation owns reality

Accepted. Language models cannot directly mutate world state.

## ADR-002 — Event-driven background simulation

Accepted. Background NPCs are advanced through scheduled events and analytical state integration, not a global per-agent tick.

## ADR-003 — Procedural Sprite Forge

Accepted. 3D/parametric source assets are compiled into 2D isometric pixel-art layers and atlases. Generated spritesheets are build artifacts, not hand-authored primary sources.

## ADR-004 — Real GGUF models in GitHub CI

Accepted. GitHub-hosted VMs may download/cache the baseline Q4_K_M GGUF files and run them on CPU for functional tests. The repository and GitHub Actions artifacts are not model distribution channels.

## ADR-005 — Separate cognitive and embedding models

Accepted. Granite 4.1 3B Q4_K_M is the initial cognition baseline; Nomic Embed Text v2 MoE Q4_K_M is the initial semantic-memory embedding baseline.

## ADR-006 — Modular monolith first

Accepted. Domain modules are separated by contracts, but deployment begins as a modular monolith plus model processes/workers. External brokers and microservices require benchmark evidence before introduction.
