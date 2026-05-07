## Context

Parliament's deliberation engine resolves *whether* a claim holds. Ideation is the inverse cognitive task: take a seed and grow it. Today, users force-fit ideation into Debate runs, which biases agents toward critique-then-synthesis when they should be expanding. The engine already has the primitives we need — topology runtime, parallel block executor, a registry of neurotypes — so `ideate` is a new orchestrator on top of existing infrastructure, not a parallel engine.

Two facts shape the design:

1. The topology runtime executes a fixed step list. The ideate flow is *stateful* in a way Debate isn't: cooperative output feeds adversarial critique, which conditionally triggers a rebuttal loop, which then feeds synthesis. That's a state machine, not a step list.
2. The default lineup mixes closed and open frontier models. Configuring eight model entries inline in every user's `parliament.toml` is a footgun; defaults must live in code with TOML overrides.

Stakeholders: end users running ideation interactively (CLI), programmatic callers (HTTP), and downstream UI work (Stage 4) which will consume whatever transcript shape we lock here.

## Goals / Non-Goals

**Goals:**
- Add `ideate` as a top-level mode parallel to `deliberate`, with three sub-modes (`cooperative`, `adversarial`, `full`).
- Support both `individual` (parallel) and `collective` (sequential) contribution styles.
- Adversarial agents MUST emit structured `{problem, fix}` pairs; the system MUST run a rebuttal round (capped at 2 rounds) before synthesis.
- Frontier-mixed lineup (4 closed + 4 open) bakes into core; users can override via `[ideate]` in TOML.
- Synth routing differs by sub-mode: Opus 4.6 for cooperative/adversarial, Gemini 2.5 Pro for full.
- Cost gate: `full` mode MUST require explicit caller confirmation; the server MUST NOT auto-run it on an empty body.
- Reuse existing topology executor, blackboard, and transcript storage where possible.

**Non-Goals:**
- UI surfacing of ideation transcripts. Deferred to Stage 4.
- A new memory-residue scoring model tuned for ideation. The OSI scorer keeps running but interpretation in ideation context is a future change.
- Streaming ideation output. The endpoint is poll-based like `/deliberate`. Streaming is its own change.
- Auto-promoting an ideated outcome into a deliberation. If a user wants to pressure-test an ideated plan, they'd run `/deliberate` against the synthesized doc separately.
- Letting `[ideate]` redefine the *deliberation* lineup. The two configs are isolated; touching one MUST NOT mutate the other.
- Custom user-defined ideation flows beyond the three built-ins. The state machine ships with three concrete sub-modes; arbitrary user state machines are not in scope.

## Decisions

### Ideate is an orchestrator over the topology executor, not a new engine

The ideate module composes existing topology runs into a higher-level state machine. Cooperative-build, adversarial-critique, and rebuttal phases each compile to a topology executed by the existing `DeliberationEngine` infrastructure. The state machine lives in `@parliament/core/src/ideate/orchestrator.ts` and decides which topology to run next based on previous-phase output.

**Alternative considered:** a parallel `IdeationEngine` with its own blackboard and turn loop. Rejected — duplicates a lot of plumbing (provider failover, sources, residue scoring, transcript persistence) and would drift from `DeliberationEngine` over time. Composition keeps the two paths sharing one runtime.

### Sub-modes are state machines, not topology presets

A topology preset is a flat ordered step list. The ideate flows are inherently branching (rebuttal-or-skip, full = cooperative→adversarial→rebuttal→synth, etc.). Modeling them as a single linear preset would either bake the branching into the executor (bad) or require a "skip if" condition language we don't want to design. So:

- `ideate-cooperative` is a single phase: an `individual` (parallel block) or `collective` (sequential) topology over the cooperative team, then synth.
- `ideate-adversarial` is two-or-three phases: critique → optional rebuttal × N → synth. The orchestrator runs each phase as its own topology.
- `ideate-full` is four-or-five phases: cooperative-build → adversarial-critique → rebuttal × N → synth.

