# Parliament Benchmark — Corpus Design, Methodology & Rubric

| | |
|---|---|
| **Status** | Design (v1.0 ships 50 questions; v1.5 expands to 100) |
| **Owner** | Marketing-eng |
| **Source of truth** | This file + `docs/benchmark/corpus.md` (the question set, ships when populated) |
| **Roadmap reference** | `ROADMAP.md` ticket T4.2 |

This document is the *spec* for the benchmark — what we're measuring, why, and how. The corpus itself (the 50 questions and their grading data) lives in a separate file because it'll churn frequently as we tune. This spec should be stable.

## What we're trying to demonstrate

The marketing claim Parliament needs to defend: **on hard, real-world software-decision questions, multi-agent deliberation produces measurably better answers than a single-shot frontier-model response.** "Better" decomposes into:

1. **Higher correctness** when ground truth exists.
2. **Higher completeness** — more of the relevant trade-offs surfaced.
3. **Better failure-mode identification** — what breaks first when this ships.
4. **Honest uncertainty** — Parliament's residue score correlates with actual unresolvedness, single-shot confidence does not.

Claim #4 is the load-bearing one. Anyone can claim higher accuracy; only Parliament can claim *measured* honesty about what it doesn't know. That's the differentiator the benchmark is built to expose.

## Corpus design principles

### 1. Questions must be *hard*, not just *long*

Easy questions ("how do I exit vim?") and trivia ("what's the time complexity of quicksort?") are noise — single-shot LLMs handle them fine, and Parliament adds latency without signal. The corpus is curated for questions where:

- A senior engineer would think for 10+ minutes before answering.
- The "right" answer depends on context, trade-offs, or values, not just facts.
- Hallucination is plausible — i.e., a confident-sounding wrong answer is a realistic failure mode.

### 2. Five categories, balanced

| Category | Count (of 50) | What it probes |
|---|---|---|
| **Architecture & system design** | 12 | Stack choices, data-model decisions, scaling trade-offs |
| **Security & threat modeling** | 10 | Attack surface, mitigation choices, threat-model framing |
| **Performance & debugging** | 8 | Bottleneck identification, root-cause hypotheses, observability gaps |
| **Product & engineering trade-offs** | 10 | Build vs. buy, ship-vs-polish, scope discipline |
| **Code quality & refactor scoping** | 10 | What to refactor, what to leave, when abstractions earn their keep |

Each category has its own grading rubric weights (below) — not all four output dimensions matter equally for every question type.

### 3. Questions must have either ground truth or a defensible reference answer

Two acceptable kinds:

- **Ground-truth questions** (~30%): the correct answer is verifiable post-hoc (e.g., "what does this code do at runtime?", "what's the bug here?", "what does this RFC actually require?").
- **Reference-answer questions** (~70%): no single correct answer, but a panel of three named senior engineers (declared in the corpus) has agreed on a reference response that captures the trade-offs a thoughtful answer should surface. Disagreements among the reference panel are themselves data — they bound how confident any model should be.

Pure-opinion questions ("what's the best language?") are excluded.

### 4. No questions a model could memorize

Every question is paraphrased from a real situation we've encountered, *not* drawn verbatim from Stack Overflow, GitHub issues, or known training corpora. Questions are designed so that even if a model has seen the underlying scenario, recalling a memorized answer doesn't trivially win — the framing forces fresh reasoning.

### 5. Context discipline

Each question ships with a fixed context block (~300-800 words) — the same context goes to single-shot baselines and Parliament. Parliament's edge has to come from the deliberation, not from extra context the baseline didn't get.

## Question template

Each entry in `docs/benchmark/corpus.md` follows this shape:

