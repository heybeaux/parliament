# Tasks — add-brainstorm-mode

Per-section commits, just like `refine-ideate-forge`. Don't bundle.

## Section 1 — Spec lock

- [x] 1.1 `openspec validate add-brainstorm-mode --strict` passes.
- [x] 1.2 Walk Beaux through the spec; lock open questions in design.md.
- [ ] 1.3 Merge spec change before any code lands. *(deferred — per-section commit pattern; whole change merges at end)*

## Section 2 — Core: types + orchestrator skeleton

- [x] 2.1 New module `packages/core/src/brainstorm/` with `types.ts`, `orchestrator.ts`, `lineup.ts`, `prompts.ts` stubs.
- [x] 2.2 `BrainstormMode = 'brainstorm' | 'brainstorm/forge'` (string literal, not a sub-mode enum).
- [x] 2.3 `RunBrainstormInput` + `RunBrainstormResult` types matching the design doc's output shape (phases array, rankings array, optional elaborations array).
- [x] 2.4 `runBrainstorm()` entry point throws "not implemented" but the shape exists so server + tests can compile.
- [x] 2.5 Architectural lock test at `brainstorm/__tests__/no-ideate-coupling.test.ts` grep-asserts the orchestrator module does not import or call `runIdeation` and does not import `../ideate/orchestrator`. (Also covers Section 12.1; 12.2 positive check is gated until Section 5 lands the real dedupe wiring.)

## Section 3 — Lineup + criteria

- [x] 3.1 `lineup.ts` exports `defaultBrainstormLineup()` returning the divergent-authors + judges + forge-elaborator triplet from design.md.
- [x] 3.2 TOML override resolver for `[brainstorm.lineup]`, mirroring the strict-by-default pattern from `ideate/lineup.ts`. Empty arrays + whitespace-only model IDs rejected.
- [x] 3.3 `CRITERIA` constant in `brainstorm/types.ts`: closed enum `'novelty' | 'feasibility' | 'fit' | 'evidence'` (exported as `BRAINSTORM_CRITERIA`).
- [x] 3.4 `DEFAULT_WEIGHTS` constant: equal weights summing to 1.0 (exported as `DEFAULT_RANK_WEIGHTS`).
- [x] 3.5 `resolveRankWeights()` — TOML `[brainstorm.rank.weights]` + per-run override, both partial-replace on defaults, normalized to sum=1.0. Rejects negative, NaN, infinite, and all-zero weights. *Spec deviation from original 3.5: spec said "must sum to 1.0 ± 0.01"; per design.md lock, weights are partial-replace + auto-normalized instead. The auto-normalize matches the design-decision rationale and is friendlier for partial overrides.*
- [x] 3.6 Unit tests: default lineup shape, GPT-5 overlap allowed, TOML overrides applied + rejected on empty/invalid, criteria locked, default weights equal, TOML+body partial-replace, normalization correctness, negative/NaN/all-zero rejection.

## Section 4 — Divergent generation phase

- [x] 4.1 Implement `runDivergentGeneration()` in a new `brainstorm/divergent.ts`. Parallel only.
- [x] 4.2 Per-author prompt template emphasizing breadth + anti-convergence. Each author MUST produce K ideas with structured fields (title, one-liner, dimensions, rationale).
- [x] 4.3 JSON parsing + one-shot retry, mirroring `parseAdversarialOutput` semantics.
- [x] 4.4 Each idea carries its author identity in the phase record (used by the rank phase for author-aware skip).
- [x] 4.5 Unit tests: K=1 / K=5 / K=10; parser retry; one author returning prose after retry is preserved as best-effort with `unstructured: true`.

## Section 5 — Idea dedupe phase (reuses ideate primitive)

- [x] 5.1 Cross-import `runDedupePhase` from `@parliament/core/ideate/dedupe.ts` into `brainstorm/orchestrator.ts`.
- [x] 5.2 Adapt the per-draft `role + index` ID scheme to `author + index` so the merge map keys are stable across reruns.
- [x] 5.3 Phase record `phase: 'idea-dedupe'` (not `'dedupe'`) so brainstorm and ideate dedupe records are distinguishable in shared persistence tooling.
- [x] 5.4 Unit tests: cross-author duplicate collapses; merge map preserves author identity; soft-fail behavior matches ideate.

## Section 6 — Cluster phase

- [x] 6.1 Implement `runClusterPhase()` — one model call (Opus 4.6 by default) that takes the deduped survivors and returns cluster labels + per-idea cluster assignments.
- [x] 6.2 Phase record carries the cluster map; rank phase reads it.
- [x] 6.3 Cluster output is advisory — if the cluster call fails, log a warning and proceed with cluster=null on all ideas. Do not fail the run.
- [x] 6.4 Unit tests: clean cluster; cluster call failure soft-fails; cluster output passed to rank.

## Section 7 — Rank phase

