## Context

Parliament's existing UI is a read-along: you start a deliberation, you watch turns appear, you read the synthesis. That's enough when there's one preset and five agents. With six presets and thirteen neurotypes available, the user needs:

1. A way to pick which deliberation pattern fits the question (preset picker).
2. Read-along annotations to make sense of who is speaking and why (per-turn enrichment).
3. A retrospective view for the "what actually happened in round 3" question (observability panel).

The user has explicitly said this is *not* a research instrument — it's an end-user tool. So the panel exposes the metrics that already exist (residue, OSI, convergence delta) in plain-language form, rather than introducing new research-grade metrics.

## Goals / Non-Goals

**Goals:**
- Preset picker shows enough information that a non-expert can choose meaningfully.
- Per-turn enrichment is *quiet* — it never competes with the transcript text for attention.
- Observability panel answers "did the room converge, and what nudged it" without requiring a stats background.
- Server contract is additive: new fields appear, old fields don't move.

**Non-Goals:**
- Publishing-grade metrics dashboards. The user has explicitly opted out of research framing.
- Real-time streaming updates beyond what already exists. (Streaming is an existing capability; this change doesn't expand or alter it.)
- Cross-deliberation analytics ("compare last 10 deliberations"). Single-deliberation only.
- An admin/config-edit UI for `parliament.toml`. Out of scope; users edit the file directly.

## Decisions

### Per-turn enrichment AND separate panel

Both surfaces ship. Per-turn enrichment is muted (tooltip / footer / small badge) and serves the read-along experience. The panel is the retrospective view — accessed by toggle, not always visible. Decision rationale: collapsing into one would force a tradeoff between "always visible, gets in the way" and "needs a click to see anything," and neither is the right default. Both, with the panel hidden by default, is the right balance.

### Convergence delta is the headline metric

Of the three numbers Parliament already produces (residue, OSI, convergence delta), the convergence delta per turn is the most legible: positive means "this turn moved the room toward consensus," negative means "this turn pulled the room apart." It maps cleanly to a small visual badge and explains itself without documentation.

### Plain-language metric labels

The panel uses labels like "Disagreement remaining" (residue) and "Room movement" (convergence delta) instead of the research terms. A tooltip exposes the underlying metric name for users who want to dig in. This is a deliberate user-experience choice, aligned with the user's "not a research tool" framing.

### Server contract is additive, never replaces

Every new field (`preset`, `model_name`, `neurotype_posture`, `convergence_delta`, `events`) is added without removing or renaming existing fields. Old client builds keep working. This matters because the UI ships as a separate package and may not deploy in lockstep with the server.

### Preset picker fetches from `GET /presets`

Rather than hardcoding the preset list in the UI, the picker fetches from a new server endpoint. Reasoning: user-defined presets in `parliament.toml` need to appear in the picker without a UI rebuild.

## Risks / Trade-offs

- **Server contract creep.** Each enrichment field adds payload size. Mitigation: fields are small primitives; the dominant payload is still transcript text.
- **Plain-language labels can feel patronizing to expert users.** Trade-off accepted: this is an end-user tool, not a research instrument. Tooltips give experts the underlying metric names.
- **Picker fetch adds a request.** New `GET /presets` call on every fresh page load. Trade-off accepted: small response, no auth dependencies, cacheable.
- **Observability panel is a deferred decision-maker.** Some users will never open it. That's fine — it's a "when you need it" surface, not a primary one. Per-turn enrichment carries the always-visible signal.
