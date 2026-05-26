## Why

`add-ideate-mode` shipped the cooperative→adversarial→rebuttal→synth state machine, but using it surfaced four sharp edges. Cooperative phases produce overlapping drafts that bloat the adversarial-phase prompt and dilute critique signal. The rebuttal round always runs when there's an adversarial phase, with no way to skip it for "quick sketch" brainstorms. Cooperative authors handle critiques with ad-hoc prose, making rebuttal quality model-luck. And critiques are unlabeled — the synthesizer can't tell a UX problem from a legal one, and there's no architectural lock preventing a future change from "deduping" critiques and erasing the multi-model diversity signal that ideate's whole reason for existing depends on.

This change is a refinement to the already-implemented `ideate-mode` capability. Scope is spec-only — code lands in a follow-up.

## What Changes

- **Idea-level dedupe phase** between cooperative-build and adversarial-critique. Embed each draft idea, pairwise-cosine, collapse pairs at-or-above `dedupe_threshold` (default `0.85`) into the higher-confidence/longer survivor. Embedding provider order: local `engram-embed` at `http://localhost:8080`, then Engram Cloud (`api.openengram.ai`). If both fail, emit `phase.warning` and skip dedupe — never fail the whole ideation. New event `phase.dedupe { kept, merged_into }`.
- **`critique_cycles` as first-class request parameter** (`0 | 1`, hard-capped at 1 in v1). Default `1` for `adversarial` and `full`, `0` for `cooperative`. `critique_cycles = 0` is the "Quick Sketch / Brainstorm" path: cooperative → dedupe → synth, no adversarial pass. Orthogonal to sub-mode — `full` with `critique_cycles = 0` is a valid combo. Values `> 1` are rejected with HTTP 400.
- **Rebuttal phase renamed to "defense"** with a new `defense_mode` parameter (`address | double_down | author_choice`, default `author_choice`). Each cooperative author responds to each critique with one stance: `address` rewrites the relevant draft slice; `double_down` keeps position and justifies in one paragraph. `author_choice` lets the author pick per-critique. Output schema is structured `{ defenses: [{ critique_id, stance, reasoning, draft_delta? }] }` with one parse-retry. `runRebuttalPhase` stays exported as a deprecated alias to `runDefensePhase` for backward compat.
- **Critique payload gains `dimension`** (`ux | business | technical | market | legal | other`) on every problem. Synth uses dimension to group and weight. Pax's lock: never dedupe critiques. `POST /ideate` rejects `dedupe_critiques: true` with HTTP 400 ("critique dedupe disabled by design — multi-model perspective signal is preserved").
- Server validation extended for `critique_cycles ∈ {0,1}`, `dedupe_threshold ∈ [0,1]`, `dedupe_critiques !== true`.
- CLI gains `--critique-cycles`, `--defense-mode`, `--no-dedupe`, `--dedupe-threshold`.
- TOML gains `[ideate.dedupe]` (`provider_order`, `threshold`, `enabled`) and `[ideate.defense]` (`mode`).
- `ideations.phases` JSON absorbs new `dedupe` and `defense` entries — no schema migration.
- All new params optional. Existing `POST /ideate` calls keep working.

## Capabilities

### Modified Capabilities
- `ideate-mode`: gains dedupe phase, `critique_cycles` parameter, `defense_mode` parameter with renamed defense phase (rebuttal preserved as deprecated alias), critique `dimension` field, and architectural lock against critique dedupe.

## Impact

- **@parliament/core**: new `ideate/dedupe.ts` (embedding fallback + cosine collapse). `ideate/orchestrator.ts` gains a dedupe step between cooperative and adversarial, and a `runDefensePhase` (with `runRebuttalPhase` aliased). Adversarial JSON schema and parser updated to require `dimension`.
- **@parliament/server**: `POST /ideate` validates the three new params and rejects `dedupe_critiques: true`. No new routes, no new tables.
- **@parliament/cli**: four new flags on `parliament ideate`.
- **@parliament/ui**: unaffected (still deferred to Stage 4).
- **Backward compatibility**: every new param is optional with a default that matches pre-change behavior, except dedupe — which is on by default. Disable with `--no-dedupe` or `[ideate.dedupe] enabled = false`. Disabling is a single flag so the escape hatch is obvious.
- **Cost**: dedupe adds one embedding call per draft (cheap; local engram-embed is free). `critique_cycles = 0` materially lowers cost on `full` (cooperative + dedupe + synth ≈ 1/3 the model calls of full-with-defense). No new spend introduced; `defense_mode` is a relabel, not a new pass.
- **Roadmap**: refinement on Stage 3. Does not unblock or block Stage 4.
