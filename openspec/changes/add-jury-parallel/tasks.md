## 1. Schema extension

- [ ] 1.1 Add optional `parallel_steps` field to preset definition. Each entry has the same structure as a sequential step (`id`, `neurotype`, `optional`).
- [ ] 1.2 Update validation: step IDs MUST be unique across both `steps` and `parallel_steps`.
- [ ] 1.3 Document in `add-topology-spec`'s capability that this is an additive extension.

## 2. Parallel executor

- [ ] 2.1 Implement parallel executor in `@parliament/core/src/topology/parallel.ts`.
- [ ] 2.2 Spawn parallel-step agents concurrently against the same blackboard snapshot (read-only view; writes deferred to merge).
- [ ] 2.3 After all agents complete, append results to the blackboard in registration order (deterministic for transcript).
- [ ] 2.4 Apply a single timeout to the parallel block as a whole; if any agent exceeds the timeout, the block fails with a descriptive error naming the slow agent.
- [ ] 2.5 Annotate each parallel turn with a `parallel_group` field (group ID shared by all siblings) so downstream consumers can render them together.

## 3. Jury preset

- [ ] 3.1 Register the Jury built-in preset: Proposer → parallel[Skeptic, Empiricist, Steelmanner, Devil's Advocate] → Synthesizer.
- [ ] 3.2 Set Jury's metadata: `name = "Jury"`, `description = "..."`, `best_for = "Questions where one agent's framing can dominate the room."`
- [ ] 3.3 Integration test running Jury end-to-end against a stub adapter, asserting parallel agents see the same prior state.

## 4. UI Timeline update

- [ ] 4.1 Detect `parallel_group` on turn records; render siblings as a row (visual grouping) rather than a vertical stack.
- [ ] 4.2 Confirm pre-existing transcripts (no `parallel_group`) render identically to before.
- [ ] 4.3 Component test: Timeline with one parallel group of four siblings followed by a synthesis turn.

## 5. Documentation

- [ ] 5.1 Update README presets section with Jury and a one-line note about when to choose it.
- [ ] 5.2 Document the order-bias rationale in `docs/topology.md`.