```yaml
id: bench-arch-001
category: architecture
difficulty: hard            # easy | medium | hard | expert
question: |
  We're a 12-person team running Postgres + Node. Write throughput is 200 RPS,
  projected 2,000 RPS in 18 months. Compliance requires audit trail of every
  user-state change. Should we adopt event sourcing for our user service?
context: |
  [300-800 words describing the actual system, prior decisions, team capacity,
   stakeholder constraints, etc.]
ground_truth_kind: reference  # ground_truth | reference
reference_answer:
  primary_recommendation: |
    Don't adopt event sourcing for the user service alone. Add an append-only
    audit table for compliance, defer event sourcing until a domain event
    actually justifies it.
  must_surface:
    - Compliance can be solved by a much simpler audit table
    - Event sourcing introduces CQRS complexity the team doesn't currently have
    - 2,000 RPS is well within Postgres's capabilities with proper indexing
    - "Distributed transactions" failure mode if event store and read model diverge
  bonus_points:
    - Mentions outbox pattern as a halfway option
    - Identifies that the real question is about projection-rebuild cost
  red_flags:
    - Recommends event sourcing without acknowledging operational cost
    - Treats this as a pure database choice rather than an org-capability question
reference_panel: [reviewer_a, reviewer_b, reviewer_c]
panel_consensus: 3/3        # how many of the panel agree with primary_recommendation
```

## Grading rubric

Every Parliament output and every baseline output is scored on five dimensions. Scoring happens twice: once by an LLM judge (for scale), once by a human (for trust). Scores must agree within ±1 on each dimension or the question gets re-graded.

### Dimensions (0-5 each, 25 total)

| Dimension | Weight (default) | Architecture | Security | Performance | Product | Code |
|---|---|---|---|---|---|---|
| **Correctness** — does the primary recommendation match the reference? | 1.0 | 1.2 | 1.5 | 1.5 | 0.8 | 1.0 |
| **Completeness** — fraction of `must_surface` items present | 1.0 | 1.2 | 1.0 | 1.0 | 1.2 | 1.0 |
| **Failure-mode coverage** — fraction of red-flag/risk items addressed | 1.0 | 1.0 | 1.5 | 1.2 | 1.0 | 0.8 |
| **Calibration** — does stated confidence match panel consensus? | 1.0 | 0.8 | 1.0 | 0.8 | 1.2 | 1.0 |
| **Coherence** — internal consistency of the argument | 1.0 | 0.8 | 1.0 | 1.0 | 0.8 | 1.2 |

Weights normalize per category — so a security question's correctness score is worth more than a product question's correctness score. This reflects that security wrongness is dangerous in a way product wrongness isn't.

### What "calibration" measures specifically

This is the most important dimension and the one Parliament should win on:

- **Reference panel agreed 3/3:** model should express high confidence (≥0.8 on its own scale).
- **Reference panel agreed 2/3:** model should express moderate confidence (0.5-0.7) and identify the dissenting view.
- **Reference panel agreed 1/3 or split:** model should explicitly flag the question as contested (≤0.5 confidence) and lay out the positions.

A model that always says "high confidence" loses calibration points on the contested questions; a model that always hedges loses on the consensus ones. Single-shot LLMs typically fail by being overconfident on contested questions; Parliament's residue score is designed to surface exactly this.

## Test conditions

### Parliament configuration

- **Lineup:** frontier (qwen3.6-plus, mistral-large-2512, deepseek-v4-pro, kimi-k2.6, glm-5.1).
- **Preset:** matched to category. Architecture → socratic; Security → adversarial; Performance → chain-of-verifiers; Product → debate; Code → jury.
- **Max rounds:** 5.
- **Confidence threshold:** 0.85.

### Baselines (3, run for every question)

1. **Frontier-A:** a single call to the strongest model in the Parliament lineup (claude-opus-4-7 or equivalent), with the same context block, asked the same question.
2. **Frontier-B:** same as Frontier-A but using a different vendor's frontier model (e.g., gemini-3-ultra) — to defend against any "Parliament wins because of model selection bias."
3. **Chain-of-thought:** same model as Frontier-A, with explicit "think step by step, list trade-offs, identify failure modes" prompt scaffolding. This is the strongest single-shot baseline — if Parliament can beat *this*, the deliberation is doing real work.

### Run protocol

