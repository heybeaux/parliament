## Why

Stages 0–3 produce a topology runtime that executes steps sequentially: each agent reads what came before, then speaks. That's right for dialectic patterns, but it has a known weakness — the *order* of agents biases the output. The first agent to speak sets the frame; the last agent to speak closes the synthesis. A truly diverse cast can still converge into the framing of whoever spoke first.

The fix is parallel-step execution: a group of agents reads the same prior state, generates *independently*, and a downstream synthesis step reconciles. The Jury preset is the canonical example — multiple Empiricists/Skeptics/Steelmanners deliberate without seeing each other, then a Synthesizer reads all verdicts together. This produces the kind of "many minds, one verdict" structure that order-sensitive sequential pipelines can't.

## What Changes

- Topology spec gains a `parallel_steps` block: a list of steps that all execute against the same prior state, with their results merged into the blackboard before the next sequential step.
- Topology runtime gains a parallel executor: spawns parallel-step agents concurrently, waits for all to complete, appends results to the blackboard in registration order (deterministic for transcripts).
- A seventh built-in preset ships: **Jury** — Proposer → [parallel: Skeptic, Empiricist, Steelmanner, Devil's Advocate] → Synthesizer.
- Per-deliberation timeouts apply to the parallel block as a whole (the slowest agent in a parallel block bounds the round).
- UI gains visual handling for parallel turns in the Timeline (siblings rendered as a row, not stacked).

## Capabilities

### New Capabilities
- `topology-parallel`: Parallel-step execution semantics for topologies. Owns the executor, the timeout policy, and the deterministic ordering of merged results.

### Modified Capabilities
- `topology`: The schema gains an optional `parallel_steps` field on presets. Existing sequential-only presets continue to validate without changes.
- `topology-runtime`: The executor MUST handle parallel blocks alongside sequential ones; preset registry adds the Jury preset.
- `observability-ui`: The Timeline MUST visually distinguish parallel siblings from sequential turns.

## Impact

- **@parliament/core**: schema extension; parallel executor; Jury preset registration.
- **@parliament/server**: no contract change (parallel turns appear in the same turn list, distinguished by a `parallel_group` field).
- **@parliament/ui**: Timeline component update to render parallel siblings as a row.
- **Backward compatibility**: existing sequential presets work unchanged; old transcripts have no `parallel_group` field and render as before.
- **Roadmap**: Stage 4. Depends on `add-topology-spec` (schema base), `add-topology-runtime` (sequential executor as foundation), `add-eight-neurotypes` (Jury references new neurotypes), `add-observability-ui` (Timeline component to extend).
