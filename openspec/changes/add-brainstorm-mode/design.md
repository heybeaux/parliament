## Context

The `/brainstorm` and `/brainstorm/forge` routes shipped as aliases over `runIdeation()`. Per the Pax → Rook handover (`docs/2026-05-23-rook-handover-brainstorm-forge-training-pattern.md`), the routes are real but the runtime is wrong: ideate's pipeline is built to *converge* on a single seed idea, while brainstorm's whole purpose is *divergence + ranking*. The fix is a genuinely new reasoning pattern, not more aliasing.

The previous `refine-ideate-forge` design explicitly rejected `brainstorm` as a sub-mode of ideate. That call was correct: ideate's sub-modes (`cooperative`, `adversarial`, `full`) encode *lineup defaults and phase ordering for one idea*. Brainstorm has different phases, a different output shape (N ranked ideas vs one synthesis), and different lineup logic. It deserves the top-level slot for the same reason `deliberate` does.

This change is spec-only. Implementation lands in a sibling change.

## Goals / Non-Goals

**Goals:**
- A distinct top-level mode `brainstorm`, with its own orchestrator (`runBrainstorm`) that MUST NOT call `runIdeation()`.
- Output shape: ranked list of candidate project ideas, each with stable identity (title, one-liner, dimension tags, scores, rationale).
- Reduce concept drift across reruns by anchoring rank on a fixed, configurable criteria set. Same prompt + same criteria + same lineup should produce stable rankings even if exact prose drifts.
- Reuse `runDedupePhase` from `ideate/dedupe.ts` so the dedupe story stays unified.
- Forge is a *continuation* of brainstorm, not a separate top-level mode. `/brainstorm/forge` runs the brainstorm pipeline and then forges the top-K winners. This preserves the route convention from the v0 alias while giving the route real semantics.

**Non-Goals:**
- No streaming. SSE / WebSocket surfacing of intermediate phases is out of scope; the existing fire-and-forget + poll pattern is reused.
- No multi-round refinement of rankings. One rank phase, one set of scores.
- No critique / defense phases. Brainstorm explicitly does not run an adversarial pass — divergence + judging is the whole pattern.
- No persistence migration tooling for the v0 alias-era brainstorm rows. There are none in production today (the routes were aliases; rows landed in `ideations`). If any test fixtures depend on the alias behavior they get rewritten in tasks.md.
- No UI work. Stage 4 still owns UI.

## Decisions

### Top-level mode, not a sub-mode of ideate

Brainstorm has different phases (generate / dedupe / cluster / rank), a different output shape (ranked array vs single synthesis), a different lineup (judges, not adversaries), and an optional forge continuation. Squeezing it into ideate's sub-mode slot would force one of two bad outcomes: (a) overloading `runIdeation` to branch on sub-mode and produce a different output shape, or (b) silently producing a single-idea synthesis when the user asked for ranked candidates. Both make the routes lie about what they do. A separate top-level mode keeps each pattern coherent.

**Alternative considered:** add `brainstorm` as a fourth sub-mode of ideate. Rejected — the existing `refine-ideate-forge/design.md` already considered and rejected this. The reasoning still holds: sub-modes encode "which models run, in what order, for one seed idea." Brainstorm's shape doesn't fit.

**Alternative considered:** make `forge` its own top-level mode parallel to `brainstorm`. Rejected — forge always operates on brainstorm output; making it independent would force callers to thread a brainstorm ID into a separate POST, doubling the request count for the common case. Keeping `/brainstorm/forge` as a brainstorm continuation matches the route convention Pax shipped and matches the natural workflow.

### Four phases, plus optional forge

The pipeline:

```
divergent-generation → idea-dedupe → idea-cluster → idea-rank → [forge-elaboration]
```

- **divergent-generation** owns the "produce many ideas" part. N parallel divergent authors, each producing K ideas. Parallel only — sequential would let later authors converge on earlier ones, defeating the point.
- **idea-dedupe** reuses `runDedupePhase` unchanged. Same provider order, same threshold defaults, same soft-fail semantics. The merge map is preserved on the phase record so the rank phase knows which ideas were collapsed into which.
- **idea-cluster** groups survivors into thematic clusters. Cluster labels are model-generated and serve as a UI hint and a rank-phase context primer; they do NOT affect scoring directly.
- **idea-rank** scores each surviving idea on a fixed criteria set with independent judges. Final rank is a weighted sum of per-criterion scores. Weights are configurable via TOML; defaults are equal weights across all four criteria.
- **forge-elaboration** is opt-in, triggered only by `/brainstorm/forge`. For each of the top-K ideas, run a lightweight cooperative elaboration. This step MAY share code with `runCooperativeBuild` from ideate, but the brainstorm orchestrator owns the call and the result shape — no calls into `runIdeation()`.

