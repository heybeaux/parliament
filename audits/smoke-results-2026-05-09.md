# Parliament × Lattice — Category 1 Smoke Test Results

**Date:** 2026-05-09
**Plan:** https://github.com/heybeaux/ops/blob/main/parliament-lattice-test-plan.md
**PR:** heybeaux/parliament#77 (extend Lattice to all deliberation presets)
**Audit log:** `parliament-lattice-audit-2026-05-09.jsonl`

## Setup
- Build: PR #77 merged to `main` (commit 97a8ef0), 893 tests passing
- CLI: `parliament deliberate ... --preset star-chamber --max-rounds 1 --lattice`
- Config: `parliament.openrouter.toml` (14 neurotypes routed via OpenRouter)
- Server: pid 49506 on port 3030 (CLI runs engine in-process; server unused for these smokes)

## Topics
| # | Topic | Trace ID | Time |
|---|---|---|---|
| 1 | What is the biggest risk in multi-agent AI systems? | `0100MOYL6R8LTQCP11YR2Z0G37` | ~31s |
| 2 | Should AI agents have runtime authority limits? | `0100MOYLA5K7H01XZDNHFYFVYM` | ~23s |
| 3 | What's the best framework for production agent pipelines? | `0100MOYLAYPHEU51SVIIMO0CQA` | ~25s |
| 4 | How do we measure AI agent reliability? | `0100MOYLBRED5CLO56DQLNPMLZ` | ~23s |
| 5 | What will AI coordination look like in 2027? | `0100MOYLCFYZLVQSZ9X25WGXA7` | ~23s |

## Success Criteria

| Criterion | Result |
|---|---|
| State Contracts created per response | yes — `contractId` on every audit entry |
| Audit log written | yes — 20 wrapped entries (4 per run × 5 runs) |
| Lattice Coordination Report appended to synthesis | yes — all 5 |
| Trace IDs shared across critics in a deliberation | yes — 4 entries per trace |
| Agreement ratio computed | 0.50 on all 5 runs |
| Conflicts detected | 3 fields on all 5 (`mainPoint`, `supportingArguments`, `conclusion`) |

## Per-Run Roles Wrapped
Every run wrapped the star-chamber critics: `structured` (proposer), `critical` (skeptic), `devils-advocate`, `empiricist`. Synthesizer/Sentry/RedAgent are correctly excluded from wrapping (structural roles).

## Adversarial Classification
- `critical`, `devils-advocate` → `isAdversarial: true`, breaker tier `L1`
- `structured`, `empiricist` → `isAdversarial: false`, breaker tier `L1+L2`

## Notes
- The first 2 lines in `parliament-lattice-audit-2026-05-09.jsonl` (trace `0100MOYL3R12EBGR9ATESVSY7G`) are from an earlier debate-preset attempt with `gemma-4-31b-it-8bit` before switching to openrouter config; ignore for smoke verification.
- Agreement ratio of 0.50 reflects the 5 critics producing genuinely divergent state contracts under a 1-round forcing condition. This is expected behavior — the smoke verifies the wrapping/audit machinery, not consensus quality.
- All 5 runs terminated on `max_rounds` as instructed by `--max-rounds 1`.

## Verdict
**5/5 pass.** Category 1 smoke complete. Ready for Category 2 (Performance Benchmark — 20 deliberations) on user go-ahead.
