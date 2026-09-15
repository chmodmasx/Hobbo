# Model CI

Hobbo uses real local GGUF models during CI to verify compatibility with the exact inference path used by the game.

## Policy

GitHub-hosted runners are an **ephemeral test environment**, not a model distribution mechanism.

CI may:

1. restore GGUF files from the repository-scoped Actions cache;
2. download missing files directly from their official Hugging Face repositories;
3. verify every downloaded file against the SHA256 declared in `models/models.lock.json`;
4. run llama.cpp on CPU;
5. execute smoke/integration tests;
6. discard the VM after the workflow finishes.

CI must not:

- commit GGUF files to Git;
- publish GGUF files as release assets or workflow artifacts;
- treat the Actions cache as a production source;
- silently accept a changed upstream file with a different checksum.

## Baseline models

### Cognition

`ibm-granite/granite-4.1-3b-GGUF`, `Q4_K_M`.

The smoke test starts an OpenAI-compatible llama.cpp server and verifies schema-constrained decision output. The test intentionally checks protocol compatibility rather than tokens/second: shared CI runners are not a stable performance benchmark.

### Embeddings

`nomic-ai/nomic-embed-text-v2-moe-GGUF`, `Q4_K_M`.

The embedding smoke test starts llama.cpp in embedding mode and performs two layers of validation:

1. a raw OpenAI-compatible `/v1/embeddings` request verifies that llama.cpp returns finite vectors and exactly 768 dimensions for the locked Nomic model;
2. `packages/ai-provider/test/nomic-live.integration.test.ts` calls the production `NomicEmbeddingProvider` against that same live llama.cpp process and real GGUF.

The production provider applies Nomic's `search_query:` and `search_document:` prefixes automatically, validates response counts and indices, rejects non-finite/zero or dimension-mismatched vectors, and exposes the vectors under the model identity used by durable memory storage.

This split is intentional: the raw request isolates llama.cpp/model compatibility, while the live provider test closes the application-level path actually used by Hobbo.

Changes under `packages/ai-provider/**`, `scripts/ci/**`, `models/**` or the model-smoke workflow itself trigger this workflow so provider regressions cannot bypass the real GGUF gate.

## Cache invalidation

The workflow cache key includes a hash of `models/models.lock.json`. Changing a model, quantization, URL or checksum therefore creates a new cache namespace automatically.

A cache miss is expected and safe. `scripts/ci/download-models.sh` re-downloads and verifies the model.

## Performance benchmarking

Do not use GitHub-hosted runners for authoritative throughput numbers. Performance tests belong on controlled hardware. GitHub CI is for functional compatibility, regression detection, schema correctness and end-to-end startup verification.
