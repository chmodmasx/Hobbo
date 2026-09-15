# CI execution notes

The model smoke workflow is intentionally CPU-only. It exists to prove that the exact GGUF files can be loaded by llama.cpp and that Hobbo's protocol assumptions work end-to-end on a clean Linux VM.

A green workflow means:

- downloads/checksums are correct;
- llama.cpp can load both GGUF files;
- the cognition model serves OpenAI-compatible chat completions;
- schema-constrained output is accepted;
- the embedding model serves OpenAI-compatible embeddings;
- the API responses satisfy Hobbo's basic integration contract.

It does **not** establish production throughput or latency.
