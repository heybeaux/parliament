# Parliament × Lattice — Category 3 Model Reliability Results

**Date:** 2026-05-09
**Plan:** https://github.com/heybeaux/ops/blob/main/parliament-lattice-test-plan.md
**PR (latency fields):** heybeaux/parliament#79
**Audit log:** `audits/parliament-lattice-cat3-2026-05-09.jsonl` (80 entries)
**Run results:** `/tmp/cat3-results.jsonl` (20 rows, archived alongside this report)

## Setup
- Build: `lattice-latency-fields-2026-05-09` branch (PR #79), 537 tests passing
- CLI: `parliament deliberate ... --preset star-chamber --max-rounds 1 --lattice --audit-log <unique>`
- Config: `parliament.openrouter.toml` (4 critics: structured/critical/devils-advocate/empiricist)
- Audit isolation: unique audit-log path to avoid the orphan-server pollution
  observed in Category 2 (smoke audit was clean; bench audit had inflated trace
  count from a `launchd`-managed server pid 49506 servicing concurrent clients)

## Topics — 5 categories × 4 topics each

| Category | Topics |
|---|---|
| Technical | 100k QPS multi-tenant SaaS · gRPC vs REST · K8s secrets · CI perf-regression detection |
| Ethical | AI legal personhood · open weights vs safety · copyrighted training data · autonomous-agent harm responsibility |
| Business | PMF vs revenue · VC vs bootstrap · B2B SaaS AI pricing · ROI on dev tooling |
| Creative | Sci-fi protagonists · UI novelty vs familiarity · constraint and creativity · narrative pacing |
| Factual | 2008 financial crisis · CRISPR-Cas9 · macroscopic quantum decoherence · printing press impact |

## Top-Line Results

| Metric | Value |
|---|---|
| Total runs | 20 |
| All `rc=0` | yes |
| Unique trace IDs | 20 (one per run, 4 wrap entries each = 80 audit lines) |
| Termination | `max_rounds` on all 20 (as instructed by `--max-rounds 1`) |
| Lattice overhead per wrap (mean / p99 / max) | **15ms / 23ms / 23ms** |
| Lattice overhead share of model call time | **0.25%** |
| Agreement ratio | 0.50 on every run (see Finding 1) |
| Conflicts reported | 3 on every run — `mainPoint`, `supportingArguments`, `conclusion` |
| `passed: false` on every audit entry | yes — expected (see Finding 2) |

## Per-Category Wall-Clock

| Category | Mean (ms) | Comment |
|---|---|---|
| Technical | 41,731 | Slowest — denser prompts/responses, longer LLM completions |
| Creative | 29,345 | |
| Business | 24,641 | |
| Ethical | 23,707 | |
| Factual | 22,947 | Fastest — terse known-answer questions |

Range across all 20 runs: 15.4s – 54.7s, median 25.3s. Star-chamber on
OpenRouter at `--max-rounds 1` is the same regime as Cat 1/Cat 2 — these
numbers track the bench results.

## Per-Role Lattice Overhead

| Role | Adversarial | n | Mean call (ms) | Mean overhead (ms) | Max overhead (ms) |
|---|---|---|---|---|---|
| `structured` (proposer) | no | 20 | 3163 | 11 | 13 |
| `critical` (skeptic) | yes | 20 | 13417 | 16 | 20 |
| `devils-advocate` | yes | 20 | 2253 | 17 | 23 |
| `empiricist` | no | 20 | 5703 | 16 | 21 |

Adversarial (L1-only) and cooperative (L1+L2) tiers add comparable per-wrap
overhead at this prose volume. The `critical` role's higher mean call latency
is just the upstream model — Lattice overhead does not scale with payload here.

## Findings

### Finding 1 — Agreement ratio 0.50 is a metric ceiling, not a coordination failure

**Observed**: 30 deliberations to date (5 smoke + 5 bench-lattice + 20 Cat 3) all
report `agreementRatio: 0.50` and `conflicts: 3` (`mainPoint`,
`supportingArguments`, `conclusion`).

**Root cause**: `buildSyntheticContract` in `packages/core/src/ideate/lattice.ts`
projects each cooperative LLM's prose response into three string fields:
- `mainPoint` = first sentence, ≤200 chars
- `supportingArguments[0]` = first 500 chars of content
- `conclusion` = last 200 chars of content

`ConsensusReducer` then compares those slices using **exact string equality**.
Two LLMs writing on the same topic almost never produce byte-identical first
sentences, first-500-chars, or last-200-chars — even when they semantically
agree. Result: 3/3 fields differ → ratio = 0.50.

**Reproduced** in an isolated probe: two synthetic responses arguing the
same conclusion ("coordination is the biggest risk; mitigate via explicit
protocols + observability") in different prose still hit 0.50 / 3 conflicts.
With two byte-identical responses the same code returns 1.00 / 0 conflicts.

**Verdict**: not a bug in either Parliament or `lattice-adapter-parliament` —
the agreement metric simply isn't semantic. The wrap, audit log, contract
creation, and circuit-breaker pipeline are all working as designed.

**Recommended fix (out of scope for Parliament)**: replace the prose-slice
projection with one of:
1. **Embedding-similarity** at L2 (would need an `EmbeddingProvider` and a
   reducer that compares cosine distance, not string equality).
2. **Cheap claim-extraction** via a small LLM that maps each response to
   structured `{stance, claims[], conclusion}` before reduction.
3. **Boolean-stance projection** (`agrees_with_proposer: true|false`) for the
   simplest case where the topic admits a binary answer.

This is a `lattice-adapter-parliament` enhancement, not a Parliament fix.
Recommend filing as a separate issue against the adapter package.

### Finding 2 — `passed: false` on 100% of audit entries is expected

Lattice runs in `shadowMode: true` and the breaker tiers that **could** pass
(L2 similarity, L3 confidence) require an `EmbeddingProvider` and a
`JudgeProvider` to be injected. None are configured in Parliament's CLI
path today, so L1 structural validation fails closed but doesn't block (shadow
mode), and L2/L3 never run. Every audit entry therefore has `passed: false`.

This means **Cat 3 cannot answer "which models are most reliable"** in the
sense the test plan originally framed — every model "fails" identically
because the validators aren't configured for these payloads. This is a
known limitation, not a regression.

**Recommended fix (also out of scope)**: wire `EmbeddingProvider` (e.g. local
or via OpenRouter embeddings endpoint) and `JudgeProvider` (small judge model)
into the Parliament CLI's `--lattice` setup. Once those are in place, L2/L3
will produce real per-model reliability signal.

### Finding 3 — Lattice wall-clock overhead is negligible

15ms mean, 23ms p99 per wrap. With 4 wraps per star-chamber deliberation, that's
~60ms per run on top of ~28s of model time — **0.25%** of total wall-clock.
The `<10%` overhead target from the test plan is satisfied with 40× headroom.

This is the answer to the practical question "does Lattice slow Parliament
down?" — empirically, no.

### Finding 4 — Audit-log isolation works

Cat 2 had spurious trace IDs from an orphan server. Cat 3 used a unique
audit-log path (`parliament-lattice-cat3-2026-05-09.jsonl`) and produced
exactly 20 unique trace IDs × 4 wrap entries = 80 lines, no pollution.
Future benchmark runs should keep using per-run unique paths until the
server-lifecycle hygiene issue is addressed.

## Verdict

**20/20 pass on the wrapping/audit machinery.** The integration is solid:
- Every model response wraps correctly (4 wraps × 20 runs = 80 audit entries)
- All trace IDs unique and consistent across critics in a run
- Wall-clock overhead is well below the target
- Adversarial vs cooperative classification correct (`critical` and
  `devils-advocate` get L1, `structured` and `empiricist` get L1+L2)

**Cat 3 cannot answer the per-model reliability question** in its
current form because (a) the agreement metric is bounded by a string-equality
projection and (b) L2/L3 validators aren't injected. Both are
`lattice-adapter-parliament` enhancements; Parliament's side of the integration
is correct.

**Ready for Category 4** (known-answer value validation) and **Category 5**
(stress tests). The same caveats apply: we'll be measuring wall-clock,
wrap correctness, and audit-trail integrity — not semantic accuracy of the
consensus output.