- [x] 7.1 Implement `runRankPhase()` — parallel per-judge scoring across all surviving ideas.
- [x] 7.2 Per-judge prompt: each judge sees the prompt, all surviving ideas, the cluster labels, and the criteria definitions. Returns per-idea per-criterion scores with one-line rationale.
- [x] 7.3 Author-aware skip: a judge whose model ID matches an idea's author MUST be skipped for that idea (orchestrator filters before computing final score).
- [x] 7.4 Both-judges-authored edge case: surfaces idea with `score: null`, `judge_skipped: true`, `judges_attempted: []`, `judges_skipped: [...]`. Locked v1 default per design.md "Resolved Decisions".
- [x] 7.5 Final score = weighted sum across criteria of averaged judge scores (averaged over non-skipped judges). Rank is descending by final score; ties broken by `idea_id` for determinism.
- [x] 7.6 `idea_id` derived from stable hash of `(title, one-liner)` after dedupe. *(Reuses `stableIdeaId` from `brainstorm/dedupe.ts`, already landed in Section 5.)*
- [x] 7.7 Unit tests: independent judging produces averaged scores; author-aware skip exercised; both-judges-authored edge case; deterministic tiebreak; rank stable across reruns with same inputs (stub adapter).

## Section 8 — Forge elaboration

- [ ] 8.1 Implement `elaborateIdea()` in `brainstorm/forge.ts`. Lightweight cooperative elaboration; MAY share helpers with `runCooperativeBuild` but does NOT call `runIdeation`.
- [ ] 8.2 `forgeTopK()` runs `elaborateIdea` in parallel over the top-K ideas from the rank phase.
- [ ] 8.3 Elaboration result shape: `{ idea_id, elaboration: string, model: string, timestamp }`.
- [ ] 8.4 Forge is opt-in: triggered only by `mode === 'brainstorm/forge'` in `RunBrainstormInput`.
- [ ] 8.5 Unit tests: forge runs on top-K only; forge skipped when mode is plain brainstorm; one elaboration failure does not abort others (best-effort: surface partial).

## Section 9 — Server: routes + persistence

- [ ] 9.1 New `brainstorms` table migration. Columns: `id TEXT PK`, `created_at TEXT`, `prompt TEXT`, `mode TEXT`, `status TEXT`, `lineup JSON`, `phases JSON`, `rankings JSON`, `elaborations JSON NULL`, `error TEXT NULL`.
- [ ] 9.2 New file `packages/server/src/routes/brainstorm.ts`. Two distinct handlers: `handleBrainstorm` and `handleBrainstormForge`. They MUST NOT share a handler.
- [ ] 9.3 Zod schemas for `BrainstormRequest` and `BrainstormForgeRequest`. Schemas differ on the `mode` literal and on whether `k` is accepted.
- [ ] 9.4 `POST /brainstorm` and `POST /brainstorm/forge` register the two handlers. Existing `app.post('/brainstorm', handleIdeate)` and `app.post('/brainstorm/forge', handleIdeate)` MUST be removed.
- [ ] 9.5 `GET /brainstorm/:id` reads only from `brainstorms`. MUST NOT fall back to `ideations`.
- [ ] 9.6 Fire-and-forget pattern matches `/ideate`: 202 with `{ id, status: 'running' }`; background runner persists phases as they complete.
- [ ] 9.7 Integration tests: round-trip POST → poll → complete; forge variant produces elaborations; plain brainstorm has `elaborations: null` in response.

## Section 10 — CLI

- [ ] 10.1 New `parliament brainstorm "<prompt>"` command in the CLI.
- [ ] 10.2 Flags: `--forge` (toggles forge phase), `--k=N` (forge breadth, default 3), `--ideas-per-author=K` (divergent fan-out, default 5).
- [ ] 10.3 `--print-lineup` prints the resolved lineup including judges and forge elaborator.
- [ ] 10.4 Polling output renders ranked ideas as a numbered list with per-criterion scores in a compact table.
- [ ] 10.5 Integration test: end-to-end CLI invocation with a stub server.

## Section 11 — TOML

- [ ] 11.1 New `[brainstorm]` section with `lineup`, `rank.weights`, `ideas_per_author`, `forge.k` keys.
- [ ] 11.2 Validation: weights must sum to ~1.0; `ideas_per_author` must be in [1, 20]; `forge.k` must be in [1, 10].
- [ ] 11.3 Sample config block added to `parliament.openrouter.toml` (commented out).
- [ ] 11.4 Loader tests: defaults applied; overrides applied; invalid values rejected.

## Section 12 — Architectural lock test

- [ ] 12.1 Test in `brainstorm/__tests__/no-ideate-coupling.test.ts` that greps the brainstorm orchestrator source and asserts it contains no `runIdeation` import or call.
- [ ] 12.2 Same test asserts `runDedupePhase` IS imported (positive check — confirms intentional reuse).

## Section 13 — Docs + release note

- [ ] 13.1 Update `README.md` (and the existing brainstorm/forge handover doc) with the new shape.
- [ ] 13.2 Release note in `CHANGELOG.md` flagging the `/brainstorm` response shape break.
- [ ] 13.3 Confirm with Beaux before pushing (heybeaux/* gated-repo rule).

## Section 14 — Spec validation

- [ ] 14.1 `openspec validate add-brainstorm-mode --strict` passes.
- [ ] 14.2 PR description includes a per-section completion checklist.
