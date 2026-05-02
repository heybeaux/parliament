# AGENTS.md — Parliament

## Project

**Nexus Parliament** — a multi-model adversarial reasoning engine ("synthetic discourse engine") grounded in the PNAS Nexus paper *"Neurodivergent influenceability in agentic AI as a contingent solution to the AI alignment problem"* (Hernández-Espinosa et al., 2026).

The thesis: perfect AI alignment is mathematically impossible (undecidability / Gödel). Parliament instead uses *managed* misalignment — deliberate cognitive diversity across open-source models — so the answer that emerges has survived an internal adversarial process.

- **Repo**: `heybeaux/parliament`
- **Default branch**: `main`
- **Local path** (humans): `~/Dev/parliament`
- **Symphony workspace root** (agents): `~/code/par-workspaces`

## Stack

| Layer            | Tech                                                          |
| ---------------- | ------------------------------------------------------------- |
| Language         | TypeScript (Node 20+, ESM, `"type": "module"`)                |
| Monorepo         | pnpm workspaces (`packages/*`)                                |
| HTTP             | Hono (`packages/server`)                                      |
| CLI              | commander                                                     |
| UI               | React 18 + Vite (`packages/ui`)                               |
| Persistence      | better-sqlite3 (deliberation history) + JSON transcripts      |
| Test             | vitest                                                        |
| Lint             | eslint (`@typescript-eslint`)                                 |
| Spec             | OpenSpec (changes under `openspec/changes/`)                  |
| Models           | Open-source via local adapters (mlx / llama.cpp / Ollama)     |

## Packages

```
packages/
├── core/      # Engine: agents, blackboard, scheduler, topology runtime, types
├── server/    # Hono HTTP API (POST /deliberate, GET /presets, etc.)
├── cli/       # `parliament` CLI (commander-based)
└── ui/        # React + Vite read-along UI (Timeline, TurnCard, Observability)
```

## Commands

Run all from the repo root unless noted.

```bash
pnpm install          # First-time setup
pnpm lint             # eslint
pnpm test             # vitest
pnpm build            # tsc -b core + server + cli (UI built separately)

# UI dev (run from packages/ui)
cd packages/ui && pnpm dev    # Vite dev server
cd packages/ui && pnpm build  # Vite production build

# Server dev
node packages/server/dist/index.js   # after pnpm build
```

### Pre-PR Quality Gate

```bash
pnpm lint && pnpm test && pnpm build
```

All three must exit 0 before opening a PR.

## Key Concepts

### Topology + Neurotypes

The engine is **data-driven**: the deliberation pipeline shape is configured in `parliament.toml` under `[topology]` and `[neurotypes.*]`, not hardcoded.

- A **neurotype** is an agent class with a posture (e.g. Skeptic = adversarial, Empiricist = evidence-first, Synthesizer = reconciliation).
- A **topology preset** is a named pipeline of neurotypes. Built-ins: Debate, Star Chamber, Chain-of-Verifiers, Socratic, Long-View, Reframe, Jury (parallel).
- **Sentry** runs out-of-band across every preset — never appears in any preset's `steps` array.
- **Parallel steps** (Jury preset only): siblings read a read-only blackboard snapshot, run concurrently, results append in registration order (not completion order).

Source of truth:
- Schema: `openspec/changes/add-topology-spec/`
- Runtime: `openspec/changes/add-topology-runtime/`
- Eight neurotypes: `openspec/changes/add-eight-neurotypes/`
- Observability UI: `openspec/changes/add-observability-ui/`
- Parallel + Jury: `openspec/changes/add-jury-parallel/`

### Engine Types (`packages/core/src/types.ts`)

- `Turn` — one agent's contribution. Treat extensions as **additive** (don't rename existing fields without a one-release alias).
- `DeliberationResult` — engine output. New observability fields (e.g. `events[]`) extend this additively.
- `Blackboard` — shared state seen by every agent.

### Server Response Shape

`POST /deliberate` returns `{ id, ...result }` where `result` is a `DeliberationResult`. UI consumers parse this verbatim. Any new field added to `Turn` or `DeliberationResult` shows up in the response automatically — but only if the engine populates it.

## Path Aliases

This repo does **not** use TypeScript path aliases. Use relative imports inside a package, and the package name (e.g. `@parliament/core`) across packages.

## Critical Patterns

### Adding a route

`packages/server/src/routes.ts` registers all routes. Match the existing style:
- zod schema for the request body declared near the top.
- Route handler returns `c.json(...)` with explicit status codes.
- Error responses follow `{ error: string, ... }`.

### Adding an agent class

1. Create `packages/core/src/agents/<NeurotypeName>Agent.ts`.
2. Register it in `packages/core/src/agents/index.ts`.
3. Add a kebab-case ID to the built-in registry.
4. Honour the standard 200-word cap and `truncated` flag.
5. Add unit tests next to the source file.

### Adding a UI component

1. Create `packages/ui/src/components/<Name>.tsx`.
2. Wire data via `packages/ui/src/lib/api.ts`.
3. Use the existing CSS conventions in `packages/ui/src/styles.css` — no new UI library.
4. Add a vitest component test alongside.

## Rules

1. **Don't break the additive contract.** Old UI builds must parse new server responses. Add fields, don't rename.
2. **OpenSpec is binding.** When a ticket references an `openspec/changes/<change-id>/` spec, its Acceptance Criteria are the gate.
3. **Sentry stays out-of-band.** It never appears in any preset's `steps` array.
4. **Parallel siblings are independent.** Never let them see each other's output mid-block.
5. **No secrets in commits.** No `.env*`, no API keys, no model weights.
6. **One ticket, one branch, one PR.** PRs target `main`. Squash-merge.
7. **Out-of-scope improvements** become a new Backlog issue, not a scope expansion.

## Environment

Currently the engine runs against local model adapters; there's no cloud secret to leak. Future work may add:
- `PARLIAMENT_TRANSCRIPTS_DIR` (default: `transcripts`)
- model-host URLs for mlx / llama.cpp adapters

## Workpad

When working a Linear ticket, maintain a single `## Codex Workpad` comment per the WORKFLOW.md spec. That comment is the source of truth for progress, branch, and PR — do not post separate "done" comments.
