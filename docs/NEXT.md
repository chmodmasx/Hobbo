# Immediate next step

Build the first durable long-term goals/planning/reflection slice on top of `@hobbo/runtime`.

The next gate should prove that a small population can:

- persist life goals and active plans;
- derive daily/medium-term intentions from those goals without making the LLM authoritative;
- interrupt and re-plan when physiology, work or social events conflict;
- create reflection records from durable memories without rewriting the underlying event history;
- restart from a fresh PostgreSQL pool and converge to the same semantic state.

Keep the production runtime as the only scheduled-event execution path. Do not create a parallel planning simulator.
