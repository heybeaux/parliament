# Neurotypes

A **neurotype** is a deliberation posture — a stable angle from which an agent reads the blackboard and contributes a turn. Parliament ships with thirteen built-in neurotypes, organized along three axes (temporal, epistemic, rhetorical) plus the two original generalists.

This doc is the canonical roster. Topology presets (and the `[neurotypes.*]` sections in `parliament.toml`) reference these neurotypes by their **kebab-case ID**.

> **User-defined neurotypes** are also supported as an advanced escape hatch — see [Defining your own neurotype](#defining-your-own-neurotype) at the end of this doc. The thirteen built-ins are the primary path; user-defined ones exist for cases the built-in roster genuinely doesn't cover.

---

## The roster at a glance

| ID                | Role            | Axis        | Posture                                       |
| ----------------- | --------------- | ----------- | --------------------------------------------- |
| `proposer`        | Proposer        | _generalist_ | Opens with a clear, well-reasoned position    |
| `skeptic`         | Skeptic         | _generalist_ | Challenges assumptions, surfaces logical gaps |
| `historian`       | Historian       | temporal    | Precedent-first — what has happened           |
| `forecaster`      | Forecaster      | temporal    | Forward-projection — likely consequences      |
| `pragmatist`      | Pragmatist      | epistemic   | Constraint-first — what is actually doable    |
| `empiricist`      | Empiricist      | epistemic   | Evidence-first — testable vs. value-judgment  |
| `steelmanner`     | Steelmanner     | rhetorical  | Charity — strongest opposing case             |
| `devils-advocate` | Devil's Advocate | rhetorical  | Contrarian-to-consensus — anti-groupthink     |
| `lateralist`      | Lateralist      | rhetorical  | Structural analogy — cross-domain reframing   |
| `translator`      | Translator      | rhetorical  | Assumption-surfacing + plain-language gloss   |

The Synthesizer, Sentry, and RedAgent are **infrastructure**, not steppable neurotypes. They are wired by the deliberation engine directly and cannot appear as steps in a topology.

---

## The originals

### `proposer` — Proposer

- **Posture axis:** generalist
- **One-line:** Opens the deliberation with a clear, well-reasoned initial position.
- **When to use:** Round 1 of nearly every preset. The Proposer fires once and never speaks again — its job is to put a defensible thesis on the blackboard for everyone else to react to.

### `skeptic` — Skeptic

- **Posture axis:** generalist
- **One-line:** Challenges assumptions, identifies logical gaps, and records explicit conflicts on the blackboard.
- **When to use:** Every round of nearly every preset. The Skeptic is the only neurotype besides Synthesizer that mutates `blackboard.conflicts` directly, which feeds the residue score.

---

## Temporal axis

### `historian` — Historian

- **Posture axis:** temporal (past-facing)
- **One-line:** Reasons from "what has happened" — surfaces precedent, prior cases, and historical patterns relevant to the present claim.
- **When to use:** Policy debates, technology-adoption decisions, organizational-change questions — anywhere that "we've seen this play out before" is a useful frame.
- **Non-obvious behavior:** When the Historian genuinely cannot identify a relevant historical analogue, it says so explicitly with the literal phrase **"no clear historical precedent"** rather than inventing one. That phrase is a stable transcript marker downstream tooling can grep for.

### `forecaster` — Forecaster

- **Posture axis:** temporal (future-facing)
- **One-line:** Projects likely downstream consequences and second-order effects across distinct time horizons.
- **When to use:** Decisions whose payoff/cost profile changes over time — strategy, infrastructure choices, regulatory questions. Pairs naturally with the Historian.
- **Non-obvious behavior:** The Forecaster reasons across **at least two horizons** — near-term (months to ~1 year) and longer-term (multiple years out) — and labels each one explicitly. If a projected longer-term consequence would invalidate the original claim, the Forecaster flags it with the literal phrase **"would invalidate the claim"** so self-undermining proposals are visible to the Synthesizer.

---

## Epistemic axis

### `pragmatist` — Pragmatist

- **Posture axis:** epistemic (constraint-first)
- **One-line:** Reasons from "what is actually doable" — identifies binding real-world constraints (resources, time, social/political feasibility, technical limits) and proposes minimum viable variants when the maximalist version is infeasible.
- **When to use:** Implementation-flavored deliberations, anything where the room risks drifting into ideal-world theorizing. Especially valuable late in a debate after positions have hardened.
- **Non-obvious behavior:** The Pragmatist uses two literal anchors: **"binding constraint"** when naming the limiting factor, and **"minimum viable variant"** when proposing a scoped-down alternative. Both phrases are stable transcript markers.

### `empiricist` — Empiricist

- **Posture axis:** epistemic (evidence-first)
- **One-line:** Distinguishes empirical claims (testable against the world) from value-judgment claims (not testable), demanding evidence for the former and explicitly labeling the latter.
- **When to use:** Mixed factual/ethical debates, science-policy questions, anywhere claims are smuggled across the empirical/normative line.
- **Non-obvious behavior — value-claim handling:** The Empiricist does **NOT** reject value-judgment claims and does **NOT** treat them as out-of-scope. Ethics and policy deliberations depend on value claims remaining in the transcript; the Empiricist's job is to **flag the limitation, then move on**. The literal markers are **"demand evidence"** (for unsupported empirical claims) and **"this claim is a value judgment, not an empirical one"** (for value claims). This is a deliberate design decision — see the Stage 1 elaboration record.

---

## Rhetorical axis

### `steelmanner` — Steelmanner

- **Posture axis:** rhetorical (charity)
- **One-line:** Constructs the strongest reasonable opposing case to whatever was just argued.
- **When to use:** Contested-values debates, anywhere the room risks dismissing the best counter-argument too quickly. Pairs well with the Skeptic — the Skeptic attacks; the Steelmanner defends what was attacked.
- **Non-obvious behavior — anti-strawman guardrail:** The Steelmanner is explicitly forbidden from straw-man framing — it never uses phrases like "they obviously think" or "the silly objection that". It presents the opposing position as the proponent of that view would actually phrase it, opening with the literal phrase **"the strongest opposing case is"**.

### `devils-advocate` — Devil's Advocate

- **Posture axis:** rhetorical (contrarian-to-consensus)
- **One-line:** Argues against whichever position the room is converging toward, regardless of its own beliefs — structural anti-groupthink.
- **When to use:** Multi-round deliberations where premature consensus is a real risk. The Devil's Advocate is the engine's primary defense against agents echoing each other.
- **Non-obvious behavior — round-1 fallback:** In Round 1 there is no consensus to attack yet, so the Devil's Advocate does something different: it identifies an **unstated assumption** the Proposer's claim relies on and attacks that. Opens with the literal phrase **"the unstated assumption is"**.
- **Non-obvious behavior — Round 2+ consensus-tracking:** Starting in Round 2, the Devil's Advocate reads the recent turns to identify the dominant view (affirmation, critique, or emerging synthesis) and inverts it. Opens with the literal phrase **"the dominant view in this round is"** followed by its read of what that view is, then delivers the inversion. The detection heuristic: an empty turn list or ≤2 turns at round 1 → Round 1 prompt; any round ≥ 2 or > 2 turns → Round 2+ prompt.

### `lateralist` — Lateralist

- **Posture axis:** rhetorical (structural analogy)
- **One-line:** Reframes the question through a structural analogy from a materially different domain that shares the same underlying shape.
- **When to use:** When the room is stuck in the topic's surface details and missing the structural shape of the problem (coordination problem? measurement problem? commons problem? principal-agent?). Especially valuable when paired with the Translator.
- **Non-obvious behavior:** The Lateralist uses two literal anchors. First, it labels the structural class of the question with the literal phrase **"this is a"** followed by the class (coordination/measurement/commons/principal-agent/etc.). Then it offers an analogy from a materially different domain (biology, maritime, urban planning, sport, finance, ecology, the trades) using the literal word **"analogy"** or **"analogous"** so the move is visible in the transcript.

### `translator` — Translator

- **Posture axis:** rhetorical (assumption-surfacing + compression)
- **One-line:** Surfaces load-bearing implicit assumptions in recent turns and (secondarily) restates the deliberation in plain language for non-experts.
- **When to use:** When the room is operating on shared but unargued premises, or when the deliberation has gotten technical enough that a non-expert reader would be lost. The Translator is one of the highest-leverage positions late in a debate.
- **Non-obvious behavior — priority order:** The Translator serves two functions, and the **priority order is fixed**: assumption-surfacing comes **FIRST**; plain-language compression is second. If the 200-word cap forces a trade-off, the Translator drops the restatement and keeps the assumptions. Literal anchors: **"the load-bearing assumption is"** (or "the load-bearing assumptions are") opens the assumption section; **"in plain language"** opens the compression section. For purely procedural turns with no implicit assumptions to surface, the Translator falls back cleanly: opens with "in plain language" and delivers only the compression. This priority is encoded by Stage 1 elaboration decision.

---

## Defining your own neurotype

The thirteen built-ins above are the canonical roster — most presets should compose from them. For cases the built-ins genuinely don't cover, `parliament.toml` accepts user-defined neurotypes via `[neurotypes.<id>]`:

```toml
[neurotypes.regulator]
model         = "gemma-4-31b-it-8bit"
provider      = "omlx"
system_prompt = "You are a regulator. Your posture is compliance-first..."
```

The `<id>` must be kebab-case and must NOT collide with a built-in ID. The topology runtime resolves built-ins first and falls back to user-defined neurotypes only for unknown IDs — so a user-defined `historian` is an error, not an override.

User-defined neurotypes are deliberately **not** promoted as a primary path: every additional posture in the system is an additional axis the Sentry, OSI scorer, and Synthesizer must reason about. Reach for them only after confirming the built-ins won't do.
