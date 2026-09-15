# CI helpers

- `download-models.sh` — downloads selected models from `models/models.lock.json` and verifies SHA256.
- `wait-http.sh` — waits for a local HTTP endpoint.
- `smoke-granite.sh` — launches Granite through llama.cpp and validates schema-constrained chat completion.
- `smoke-nomic.sh` — launches Nomic through llama.cpp and validates the embeddings endpoint.
