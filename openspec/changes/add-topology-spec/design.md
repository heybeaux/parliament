## Context

Parliament was built around a fixed five-agent pipeline. Adding new neurotypes, parallel execution, and conditional skip logic — all on the roadmap — means the pipeline shape must become data, not code. Before writing the runtime that consumes that data, the data shape itself needs a contract.

The PNAS Nexus paper's structural claim is that *diversity of cognitive posture* produces resilience. A topology spec is the user-facing knob that exposes that claim. If the spec is sloppy, every downstream stage inherits the sloppiness.

## Goals / Non-Goals

**Goals:**
- A TOML schema users can read top-to-bottom and understand what a deliberation will do.
- Strict-by-default execution semantics: opt out per step, never per default.
- Preset metadata baked in from the start so UI work in Stage 3 isn't a config break.
- Hard validation errors for the foot-gun cases (duplicate step IDs, undefined neurotype references, missing metadata).

**Non-Goals:**
- Implementing the runtime that reads this schema — that's `add-topology-runtime` (Stage 1).
- Defining the eight new neurotypes — that's `add-eight-neurotypes` (Stage 1). This spec only requires that *some* neurotype identifier exists; the inventory is owned by the neurotype change.
- Parallel-step semantics — that's `add-jury-parallel` (Stage 4). Stage 0 only specifies sequential `steps`.
- A composable / DAG-style topology builder — explicitly future work; presets only for now.

## Decisions

### Strict-by-default with `optional: true` opt-in

Every step listed in a preset's `steps` array MUST run when that preset executes, unless the step explicitly declares `optional: true`. Skip conditions are then evaluated at runtime (this stage doesn't define the conditions — only that the step has opted into being skippable).

**Why strict-by-default:** the failure mode of a deliberation tool is *quietly running fewer agents than the user thought were running*. Defaulting to "always run" is the safer error: the user notices a slow deliberation, they don't notice a missing perspective.

### Preset metadata required, not optional

Every preset MUST declare `name`, `description`, and `best_for`. Even though Stage 0/1 don't surface these, Stage 3 will, and adding required fields to a TOML schema later is a breaking change for every user config file in the wild. Costs nothing now, saves a refactor later.

### Neurotype references are by ID, not by class

Steps reference neurotypes by string ID (`"proposer"`, `"skeptic"`, `"historian"`). Resolution to a class happens in the runtime, not in the spec. This keeps the config format independent of TypeScript class names.

### Unknown neurotypes are a hard error

If a step references a neurotype ID that isn't defined in `[neurotypes.*]` and isn't a built-in, loading the config MUST fail. No silent skipping. Reasoning: a typo in a neurotype name should not change which voices participate in the deliberation.

## Risks / Trade-offs

- **Lock-in to TOML structure.** Once users write `parliament.toml` files against this spec, restructuring `[topology]` becomes a breaking change. Mitigation: required preset metadata up front, sequential `steps` only (parallel comes later as additive `parallel_steps`, not as a structural revision).
- **Schema-runtime drift.** Spec lands in Stage 0, runtime in Stage 1. Risk that runtime authors discover the spec doesn't fit. Mitigation: the same author dispatches both; Stage 1 tasks include "if you need to revise the spec, do it in a follow-up change, not silently."
- **Preset metadata bloat.** Three required fields per preset is friction for users defining custom presets. Trade-off accepted: friction now beats a forced-migration later.
