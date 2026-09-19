# Immediate next step

Build sustained LLM-generated dialogue on top of the existing durable conversation substrate.

The next gate should prove that a conversation runtime can:

- assemble dialogue context from durable participants, private beliefs, relationships, recent memories and the active plan without exposing hidden provenance;
- use mock/replay first so dialogue is deterministic and restart-safe before enabling Granite;
- persist every generated turn before applying listener effects;
- validate model output into explicit text/statements rather than letting the model mutate world state directly;
- resume after a process restart without regenerating or duplicating an already persisted turn;
- run multi-turn conversations across several agents while preserving private beliefs, rumor lineage, memories and relationship effects;
- add a Granite-backed smoke path only after the deterministic/replay gate is green.

The LLM may choose among valid dialogue affordances and generate utterance content, but PostgreSQL state plus deterministic validation remain authoritative.

Keep `@hobbo/runtime` as the only scheduled-event execution path. Do not create a separate dialogue simulator.
