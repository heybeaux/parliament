# Brainstorm Mode — Handover for Next Session (Rook → Rook)

**Date parked:** 2026-05-24 ~00:25 PDT
**Branch:** `feat/add-brainstorm-mode-spec` (4 commits ahead of `main`, NOT pushed)
**Pick up at:** Section 4 — Divergent generation phase
**OpenSpec change:** `openspec/changes/add-brainstorm-mode/`

---

## TL;DR — read this first

You're 3 of 14 sections into building a real `brainstorm` reasoning pattern to replace the alias bug where `/brainstorm` and `/brainstorm/forge` were just routing to `runIdeation()`.

The spec is **locked**. The skeleton is **in**. Lineup + criteria + rank-weight resolution is **done with tests**. Next session you start writing the first phase that actually calls models: divergent generation.

Don't re-design. Don't re-litigate the locks. The decisions were made deliberately and committed with rationale — read design.md "Resolved Decisions" once, then build.

---

## Why this work exists (one-paragraph context)

Pax handed off in `docs/2026-05-23-rook-handover-brainstorm-forge-training-pattern.md`. The TL;DR of his handover: the routes `/brainstorm` and `/brainstorm/forge` are real, but both call `handleIdeate` → `runIdeation()`. That's a lie about what the routes do. Ideate converges on one seed idea (proposer → expander → critic → synth). Brainstorm should diverge into N candidate projects and rank them. Beaux confirmed this needs a genuinely new pattern, not more aliases.

The shape we agreed on: **`brainstorm` is a top-level mode parallel to `ideate` / `deliberate`**, not a sub-mode. Pipeline:

```
divergent-generation → idea-dedupe → idea-cluster → idea-rank → [forge-elaboration]
```

`/brainstorm` stops at the ranked list. `/brainstorm/forge` continues into elaboration of top-K winners in one POST.

---

## What's done (committed, on branch, not pushed)

### Commit 88d59b4 — Section 0 (spec scaffold)
- `openspec/changes/add-brainstorm-mode/proposal.md`
- `openspec/changes/add-brainstorm-mode/design.md`
- `openspec/changes/add-brainstorm-mode/tasks.md` (14 sections)
- `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`
- `packages/core/src/brainstorm/{types,lineup,orchestrator,index}.ts` (skeleton, orchestrator throws)
- `openspec validate --strict` passes

### Commit b1561e7 — Section 1 lock
All five open questions resolved in design.md under "Resolved Decisions (locked 2026-05-24)":

1. **Both judges authored an idea** → `score: null` + `judge_skipped: true`, sorted last in rankings, excluded from forge top-K selection (treat as ineligible, not zero).
2. **Forge by idea-ID list from prior brainstorm** → deferred to a follow-up change. v1 is one-shot top-K only.
3. **Cluster labels** → stay model-generated and un-normalized. Free-form strings, advisory.
4. **Rank weights** → TOML defaults under `[brainstorm.rank.weights]` (keys: `novelty`, `feasibility`, `fit`, `evidence`). Request body MAY override partial-replace via `rank_weights`. Weights normalize to sum=1.0 before scoring.
5. **Judges score parallel/independent** → no anchoring. Locked.

### Commit f7ea88a — Section 2 (orchestrator skeleton + architectural lock)
- `packages/core/src/brainstorm/prompts.ts` stub added (4-file layout per tasks 2.1)
- `packages/core/src/brainstorm/__tests__/no-ideate-coupling.test.ts` — grep-asserts that:
  - No file in `brainstorm/` imports or calls `runIdeation`
  - No file imports `../ideate/orchestrator`
  - (Positive check) Once orchestrator is real, it MUST import `runDedupePhase` from `../ideate/dedupe` — currently gated on the stub
- Test strips line + block comments before grep so docstrings warning humans off `runIdeation` don't trip the lock
- Covers tasks 2.1–2.5 and the negative half of 12.1

