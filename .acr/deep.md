# Parliament — Deep

Loaded when designing in or debugging Parliament. Token budget ~2500.

## Engine

`DeliberationEngine` in `packages/core/src/engine.ts` runs rounds of agent emissions, classifies termination (`consensus`, `max_rounds`, `echo_loop`), and produces synthesis via the structural synthesizer agent. Best-effort synthesis tracker (since 2026-05-05) captures highest-confidence synth attempt across rounds and surfaces it when terminating on max_rounds/echo_loop instead of returning `synthesis: null`. `split` (structured non-consensus summary) is now driven by `terminationReason === 'consensus' ? null : buildSplitSummary(...)` — decoupled from synthesis presence.

Two engine paths: `run()` (linear) and the topology-driven runner. Both apply the best-effort tracker.

## Lineups and modes

Lineups live in TOML configs (`parliament.toml`, `parliament.openrouter.toml`, etc). `PARLIAMENT_CONFIG` env picks which one. A lineup is a list of agents + structural participants + mode (cooperative-full, adversarial-critique, etc).

`agent_id` field in TOML is overridden at request time by `callerAccountId` (default `acct_oss_self_host`) → memory is account-scoped, not config-scoped.

## Structural built-ins

`synthesizer`, `redAgent`, `sentry` are *structural* — they have class-level SYSTEM_PROMPTs but are deliberately outside `BUILTIN_AGENT_REGISTRY`. Use `hasBuiltinDefaultPrompt` when checking whether an agent has a default prompt. Don't add them to the registry; they're meta-coordinators, not first-class agents.

## Persistence

`~/.parliament/parliament.db` is the source of truth. Server is a view. Tables: `ideations(id, created_at, account_id, idea, mode, style, status, lineup_json, phases_json, synthesis, error, lattice_json)` and `deliberations` for the older endpoint, plus accounts + API keys.

phases_json: JSON array of round data. synthesis: plain text (not JSON).

## Key decisions / recent incidents

- **2026-05-05** — Best-effort synthesis surfacing landed. Engine no longer returns null on non-consensus terminations.
- **2026-05-12** — Server port hijacked by endeavour runtime, 8-model adversarial job appeared lost. Recovered by querying SQLite directly. Reinforced "DB is source of truth."

## Internal vocabulary

- **Phase** = one round of agent emissions
- **Synthesis** = synthesizer's prose output
- **Split** = structured non-consensus summary (per-agent positions)
- **Termination reason** = consensus | max_rounds | echo_loop
- **Lineup** = TOML-defined list of participating agents + mode
- **Structural agent** = synthesizer/redAgent/sentry (outside the registry)

## Boundaries

- Parliament **does** deliberate, synthesize, classify termination, persist results.
- Parliament **does not** sign events (Sonder), apply gate policy (Lattice), recall memory (Engram).
- Parliament **does** support being called as Inos's deliberation node type natively.

## Open questions / parked work

- **Mode taxonomy clarity.** cooperative-full vs adversarial-critique vs other modes — names + selection criteria deserve a docs pass.
- **OpenRouter `~`-prefixed virtual routes don't work.** Models like `~google/gemini-pro-latest` appear in /api/v1/models but 400 on /chat/completions. Pin concrete preview IDs.
