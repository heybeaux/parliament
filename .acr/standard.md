# Parliament

**Purpose:** Multi-round, multi-model deliberation engine. Lineups configure which models speak; structural agents (synthesizer, redAgent, sentry) coordinate rounds. Modes include cooperative-full (consensus), adversarial-critique (red-team), and others via TOML config. Returns synthesis (prose), structured split (on non-consensus), per-round phases, and termination reason. Used directly via HTTP API and as the reasoning faculty Inos consumes for `deliberation` nodes.
**Repo:** https://github.com/heybeaux/parliament
**Status:** active
**Phase:** v1, structural built-ins formalized 2026-05+ (synthesizer, redAgent, sentry outside BUILTIN_AGENT_REGISTRY)
**Last verified:** 2026-05-18

## Runtime

- **Local path:** /Users/beauxwalton/Dev/parliament
- **Tech:** TypeScript pnpm monorepo (`@parliament/server`, `@parliament/ui`, core engine)
- **DB:** SQLite at `~/.parliament/parliament.db` (better-sqlite3). Schema: `ideations`, `deliberations`, accounts/api keys.
- **Server start:**
  ```bash
  cd ~/Dev/parliament
  pnpm --filter @parliament/server build
  set -a && source .env && set +a
  PARLIAMENT_DB_PATH=/tmp/parliament-test.db \
    PARLIAMENT_CONFIG=parliament.openrouter.toml \
    node packages/server/dist/index.js
  ```
- **UI start (Node 20 required):**
  ```bash
  PATH="$HOME/.nvm/versions/node/v20.19.4/bin:$PATH" pnpm --filter @parliament/ui dev
  ```
- **Default port:** server 3001, UI Vite picks next free from 5173
- **API:** `POST /deliberate` to start, `GET /deliberate/:id` to poll. `/v1/deliberations` exists but only as a list endpoint.

## Dependencies

- **Depends on:** OpenRouter (cooperative-full lineup needs `OPENROUTER_API_KEY` or `PARLIAMENT_PROVIDER=openrouter`)
- **Used by:** Inos (deliberation node type), Ginnung (reasoning surface)
- **External:** OpenRouter; SQLite

## Key contacts

- **Owner:** @beauxwalton
- **Recent contributors:** @beauxwalton

## Quick gotchas

- **No `pnpm dev` for server.** Build then `node dist/index.js`. Without `source .env`, every request crashes with missing OPENROUTER_API_KEY.
- **UI must be Node 20.** Node 22 + Babel 7.29 (via @vitejs/plugin-react) collides on the `File` global → `Cannot redefine property: File`.
- **Routes:** `/deliberate` not `/v1/deliberations`. Don't confuse.
- **Source of truth is SQLite.** When a job 404s on HTTP, query `~/.parliament/parliament.db` before assuming loss. Server can die without losing completed work.
- **synthesizer/redAgent/sentry are structural** — they have `class SYSTEM_PROMPT`s but are NOT in `BUILTIN_AGENT_REGISTRY`. Use `hasBuiltinDefaultPrompt` for prompt-default checks.
- **Synthesis is best-effort on non-consensus.** Engine surfaces highest-confidence attempt rather than null on max_rounds/echo_loop terminations (since 2026-05-05).
- **agent_id in toml is overridden per-request** by `routes.ts:1064` to `callerAccountId` (default `acct_oss_self_host` for unauthenticated).

## Where to learn more

- `deep.md` — engine internals, lineup configs, mode taxonomy
- Memory: `parliament-server-startup.md`, `parliament-synthesis-fallback.md`, `parliament-results-durable-in-sqlite.md`, `parliament-structural-builtins.md`