Each phase is still a topology — we get to reuse loader, executor, transcript writer. The orchestrator just picks the next topology and threads outputs forward.

### Adversarial output MUST be structured `{problem, fix}`

Adversarial agents are instructed to emit JSON: `{ "problems": [{ "problem": "...", "proposed_fix": "..." }, ...] }`. This is enforced by:

1. System prompt template that demands this exact schema.
2. A parser in the orchestrator that re-prompts up to once on malformed output before failing the phase.

**Why:** the rebuttal round needs to address each problem on its merits, and a synthesizer reading critiques benefits from a structured list. Free-form prose makes the rebuttal step's prompt unstable.

**Alternative considered:** loose prose with a downstream extractor. Rejected — adds a model call, costs accuracy. Constraining the producer is cleaner than parsing the consumer.

### Rebuttal cap is 2 rounds, fixed

Hardcoded ceiling of 2 rebuttal rounds. After round 2, synthesis runs regardless. The cap lives in the state machine, not in `[ideate]` TOML, because the value is integral to the cost/quality balance. Users can tune lineup, sub-mode, and synth model — they cannot tune rebuttal depth in this change.

**Alternative considered:** dynamic stop based on adversarial-agent satisfaction (run another round if any adversarial agent says "still concerned"). Rejected for v1 — that's an alignment-with-self problem, and "are you satisfied?" prompts have known reliability issues. Fixed cap is honest and predictable. Future change can introduce a `[ideate.rebuttal] max_rounds` field if we get evidence the cap is wrong.

### Default lineup lives in code; TOML overrides additively

The 8-model default lineup (closed: Opus 4.6, Sonnet 4.6, GPT-5, Gemini 2.5 Pro; open: Qwen, DeepSeek, Mistral, Nemotron) is encoded as constants in `@parliament/core/src/ideate/lineup.ts`. `[ideate.lineup]` in `parliament.toml` MAY override individual roles or replace teams wholesale. Strict-by-default: an entry under `[ideate.lineup]` REPLACES the default for that role; absence falls back to the default. There's no merge magic.

**Why:** users shouldn't have to write 8 model entries to use this feature. They also shouldn't be confused by silent defaults — `parliament ideate --print-lineup` will dump the resolved lineup so they can see exactly what's running.

### Synth routing: per-sub-mode default, override via TOML

| Sub-mode      | Default synth        | Reason                                   |
|---------------|----------------------|------------------------------------------|
| cooperative   | Opus 4.6             | Best general-purpose synthesis           |
| adversarial   | Opus 4.6             | Same — synthesizing critiques+rebuttals  |
| full          | Gemini 2.5 Pro       | 2M context handles 8-model transcripts   |

Override via `[ideate.synth] cooperative = "..."`, etc. The Gemini-for-full default is a real choice: Opus 4.6 at 200K starts truncating mid-transcript on a full ideation run with rebuttals. Gemini's larger context wins specifically here. The user has explicitly preferred Opus 4.6 over 4.7 elsewhere in Parliament; this change does not contradict that — Opus 4.6 remains the synth for the two cheaper sub-modes.

### Cost gate is enforced server-side, not just CLI

`full` mode is roughly 3-4× the cost of `cooperative`. The CLI gates with an interactive y/N. But the HTTP API is callable programmatically, so the *server* MUST also gate: `POST /ideate` with `mode: "full"` MUST be rejected unless the request body sets `confirm: true` (or, equivalently, `acknowledge_cost: true`). Programmatic callers opt in deliberately.

**Why:** a misconfigured retry loop calling `POST /ideate` defaulting to `full` would burn money fast. Server-side gating is the only correct place for this.

### Persistence: new `ideations` table, mirroring `deliberations`

`ideations` is a separate table. We do NOT shoehorn ideation transcripts into `deliberations` with a discriminator, because the phase structure (cooperative-build / adversarial-critique / rebuttal / synth) doesn't map onto deliberation rounds and turns 1:1. Schema differences propagate cleanly into a separate table.

Schema (sketch): `id, created_at, idea, mode, style, status, lineup_resolved (JSON), phases (JSON of phase records), synthesis (JSON), error`.

