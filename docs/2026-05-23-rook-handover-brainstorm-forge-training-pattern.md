# Brainstorm/Forge Handover For Rook

**Date:** 2026-05-23
**Author:** Pax
**Repo:** `heybeaux/parliament`
**Branch:** `main`

## Executive Summary

Beaux's intent was a **genuinely new reasoning pattern/type** for project ideation under the `brainstorm` / `brainstorm/forge` surface.

What is currently implemented is **not** that.

Right now:

- `POST /brainstorm`
- `POST /brainstorm/forge`
- `POST /ideate`

all route to the same `handleIdeate` handler in `packages/server/src/routes.ts`.

So the current system has:

- real endpoint names
- shared request validation / locks
- shared `runIdeation()` execution

It does **not** have a distinct brainstorm/forge runtime, topology, or training pattern.

## What Happened

The major source of confusion is that the earlier `refine-ideate-forge` spec deliberately rejected a dedicated `brainstorm` sub-mode and instead framed "quick brainstorm" as:

- existing `ideate`
- with `critique_cycles = 0`

That decision lives here:

- `openspec/changes/refine-ideate-forge/design.md`

That is the architectural fork that now needs reversing or superseding.

## Current Code Truth

In `packages/server/src/routes.ts`:

```ts
app.post('/brainstorm', handleIdeate);
app.post('/brainstorm/forge', handleIdeate);
app.post('/ideate', handleIdeate);
```

And inside that handler, the background execution still calls:

```ts
runIdeation(...)
```

So any run made through `/brainstorm` or `/brainstorm/forge` is presently just an ideate run behind a different route name.

## Changes I Have Not Yet Pushed Before This Handover

These are the outstanding local modifications I bundled with this handover:

- `packages/core/src/ideate/__tests__/defense.test.ts`
  - fixes `Problem` typing in defense tests
- `packages/core/src/ideate/orchestrator.ts`
  - fixes missing defense imports / typings
  - adds `defenses` passthrough to contribution extras
  - tolerates `dimensionsSummary` on synth context
- `packages/server/src/routes.ts`
  - replaces the broken self-request alias approach with a shared `handleIdeate`
  - keeps `/brainstorm`, `/brainstorm/forge`, and `/ideate` wired consistently
- `parliament.openrouter.toml`
  - updates stale OpenRouter model ids:
    - `qwen/qwen3.6-flash`
    - `x-ai/grok-4.20`

These changes improve correctness, but they do **not** create the new brainstorming pattern Beaux actually wanted.

## Proven Facts From This Session

- Parliament server was brought up successfully on alternate ports during debugging.
- OpenRouter-backed runs worked once provider wiring and stale model ids were addressed enough to execute.
- The first brainstorm-style run produced useful project ideas, but it still ran through ideate semantics.
- Concept drift on reruns exposed the deeper issue: the route naming implied a new pattern, but runtime behavior remained ideate.

## What Rook Should Build

Rook should treat this as **new product/runtime work**, not cleanup.

### Required outcome

Implement a **real brainstorm/forge reasoning pattern/type** whose execution semantics are distinct from `ideate`.

### Minimum bar

At minimum, the new implementation should have:

- its own request shape or explicit mode/type discriminator
- its own orchestrator/runtime entrypoint
- its own prompt / phase design
- its own persisted record semantics if needed
- its own tests proving it does not just call `runIdeation()`

### Strong recommendation

Do **not** keep building this as aliases over ideate.

Create a fresh spec/change for the actual pattern if needed, because the current `refine-ideate-forge` design explicitly encoded the opposite assumption.

## Suggested Design Direction

Rook should decide whether the new pattern is best represented as one of:

1. a new top-level mode parallel to `ideate` / `deliberate`
2. a new runtime under the brainstorm routes with a distinct orchestrator
3. a new "training pattern/type" abstraction that both server and CLI can target cleanly

My recommendation is **option 1 or 2**, not more aliasing.

## Important Constraints

- Beaux expects "genuine, real work", not surface-area relabeling.
- Route aliases are acceptable only if they point to genuinely different behavior underneath.
- If the new pattern is meant to be the default product-ideation workflow, it should be optimized for:
  - multiple project ideas
  - ranking
  - reduced concept drift
  - consistency of idea identity across reruns

## Useful Files For Rook

- `packages/server/src/routes.ts`
- `packages/core/src/ideate/orchestrator.ts`
- `packages/core/src/ideate/types.ts`
- `packages/core/src/ideate/lineup.ts`
- `parliament.openrouter.toml`
- `openspec/changes/refine-ideate-forge/design.md`
- `openspec/changes/refine-ideate-forge/tasks.md`
- `openspec/changes/refine-ideate-forge/HANDOVER.md`

## Blunt Takeaway

The shipped work was not fake, but it solved the wrong problem.

It refined `ideate`.
It did not create the distinct brainstorm/forge reasoning pattern Beaux thought he was getting.
