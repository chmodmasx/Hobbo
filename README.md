# Hobbo

Hobbo is an experimental persistent social simulation with an isometric pixel-art presentation.

The project is built around one hard rule: **the simulation owns reality; local language models only propose intentions**. NPC identity, physiology, needs, economy, relationships, beliefs, memory and world state are persisted and validated outside the LLM.

## Current stage

Architecture/bootstrap. The repository currently establishes:

- the simulation architecture and implementation principles;
- a procedural 3D-to-2D sprite pipeline (`Hobbo Sprite Forge`);
- reproducible GGUF model manifests;
- GitHub Actions smoke tests that run the real Granite cognitive model and Nomic embedding model on GitHub-hosted CPU runners;
- no GGUF weights committed to Git.

## Baseline local models

| Purpose | Model | Quantization |
| --- | --- | --- |
| NPC cognition | `ibm-granite/granite-4.1-3b-GGUF` | `Q4_K_M` |
| Memory embeddings | `nomic-ai/nomic-embed-text-v2-moe-GGUF` | `Q4_K_M` |

CI downloads the exact files declared in [`models/models.lock.json`](models/models.lock.json), verifies SHA256, and runs them through llama.cpp. GitHub Actions is used only as an ephemeral verification environment; model hosting/distribution is outside the repository.

## Architecture docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ASSET_PIPELINE.md`](docs/ASSET_PIPELINE.md)
- [`docs/MODEL_CI.md`](docs/MODEL_CI.md)

## Repository direction

The first executable milestone is intentionally headless: a deterministic simulation kernel plus a mock cognitive provider. Real LLM cognition is introduced behind a provider interface only after world invariants, scheduling and replay are stable.
