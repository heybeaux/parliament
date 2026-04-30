## 1. Loader and validator

- [ ] 1.1 Implement TOML loader for `[topology.*]` and `[neurotypes.*]` in `@parliament/core/src/topology/loader.ts`.
- [ ] 1.2 Implement validator enforcing the rules from `add-topology-spec` (required preset metadata, unique step IDs, defined neurotype references, optional-step opt-in semantics).
- [ ] 1.3 Unit tests covering each validation failure mode (duplicate step IDs, undefined neurotype, missing metadata, unknown active preset name).

## 2. Built-in preset registry

- [ ] 2.1 Implement six built-in preset definitions: Debate, Star Chamber, Chain-of-Verifiers, Socratic, Long-View, Reframe.
- [ ] 2.2 Each preset MUST declare `name`, `description`, `best_for`.
- [ ] 2.3 Unit test that every built-in preset references only registered neurotype IDs.

## 3. Engine wiring

- [ ] 3.1 Refactor the deliberation orchestrator to accept a resolved `Topology` and execute steps in order.
- [ ] 3.2 Preserve Sentry's out-of-band watcher behavior across all presets.
- [ ] 3.3 Honor `optional: true` step skipping (skip conditions can be a no-op stub for now; real conditions land with later changes).
- [ ] 3.4 Ensure existing tests covering the Debate pipeline still pass without modification.

## 4. Server and CLI integration

- [ ] 4.1 Add optional `preset` field to the deliberation endpoint request body.
- [ ] 4.2 Add `--preset <name>` flag to `@parliament/cli`.
- [ ] 4.3 Server falls back to the config's active preset when `preset` is omitted.
- [ ] 4.4 Server returns a 400 with a helpful message when an unknown preset name is requested.

## 5. Integration tests

- [ ] 5.1 End-to-end test running each of the six presets against a stub model adapter.
- [ ] 5.2 End-to-end test confirming Debate output is byte-identical (modulo timestamps) to the pre-refactor output.

## 6. Documentation

- [ ] 6.1 Update README with a section on topology presets and how to switch.
- [ ] 6.2 (deferred to Stage 3) Surface presets in the UI picker.
- [ ] 6.3 (deferred to Stage 4) Document `parallel_steps` in the topology section.
