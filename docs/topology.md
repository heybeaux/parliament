# Topology

A **topology** describes the shape of a deliberation — which neurotypes speak, in what order, and which run side-by-side. Parliament resolves topology from `[topology]` in `parliament.toml` (or from the request `preset` field at runtime), then hands the runtime a fully-resolved `TopologyConfig` with one `activePreset`. See **[docs/neurotypes.md](neurotypes.md)** for the postures presets compose from.

This doc covers the rationale for parallel deliberation; the day-to-day "which preset should I pick?" answer is in the README's **[Presets table](../README.md#presets)**.

---

## Why order matters

Sequential deliberation has a structural blind spot: the first speaker frames the problem; the last speaker closes it. Even with diverse postures across agents, a sequential pipeline biases toward the framing baked into the first turn.

The PNAS Nexus convergence work surfaces this implicitly — open models exposed in sequence drift toward whichever voice spoke first. Independent of model quality, sequence creates a one-way dependency: each turn reads everything that came before. The Skeptic in `star-chamber` reads the Proposer's framing; the Devil's Advocate reads the Skeptic's; by the Empiricist's turn the room is already shaped.

This is fine when sequence is the point. Chain-of-verifiers wants each step to build on the last; Long-view wants Historian → Forecaster → Pragmatist *because* the temporal flow matters. But for "evaluate this proposal from N independent angles," sequential composition is a structural mismatch.

## Parallel steps as the structural fix

Stage 4 introduced `parallel_steps`: a flat block of agents that all read the same blackboard snapshot and run concurrently. None of them sees the others' output mid-block. After all complete, their results are appended to the live blackboard in **registration order** (regardless of completion order), the Synthesizer reconciles, and the round continues.

The key invariants:

- **Read-only snapshot.** Every parallel agent reads the blackboard as it was at block start. No sibling-to-sibling visibility.
- **Deterministic merge order.** Sibling outputs land in the order they were declared in `parallel_steps`, not in the order they completed. Two runs of the same preset against the same inputs produce byte-identical transcripts.
- **Block-level timeout.** One timeout for the whole block. If any sibling exceeds it, the block fails — we don't keep partial results from a "three out of four" race.

These choices are deliberate. Letting siblings see each other reintroduces the order-bias problem the parallel block was designed to eliminate. Allowing partial completion produces an asymmetric verdict (three critics weighed in, the fourth timed out) that the Synthesizer would silently reconcile as if it were complete. The full reasoning lives in the OpenSpec design doc — see **[openspec/changes/add-jury-parallel/design.md](../openspec/changes/add-jury-parallel/design.md)** for the trade-off discussion.

## Jury vs. Star Chamber — when to pick which

`jury` and `star-chamber` are structurally similar — both are "Proposer plus a panel of critics" — but they answer different questions.

- **Star Chamber** runs the critics sequentially: Skeptic → Devil's Advocate → Empiricist. Each critic reads everything before them. The resulting critique is **cumulative** — late critics build on, refute, or sharpen earlier ones. Pick this when you want the critics to interrogate one another.
- **Jury** runs four critics in parallel: Skeptic, Empiricist, Steelmanner, Devil's Advocate, all reading the same blackboard snapshot. The critiques are **independent** — four orthogonal verdicts on one proposal. Pick this when you don't want the first speaker's framing to dominate the room.

The output shape is also different. Star Chamber gives the Synthesizer one sharpened critique (each critic's turn already incorporates the prior); Jury gives it four independent verdicts to reconcile. If you find the Synthesizer struggling to pick sides on Jury output, that's the signal — the critics genuinely disagreed, which is what parallel evaluation surfaces.

## Trade-offs to know about

- **Atomic failure.** A parallel block fails or succeeds as a unit. There is no partial-degrade path: if one agent times out, the whole block raises and the round ends. Sequential pipelines have no such cliff — a slow agent only delays the next turn.
- **Fixed critic count for Jury.** Jury declares four critics and that count is not configurable from the built-in preset. Users who want three or five critics author their own user-defined preset with a custom `parallel_steps` list — the schema is uniform, only the registry entry is fixed.
- **No nested parallelism.** `parallel_steps` is a flat block. Parallel-within-parallel is rejected by the loader; if you need staged parallel evaluation, compose two presets via the engine, not one preset with nested blocks.
- **Slowest agent bounds the round.** Block latency is the max of the siblings, not the sum, but a single slow model gates the whole block. Pick parallel critics from a model pool with comparable response times.

## See also

- **[openspec/changes/add-jury-parallel/design.md](../openspec/changes/add-jury-parallel/design.md)** — full design rationale: read-only snapshot, deterministic merge, block-level timeout, why partial completion is rejected.
- **[openspec/changes/add-topology-spec/design.md](../openspec/changes/add-topology-spec/design.md)** — the underlying topology schema (presets, neurotypes, validation rules).
- **[docs/neurotypes.md](neurotypes.md)** — the thirteen built-in neurotypes presets compose from.
