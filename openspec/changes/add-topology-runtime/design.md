## Context

The existing engine constructs the five agents in code and runs them in a fixed order, looped per round. To honor the topology spec, that hardcoding has to dissolve into data: a `Topology` object the engine executes.

Two specific risks shape this design:

1. **The Debate preset must remain byte-identical.** Users have run deliberations against the current pipeline; their archived transcripts are reproducible only if Debate keeps producing the same sequence and the same prompts.
2. **The Sentry isn't a step.** The Sentry watches the blackboard for echo collapse and may trigger the RedAgent; it's not in the pipeline order. The runtime has to keep treating it as out-of-band even though steps are now declarative.

## Goals / Non-Goals

**Goals:**
- Engine reads `[topology]` and `[neurotypes]`; falls back cleanly when absent.
- Six presets shipped, each with full metadata.
- Existing Debate-pipeline behavior preserved at the byte level.
- Sentry continues to run out-of-band across every preset.
- Helpful error messages when configs reference unknown presets or neurotypes.

**Non-Goals:**
- Parallel steps. Sequential only in this stage; parallel comes in `add-jury-parallel`.
- Topology composition (a topology that delegates to a sub-topology). Not on the roadmap.
- Per-step model overrides at the step level. Model assignment lives at the neurotype level.
- UI surfacing of presets. `add-observability-ui` owns that.

## Decisions

### Resolution happens once, at config load

The loader produces a fully-resolved `Topology` object: every step's `neurotype` field is replaced with a concrete agent constructor. The engine never re-resolves at runtime. Reasoning: keeps execution paths fast and makes resolution errors load-time, not deliberation-time.

### Sentry is engine infrastructure, not a step

The Sentry's role doesn't change. It still attaches to the blackboard and watches for echo collapse. It is not represented in any preset's `steps` array. This is intentional: the Sentry is *meta* — it observes the deliberation and reacts — and modeling it as a step would either make it run synchronously (changing semantics) or require a parallel-step abstraction (which we're not building yet).

### Built-in presets live in code, not in `parliament.toml`

The six presets are TypeScript constants in the registry, not embedded in a sample `parliament.toml`. Reasoning: users shouldn't be able to break Debate by editing their config. The config is for *additional* presets and for `active`-selection.

### Optional steps are honored even with no skip conditions

In Stage 1, `optional: true` steps will run anyway because no skip conditions are defined yet. The flag is wired up so future stages can add condition evaluation without changing the schema. This is the strict-by-default semantic: the absence of skip conditions means "run it."

### Unknown active preset is a hard error

`[topology] active = "nonexistent"` MUST fail at load time with a list of available preset names. Silent fallback to Debate would be a foot-gun: the user thinks they're running their custom topology and is actually running Debate.

## Risks / Trade-offs

- **Refactor surface area.** The orchestrator is one of the more touched files in core. Mitigation: integration test in §5.2 of tasks ensures Debate is byte-identical.
- **Preset metadata duplication.** Both `add-topology-spec` and built-in presets define metadata. Trade-off accepted: the spec defines the *requirement*, the registry defines the *values*. Different layers, same constraint.
- **Sentry-as-infrastructure leaks abstraction.** A user who reads a preset definition won't see "Sentry" in the steps and may think it's missing. Mitigation: documentation in tasks §6.1 explicitly states Sentry runs in every preset.
- **Default fallback is silent.** Absence of `[topology]` falls back to Debate with an info-level log. Some users will miss the log. Trade-off accepted: noisy fallback (warn-level) would burn into every existing user's terminal on first run after upgrade. Info-level is the right balance.
