# Parliament

Parliament is a multi-agent deliberation system. Five specialised AI agents — Proposer, Skeptic, Synthesizer, RedAgent, and Sentry — debate a topic on a shared blackboard until they either reach consensus, surface an irreconcilable split, or hit a configured round limit. The engine tracks Opinion Shift Index (OSI) per agent to detect echo loops, weights unresolved conflicts to compute a residue score, and persists every transcript via a REST API.

## Quick start

```bash
pnpm install
pnpm build

# Run a deliberation locally (requires oMLX running at http://localhost:8080/v1)
node packages/cli/dist/index.js deliberate "Should we adopt a four-day work week?"
```

The CLI is exposed as `parliament` once published; until then invoke the built entry directly.

## Configuration

All configuration lives in `parliament.toml` at the repository root. The loader reads from `process.cwd()`; override the path with `PARLIAMENT_CONFIG=/path/to/config.toml` or `--config <path>` on the CLI.

```toml
[parliament]
max_rounds            = 5      # forced termination round
confidence_threshold  = 0.7    # synthesizer score required for consensus
red_agent_interval    = 2      # inject the disruptor every N rounds
osi_enabled           = true   # echo-loop detection on per-role transcripts
server_port           = 3000   # REST server port

[neurotypes.proposer]
model    = "gemma-4-31b-it-8bit"
provider = "omlx"
system_prompt = "You are a structured reasoner. ..."

# ...skeptic, synthesizer, redAgent, sentry follow the same shape
```

The five neurotype roles — `proposer`, `skeptic`, `synthesizer`, `redAgent`, `sentry` — are required. Multiple roles may share a model; the scheduler groups same-model agents into batches to minimise model swaps.

Switch the LLM provider via `PARLIAMENT_PROVIDER` or per-neurotype `provider` field: `ollama`, `lm_studio`, or `omlx` (default for this config). Set `OMLX_BASE_URL` to point at your oMLX instance (default: `http://localhost:8080/v1`).

## REST API

```bash
node packages/server/dist/index.js
```

The server binds to `parliament.server_port` (3000 by default) or the `PORT` env var if set.

| Endpoint                | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `POST /deliberate`      | Run a new deliberation. Body: `{ topic, config? }`.    |
| `GET  /deliberate/:id`  | Fetch a stored deliberation by UUID.                   |
| `GET  /health`          | Probe each model's adapter for connectivity.           |

`config` accepts `maxRounds`, `redAgentInterval`, and `confidenceThreshold` overrides; anything omitted falls back to the values in `parliament.toml`. Results are persisted to a SQLite file (`parliament.db`) in the working directory.

Example:

```bash
curl -s -X POST http://localhost:3000/deliberate \
  -H 'Content-Type: application/json' \
  -d '{"topic": "Should we ship feature X this quarter?"}' | jq .
```

## CLI

```
parliament deliberate <topic> [options]
  --max-rounds <n>          Override [parliament].max_rounds
  --model-proposer <id>     Override the Proposer's model
  --model-skeptic <id>      Override the Skeptic's model
  --config <path>           Use a specific parliament.toml

parliament get <id>
  Fetch a previously-saved deliberation from the server.
  Server URL is read from PARLIAMENT_SERVER_URL (default http://localhost:3030).
```

The deliberate command streams a colored transcript turn-by-turn, then prints either a SYNTHESIS section (consensus) or an UNRESOLVED SPLIT section (irreconcilable positions), followed by the residue score and termination reason.

## Architecture

- **`@parliament/core`** — pure TypeScript engine. Contains `DeliberationEngine`, the five agent classes, model adapters (Ollama, LM Studio, OMLX, OpenAI-compatible), the OSI calibration module, the model-aware scheduler, and the TOML config loader.
- **`@parliament/server`** — Hono REST server backed by SQLite (better-sqlite3). Wires the engine to HTTP and persists every result.
- **`@parliament/cli`** — Commander-based CLI that runs deliberations locally and fetches stored ones from the server.

The `DeliberationEngine` runs each round as: Proposer (round 1 only) → Skeptic → Sentry → Synthesizer → Sentry → optional RedAgent. Sentry returns `COLLAPSE_DETECTED` to terminate on echo, and the Synthesizer's parsed confidence terminates on consensus.

## Agents

| Agent       | Model                                                        | Provider | Role                                                        |
|-------------|--------------------------------------------------------------|----------|-------------------------------------------------------------|
| Proposer    | gemma-4-31b-it-8bit                                          | oMLX     | Opens with a clear, well-reasoned initial position          |
| Skeptic     | Qwen3.5-35B-A3B-8bit                                         | oMLX     | Challenges assumptions and identifies logical gaps          |
| Synthesizer | MLX-Qwen3.5-35B-A3B-Claude-4.6-Opus-Reasoning-Distilled-8bit | oMLX     | Reconciles conflicts or marks irreconcilable splits         |
| Red Agent   | Qwen3.5-35B-A3B-8bit                                         | oMLX     | Adversarial injection to disrupt premature consensus        |
| Sentry      | gemma-4-31b-it-8bit                                          | oMLX     | Echo-loop + convergence monitor (`OK` / `SPECIALIST_NEEDED` / `COLLAPSE_DETECTED`) |

All agents run locally via [oMLX](https://github.com/openclaw/omlx). Set `OMLX_BASE_URL` if your instance isn't at the default `http://localhost:8080/v1`.

Models and system prompts are configured in `parliament.toml` and can be swapped per-neurotype without touching code.

## Development

```bash
pnpm test         # vitest across all packages (unit + integration)
pnpm build        # tsc project references
pnpm lint         # eslint
```

Integration tests stub only the LLM call, exercising the real engine, real router, and a real in-memory SQLite database, so they run offline.
