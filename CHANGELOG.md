# Changelog

All notable changes to Parliament are documented here.

## [Unreleased]

### Added

- **`parliament brainstorm` CLI command** — divergent-generation → idea-dedupe → idea-cluster → idea-rank pipeline. Flags: `--forge`, `--k`, `--ideas-per-author`, `--print-lineup`.
- **`POST /brainstorm`** — new distinct handler (`handleBrainstorm`) that drives the brainstorm pipeline. Returns `202 { id, status }` immediately; poll `GET /brainstorm/:id` for the completed result.
- **`POST /brainstorm/forge`** — new distinct handler (`handleBrainstormForge`) that runs the full pipeline plus forge-elaboration over the top-K ranked ideas. Response includes an `elaborations` array.
- **`GET /brainstorm/:id`** — reads from the new `brainstorms` SQLite table. Does **not** fall back to `ideations`.
- **`brainstorms` database table** — columns: `id`, `created_at`, `prompt`, `mode`, `status`, `lineup`, `phases`, `rankings`, `elaborations`, `error`.
- **`[brainstorm]` TOML block** — `ideas_per_author`, `rank.weights` (partial-replace, auto-normalized), `forge.k`, and `lineup` overrides.
- **Author-aware judge skipping** — judges whose model ID matches an idea's author are automatically skipped for that idea to prevent self-scoring.
- **Forge elaboration** (`brainstorm/forge` mode only) — parallel cooperative elaboration over top-K ranked ideas; partial failures surface rather than abort the run.

### Breaking Changes

> **`POST /brainstorm` and `POST /brainstorm/forge` response shape has changed.**
>
> Prior to this release, both routes were aliases for `runIdeation()` and returned the ideate response shape (`{ phases: [...ideate-phases...], synthesis, lineup, ... }`).
>
> They now return the **brainstorm shape**:
>
> ```jsonc
> {
>   "id": "<uuid>",
>   "status": "complete",
>   "phases": [
>     { "phase": "divergent-generation", ... },
>     { "phase": "idea-dedupe",          ... },
>     { "phase": "idea-cluster",         ... },
>     { "phase": "idea-rank",            ... }
>   ],
>   "rankings": [{ "idea_id": "...", "rank": 1, "score": 0.87, ... }],
>   "elaborations": null   // array only for brainstorm/forge runs
> }
> ```
>
> If you were calling `/brainstorm` to run an ideation, switch to `POST /ideate` — it is unchanged and still returns the ideate shape.
