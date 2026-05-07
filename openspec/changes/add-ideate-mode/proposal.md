## Why

Parliament's deliberation engine is built for *resolving* a question. But the upstream stage — generating, expanding, and stress-testing a product idea — is also where multi-model diversity pays off, and there's no first-class flow for it today. Users currently shoehorn ideation into a Debate run, which conflates "build on this idea" with "decide which side wins." `/ideate` carves that out as its own mode with a control flow tuned for divergent → adversarial → convergent thinking, and a frontier-model lineup that mixes open and closed providers so cognitive diversity isn't bottlenecked by a single vendor.

This change is roadmap **Stage 3** — a new top-level mode parallel to `deliberate`, building on the topology runtime and neurotype registry already in place.

## What Changes

- A new top-level mode `ideate`, parallel to `deliberate`, with three sub-modes:
  - `cooperative` (default): all agents build additively on the idea.
  - `adversarial`: 2–3 agents stress-test the working idea; each critique MUST surface both a problem and at least one proposed fix; cooperative agents then run a mandatory rebuttal round (capped at 2 rounds).
  - `full`: cooperative team builds → adversarial team critiques → cooperative rebuts (capped at 2 rounds) → synthesizer reconciles. Most expensive, richest output.
- Two contribution **styles**, orthogonal to sub-mode:
  - `individual`: each model riffs in parallel on the original idea; synthesizer reconciles at the end.
  - `collective` (default): agents run sequentially, each seeing prior turns.
- New default lineup mixing open + closed frontier models (drops Grok, adds Mistral and Nemotron):
  - **Closed**: Opus 4.6, Sonnet 4.6, GPT-5, Gemini 2.5 Pro
  - **Open**: Qwen, DeepSeek, Mistral, Nemotron
  - `cooperative` and `adversarial` default to closed-team only; `full` uses all eight.
- Synthesizer routing:
  - `cooperative` / `adversarial` → Opus 4.6
  - `full` → Gemini 2.5 Pro (chosen for context window — full ideation transcripts strain Opus's 200K)
- New HTTP route `POST /ideate` with parallel polling at `GET /ideate/:id`, mirroring `/deliberate`.
- New CLI command `parliament ideate "<idea>" [--mode=cooperative|adversarial|full] [--style=individual|collective]`.
- New TOML block `[ideate]` to override defaults (sub-mode, style, lineup, synth model, rebuttal cap) without code changes.
- `/deliberate` is **unchanged**. `/ideate` is purely additive.

## Capabilities

### New Capabilities
- `ideate-mode`: A deliberation flavor specialized for idea generation and stress-testing. Owns the cooperative/adversarial/full sub-mode state machine, individual/collective styling, the rebuttal loop, and lineup defaults.

### Modified Capabilities
<!-- None. The existing topology-runtime capability is reused as the underlying execution mechanism, but its requirements don't change — `ideate` registers its flows as topologies and consumes the existing executor. -->

## Impact

- **@parliament/core**: new `ideate/` module (sub-mode state machine, rebuttal controller, lineup resolver). Reuses `topology/` executor for individual phases. New built-in topologies: `ideate-cooperative`, `ideate-adversarial`, `ideate-full`.
- **@parliament/server**: new `POST /ideate` and `GET /ideate/:id` routes; new `ideations` table mirroring `deliberations` for transcript storage; new request/response types.
- **@parliament/cli**: new `parliament ideate` command with `--mode` and `--style` flags.
- **@parliament/ui**: (deferred to Stage 4) ideation viewer. This change ships API + CLI only.
- **Backward compatibility**: zero impact on `deliberate`. Existing `parliament.toml` files without `[ideate]` keep working — defaults are baked into core. The Grok→Mistral/Nemotron lineup change applies only to `ideate` defaults; `parliament.openrouter.toml`'s deliberation lineup is unchanged.
- **Cost**: `full` mode is materially more expensive (8 models × cooperative-build + 3 adversarial × critique + 4 cooperative × rebuttal × 2 rounds + synthesizer ≈ 20 model calls per idea). The CLI MUST print an estimate-and-confirm prompt before running `full` mode interactively. Programmatic API callers MUST opt in via `confirm: true` or an equivalent flag — the server MUST NOT auto-run `full` for callers who pass an empty body.
- **Roadmap**: Stage 3. Depends on `add-topology-runtime` (executor) and `add-eight-neurotypes` (lineup roles). Unblocks Stage 4 UI surfacing for ideation transcripts.
