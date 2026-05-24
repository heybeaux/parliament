## Why

`/brainstorm` and `/brainstorm/forge` are currently route aliases over `runIdeation()`. They share its lineup, phase ordering, and single-idea-in / single-synthesis-out shape. That is not what the routes were supposed to do.

The actual product need is *divergent project ideation*: generate many candidate project ideas in one run, rank them by configurable criteria, and reduce concept drift across reruns. `runIdeation()` is built for the opposite shape — *converging* on a single seed idea via cooperative elaboration plus adversarial critique. Forcing brainstorm through it produces "ideate behind a different URL," which is what the handover doc (`docs/2026-05-23-rook-handover-brainstorm-forge-training-pattern.md`) flagged.

The previous `refine-ideate-forge` design explicitly rejected a `brainstorm` sub-mode of ideate. That decision was correct *for ideate's shape* — sub-modes encode lineup defaults and phase ordering for refining one idea. Brainstorm is a different shape entirely (N divergent ideas → cluster → rank → optional forge), so it belongs as a top-level mode parallel to `ideate` and `deliberate`, not as another sub-mode.

This change is spec-only. Code follows in a sibling change.

## What Changes

- A new top-level mode `brainstorm`, parallel to `ideate` and `deliberate`. Its runtime is a distinct orchestrator (`runBrainstorm()`) that MUST NOT call `runIdeation()`.
- Two top-level operations under the brainstorm surface:
  - `POST /brainstorm` — divergent ideation, dedupe + cluster, rank. Returns N ranked candidate ideas, no per-idea elaboration.
  - `POST /brainstorm/forge` — runs the brainstorm pipeline, then forges the top-K winners by delegating each to a lightweight elaboration step. Forge is a continuation of brainstorm, not an independent mode.
- A new four-phase pipeline distinct from ideate's:
  1. `divergent-generation` — N parallel divergent authors, each producing K candidate ideas with explicit identity fields (title, one-liner, dimension tags, rationale). Higher temperature, anti-convergence prompt. Style is always parallel — collective sequencing is incompatible with divergent generation.
  2. `idea-dedupe` — collapse near-duplicates *across authors* using the existing `runDedupePhase` primitive from `@parliament/core/ideate/dedupe.ts`. Same provider order, same soft-fail semantics.
  3. `idea-cluster` — semantic clustering over survivors, producing a small number of thematic groups. Cluster labels are part of the output.
  4. `idea-rank` — independent judge models score each surviving idea on a fixed criteria set (novelty, feasibility, fit, evidence). Each criterion is scored 0–10 with a one-line rationale. Final rank is a configurable weighted sum.
- Forge phase (only when invoked via `/brainstorm/forge`):
  5. `forge-elaboration` — for the top-K ideas (K configurable, default 3), each is elaborated by a lightweight cooperative pass. The elaboration MAY internally reuse parts of the ideate pipeline (specifically `runCooperativeBuild`-style elaboration) but the brainstorm orchestrator owns the boundary: forge invokes its own elaborator, not `runIdeation()`.
- New persistence: `brainstorms` table mirroring the shape of `ideations`. Columns: `id`, `created_at`, `prompt`, `mode` (`brainstorm` | `brainstorm/forge`), `status`, `lineup`, `phases`, `rankings`, `elaborations` (only on forge), `error`. JSON columns follow the same free-form pattern as `ideations.phases`.
- New default lineup tuned for divergent generation. Distinct from ideate's lineup:
  - **Divergent authors (4)**: chosen for breadth and willingness to propose unconventional ideas — Claude Opus 4.6, Gemini 2.5 Pro, GPT-5, DeepSeek V4 Flash.
  - **Judges (2)**: chosen for calibrated scoring — Claude Sonnet 4.6 and GPT-5. Judges MUST be a non-overlapping pool from divergent authors when possible; the spec MUST NOT silently let a divergent author also judge its own idea (per-idea author identity is recorded; the rank phase MUST skip judges that authored an idea being scored).
  - **Forge elaborator (1)**: Claude Opus 4.6.
- New HTTP routes `POST /brainstorm`, `POST /brainstorm/forge`, `GET /brainstorm/:id`. The two POST routes MUST resolve to two distinct handlers with distinct request schemas — they MUST NOT share a `handleIdeate`-style handler.
- New CLI command `parliament brainstorm "<prompt>" [--forge] [--k=N] [--ideas-per-author=K]`.
- New TOML block `[brainstorm]` for lineup, criteria weights, K, and ideas-per-author overrides.
- `/ideate` and `/deliberate` are unchanged. Brainstorm is purely additive.

## Capabilities

### New Capabilities

- `brainstorm-mode`: A reasoning pattern specialized for divergent project ideation. Owns the four-phase generate → dedupe → cluster → rank pipeline, plus the optional forge elaboration step. Distinct from `ideate-mode`; MUST NOT route through it.

### Modified Capabilities

<!-- None. Brainstorm reuses `runDedupePhase` from ideate-mode but does not modify its requirements. -->

## Impact

- **@parliament/core**: new `brainstorm/` module mirroring the `ideate/` layout (`orchestrator.ts`, `types.ts`, `lineup.ts`, `prompts.ts`, `rank.ts`, `cluster.ts`, `forge.ts`). Reuses `ideate/dedupe.ts` as-is for the idea-dedupe phase.
- **@parliament/server**: new `POST /brainstorm`, `POST /brainstorm/forge`, `GET /brainstorm/:id` routes; new `brainstorms` table with its own migration; new request/response Zod schemas. The existing alias-style routing in `routes.ts` MUST be removed — the new handlers replace it.
- **@parliament/cli**: new `parliament brainstorm` command. `--forge` toggles the forge phase. `--k` controls forge breadth. `--ideas-per-author` controls divergent fan-out.
- **@parliament/ui**: (deferred) brainstorm viewer with cluster + ranking surfaces. This change ships API + CLI only.
- **Backward compatibility**: the *behavior* of `POST /brainstorm` and `POST /brainstorm/forge` changes — they no longer return ideate-shaped responses. This is a deliberate break; the current behavior is the bug. The response shape change is documented in tasks.md migration steps and a release note. `ideations` table is untouched.
- **Cost**: a default `/brainstorm` run is 4 divergent authors × K ideas + clustering (1 model call) + 2 judges × surviving ideas (one batched call per judge). At K=5 with ~12 survivors after dedupe that's roughly 7 model calls plus the per-judge batched scoring — materially cheaper than ideate-full. `/brainstorm/forge` adds the elaborator cost per top-K idea (default 3), bringing total to ~10–12 calls.
- **Roadmap**: builds on `add-ideate-mode` (reuses dedupe) and the existing topology runtime. Unblocks a brainstorm-aware UI surface and future "auto-promote winners to ideate" workflows.
