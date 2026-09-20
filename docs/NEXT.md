# Immediate next step

Add explicit same-person/entity affinity or equivalent conflict serialization before enabling multi-worker production runtime mode.

The next gate should prove that multiple durable scheduler workers can:

- process independent agents concurrently without introducing a global world lock;
- identify the person/entity resources an event can mutate before executing its handler;
- serialize simultaneous events that can mutate the same person or other shared authoritative entity;
- preserve deterministic same-frontier ordering for conflicting work;
- release/recover affinity ownership after a worker crash or stale scheduler lease;
- keep physiology, inventory, employment/payroll, housing, social delivery, planning and dialogue side effects idempotent under worker races;
- produce the same semantic result as the supported sequential runtime on a multi-agent long-running fixture.

Prefer a small explicit affinity/conflict layer over handler-specific ad-hoc locks. Reuse PostgreSQL transaction/advisory-lock primitives where they preserve the existing scheduler crash boundary.

Do not claim multi-worker runtime support until a deliberately contended integration gate and crash/requeue gate are both green. Keep the current sequential worker path as the supported default throughout this work.
