## Why

`add-topology-spec` defines the schema for `[topology]` and `[neurotypes]` in `parliament.toml`. This change wires the engine to read that schema, resolve neurotypes, and execute the active preset. Without this, the spec is documentation; with this, Parliament becomes topology-driven.

This stage also ships the six built-in sequential presets so end users have something useful out of the box without writing custom topologies.

## What Changes

- `@parliament/core` gains a TOML loader for `[topology.*]` / `[neurotypes.*]`, validating against the rules in `add-topology-spec`.
- The deliberation engine consumes a resolved `Topology` object instead of the hardcoded five-agent pipeline.
- Six built-in presets ship in core, each with required metadata (`name`, `description`, `best_for`):
  - **Debate** — the original five-agent pipeline. Default.
  - **Star Chamber** — Proposer is interrogated by Skeptic + Devil's Advocate + Empiricist before Synthesizer reconciles.
  - **Chain-of-Verifiers** — Proposer → Empiricist → Steelmanner → Skeptic → Synthesizer. Each verifier's output feeds the next.
  - **Socratic** — Proposer's claim is dissected by Translator (assumptions) → Empiricist (evidence) → Skeptic (logic) → Synthesizer.
  - **Long-View** — Historian → Proposer → Forecaster → Pragmatist → Synthesizer. Temporal-spanning posture.
  - **Reframe** — Lateralist → Translator → Steelmanner → Synthesizer. Pulls a question out of its original framing.
- The Sentry runs as an out-of-band watcher in every preset, not as an explicit step (consistent with current behavior).
- `[topology] active = "<preset-name>"` selects which preset runs. Absence of `[topology]` falls back to Debate.

## Capabilities

### New Capabilities
- `topology-runtime`: The engine subsystem that loads, validates, and executes topology configurations. Owns preset registry and step execution order.

### Modified Capabilities
<!-- None at the requirement level — the existing deliberation behavior is preserved as the Debate preset's behavior. The mechanism changes (config-driven instead of hardcoded), but the observable contract for the default case is unchanged. -->

## Impact

- **@parliament/core**: new `topology/` module (loader, validator, registry, executor); refactor of the deliberation orchestrator to consume a `Topology` instead of a fixed agent list.
- **@parliament/server**: deliberation endpoint accepts an optional `preset` parameter. When omitted, the server uses the active preset from `parliament.toml`.
- **@parliament/cli**: gains `--preset <name>` flag.
- **Backward compatibility**: existing `parliament.toml` files (no `[topology]`) keep producing identical Debate-pipeline output.
- **Roadmap**: Stage 1. Depends on `add-topology-spec` (schema) and `add-eight-neurotypes` (so non-Debate presets can resolve). Unblocks Stage 3 (UI surfacing) and Stage 4 (parallel execution).