### Commit 2ea38c0 — Section 3 (lineup validation + rank weights)
- `lineup.ts`:
  - `resolveBrainstormLineup()` now strict-validates: empty arrays + whitespace-only model IDs throw with clear messages
  - New `resolveRankWeights(config?, override?)`:
    - Starts from `DEFAULT_RANK_WEIGHTS` (0.25 each)
    - TOML `[brainstorm.rank.weights]` partial-replaces
    - Per-run `override` partial-replaces on top of that
    - Normalizes sum to 1.0
    - Rejects negative, NaN, infinite, all-zero weights
- `index.ts` exports `resolveRankWeights`
- `__tests__/lineup.test.ts` — 20 new tests
- **Spec deviation noted in tasks.md 3.5:** original task said "must sum to 1.0 ± 0.01". The locked design decision is auto-normalize instead — friendlier with partial overrides. Deviation is explicit, not silent.

### Test/build status
- `pnpm --filter @parliament/core test` → **667 passed | 7 skipped (43 files)**
- `pnpm --filter @parliament/core build` → clean
- `pnpm openspec validate add-brainstorm-mode --strict` → valid

---

## What's NOT done — pick up at Section 4

### Section 4 — Divergent generation phase (this is your next focus)

Tasks 4.1–4.5 from `openspec/changes/add-brainstorm-mode/tasks.md`:

- [ ] 4.1 Implement `runDivergentGeneration()` in a new `brainstorm/divergent.ts`. Parallel only.
- [ ] 4.2 Per-author prompt template emphasizing breadth + anti-convergence. Each author MUST produce K ideas with structured fields (title, one-liner, dimensions, rationale).
- [ ] 4.3 JSON parsing + one-shot retry, mirroring `parseAdversarialOutput` semantics.
- [ ] 4.4 Each idea carries its author identity in the phase record (used by the rank phase for author-aware skip).
- [ ] 4.5 Unit tests: K=1 / K=5 / K=10; parser retry; one author returning prose after retry is preserved as best-effort with `unstructured: true`.

### Recommended Section 4 build order

1. **Read first**:
   - `packages/core/src/ideate/adversarial.ts` — for `parseAdversarialOutput` pattern (4.3 mirrors this)
   - `packages/core/src/ideate/cooperative.ts` — for parallel adapter-call patterns
   - `packages/core/src/adapters/base.ts` — to confirm `ModelAdapter` interface
   - `packages/core/src/brainstorm/types.ts` lines 55–66 — `BrainstormIdea` shape you're producing
   - `packages/core/src/brainstorm/types.ts` lines 104–135 — `BrainstormPhaseRecord` shape for the phase output

2. **Write `brainstorm/prompts.ts`** first (currently a stub). Functions:
   - `divergentAuthorPrompt({ prompt, ideasPerAuthor, authorModel })` — returns the user/system prompt pair
   - Emphasize anti-convergence: tell the author they're one of 4 parallel authors, breadth matters more than polish, don't pick the obvious idea
   - Specify the exact JSON output shape with an example
   - Reference: tasks.md 4.2

