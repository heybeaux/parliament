# Parliament

Parliament is a multi-agent deliberation system. A configurable cast of AI agents — chosen from thirteen built-in **neurotypes** (Proposer, Skeptic, Empiricist, Steelmanner, Devil's Advocate, Translator, Lateralist, Historian, Forecaster, Pragmatist, plus the Synthesizer / RedAgent / Sentry infrastructure roles) — debate a topic on a shared blackboard until they either reach consensus, surface an irreconcilable split, or hit a configured round limit. The shape of each debate is set by a **topology preset** (seven built in, plus user-defined). The engine tracks Opinion Shift Index (OSI) per agent to detect echo loops, weights unresolved conflicts to compute a residue score, and persists every transcript via a REST API.

## Quick start

```bash
pnpm install
pnpm build

# Run a deliberation locally (requires oMLX running at http://localhost:8080/v1)
node packages/cli/dist/index.js deliberate "Should we adopt a four-day work week?"

# Pick a different deliberation shape (a "preset") for this run:
node packages/cli/dist/index.js deliberate --preset jury "Should we adopt a four-day work week?"
```

The CLI is exposed as `parliament` once published; until then invoke the built entry directly.

### Choosing a deliberation type

Every run uses one **topology preset** — the shape of the debate (which neurotypes speak, in what order, and which run in parallel). Three places to set it:

- **Web UI** — start the React dev server with `pnpm --filter @parliament/ui dev` and use the **preset picker** at the top of the New Deliberation form. Pick a preset from the dropdown (or click a color chip), enter a topic, optionally expand "Add context" to paste a brief, and submit. Live turns stream in over SSE as each agent fires; when the Synthesizer terminates the run, the completed deliberation renders in place. The picker reads `GET /presets` from the server, so any user-defined presets in `parliament.toml` show up alongside the seven built-ins.
- **CLI** — pass `--preset <id>` to `parliament deliberate`. Example: `parliament deliberate --preset chain-of-verifiers "Is this load-shedding plan sound?"`. Unknown values exit `1` with a "did you mean …?" suggestion.
- **`parliament.toml`** — set `[topology] active = "<id>"` to make a preset the default for every run. The CLI flag and the `POST /deliberate` `preset` field both override this per-run.

Skip to the [Presets table](#presets) for the seven built-in shapes, or read **[docs/topology.md](docs/topology.md)** for the parallel-step semantics and order-bias rationale. The thirteen built-in neurotypes are catalogued in **[docs/neurotypes.md](docs/neurotypes.md)**.

## Configuration

All configuration lives in `parliament.toml` at the repository root. The loader reads from `process.cwd()`; override the path with `PARLIAMENT_CONFIG=/path/to/config.toml` or `--config <path>` on the CLI.

```toml
[parliament]
max_rounds            = 5      # forced termination round
confidence_threshold  = 0.7    # synthesizer score required for consensus
red_agent_interval    = 2      # inject the disruptor every N rounds
osi_enabled           = true   # echo-loop detection on per-role transcripts
server_port           = 3000   # REST server port

# Pick the default deliberation shape. Built-in presets:
#   debate, star-chamber, chain-of-verifiers, socratic, long-view, reframe, jury
# Override per-run via the CLI `--preset` flag or the POST /deliberate body.
[topology]
active = "jury"

# Customize a built-in neurotype — here, give the Proposer a different model
# and prompt without touching the topology. The three infrastructure roles
# (synthesizer, redAgent, sentry) are wired by the engine and configured the
# same way.
[neurotypes.proposer]
model    = "gemma-4-31b-it-8bit"
provider = "omlx"
system_prompt = "You are a structured reasoner. ..."

# ...other neurotype overrides follow the same shape
```

A `[neurotypes.<id>]` block declares which model and prompt to use for that neurotype. The infrastructure roles (`synthesizer`, `redAgent`, `sentry`) are always wired by the engine. Steppable neurotypes only need a block when the active preset references them — see [the preset table below](#presets) and **[docs/neurotypes.md](docs/neurotypes.md)** for the full roster. Multiple neurotypes may share a model; the scheduler groups same-model agents into batches to minimise model swaps.

Switch the LLM provider via `PARLIAMENT_PROVIDER` or per-neurotype `provider` field: `ollama`, `lm_studio`, or `omlx` (default for this config). Set `OMLX_BASE_URL` to point at your oMLX instance (default: `http://localhost:8080/v1`).

## REST API

```bash
node packages/server/dist/index.js
```

The server binds to `parliament.server_port` (3000 by default) or the `PORT` env var if set, on the host configured under `[server].host` (default `127.0.0.1` — loopback only).

| Endpoint                | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `POST /deliberate`      | Run a new deliberation. Body: `{ topic, preset?, config? }`. |
| `GET  /deliberate/:id`  | Fetch a stored deliberation by UUID.                   |
| `GET  /presets`         | List the topology preset registry plus the active default. |
| `GET  /health`          | Probe each model's adapter for connectivity.           |

#### Preset precedence

`POST /deliberate` resolves the preset to use in this order:

1. `request.preset` — wins when supplied. Unknown values return `400` with a list of available preset IDs.
2. `[topology].active` from `parliament.toml` — used when the request omits `preset`.
3. `debate` — falls back here when `[topology]` is absent or `active` is unset (matches the loader's default-fallback rule).

`GET /presets` returns `{ presets, defaultPreset }`. Each entry carries the full required metadata (`id`, `name`, `description`, `best_for`) plus its step list, so clients can render a picker without a second round-trip.

### Hardening

The server is locked down to a localhost-only profile by default. Override via `[server]` in `parliament.toml` or the matching env vars:

```toml
[server]
host                 = "127.0.0.1"                                  # PARLIAMENT_SERVER_HOST
cors_origins         = ["http://localhost:*", "http://127.0.0.1:*"] # PARLIAMENT_CORS_ORIGINS (comma-separated)
rate_limit_concurrent = 1                                           # PARLIAMENT_RATE_LIMIT_CONCURRENT
rate_limit_per_hour   = 10                                          # PARLIAMENT_RATE_LIMIT_PER_HOUR
```

To expose the API beyond loopback set `host = "0.0.0.0"` **and** explicitly set `cors_origins` to your real allowlist; the localhost defaults are not auto-expanded.

Set `PARLIAMENT_API_KEY=<secret>` to require `Authorization: Bearer <secret>` on every route (timing-safe compare). When unset, the server logs a warning at startup and accepts unauthenticated requests so localhost dev works out of the box. `POST /deliberate` is rate-limited per client IP using the values above.

`config` accepts `maxRounds`, `redAgentInterval`, and `confidenceThreshold` overrides; anything omitted falls back to the values in `parliament.toml`. `preset` accepts any registered preset id (built-in or user-defined). Results are persisted to a SQLite file (`parliament.db`) in the working directory.

Example:

```bash
curl -s -X POST http://localhost:3000/deliberate \
  -H 'Content-Type: application/json' \
  -d '{"topic": "Should we ship feature X this quarter?"}' | jq .
```

## CLI

```
parliament deliberate <topic> [options]
  --preset <name>           Override [topology].active for this run
  --max-rounds <n>          Override [parliament].max_rounds
  --model-proposer <id>     Override the Proposer's model
  --model-skeptic <id>      Override the Skeptic's model
  --config <path>           Use a specific parliament.toml

parliament get <id>
  Fetch a previously-saved deliberation from the server.
  Server URL is read from PARLIAMENT_SERVER_URL (default http://localhost:3030).
```

`--preset` accepts any registered preset id (built-in or user-defined). Unknown values exit `1` with a `did you mean "X"?` suggestion plus the alphabetized list of available presets — the same format the loader emits when `[topology].active` points at a non-existent preset. When omitted, the CLI uses `[topology].active` from `parliament.toml`, falling back to `debate`. The default `debate` path is byte-identical to legacy runs; any non-default preset routes through the topology runtime.

The deliberate command streams a colored transcript turn-by-turn, then prints either a SYNTHESIS section (consensus) or an UNRESOLVED SPLIT section (irreconcilable positions), followed by the residue score and termination reason.

## Presets

Topology presets compose neurotypes into reusable deliberation shapes. Pick one with `--preset <id>` (CLI), `preset` in the `POST /deliberate` body, or by setting `[topology].active` in `parliament.toml`. The full topology rationale, parallel-step semantics, and order-bias notes live in **[docs/topology.md](docs/topology.md)**.

| Preset               | Shape                                                              | Pick when                                                                                                              |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `debate`             | Proposer → Skeptic                                                 | You want the original, byte-identical Parliament debate. The default when `[topology]` is absent.                      |
| `star-chamber`       | Proposer → Skeptic → Devil's Advocate → Empiricist                 | Sequential interrogation. Each critic builds on the prior one's framing.                                               |
| `chain-of-verifiers` | Proposer → Empiricist → Steelmanner → Skeptic                      | Claim-checking pipelines where each step verifies the prior turn before advancing.                                     |
| `socratic`           | Translator → Empiricist → Skeptic                                  | Surfacing hidden assumptions before stress-testing them.                                                               |
| `long-view`          | Historian → Proposer → Forecaster → Pragmatist                     | Decisions whose consequences play out over years — precedent in, constraint out.                                       |
| `reframe`            | Lateralist → Translator → Steelmanner                              | Stuck framings. Forces a structural shift before anyone defends a position.                                            |
| `jury`               | Proposer, then **{Skeptic, Empiricist, Steelmanner, Devil's Advocate}** in parallel | Use Jury when you don't want the first speaker's framing to dominate the room — four critics fire concurrently against one snapshot. |

Built-in presets always include their full metadata (`name`, `description`, `best_for`, step list, plus `requires_neurotypes` / `missing_neurotypes`) under `GET /presets`, so a UI picker can render them without a second round-trip. User-defined presets author the same fields under `[topology.presets.<id>]`.

## Architecture

- **`@parliament/core`** — pure TypeScript engine. Contains `DeliberationEngine`, the thirteen built-in neurotype agent classes, the topology loader (presets, parallel-step support), model adapters (Ollama, LM Studio, OMLX, OpenAI-compatible), the OSI calibration module, the model-aware scheduler, and the TOML config loader.
- **`@parliament/server`** — Hono REST server backed by SQLite (better-sqlite3). Wires the engine to HTTP, exposes `GET /presets` for UI pickers, and persists every result.
- **`@parliament/cli`** — Commander-based CLI that runs deliberations locally and fetches stored ones from the server.
- **`@parliament/ui`** — React + Vite web client. Includes the preset picker, live SSE turn stream, and observability panel.

`DeliberationEngine` exposes two paths. The default `debate` preset uses the legacy round-shape (Proposer round 1 only → Skeptic → Sentry → Synthesizer → Sentry → optional RedAgent) for byte-identical back-compat with pre-topology runs. Every other preset routes through `runTopology`, which executes the preset's `steps` (or `parallel_steps`) per round and threads Sentry + Synthesizer through the same termination logic. In both paths Sentry returns `COLLAPSE_DETECTED` to terminate on echo, and the Synthesizer's parsed confidence terminates on consensus.

## Agents

Parliament ships with thirteen built-in **neurotypes** — deliberation postures that topology presets compose from — plus three pieces of structural infrastructure (Synthesizer, Sentry, RedAgent). The full roster, their posture axes, and the non-obvious behaviors of each are documented in **[docs/neurotypes.md](docs/neurotypes.md)**.

| Agent             | Posture                                                                            |
|-------------------|------------------------------------------------------------------------------------|
| Proposer          | Opens with a clear, well-reasoned initial position                                 |
| Skeptic           | Challenges assumptions, identifies logical gaps                                    |
| Historian         | Precedent-first — reasons from "what has happened"                                 |
| Forecaster        | Forward-projection — likely consequences across time horizons                      |
| Pragmatist        | Constraint-first — what is actually doable                                         |
| Empiricist        | Evidence-first — distinguishes empirical claims from value judgments               |
| Steelmanner       | Charity — constructs the strongest opposing case                                   |
| Devil's Advocate  | Contrarian-to-consensus — anti-groupthink                                          |
| Lateralist        | Structural analogy — cross-domain reframing                                        |
| Translator        | Assumption-surfacing + plain-language gloss                                        |
| Synthesizer       | _infrastructure_ — reconciles conflicts or marks irreconcilable splits             |
| Red Agent         | _infrastructure_ — adversarial injection to disrupt premature consensus            |
| Sentry            | _infrastructure_ — echo-loop + convergence monitor                                 |

All agents run locally via [oMLX](https://github.com/openclaw/omlx). Set `OMLX_BASE_URL` if your instance isn't at the default `http://localhost:8080/v1`.

Models and system prompts are configured in `parliament.toml` and can be swapped per-neurotype without touching code.

## Development

```bash
pnpm test         # vitest across all packages (unit + integration)
pnpm build        # tsc project references
pnpm lint         # eslint
```

Integration tests stub only the LLM call, exercising the real engine, real router, and a real in-memory SQLite database, so they run offline.
