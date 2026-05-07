## 1. Core: lineup + types

- [x] 1.1 Define `IdeateMode = 'cooperative' | 'adversarial' | 'full'` and `IdeateStyle = 'individual' | 'collective'` in `@parliament/core/src/ideate/types.ts`.
- [x] 1.2 Define `LineupRole`, `LineupTeam`, `ResolvedLineup` types covering the 8-model frontier mix (4 closed + 4 open).
- [x] 1.3 Encode default lineup constants in `@parliament/core/src/ideate/lineup.ts`:
  - Closed: `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6`, `openai/gpt-5`, `google/gemini-2.5-pro`
  - Open: `qwen/qwen-turbo`, `deepseek/deepseek-v4-flash`, `mistralai/mistral-nemo`, `nvidia/nemotron-nano-9b-v2`
- [x] 1.4 Implement `resolveLineup(mode, tomlOverrides?)` enforcing strict-by-default override semantics (per-role replace; no merging).
- [x] 1.5 Define `PhaseRecord` and `IdeationRecord` types for transcript persistence.
- [x] 1.6 Unit tests: lineup resolution for each sub-mode with no overrides, partial overrides, full overrides; verify no merge magic.

## 2. Core: orchestrator state machine

- [x] 2.1 Implement `IdeateOrchestrator` in `@parliament/core/src/ideate/orchestrator.ts` driving phase transitions per sub-mode.
- [x] 2.2 Implement `runCooperativePhase(idea, lineup, style, blackboard)` producing a working idea draft.
- [x] 2.3 Implement `runAdversarialPhase(draft, lineup, style, blackboard)` returning parsed `Problem[]` (with one structured-output retry).
- [x] 2.4 Implement `runRebuttalPhase(draft, problems, lineup, style, blackboard, round)` capped at 2 rounds.
- [x] 2.5 Implement `runSynthPhase(transcript, synthModel, blackboard)` producing the final ideation document.
- [x] 2.6 Wire each phase through the existing topology executor — each phase compiles to a topology, executed via `DeliberationEngine` infrastructure (no new engine).
- [x] 2.7 Unit tests with stub adapters covering: cooperative-only flow, adversarial flow with 1 rebuttal, adversarial flow hitting 2-round cap, full flow happy path, full flow with malformed adversarial JSON requiring retry.

## 3. Core: structured adversarial output

- [x] 3.1 Define adversarial system-prompt template enforcing `{ "problems": [{ "problem": ..., "proposed_fix": ... }, ...] }` schema.
- [x] 3.2 Implement parser with one re-prompt on parse failure using a stricter "JSON only" instruction.
- [x] 3.3 On second-attempt failure, preserve raw prose in transcript, emit a `phase.warning` event, and surface the prose in downstream phase prompts marked as unstructured.
- [x] 3.4 Unit tests for: well-formed JSON, malformed-then-retry-success, double-failure-fallback.

## 4. Core: phase-to-topology compilation

- [x] 4.1 Compile cooperative-build to a topology — `individual` style maps to a parallel block, `collective` style maps to a sequential preset over the cooperative team.
- [x] 4.2 Compile adversarial-critique to a parallel block over 2–3 adversarial agents (style-independent: critique is always parallel; style affects only cooperative phases).
- [x] 4.3 Compile rebuttal to a sequential preset (cooperative agents respond one-by-one to the structured problems).
- [x] 4.4 Compile synthesis to a single-agent step using the resolved synth model for the sub-mode.

## 5. Server: routes + persistence

- [x] 5.1 Add `ideations` table schema to the existing migration utility (id TEXT PK, created_at, idea TEXT, mode TEXT, style TEXT, status TEXT, lineup_resolved JSON, phases JSON, synthesis JSON, error TEXT).
- [x] 5.2 Implement `POST /ideate` accepting `{ idea, mode?, style?, confirm? }`. Reject `mode = "full"` without `confirm: true` with HTTP 400.
- [x] 5.3 Implement `GET /ideate/:id` returning the full ideation record; HTTP 404 for unknown IDs.
- [x] 5.4 Implement an in-flight tracker for ideations (mirrors the existing deliberation in-flight pattern) so duplicate `POST /ideate` for the same idea-hash within a window returns the existing ID.
- [x] 5.5 Integration tests: POST/GET round-trip for each sub-mode against a stub provider; confirm-gate enforcement; 404 path.

## 6. Server: lineup TOML loading

- [x] 6.1 Extend the TOML loader to parse `[ideate]`, `[ideate.lineup.<sub-mode>.<role>]`, and `[ideate.synth]`.
- [x] 6.2 Surface validation errors at server boot (unknown role, malformed model ID) with a clear message.
- [x] 6.3 Log the resolved lineup at info-level on first ideation per process (not per-request — keep logs quiet).

## 7. CLI: ideate command

- [x] 7.1 Add `parliament ideate "<idea>"` command in `@parliament/cli` with `--mode` (default `cooperative`), `--style` (default `collective`), `--yes`/`-y` (skip cost prompt), `--print-lineup`.
- [x] 7.2 Implement the cost-estimate-and-confirm prompt for `--mode=full` interactive runs.
- [x] 7.3 Implement `--print-lineup` resolving the lineup without running any model calls.
- [x] 7.4 Hook the CLI to `POST /ideate` with `confirm: true` whenever the user has confirmed (interactively or via `--yes`).
- [x] 7.5 CLI poll loop on `GET /ideate/:id` printing phase progression as it appears.

## 8. Documentation

- [x] 8.1 README section on `parliament ideate` covering sub-modes, styles, lineup, and `[ideate]` TOML overrides.
- [x] 8.2 Document strict-by-default override semantics explicitly: "entries override per-role; missing entries fall back to defaults; there is no merge."
- [x] 8.3 Cost guidance for `full` mode (rough $0.30–1.00 per run depending on idea size).
- [ ] 8.4 (deferred to Stage 4) UI surfacing of ideation transcripts.
- [ ] 8.5 (deferred) Streaming output for ideation runs.

## 9. Validation

- [x] 9.1 `openspec validate add-ideate-mode --strict` passes before merge.
- [ ] 9.2 End-to-end test: real OpenRouter call running cooperative mode against a small idea, asserting non-empty synthesis and a populated `ideations` row. Gated behind an env flag so it doesn't run in default CI.