3. **Write `brainstorm/divergent.ts`**:
   - `runDivergentGeneration({ prompt, lineup, ideasPerAuthor, factory })` → `{ ideas, warnings }`
   - Fan out `Promise.all` over `lineup.divergentAuthors` — parallel, never sequential (sequential would let later authors converge on earlier ones, defeating the point)
   - For each author:
     - Build prompt
     - Call adapter
     - Try-parse JSON
     - If parse fails: one-shot retry with a corrective prompt (mirror `parseAdversarialOutput`'s retry shape)
     - If retry still fails: surface as a single `BrainstormIdea` with `unstructured: true` flag and the raw text in `rationale`. **Note:** `unstructured` isn't on `BrainstormIdea` yet — you'll need to add it as an optional field in `types.ts`. Keep the spec-honoring behavior of "best-effort, never crash a whole run because one author returned prose."
   - Set `author_model` on every idea (load-bearing for Section 7's author-aware skip)
   - `idea_id` is NOT set here — that happens after dedupe in Section 5. Use a temp local ID for now (e.g., `${authorModel}#${i}`) or leave empty string — the dedupe pass owns final ID assignment.

4. **Tests in `brainstorm/__tests__/divergent.test.ts`**:
   - Stub adapter that returns canned JSON; assert K=1 / K=5 / K=10 produce the right shape
   - Stub adapter that returns broken JSON once then valid JSON; assert retry succeeds
   - Stub adapter that returns prose both times; assert idea is surfaced with `unstructured: true` and `author_model` is still populated
   - Concurrency: assert all authors are called in parallel (use timing or call-order assertion)

### What comes after Section 4

5 (idea-dedupe via `runDedupePhase` reuse — this is when the architectural lock test's positive check goes live), 6 (cluster), 7 (rank — biggest section, the author-aware-skip filter lives here), 8 (forge), 9 (server routes + DB migration), 10 (CLI), 11 (TOML loader wiring), 12 (extra lock tests), 13 (docs/CHANGELOG), 14 (final validate).

---

## Locked decisions — DO NOT re-litigate

These are committed and live in `design.md` under "Resolved Decisions". If you find yourself wanting to change one, that's a signal to first re-read the rationale and Beaux's confirmation in this conversation's transcript, not to silently flip it.

- Brainstorm is a **top-level mode**, not a sub-mode of ideate (Beaux confirmed)
- Pipeline is **4 phases + optional forge**, phase order hard-coded
- Lineup: **4 divergent authors (Opus 4.6, Gemini 2.5 Pro, GPT-5, DeepSeek V4 Flash) + 2 judges (Sonnet 4.6, GPT-5)**
- GPT-5 overlap is intentional, mitigated by author-aware skip
- Forge is a **continuation** of brainstorm (`/brainstorm/forge` is one POST), not a separate top-level mode
- Criteria set is **locked to 4** in v1: novelty, feasibility, fit, evidence
- Both-judges-authored → **score: null + judge_skipped + sorted last + excluded from forge top-K**
- Rank weights → **TOML default + body partial-replace, auto-normalized**
- Judges score **parallel/independent**
- `idea_id` = **stable hash of (title, one_liner)** after dedupe

---

## Repo + environment notes for tomorrow

- **Branch:** `feat/add-brainstorm-mode-spec` (4 commits, NOT pushed; gated-repo rule — confirm with Beaux before pushing)
- **Working dir:** `/Users/beauxwalton/projects/parliament`
- **Build:** `pnpm --filter @parliament/core build`
- **Test:** `pnpm --filter @parliament/core test`
- **Test only brainstorm:** `pnpm --filter @parliament/core test -- --run brainstorm`
- **Validate spec:** `pnpm openspec validate add-brainstorm-mode --strict`
- **Commit pattern:** per-section commits with `feat(brainstorm): finish Section N — <short>` followed by a body explaining the *why*, not the *what*. Mirror the style of the four existing commits on this branch.

---

## Memory side-quests still pending

- **Engram cloud 401** — both `eng_kit_local_dev_2026` and Rook's old prod key 401 against `api.openengram.ai`. Local engram on `localhost:3007` works. Logged at `~/.claude/projects/.../memory/engram-cloud-401.md`. **Investigate tomorrow with engram repo open.** Pax's completion memories from yesterday silently failed because of this; same will happen to anything I try to write until it's fixed.

---

## How to actually pick up tomorrow

1. Open this file (`docs/2026-05-24-rook-handover-brainstorm-section-4.md`)
2. Open `openspec/changes/add-brainstorm-mode/tasks.md` — scroll to Section 4
3. Open `packages/core/src/ideate/adversarial.ts` and find `parseAdversarialOutput` — that's the pattern for 4.3
4. Open `packages/core/src/brainstorm/types.ts` — confirm the `BrainstormIdea` shape you're targeting
5. Build Section 4 in the order listed above (prompts → divergent → tests)
6. Commit per section, don't bundle
7. Run `pnpm --filter @parliament/core test` after each meaningful change — the architectural lock test is fast and catches silent regressions

Good luck, future me. Don't overthink — the design is done; just build the phase.

— Rook, 2026-05-24 00:25 PDT
