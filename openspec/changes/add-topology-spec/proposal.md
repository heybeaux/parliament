## Why

Parliament currently hardcodes a single deliberation pattern: Proposer → Skeptic → Synthesizer → RedAgent → Sentry, looped per round. The PNAS Nexus paper that inspired this project argues the safety property comes from cognitive diversity *across structures*, not just across models. To experiment with that — and to let end users pick a deliberation shape that matches their question — we need topology and neurotype configuration to be a first-class part of `parliament.toml`.

This change is **spec only** (Stage 0). It defines the configuration schema. Runtime that consumes the schema, new neurotype implementations, and UI surfacing all land in later stages and reference this spec.

## What Changes

- Adds a new `topology` capability (configuration surface) to `@parliament/core`.
- Defines `[topology.*]` and `[neurotypes.*]` sections in `parliament.toml`.
- Establishes **strict-by-default execution semantics**: every step in a topology runs unless explicitly marked `optional: true`.
- Establishes preset metadata as a required schema element (`name`, `description`, `best_for`) so future UI work doesn't break the config format.
- Specifies validation rules: unknown neurotypes, duplicate step IDs, references to undefined neurotypes, missing required metadata are all hard errors.

## Capabilities

### New Capabilities
- `topology`: Declarative configuration of which neurotypes participate in a deliberation, in what order, with what metadata. Stage 0 specifies the schema; Stage 1+ implements the runtime.

### Modified Capabilities
<!-- None — Stage 0 introduces a new capability without changing existing requirement-level behavior. -->

## Impact

- **@parliament/core**: new TOML schema definition; loader update happens in `add-topology-runtime` (Stage 1).
- **parliament.toml** (user-facing): adds optional `[topology]` and `[neurotypes]` sections. Absence falls back to the existing default (Debate preset).
- **No breaking changes** in this stage — existing `parliament.toml` files continue to work because the new sections are additive.
- **Roadmap**: unblocks Stage 1 (runtime + 8 new neurotypes), Stage 2 (presets shipped), Stage 3 (observability UI), Stage 4 (Jury parallel preset).
