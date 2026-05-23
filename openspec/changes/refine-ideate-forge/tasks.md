## 1. Core: dedupe module

- [ ] 1.1 Create `@parliament/core/src/ideate/dedupe.ts` exporting `runDedupePhase(drafts, opts): Promise<{ kept: Draft[], merged_into: Record<string, string> }>`.
- [ ] 1.2 Implement embedding provider with fallback order: local `engram-embed` at `http://localhost:8080` first, then Engram Cloud (`https://api.openengram.ai`). Provider order configurable via opts.
- [ ] 1.3 If both providers fail, emit `phase.warning` with the underlying error and return drafts untouched. Dedupe failure MUST NOT fail the ideation.
- [ ] 1.4 Implement pairwise cosine over embeddings; for each pair at-or-above `threshold` (default `0.85`), collapse into the survivor (higher confidence; tiebreak on longer draft).
- [ ] 1.5 Emit `phase.dedupe { kept, merged_into }` event via the existing blackboard event bus.
- [ ] 1.6 Wire `runDedupePhase` into `IdeateOrchestrator` between `runCooperativePhase` and `runAdversarialPhase`. Skipped when `dedupe.enabled = false`.
- [ ] 1.7 Append a `dedupe` record to `ideations.phases` JSON capturing kept IDs, merge map, threshold, and provider used.
- [ ] 1.8 Unit tests: both-providers-succeed pick local, local-fails-cloud-succeeds, both-fail-skip-with-warning, threshold edge cases (0, 1, exact-match), tiebreak on equal cosine.

## 2. Core: defense phase rename + author_choice logic

- [ ] 2.1 Rename `runRebuttalPhase` to `runDefensePhase` in `@parliament/core/src/ideate/orchestrator.ts`.
- [ ] 2.2 Re-export `runRebuttalPhase` as a deprecated alias pointing at `runDefensePhase`; mark with `@deprecated` JSDoc.
- [ ] 2.3 Add `defense_mode: 'address' | 'double_down' | 'author_choice'` to `IdeateRequest` and orchestrator opts; default `'author_choice'`.
- [ ] 2.4 Implement defense prompt template producing `{ defenses: [{ critique_id, stance, reasoning, draft_delta? }] }`. In `author_choice`, the author picks `stance` per critique. In `address` or `double_down`, the prompt forces the stance and the parser MUST reject any defense whose stance disagrees with the forced mode (one retry, then phase.warning + use the wrong-stance response as best-effort).
- [ ] 2.5 Reuse the existing adversarial JSON parse-retry logic for defense parse failures (one retry; on second failure, preserve raw prose in transcript and emit `phase.warning`).
- [ ] 2.6 Append a `defense` record to `ideations.phases` JSON.
- [ ] 2.7 Unit tests: `author_choice` produces mixed stances; `address` rejects double-down; `double_down` rejects address; structured parse retry on malformed defense JSON.

## 3. Core: critique dimension + dedupe lock

- [ ] 3.1 Extend adversarial JSON schema: each problem MUST include `dimension: 'ux'|'business'|'technical'|'market'|'legal'|'other'`. Update the adversarial system-prompt template.
- [ ] 3.2 Update the adversarial parser to reject problems missing or with an unknown `dimension` (one retry, same fallback behavior as existing parser).
- [ ] 3.3 Pass `dimension` through to the defense phase prompt and to the synthesizer prompt for grouping/weighting.
- [ ] 3.4 Add an in-code architectural assertion: no code path in `@parliament/core/src/ideate/` MAY call any cosine-collapse or dedupe utility against critiques. Enforce via a comment lock plus an exported `assertCritiquesNotDeduped()` callable used in tests.

## 4. Server: param validation

- [ ] 4.1 Extend `POST /ideate` request schema with optional `critique_cycles?: 0|1`, `defense_mode?: 'address'|'double_down'|'author_choice'`, `dedupe?: boolean`, `dedupe_threshold?: number`.
- [ ] 4.2 Reject `critique_cycles > 1` with HTTP 400 message `"critique_cycles is hard-capped at 1 in v1"`.
- [ ] 4.3 Reject `dedupe_threshold` outside `[0,1]` with HTTP 400.
- [ ] 4.4 Reject `dedupe_critiques: true` (any truthy value of that field) with HTTP 400 message `"critique dedupe disabled by design — multi-model perspective signal is preserved"`.
- [ ] 4.5 Default `critique_cycles` to `1` for `adversarial`/`full`, `0` for `cooperative`. Default `defense_mode` to `'author_choice'`. Default `dedupe` to `true`. Default `dedupe_threshold` to `0.85`.
- [ ] 4.6 Integration tests: each new param's accept and reject paths; `critique_cycles = 0` on `full` skips adversarial and defense phases entirely.

## 5. CLI flags

- [ ] 5.1 Add `--critique-cycles 0|1` to `parliament ideate`.
- [ ] 5.2 Add `--defense-mode address|double_down|author_choice` to `parliament ideate`.
- [ ] 5.3 Add `--no-dedupe` and `--dedupe-threshold <float>` to `parliament ideate`.
- [ ] 5.4 Update `--help` output and `--print-lineup` to also print resolved dedupe/defense/critique-cycles settings.
- [ ] 5.5 CLI passes the flags into `POST /ideate` body; absent flags are omitted (server-side default applies).

## 6. TOML loader

- [ ] 6.1 Parse `[ideate.dedupe]` with `provider_order: string[]` (default `["local", "cloud"]`), `threshold: float` (default `0.85`), `enabled: bool` (default `true`).
- [ ] 6.2 Parse `[ideate.defense]` with `mode: 'address'|'double_down'|'author_choice'` (default `'author_choice'`).
- [ ] 6.3 Validation at server boot: unknown `provider_order` entries, out-of-range threshold, unknown defense mode all surface as boot-time errors.
- [ ] 6.4 Precedence: request-body params > TOML > in-code defaults. Document precedence in the README section added in section 8.

## 7. Tests

- [ ] 7.1 Orchestrator integration: cooperative → dedupe → synth with `critique_cycles = 0` against a stub provider; assert no adversarial or defense phase records.
- [ ] 7.2 Orchestrator integration: full mode with `defense_mode = 'address'` forces all defenses to address stance.
- [ ] 7.3 Orchestrator integration: full mode with `dedupe_threshold = 1.0` (only exact matches collapse) preserves diverse drafts.
- [ ] 7.4 Orchestrator integration: dedupe provider fallback — kill local, assert cloud is used; kill both, assert warning + skip.
- [ ] 7.5 Server: `dedupe_critiques: true` rejected with HTTP 400.
- [ ] 7.6 Server: `critique_cycles = 2` rejected with HTTP 400.
- [ ] 7.7 Backward-compat: existing `add-ideate-mode` test suite passes unchanged (the rename is alias-preserved; new params are optional).

## 8. Documentation

- [ ] 8.1 README updates: new section on dedupe (provider order, threshold, disable flag), `critique_cycles` (the Quick Sketch use case explicitly called out), `defense_mode` (with examples of each stance), and `dimension` (with the no-critique-dedupe lock explained).
- [ ] 8.2 Document that `runRebuttalPhase` is a deprecated alias and the canonical name is `runDefensePhase`.
- [ ] 8.3 Document precedence: request body > TOML > defaults.
- [ ] 8.4 Cost note: `critique_cycles = 0` on `full` is the cheapest way to get a multi-model brainstorm with dedupe but no critique.

## 9. Validation

- [ ] 9.1 `openspec validate refine-ideate-forge --strict` passes before merge.
