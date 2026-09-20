# Immediate next step

Build the optional World Director as a bounded, non-authoritative orchestration layer.

The city substrate now has durable rooms/buildings/streets, local active-area movement, hierarchical travel and capacity reservations. The next gate should prove that a director can propose higher-level world opportunities without bypassing normal simulation causality or directly editing person/world truth.

The World Director gate should:

- observe bounded durable world summaries and recent causal events rather than raw mutable internals;
- propose opportunities, pressures or scenario seeds through explicit typed contracts;
- translate accepted proposals into ordinary scheduled events, commitments, affordances or other existing authoritative mechanisms;
- never write person beliefs, memories, positions, balances, relationships or outcomes directly;
- keep all resulting mutations inside the same PostgreSQL transactions, action validation and scheduler paths already used by autonomous agents and players;
- make every director proposal and accepted/rejected result traceable and replayable;
- support a deterministic mock/replay provider before any live model provider;
- enforce hard budgets for cadence, affected entities and generated work so the director cannot become a hidden per-tick cognition loop;
- prove that disabling the director leaves the base simulation fully functional and deterministic;
- gate malformed proposals, unavailable affordances, duplicate/replayed proposals and restart recovery.

Do not turn the director into a game master that overrides outcomes, teleports entities, invents balances or rewrites history. It may create opportunities; existing world rules decide what actually happens.