Phase order is hard-coded. There is no `phases` overrideable surface in v1.

### Lineup separation: divergent authors vs judges

Independence of judging from authoring is the anchor for reduced drift across reruns. If the same models that produced the ideas also rank them, you get rationalization rather than evaluation, and the ranking inherits the same biases as the generation.

Default lineup:
- Divergent authors (4): Claude Opus 4.6, Gemini 2.5 Pro, GPT-5, DeepSeek V4 Flash.
- Judges (2): Claude Sonnet 4.6, GPT-5.

GPT-5 appears in both pools, which is unavoidable given the small frontier-model set. The orchestrator MUST enforce author-aware judging: when a judge model is asked to score an idea it authored, that judge MUST be skipped for that idea (the other judge's score is used; if both judges authored, the idea is scored only by the non-author or, in the degenerate case where both authored, only by `consensus` of the cluster — see open questions). Per-idea author identity is recorded in the divergent-generation phase record specifically to support this filter.

### Criteria set is fixed in v1

Four criteria, each scored 0–10 with a one-line rationale:

- **novelty** — how different is this idea from what already exists in this space?
- **feasibility** — could a small team realistically ship a v1 in 90 days?
- **fit** — how well does this match the prompt's intent and constraints?
- **evidence** — how strong is the underlying signal that this is worth building?

The criteria set is locked in v1 specifically because allowing arbitrary criteria sets per-run would destroy cross-run comparability — defeating the whole "reduced drift" goal. A future change can add a small closed enum of alternative criteria sets (e.g., "research-focused", "consumer-product") once we have usage data on whether the v1 set is too narrow.

**Alternative considered:** let users define their own criteria per run via TOML or request body. Rejected for v1 — the drift story collapses if every run uses different criteria. The escape hatch is reweighting via `[brainstorm.rank.weights]`, which keeps the criteria stable but lets users prioritize differently.

### Identity preservation across reruns is a design property, not a feature flag

Each idea carries a deterministic `idea_id` derived from a stable hash of `(title, one-liner)` after dedupe. Reruns on the same prompt that produce the same title+one-liner pair MUST surface as the same `idea_id`. This isn't a guarantee — models drift — but it gives downstream tools a chance to recognize "this is the same idea we ranked last week" without doing fuzzy matching themselves.

**Alternative considered:** use an LLM-generated stable slug. Rejected — adds a model call and the slug itself drifts. Hash is deterministic, cheap, and good enough for the "is this the same idea" check.

### Forge reuses elaboration primitives, not the full ideate pipeline

The forge phase needs to elaborate a candidate idea into something richer — a one-page-ish project sketch. The temptation is to call `runIdeation(idea, 'cooperative')` because that does exactly that. Rejected for two reasons:

1. `runIdeation` runs dedupe, optional adversarial, and synth for a *single seed*. Brainstorm's forge wants K elaborations in parallel; coordinating K concurrent `runIdeation` calls is the wrong abstraction.
2. The brainstorm orchestrator owning forge means we can evolve elaboration semantics (e.g., feeding cluster context to the elaborator) without coupling to ideate's evolution.

So forge uses a new lightweight `elaborateIdea(idea, lineup)` primitive that internally MAY share helper functions with `runCooperativeBuild` (specifically the per-role prompt assembly and adapter dispatch), but is its own entry point.

### `runDedupePhase` is reused unchanged

Brainstorm's idea-dedupe phase is the same operation as ideate's: cosine-collapse near-duplicate drafts. The existing primitive in `ideate/dedupe.ts` handles provider order, soft-fail, threshold, and audit. Cross-importing this from `brainstorm/orchestrator.ts` is fine — both modules live under `@parliament/core` and dedupe is general-purpose, not ideate-specific.

The `assertCritiquesNotDeduped()` lock from ideate remains in effect everywhere it currently applies. Brainstorm has no critiques, so the lock is moot in this module.

### `/brainstorm/forge` is one POST, not a chained two-call workflow

Doing `POST /brainstorm` then `POST /brainstorm/:id/forge` would be more REST-pure but doubles request count and forces the client to poll twice for the common case ("run brainstorm and forge the winners"). One POST that internally runs both phases is what the route already implies and what users want. The brainstorm ID returned from `/brainstorm/forge` covers the full pipeline including the forge step; status transitions `running` → `complete` cover the whole run.

`GET /brainstorm/:id` returns the same shape regardless of which POST started the run — `elaborations` is present only when forge ran.

## Risks / Trade-offs

- **Judge bias from shared model pool.** [Risk] GPT-5 appears in both divergent authors and judges. Even with the author-aware skip, GPT-5 may systematically over-rate ideas in the style it would have written. → Mitigation: author-aware skip is enforced (not optional); Sonnet 4.6 provides a second-opinion check; TOML override lets advanced users use a fully disjoint pool when budget allows.

- **Anti-convergence prompting can produce low-quality novelty.** [Risk] Pushing models toward divergence can backfire — outputs become contrived rather than useful. → Mitigation: criteria-anchored ranking surfaces this naturally; bad-novelty ideas score low on feasibility and evidence; downstream forge focuses on top-K only.

- **Cluster phase adds latency without obvious user value in v1.** [Risk] If users don't read the cluster labels, we pay for an extra model call per run for nothing. → Mitigation: cluster output also primes the rank phase (judges see cluster context, which improves cross-cluster comparison). If usage data shows the cluster output is unused, it can be removed without changing the rank surface.

- **Forge-as-continuation breaks REST purity.** [Risk] `/brainstorm/forge` is doing two things; a strict-REST reviewer would prefer chained calls. → Mitigation: route is named `/brainstorm/forge` (action-as-resource), pattern matches what's already shipped, and the cost of doubling poll loops outweighs purity. Internal naming keeps the two phases distinct (`runBrainstorm` vs `forgeElaboration`).

- **Deterministic `idea_id` collisions on rerun.** [Risk] Two genuinely different ideas could produce the same title+one-liner hash on different runs. → Mitigation: collision is harmless within a single run (dedupe catches same-title duplicates) and across runs only matters for the "is this the same idea" check, which is best-effort. If collisions become a real problem we add a third hash input (e.g., dimension tags).

- **Weighted-sum ranking masks per-criterion divergence.** [Risk] Two ideas with the same total may have wildly different per-criterion profiles. → Mitigation: per-criterion scores are persisted on the rank phase record; the API surfaces them; only the *final rank* uses the weighted sum.

- **The break in `/brainstorm` response shape will surprise any existing programmatic caller.** [Risk] Anyone already hitting `/brainstorm` gets a different shape back. → Mitigation: current behavior is itself the bug per Pax's handover; release note + version bump signals the change; CLI users only see the new shape via the new `parliament brainstorm` command.

## Migration Plan

The break is acceptable because the current behavior is itself the bug (Pax's handover). Steps:

1. New spec lands; sibling implementation change creates `packages/core/src/brainstorm/`, `packages/server/src/routes/brainstorm.ts`, new Zod schemas, new `brainstorms` table migration.
2. In the implementation change, the existing alias routing in `routes.ts` is removed: `app.post('/brainstorm', handleIdeate)` and `app.post('/brainstorm/forge', handleIdeate)` are deleted. `app.post('/ideate', handleIdeate)` stays.
3. New routes register two distinct handlers. `GET /brainstorm/:id` reads from the new `brainstorms` table; it MUST NOT fall back to `ideations`.
4. CLI: `parliament brainstorm` is a new command; the existing aliasing in the CLI (if any) is removed in the same change.
5. Release note flags the shape change and points callers at the new response schema.
6. Rollback: revert the implementation change. Spec change can stay (it has no runtime effect); the alias routing in v0 can be restored from git history if absolutely necessary, but doing so reintroduces Pax's documented bug.

## Resolved Decisions (locked 2026-05-24)

- **Both judges authored a given idea.** Locked: option (a) — `score: null` plus `judge_skipped: true` on the idea record. Rationale: honest, rare, and avoids fabricating a score from a biased judge. The idea still appears in the ranked list, sorted to the bottom, with `judge_skipped: true` so the UI can flag it. Downstream forge MUST exclude `score: null` ideas from top-K selection (treat as ineligible, not as zero).
- **Forge accepting an idea-ID list from a prior brainstorm.** Deferred to a follow-up change. v1 ships `POST /brainstorm/forge` as one-shot top-K only. If usage shows users want to cherry-pick winners from an old run, add `POST /brainstorm/:id/forge` with an optional `idea_ids` body field then.
- **Cluster labels stay model-generated and un-normalized.** No taxonomy in v1. Labels are advisory; UI treats them as free-form strings.
- **Rank weights live in TOML, overridable via request body.** TOML provides defaults under `[brainstorm.rank.weights]` (keys: `novelty`, `feasibility`, `fit`, `evidence`, all numeric; default 1.0 each). Request body MAY include `rank_weights: { novelty?, feasibility?, fit?, evidence? }` to override per-run. Body-supplied weights MUST be partial-replace (specified keys override; unspecified keys keep TOML default). Weights are normalized to sum to 1.0 before scoring.
- **Judges score independently / parallel.** No anchoring. Locked.

## Open Questions

(None — all resolved above. New questions surfaced during implementation get added back here and re-decided before the affected section lands.)
