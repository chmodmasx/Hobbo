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

## Next implementation milestones

- [ ] Domain types package.
- [ ] Deterministic world clock.
- [ ] Scheduled-event queue.
- [ ] Domain-event envelope and replay primitives.
- [ ] Action registry/validator.
- [ ] Mock cognitive provider.
- [ ] Initial PostgreSQL schema/migrations.
- [ ] Property-based world invariants.
- [ ] Headless 20-agent simulation fixture.
- [ ] Minimal Sprite Forge Blender fixture.

The project should not begin large-scale visual/content work before the headless simulation gates are met.
