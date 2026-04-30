## Context

The original five agents were chosen for the dialectic loop. As Parliament grew, the limit became clear: every voice was operating on the agree/disagree axis. A deliberation about a long-range policy question and a deliberation about an immediate engineering tradeoff both ended up sounding like Skeptic vs. Proposer, with Synthesizer mediating.

The PNAS Nexus paper's structural insight is that *posture* diversity (how an agent is *thinking*, not just what it's *saying*) is what produces resilient deliberation. Eight neurotypes were chosen to span three orthogonal posture axes:

- **Temporal**: Historian (past) ↔ Forecaster (future). Anchors claims in time.
- **Epistemic**: Pragmatist (constraint-first) ↔ Empiricist (evidence-first). Anchors claims in what's true / what's feasible.
- **Rhetorical**: Steelmanner (charity) ↔ Devil's Advocate (contrarian) / Lateralist (analogy) / Translator (compression). Anchors claims in how they're argued.

## Goals / Non-Goals

**Goals:**
- Eight neurotypes, each implementable as a small focused agent class.
- Postures distinct enough that picking any 3-4 of them yields a non-redundant deliberation.
- Stable string IDs that topology configs can reference forever.
- Word caps tuned so a deliberation with 8 voices stays under reasonable token budgets.

**Non-Goals:**
- Replacing the original five. They stay; this is additive.
- Modeling personality beyond posture. These are *cognitive postures*, not characters.
- Dynamic neurotype generation. Roster is fixed in Stage 1; user-defined neurotypes via `[neurotypes.*]` came in Stage 0 spec, but the *built-in registry* is closed.
- Picking optimal models per neurotype. Model assignment is config-time, not class-time.

## Decisions

### Posture, not persona

Each neurotype's system prompt describes **how to think**, not **who to be**. "You are a Historian" frames cognitive method; it doesn't invent a character. This keeps the prompt testable: does the output exhibit the posture?

### Devil's Advocate is contrarian-to-consensus, not contrarian-to-Proposer

The DA reads the latest synthesis and argues against *whatever just emerged as the room's view*. That includes arguing against critique itself when critique has dominated. This is the only neurotype whose target shifts mid-deliberation.

**Why it matters:** a fixed-target contrarian (always disagreeing with the Proposer, say) is just a second Skeptic. A consensus-tracking contrarian breaks echo collapse, which is the failure mode the Sentry exists to detect.

### Translator surfaces hidden assumptions

Translator is the only neurotype with two jobs: compress for non-experts AND name assumptions that experts left implicit. Splitting these into two agents was considered and rejected — they're the same cognitive move (re-stating in different terms), and combining them keeps the roster at eight rather than nine.

### IDs are kebab-case

Registry IDs: `historian`, `forecaster`, `pragmatist`, `steelmanner`, `empiricist`, `lateralist`, `translator`, `devils-advocate`. Apostrophes drop. Kebab-case stays consistent with the rest of `parliament.toml`.

### Word caps

Word caps stay aligned with the original five (200 words default). A deliberation including all eight new neurotypes is still under 2,000 output tokens per round, which is well within budget for local MLX models.

## Risks / Trade-offs

- **Roster is closed in core.** Users who want a ninth neurotype must define one under `[neurotypes.*]` (Stage 0 spec already permits this). Trade-off: simpler core, slightly more friction for power users.
- **DA may collude with Skeptic.** When a deliberation is critique-heavy, both the DA and Skeptic point in the same direction (against the Proposer). Mitigation: DA's prompt explicitly tells it to oppose the *most recent* convergent view, not a fixed target.
- **Translator sometimes flattens nuance.** Compression is lossy. Trade-off accepted: the value of surfacing hidden assumptions outweighs the cost of occasional oversimplification.
- **Eight is a lot.** Topologies that use all eight will be slow on small local models. Mitigation: topology presets pick subsets (Long-View uses Historian + Forecaster + Pragmatist; Reframe uses Lateralist + Steelmanner + Translator; etc.), not the full roster.