**Why a separate table:** deliberations are round-based; ideations are phase-based. Forcing one schema would require a `phase_type` column in `turns` and lots of NULLable round-specific columns. Cleaner to have parallel tables that share the transcript-writing utilities.

## Risks / Trade-offs

- **State-machine bugs hiding in conditional paths.** [Risk] Rebuttal-skip logic and full-mode phase chaining are net-new control flow with several branches. → Mitigation: each phase transition is unit-tested with stub adapters; an integration test runs full mode end-to-end against a deterministic fake provider.

- **Adversarial-output JSON parse failures.** [Risk] Models occasionally emit prose despite schema instructions; one bad output stalls the phase. → Mitigation: one structured-retry on parse failure with a stricter "JSON only, no prose" prompt; second failure surfaces the prose in the transcript and synth treats it as best-effort. Avoid hard-failing the whole ideation on a single bad output.

- **Cost surprise on `full`.** [Risk] User runs `parliament ideate --mode=full "..."` not realizing it's ~$0.30-1.00 per run depending on idea size. → Mitigation: CLI prints a token+dollar estimate before running and requires explicit `y` to proceed; server requires `confirm: true`.

- **Lineup drift from default deliberation lineup.** [Risk] Two lineups in two configs creates "which model am I actually running?" confusion. → Mitigation: `parliament ideate --print-lineup` and a startup log line on first ideation per process showing the resolved lineup.

- **Open-source model availability through OpenRouter.** [Risk] Qwen / DeepSeek / Mistral / Nemotron model IDs change as providers update versions; defaults rot. → Mitigation: the lineup constants name a single specific model ID per role; failing OpenRouter calls surface as phase failures with the model ID in the error so the fix is obvious. We accept periodic constant updates as a maintenance cost.

- **Synthesizer context-window mismatch.** [Risk] Choosing Gemini 2.5 Pro only for `full` means cooperative/adversarial synths could still truncate on unusually long ideation runs (large initial idea + verbose agents). → Mitigation: monitor truncation in initial usage; if cooperative/adversarial transcripts exceed ~150K tokens regularly, reroute their synth to Gemini too. Not blocking for v1.

- **Strict-by-default lineup overrides could surprise users who expected merging.** [Risk] User adds `[ideate.lineup.cooperative.proposer]` thinking they're appending; instead they replace just that role and the rest of the cooperative team uses defaults — *which is the correct behavior*, but documenting it loud is necessary. → Mitigation: the README section on `[ideate.lineup]` MUST state "entries override per-role; missing entries fall back to defaults; there is no merge."

- **Rebuttal loop oscillation.** [Risk] Cooperative and adversarial agents could ping-pong on the same disagreement for both rounds. → Mitigation: the cap is hardcoded at 2; synthesis runs regardless after round 2; the rebuttal prompt explicitly instructs the cooperative agent to either *concede the point* or *defend with new evidence*, never just restate.

## Migration Plan

No migration required. Additive change:

1. New code lands behind the `ideate` namespace; nothing in `deliberate` paths changes.
2. New `ideations` SQLite table is created on first server boot via the existing schema-migration utility.
3. CLI gains `parliament ideate`; existing `parliament deliberate` is untouched.
4. Rollback strategy: revert the change. The `ideations` table is harmless to leave behind; new code paths are unreachable without callers.

## Open Questions

- Should the `individual` style synthesizer see all parallel outputs simultaneously, or run a brief reconciliation pass between independent agents before synth? → Tentatively no — synthesizer reads them all at once. Revisit if synthesis quality on `individual` runs is poor.
- Should `full` mode allow an asymmetric lineup (e.g. closed-team cooperative + open-team adversarial) as a first-class option, or is "all 8 do all phases" enough? → v1 ships "all 8 do all phases"; asymmetric splits are a later configuration concern.
- Does `parliament ideate` need a `--no-confirm` flag for scripting? → Likely yes; `--yes`/`-y` skips the cost prompt. Tasks include this.
