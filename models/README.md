# Models

`models.lock.json` is the reproducibility manifest for external model weights used by Hobbo.

The repository never stores GGUF files. Local development and CI place downloaded weights under `.cache/models/`, verify SHA256, and use those files only as runtime dependencies.

Changing a model requires updating the manifest and intentionally accepting the new checksum.
