## Context

`add-ideate-mode` is live and exercised. Real runs surface four problems the original change couldn't have known about without usage data:

1. Cooperative output has near-duplicates that bloat the adversarial prompt and dilute critique signal. Embedding+cosine collapse is the standard fix.
2. The rebuttal round is mandatory whenever there's an adversarial phase. There's no "quick brainstorm with dedupe but no critique" path even though that's the most common ask in practice.
3. Cooperative authors respond to critiques with whatever prose the model felt like. Outputs vary wildly model-to-model and there's no way to say "for this run, force authors to actually revise" vs "let them defend."
4. Critiques aren't labeled by dimension. The synthesizer can't group "all UX problems" or weight legal differently than business. And there's no architectural lock against a well-meaning future change "deduping" critiques — which would erase the very thing ideate optimizes for (multi-model perspective diversity).

This change is spec-only. Code follows. The goal is to lock the contract so the four edges get fixed coherently rather than piecemeal.

## Goals / Non-Goals

**Goals:**
- Dedupe ideas, never critiques. The diversity that makes critiques valuable is the same diversity dedupe would destroy.
- Make the "no adversarial pass" path a first-class request, not a special mode. `critique_cycles = 0` is orthogonal to sub-mode so a `full` user can still skip critique cheaply.
- Make the cooperative-author response policy explicit (`defense_mode`). Eliminate "did the model decide to address or defend? who knows."
- Rename rebuttal → defense without breaking callers (`runRebuttalPhase` stays exported as a deprecated alias).
- Keep dedupe failure soft. Embedding providers are external; a transient outage MUST NOT fail an ideation.

**Non-Goals:**
- Multi-round critique. Hard-capped at 1 cycle in v1. The parameter exists for future expansion; values `> 1` are rejected.
- Dedupe of critiques. Architectural lock — `dedupe_critiques: true` is a 400.
- Tuning the dedupe threshold per dimension or sub-mode. Single threshold, single knob.
- Streaming any of the new events. `phase.dedupe`, `phase.warning` go through the existing event bus to existing consumers.
- UI surfacing of dimensions or defenses. Stage 4 still owns UI.

## Decisions

### Dedupe runs between cooperative and adversarial — not after adversarial

Two reasons. First, the value of dedupe is reducing what the adversarial phase has to chew on; running it after critique misses the point. Second, deduping after adversarial would require also reconciling critiques across collapsed drafts, which is exactly the critique-dedupe operation Pax explicitly forbids. Pre-adversarial dedupe operates only on cooperative drafts where collapsing is unambiguous (same draft expressed twice). Post-adversarial dedupe would have to touch critiques. So pre-adversarial is both better and the only place that's architecturally clean.

**Alternative considered:** dedupe after synth, as a post-processing step on the synthesized document. Rejected — by synth time the critiques have already done expensive work on duplicate drafts.

### Embedding provider order: local first, cloud fallback, soft-fail

`engram-embed` at `http://localhost:8080` is preferred because it's free, fast, and lives on the same machine as the orchestrator. Engram Cloud at `api.openengram.ai` is the fallback because remote latency and cost are real but the call is one batch per ideation. If both fail, dedupe is skipped with a `phase.warning` — the ideation continues with un-deduped drafts. Hard-failing the ideation on an embedding outage would be a fragility multiplier on a refinement that's supposed to add robustness.

**Alternative considered:** cloud-first to avoid the local engram-embed setup burden. Rejected — local-first matches the user's stated preference for keeping local services authoritative when running (see Engram running tree notes), and remote calls dominate latency on otherwise-fast cooperative phases.

### `critique_cycles` stays orthogonal to sub-mode

The natural temptation is to add a fourth sub-mode `brainstorm` that means "cooperative + dedupe + synth, no critique." Rejected. Sub-modes encode lineup defaults (which models are in the cooperative team vs adversarial team) and phase ordering. `critique_cycles = 0` is purely a phase-toggle. Wrapping it in a sub-mode would mean either duplicating lineup defaults across `brainstorm` and `cooperative` (and keeping them in sync) or making `brainstorm` an alias which is just bad surface area. `critique_cycles` as an independent param means `full` with `critique_cycles = 0` is a coherent combo — "use the full 8-model lineup but skip the adversarial pass" — which is a real ask we'd otherwise have to invent another sub-mode for.

The hard cap at 1 is a v1 honesty signal, same logic as the 2-round rebuttal cap in `add-ideate-mode`. We don't know what 2+ critique cycles look like in practice yet. The parameter shape supports future expansion without an API break.

### `defense_mode` default is `author_choice`

Three options were considered for the default:

| Default        | Effect                                                                    |
|----------------|---------------------------------------------------------------------------|
| `address`      | Force rewrites. Highest revision rate but kills genuine "I still think I'm right" signal. |
| `double_down`  | Force justifications. Preserves position diversity but ideas never improve in response to critique. |
| `author_choice`| Author picks per critique. Mirrors how thoughtful humans actually defend their work. |

`author_choice` wins because it most resembles the actual cognitive work the system is simulating. Users who want a specific stance for a specific run can force it. `address` is the right pick when the goal is "stress-test then revise" (e.g., feeding the output into a deliberation). `double_down` is the right pick when the goal is preserving diverse positions for a downstream human reviewer.

The forced-stance modes (`address`, `double_down`) parser-validate the stance field and reject mismatched stances with one retry. This is symmetric with the existing adversarial JSON retry logic — same fallback semantics, no new error machinery.