- Each question runs **3 trials** per condition (Parliament, Frontier-A, Frontier-B, CoT) to control for sampling variance. 50 questions × 4 conditions × 3 trials = **600 runs**.
- All runs published to `parliament.app/d/bench-<id>-<condition>-<trial>` as public deliberations (Parliament) or transcripts (single-shot).
- Per-run cost recorded.
- Per-run latency recorded.
- LLM judge: a separate frontier model (not in Parliament's lineup) grades each output blind to which condition produced it. Human grader reviews 20% sample for inter-rater agreement.

## Reporting

The published benchmark page (`parliament.app/benchmark`) reports:

1. **Headline score:** total weighted points, Parliament vs. each baseline, per category and overall.
2. **Win rate:** fraction of questions where Parliament's median trial score exceeds each baseline's median.
3. **Calibration plot:** stated confidence on x-axis vs. correctness rate on y-axis, per condition. The line of identity is the ideal; deviations show overconfidence (above the line) or underconfidence (below).
4. **Cost-per-correct-answer:** each condition's total spend divided by total correct-answer count. Parliament loses on absolute spend; the question is whether it wins on $/correct.
5. **Latency-per-correct-answer:** same shape, latency instead of cost.
6. **Failure showcase:** the top-5 questions where Parliament won by the largest margin, and the top-5 where it lost. Both are honest signal — the losses tell users when *not* to reach for Parliament.

## Pre-registered hypotheses (declared before grading begins)

To keep the benchmark honest, we commit to these hypotheses *before* any data is graded:

1. **H1 (primary):** Parliament's weighted total exceeds the strongest single-shot baseline (CoT) by ≥10% on the corpus overall.
2. **H2:** Parliament's calibration error (mean absolute deviation between stated confidence and correctness rate) is at least 30% lower than every single-shot condition.
3. **H3 (the one we might lose):** On *easy* questions (difficulty: easy), Parliament does not win — single-shot is faster, cheaper, and good enough.
4. **H4:** Adversarial-preset wins on the Security category by a wider margin than any other preset wins its matched category — failure-mode-first deliberation is the most differentiated.

If H1 fails, we don't publish a "Parliament wins" benchmark — we publish what we measured and reframe the marketing claim. If H3 *succeeds* (Parliament wins on easy questions too), we should be skeptical of the corpus design — it suggests the easy questions weren't actually easy. Disconfirming the easy-baseline hypothesis is itself a check on our methodology.

## Anti-cheat protections

- **No corpus leakage to training.** The corpus stays private until publication; questions are drawn from real situations rephrased to be unsearchable.
- **Held-out sample (20%).** A 10-question held-out set is reserved for re-validation 6 months post-launch — if Parliament's win margin holds on a fresh-to-the-models corpus, the original benchmark stands; if it doesn't, the methodology gets revisited.
- **Open data.** Every transcript and grading record is published. Anyone can re-grade or re-run.
- **Adversarial review.** Before publication, three external senior engineers review the corpus for: (a) questions where the reference answer is wrong, (b) categories that are systematically biased toward Parliament's strengths, (c) grading rubric ambiguities. Their findings ship as an addendum if non-trivial.

## Update cadence

- **v1.0 ships 50 questions.** Built in M4 (ROADMAP T4.2).
- **v1.5 expands to 100** (Q4 2026), with adversarial-review feedback incorporated.
- **Quarterly re-runs:** the corpus is re-run quarterly as model releases ship. Parliament's win margin against each frontier release is the live signal we care about.
- **Corpus rotation:** any question that all four conditions ace gets retired (it's stopped being hard).

## What this benchmark is *not*

- **Not a leaderboard.** This isn't a "Parliament beats GPT-N" race. The publication is structured around the calibration story, not horse-race scores.
- **Not a replacement for in-domain eval.** Pro/Team customers should run their own deliberations on their own decisions and grade accordingly. The benchmark exists to make the *initial* case credible, not to substitute for measured fit.
- **Not infinitely refined.** There is no version of this corpus that escapes Goodhart entirely. Treat the benchmark as a calibration tool, not as the truth.
