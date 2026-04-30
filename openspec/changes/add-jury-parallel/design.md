## Context

Sequential deliberation has a structural blind spot: order matters. The first speaker frames the problem; the last speaker closes the synthesis. Even with diverse postures across agents, a sequential pipeline biases toward the framing baked in by the first turn.

The PNAS Nexus paper highlights this implicitly through its convergence findings — proprietary models converge faster than open ones, but open models *exposed in sequence* still drift toward whichever voice spoke first. Parallel deliberation breaks the order dependency: agents read the same prior state, generate without seeing each other, and a downstream step reconciles.

The Jury preset is the canonical use of this. A Proposer states a position; a parallel block of critics each evaluates it without seeing each other's critique; a Synthesizer reconciles. This is structurally different from "Star Chamber" (sequential interrogation) — and produces a different kind of output: many independent verdicts vs. one cumulative critique.

## Goals / Non-Goals

**Goals:**
- Parallel-step execution that produces a deterministic transcript (sibling order matches registration order, regardless of completion order).
- A single timeout policy for a parallel block (slowest agent bounds the round).
- A built-in Jury preset that demonstrates the value.
- Timeline UI that renders parallel siblings legibly.
- Backward compatibility: every existing sequential preset and transcript still works.

**Non-Goals:**
- Nested parallel blocks. Parallel-within-parallel is rejected for this stage; flat groups only.
- Cross-talk between parallel siblings. Siblings cannot read each other's output mid-block; that defeats the order-independence property.
- Per-agent timeouts within a parallel block. One block-level timeout only.
- Streaming parallel output to the UI. Parallel results commit to the blackboard atomically after all complete.
- Dynamic parallel-block sizing. Block membership is fixed at config time.

## Decisions

### Read-only blackboard snapshot during parallel execution

When a parallel block starts, the executor takes a read-only snapshot of the blackboard. Every parallel agent reads from this snapshot. None of them sees any other parallel agent's output. After all agents complete, their results are appended to the live blackboard in registration order.

**Why:** Order-independence is the entire point. Letting siblings see each other's outputs (even partial) reintroduces the order-bias problem the parallel block was designed to eliminate.

### Block-level timeout, not per-agent

The parallel block has one timeout. If any agent exceeds it, the block fails. We don't kill individual slow agents while letting others succeed.

**Why:** A partial parallel block produces an asymmetric verdict — three out of four critics weighed in, the fourth timed out. The Synthesizer then reconciles a known-incomplete picture. That's worse than failing loudly. Timeouts in this regime are a deliberation-quality signal; surface them as errors.

### Deterministic sibling order

Sibling turns appear in the transcript in the order they were declared in `parallel_steps`, not in completion order. This makes transcripts reproducible and diff-able.

**Why:** Two runs of the same Jury deliberation might have agents finish in different orders depending on model latency. If the transcript reflected completion order, identical inputs could produce visibly different transcripts. That's confusing. Registration order keeps transcripts stable.

### `parallel_group` annotation on turns

Each turn produced inside a parallel block carries a `parallel_group` field — a group ID shared by all siblings. Downstream consumers (UI, scoring, exporters) use this to render and reason about the group as a unit.

**Why:** Without an annotation, the only way to identify parallel siblings would be to re-read the topology spec. That couples consumers to the topology config. The annotation lets the transcript stand alone.

### Jury membership: Skeptic + Empiricist + Steelmanner + Devil's Advocate

Jury's parallel block uses four critics with deliberately different postures:
- **Skeptic** — logical scrutiny.
- **Empiricist** — evidence demand.
- **Steelmanner** — strongest opposing case.
- **Devil's Advocate** — argues against the room's most likely consensus.

**Why these four:** They're the four critic-postures that can each produce a verdict on a Proposer's position without needing to coordinate. Adding more (e.g., a fifth) starts producing redundant verdicts; fewer leaves blind spots (no charity, or no evidence demand).

## Risks / Trade-offs

- **Concurrency cost.** Parallel blocks send N requests to the model backend simultaneously. On Apple Silicon MLX, this saturates faster than sequential. Mitigation: small blocks (Jury caps at 4); document the implication in the preset description.
- **Block timeout means whole-round failure.** A flaky model can take down a Jury round. Trade-off accepted: fail loudly beats silently degrading the verdict.
- **UI complexity for sibling rendering.** Timeline gains a new visual mode. Mitigation: render-as-row only when `parallel_group` is present; sequential turns render unchanged.
- **No nested parallel.** Some users will eventually want a parallel block inside a parallel block. Trade-off accepted: that's a future change. Flat parallel covers Jury and the obvious next presets.
- **Determinism via registration order, not completion order.** Users debugging latency may want to see completion order. Mitigation: the executor logs completion timing under a debug flag without affecting the transcript order.