### `runRebuttalPhase` stays as a deprecated alias

The rename to defense is more accurate (a rebuttal is just one of two stances; defense is the umbrella). But `runRebuttalPhase` is exported from `@parliament/core` and could be imported by external consumers. Breaking the export name on a refinement is a bad trade. Alias keeps the surface stable; `@deprecated` JSDoc nudges callers to the new name; a future major version can drop the alias.

### Critique-dedupe lock is architectural, not policy

Pax's call: never dedupe critiques. The lock is enforced at two layers:

1. **Request layer:** `dedupe_critiques: true` in the POST body is a 400 with an explanatory message. This catches well-meaning callers.
2. **Code layer:** an in-tree comment lock plus an `assertCritiquesNotDeduped()` callable used in tests. The function itself is trivial; the value is the test coverage forcing future refactors to confront the lock.

The lock exists because the temptation to "clean up" critiques across models is real and would silently erase the multi-model diversity signal that ideate's whole architecture is built on. The 400 message says this verbatim so future contributors understand why it's locked.

### `dimension` on critiques enables synth grouping without new tables

Adding `dimension: 'ux'|'business'|'technical'|'market'|'legal'|'other'` to every problem lets the synthesizer group critiques by category and weight them differently in the final synthesis. The synth prompt can say "address every legal critique explicitly; group UX critiques into themes." No new persistence — `dimension` lives inside the existing `phases[].problems[]` JSON. The closed enum (six values) is small enough that models pick correctly with one-shot prompting; `other` is the escape hatch.

### Persistence: no migration

`ideations.phases` is free-form JSON. New entries `dedupe` and `defense` slot in without schema change. The `synthesis` JSON also has room for dimension-grouped output. This was a deliberate design property of `add-ideate-mode` and it pays off here.

## Risks / Trade-offs

- **Dedupe collapses ideas that are similar-but-not-identical.** [Risk] At `threshold = 0.85` you can lose genuine semantic variation, especially when cooperative authors riff on the same seed. → Mitigation: threshold is configurable; default tuned conservatively; `--no-dedupe` is one flag away; `phase.dedupe` event surfaces the merge map so users can audit.

- **Embedding provider fallback adds a hidden network call.** [Risk] Users not running local engram-embed silently hit Engram Cloud on every ideation, which has cost and latency implications. → Mitigation: `--print-lineup` (extended in this change) also prints the resolved dedupe config including which provider order is configured. Local-first default means the cost only materializes for users who don't run engram-embed, and they can `enabled = false` it.

- **`defense_mode` forced stances may produce model contortion.** [Risk] Forcing `double_down` when the author actually agrees with the critique produces ugly defensive prose; forcing `address` when the author disagrees produces shallow rewrites. → Mitigation: `author_choice` is the default for exactly this reason. Forced modes are opt-in tools for specific workflows.

- **`critique_cycles = 0` on `full` looks like a misconfiguration.** [Risk] A user pays for the full 8-model lineup and skips the most expensive phase. Could be the right call, could be a mistake. → Mitigation: CLI prints the resolved phase list before running; the cost estimate explicitly reflects the skipped phase so the user sees the savings.

- **Critique-dedupe lock could be bypassed by future contributors who don't read design.md.** [Risk] The `assertCritiquesNotDeduped()` test helper helps but isn't ironclad. → Mitigation: the request-layer 400 + explanatory message + this design doc + the in-code comment block. Layered defense, not a single chokepoint.

- **Dimension classification accuracy varies by model.** [Risk] Some adversarial models will mis-label legal critiques as business, etc. → Mitigation: `other` exists as the escape hatch; downstream synth weights are advisory not load-bearing; misclassification is a soft-quality issue, not a correctness one.

- **Soft-fail dedupe hides embedding outages.** [Risk] If engram-embed and Engram Cloud both go down for an extended period, users get un-deduped ideations and a `phase.warning` they may not notice. → Mitigation: the warning is in the persisted phases JSON; the CLI prints warnings inline during polling; longer-term observability is a separate concern.

## Migration Plan

No data migration. Refinement is purely additive at the request, code, and persistence layers:

1. New code lands in `@parliament/core/src/ideate/dedupe.ts`; orchestrator gains the new phase between existing phases.
2. `runRebuttalPhase` keeps working via alias. External callers are unaffected on import.
3. CLI gains four new flags. Absent flags hit server-side defaults.
4. TOML gains two new sections. Absent sections hit in-code defaults.
5. `ideations.phases` JSON shape extends; existing rows are forward-compatible (no required new fields on old rows).
6. Rollback strategy: revert the change. Old rows with `dedupe`/`defense` phase entries remain readable (free-form JSON); the orchestrator just won't write new ones.

## Open Questions

- Should `dedupe_threshold` be tuneable per sub-mode (e.g., looser for `cooperative`, tighter for `full`)? → Tentatively no; single knob until usage data argues for splitting.
- Should `phase.dedupe` events include the embedding vectors for debugging? → No — bloats transcript JSON. The merge map is enough; vectors can be recomputed if needed.
- Does `defense_mode = 'address'` need a hard length cap on `draft_delta` to prevent runaway rewrites? → Tentatively no; defer until we see a runaway in practice.
- Will Pax want `dimension` weights configurable via TOML (e.g., always weight `legal` 2×)? → Future change if it comes up; not in scope here.
