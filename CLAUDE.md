# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm install              # install all workspace dependencies
pnpm build                # tsc project references: core → server → cli
pnpm test                 # vitest across all packages
pnpm lint                 # eslint across all packages

# Run a single package's tests
pnpm --filter @parliament/core test
pnpm --filter @parliament/server test
pnpm --filter @parliament/cli test

# Run a single test file
pnpm vitest run packages/core/src/__tests__/engine.test.ts

# Run the server (requires build first)
node packages/server/dist/index.js

# Run a deliberation via CLI (requires build first)
node packages/cli/dist/index.js deliberate "topic here"

# UI dev server
pnpm --filter @parliament/ui dev
```

## Architecture

**Monorepo** using pnpm workspaces with four packages under `packages/`:

### @parliament/core
Pure TypeScript engine with zero runtime side-effects. Contains:
- **Two execution paths**: `DeliberationEngine` (structured 5-agent protocol) and `runDebate()` (legacy scheduler-based debate). Both produce typed result objects but have different turn-ordering logic.
- **Five agent classes** in `agents/`: `ProposerAgent`, `SkepticAgent`, `SynthesizerAgent`, `RedAgent`, `SentryAgent`. Each wraps a `ModelAdapter` and operates on a shared `Blackboard`. `SynthesizerAgent.generate()` returns a `confidence` field parsed from LLM output. `SentryAgent.generate()` returns a `signal` field (`ok` | `collapse_detected`) based on Jaccard similarity, not LLM classification.
- **Model adapters** in `adapters/`: `OllamaAdapter`, `LMStudioAdapter`, `OMLXAdapter`, `OpenAICompatAdapter`. All implement the `ModelAdapter` interface (`generate(prompt, system?) → string`). `createAdapter()` in `provider-factory.ts` is the factory, selecting based on `PARLIAMENT_PROVIDER` env var or per-neurotype `provider` field.
- **Scheduler** (`scheduler/index.ts`): topological sort with model-affinity batching to minimize model swaps. Used by `runDebate()`, not by `DeliberationEngine`.
- **OSI** (`osi.ts`): Opinion Shift Index — Jaccard-distance-based echo-loop detection calibrated against a real corpus. Threshold is 0.15.
- **Config** (`config.ts`): TOML loader using `smol-toml`. Reads from `parliament.toml` (or `PARLIAMENT_CONFIG` env var). Singleton cache with `resetConfigCache()` for tests.

### @parliament/server
Hono REST server with SQLite (better-sqlite3) persistence. Routes in `routes.ts`, DB helpers in `db.ts`. Endpoints: `POST /deliberate`, `GET /deliberate/:id`, `GET /deliberations`, `GET /transcripts`, `GET /transcripts/:file`, `GET /health`. Uses Zod for request validation.

### @parliament/cli
Commander-based CLI. `createProgram()` is exported for testing without side-effects. Commands: `deliberate <topic>` (runs engine locally), `get <id>` (fetches from server).

### @parliament/ui
React + Vite + Tailwind dashboard (early stage). Separate from the build pipeline — not included in `pnpm build`.

## Key Design Patterns

- **Blackboard pattern**: Agents read from and write to a shared `Blackboard` object (topic, turns, conflicts, metadata). The engine orchestrates turn order; agents are stateless beyond their adapter.
- **DeliberationEngine round loop**: Proposer (round 1 only) → Skeptic → Sentry → Synthesizer → Sentry → optional RedAgent. Terminates on consensus (synthesizer confidence >= threshold), echo_loop (sentry collapse), or max_rounds.
- **Two result types**: `DeliberationResult` (from `DeliberationEngine`) has `residueScore`, `synthesis`, `split`. `DebateResult` (from `runDebate()`) has `residue` string array. Don't confuse them.

## Configuration

All runtime config comes from `parliament.toml` at repo root. The five neurotype roles (`proposer`, `skeptic`, `synthesizer`, `redAgent`, `sentry`) are required. Each has `model`, `system_prompt`, and optional `provider` override.

Environment variables:
- `PARLIAMENT_PROVIDER` — global LLM provider: `ollama` (default), `lm_studio`, `omlx`
- `PARLIAMENT_CONFIG` — path to config file override
- `OMLX_BASE_URL` — oMLX endpoint (default: `http://127.0.0.1:8000/v1`)
- `OMLX_API_KEY` — oMLX auth key
- `PARLIAMENT_SERVER_URL` — CLI's server target (default: `http://localhost:3030`)
- `PORT` — server bind port override

## Testing Conventions

Tests use vitest. Integration tests stub only the LLM adapter's `generate()` method — the real engine, router, and in-memory SQLite all run. Agent tests mock the `ModelAdapter` interface. Config tests use `resetConfigCache()` between runs.
