# refine-ideate-forge — Handover for Pax

**Date:** 2026-05-23
**From:** Rook
**To:** Pax
**Branch:** `feat/refine-ideate-forge-impl`
**Base:** `main` (PR #84 merged)
**Spec:** `openspec/changes/refine-ideate-forge/`

---

## TL;DR

Sections 1–3 are scaffolded; **Section 1 is fully finished and tested.** Sections 2 and 3 have prior `wip` scaffolding from the previous session but need finishing per the same per-section commit pattern Beaux asked for.

You are picking this up at the **start of Section 2**, with Section 1 already shipped and merged-ready.

---

## What's on the branch right now

```
1726abf feat(ideate): finish Section 1 — wire dedupe phase into orchestrator + tests   ← Rook, this session
6713bf4 wip(ideate): refine-ideate-forge sections 1-3 — dedupe + defense + dimension scaffolding   ← prior session
2163271 spec(refine-ideate-forge): amend ideate-mode with dedupe, critique_cycles, defense_mode, dimension (#84)   ← main
```

The `wip` commit dropped scaffolding for all three core sections. The Section 1 finish commit closed Section 1 properly. Sections 2 and 3 still have partial work but no tests / no commit-per-section.

---

## Beaux's hard rules for this work

These were given to Rook this session and must carry over to you:

1. **Per-section commits.** Beaux explicitly asked for "1a — finish 1-3 properly, commit per-section." Don't bundle Sections 2 + 3 into one commit.
2. **Truth above all else.** Don't claim "tests pass" without running them. Don't claim a feature works without exercising it.
3. **Never dedupe critiques.** Architectural lock — `assertCritiquesNotDeduped()` exists in `dedupe.ts`. Add a call to it in any new test that touches the adversarial/defense path.
4. **Confirm before pushing.** `heybeaux/*` repo pushes need explicit per-push approval. Rook pushed Section 1 with Beaux's go-ahead. Don't push without one.
5. **Don't bypass hooks.** Pre-push runs `lint + build + test`. If it fails, fix the underlying issue. Don't use `--no-verify`.
6. **Confirmation on cooperative + critique_cycles=1.** Already locked: **Option 2 (Silent No-Op).** Pax confirmed in conversation #7240. Don't reopen this debate.

---

## Section 1 — DONE ✅

**Commit:** `1726abf feat(ideate): finish Section 1 — wire dedupe phase into orchestrator + tests`

**What's in:**

- `packages/core/src/ideate/orchestrator.ts` — `runDedupePhase` wired between cooperative-build and adversarial-critique (or synth in cooperative sub-mode)
  - New `dedupe` opts on `RunIdeationInput`: `enabled`, `threshold`, `providerOrder`, `embedder` (test seam)
  - Opt-out via `dedupe.enabled: false`
  - Downstream phases (rebuttal, synth) read survivors, not original drafts
  - Soft-fail: phase record still pushed with `skipped: true`, `provider: null`, warning in `warnings[]`
  - PhaseRecord is the canonical "phase.dedupe event" surface (no separate event bus in ideate)
- `packages/core/src/ideate/dedupe.ts` — already existed from `wip` commit, no changes needed
- `packages/core/src/ideate/__tests__/dedupe.test.ts` (new, 12 tests):
  - both-succeed (local wins by default order)
  - local-fails / cloud-succeeds
  - both-fail → skip + warning
  - threshold edges: 0, 1.0, exact-match
  - tiebreak on equal cosine → longer content wins
  - transitive collapse (A~B, B~C → all collapse)
  - ≤1 draft passthrough (0 and 1 cases)
  - provider order respected
  - wrong-length embedding soft-fail
  - `cosineSimilarity` math (parallel, orthogonal, antiparallel, empty)
- `packages/core/src/ideate/__tests__/orchestrator.test.ts` (+4 tests):
  - dedupe runs by default with stub embedder
  - duplicate drafts collapse before synth (synth sees only survivors)
  - both providers down → skipped phase + warning + drafts pass through
  - `dedupe.enabled: false` → no phase record at all
- `packages/core/src/ideate/__tests__/adversarial.test.ts` (+2 tests, fixtures updated):
  - rejects problems missing `dimension`
  - rejects unknown `dimension` values
  - all existing fixtures gained `dimension` (Section 3.2 closed-enum requirement)
- Legacy orchestrator tests now pass `dedupe: { enabled: false }` to preserve behavior — dedupe-specific coverage lives in the new tests.

**Test status:** All 990 tests pass repo-wide. `tsc --noEmit` clean on `src/ideate/`.

**What's deferred (not blocking Section 1, but flag for later):**
- Section 1.5 spec says "emit `phase.dedupe { kept, merged_into }` event via the existing blackboard event bus." There is no blackboard event bus in `@parliament/core/ideate`. Rook implemented the equivalent as a `PhaseRecord` pushed onto `phases[]` — same payload, same observability, no separate pub/sub. Documented inline in `orchestrator.ts` and `dedupe.ts`. If you'd rather build an event bus, that's a larger refactor and should be its own change.

---

## Section 2 — START HERE 🟡

**Spec:** `openspec/changes/refine-ideate-forge/tasks.md` lines for Section 2.

**Status:** partial scaffolding from `wip` commit. Audit before starting.

### Tasks (per spec)

- [ ] **2.1** Rename `runRebuttalPhase` → `runDefensePhase` in `packages/core/src/ideate/orchestrator.ts`.
- [ ] **2.2** Re-export `runRebuttalPhase` as a `@deprecated` alias pointing at `runDefensePhase`.
- [ ] **2.3** Add `defense_mode: 'address' | 'double_down' | 'author_choice'` to `IdeateRequest` and orchestrator opts. Default `'author_choice'`.
- [ ] **2.4** Implement defense prompt template producing `{ defenses: [{ critique_id, stance, reasoning, draft_delta? }] }`.
  - `author_choice` → author picks `stance` per critique
  - `address` / `double_down` → prompt forces the stance; parser MUST reject any defense with disagreeing stance (one retry, then `phase.warning` + use the wrong-stance response as best-effort)
- [ ] **2.5** Reuse existing adversarial JSON parse-retry logic for defense parse failures (one retry; on second failure, preserve raw prose + emit `phase.warning`)
- [ ] **2.6** Append a `defense` record to `ideations.phases` JSON
- [ ] **2.7** Unit tests:
  - `author_choice` produces mixed stances
  - `address` rejects double-down
  - `double_down` rejects address
  - structured parse retry on malformed defense JSON

### Files to touch (likely)

- `packages/core/src/ideate/orchestrator.ts` — rename + alias + `defense_mode` opt + wire into the rebuttal loop
- `packages/core/src/ideate/types.ts` — `DefenseEntry` already exists; `defenses?` on `PhaseRecord` already exists. Check `defense_mode` field on `IdeateRequest`.
- `packages/core/src/ideate/prompts.ts` — add defense prompt template (likely a new file `defense.ts` mirroring `adversarial.ts` pattern, with a `parseDefenseOutput()` parser)
- New: `packages/core/src/ideate/defense.ts` (parser + system prompt)
- New: `packages/core/src/ideate/__tests__/defense.test.ts`
- Update: `packages/core/src/ideate/__tests__/orchestrator.test.ts` (add defense_mode tests)

### Gotchas

- The rebuttal loop currently runs up to `REBUTTAL_ROUND_CAP` (2). Defense semantics are different from rebuttal — defense is ONE response per critique with a stance, not an N-round back-and-forth. Read the existing `runRebuttal` carefully before renaming; the rename may need a behavioral split, not just a label change. **Check what `wip` did before you redo it.**
- The "wrong-stance fallback" in 2.4 is subtle: retry once, then if it still violates, *use* the wrong-stance response and emit `phase.warning`. Don't drop the response on the floor.
- `defenses` field on `PhaseContribution` already exists (types.ts:128). Use it for per-author defense entries; use `PhaseRecord.defenses` for the phase-level rollup.

### Suggested commit message

```
feat(ideate): finish Section 2 — defense phase rename + author_choice mode

Renames runRebuttalPhase to runDefensePhase. Adds @deprecated alias for
backward compat. New defense_mode opt ('address' | 'double_down' |
'author_choice', default 'author_choice') propagates from IdeateRequest
through the orchestrator into the defense prompt.

[...]
```

---

## Section 3 — also partially scaffolded 🟡

**Spec:** `openspec/changes/refine-ideate-forge/tasks.md` Section 3.

**Status:** Section 3.1 and 3.2 (adversarial parser requires `dimension`) are **done** — landed in the `wip` commit and Rook's Section 1 finish added the parser tests for rejection cases. **3.3 and 3.4 still need work.**

### Tasks remaining

- [x] 3.1 Adversarial JSON schema includes `dimension`. Adversarial system prompt updated. (done in `wip`)
- [x] 3.2 Parser rejects missing/unknown dimension with one retry. (parser done in `wip`; reject-case tests added in Rook's Section 1 finish)
- [ ] **3.3** Pass `dimension` through to defense phase prompt and synthesizer prompt for grouping/weighting.
  - Defense prompt should receive the dimension per critique
  - Synth prompt should group critiques by dimension when summarizing
- [ ] **3.4** In-code architectural assertion: no code path in `@parliament/core/src/ideate/` MAY call any cosine-collapse/dedupe utility against critiques.
  - `assertCritiquesNotDeduped()` already exported from `dedupe.ts` (line 266) as a no-op marker.
  - Add a comment lock above the adversarial loop in `orchestrator.ts`.
  - Add a test in `dedupe.test.ts` or new `critique-lock.test.ts` that calls `assertCritiquesNotDeduped()` from a representative point in the critique pipeline — its real value is forcing a future refactor to confront the lock.

### Files to touch (likely)

- `packages/core/src/ideate/defense.ts` (from Section 2) — wire `dimension` into prompt context
- `packages/core/src/ideate/synth.ts` or wherever `runSynth` builds its prompt — group critiques by `dimension`
- `packages/core/src/ideate/orchestrator.ts` — comment lock above adversarial phase
- New test exercising `assertCritiquesNotDeduped()`

### Suggested commit message

```
feat(ideate): finish Section 3 — dimension propagation + critique-dedupe lock

Pipes Problem.dimension through to defense and synth prompts. Adds an
in-code architectural lock asserting critique entries are never deduped.
```

---

## Sections 4–9 — not started

Sections 4 (server param validation), 5 (CLI flags), 6 (TOML loader), 7 (integration tests), 8 (docs), and 9 (`openspec validate --strict`) are untouched. Spec is in `openspec/changes/refine-ideate-forge/tasks.md`.

**Pax's prior architectural decisions (from conversation #7240) that apply here:**

- **Section 4.2 (cooperative + critique_cycles=1):** Option 2 (Silent No-Op). Cooperative mode silently ignores `critique_cycles` rather than 400-ing. Document the behavior in the server validation message ("ignored in cooperative sub-mode").
- **Section 4.4 (`dedupe_critiques: true`):** Hard 400 with the exact message `"critique dedupe disabled by design — multi-model perspective signal is preserved"`. This is the public face of the architectural lock.

---

## How to run things

```bash
# from the worktree root
cd /Users/beauxwalton/Dev/parliament-refine-ideate

# install (one-time per worktree)
pnpm install
# Then approve + rebuild native modules:
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install && cd -

# core-only tests (fast, ~1s)
pnpm --filter @parliament/core test

# ideate-only (very fast)
pnpm --filter @parliament/core test src/ideate/

# typecheck core (ignore lattice + node-type noise — those errors are pre-existing)
pnpm --filter @parliament/core exec tsc --noEmit 2>&1 | grep -E "src/ideate/" | grep -v lattice

# full repo (what pre-push runs — must pass before push)
pnpm run lint && pnpm run build && pnpm run test
```

## Gotchas you'll hit

1. **better-sqlite3 native binding.** Fresh `pnpm install` skips it ("Ignored build scripts" warning). You'll see 163 test failures across other packages until you rebuild. Run the rebuild command above. (Rook hit this when pushing Section 1.)
2. **pre-push hook.** Runs `lint + build + test` on the WHOLE repo, not just affected packages. Budget time for ~30s of pre-push runtime.
3. **Test pattern.** Scripted adapter keyed on `model::system-prompt-first-line`. See `packages/core/src/ideate/__tests__/orchestrator.test.ts` lines 1–30 for the pattern.
4. **Spec retries are one-shot.** Both adversarial and defense parsers retry exactly once. Don't loop infinitely.
5. **Worktree isolation.** This branch lives in `/Users/beauxwalton/Dev/parliament-refine-ideate`, not the canonical Parliament checkout. Don't accidentally commit to the wrong worktree.

## When you're done

1. Commit each section separately.
2. Push (with Beaux's go-ahead).
3. After Section 9, run `openspec validate refine-ideate-forge --strict`.
4. Update PR description with a Section completion checklist.

## Open questions for Beaux

These don't block forward progress but should be confirmed before merging:

1. **Section 1.5 — event bus?** Rook implemented the "phase.dedupe event" as a `PhaseRecord` push, not via a new event bus (there isn't one in ideate). If Beaux wants a real pub/sub event bus, that's a separate change.
2. **Section 2.4 — wrong-stance fallback.** Spec says retry once, then "use the wrong-stance response as best-effort." Confirm: does "use" mean persist the wrong-stance defense as-is, or coerce its `stance` field to the requested mode? Rook's read is: persist as-is, surface warning. Pax can confirm.

---

*Generated by Rook on 2026-05-23 as part of the Section 1 finish handoff. Update this doc as you complete sections — it's a living handover, not a snapshot.*
