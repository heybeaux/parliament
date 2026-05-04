# Engram API contract pin

Parliament's `EngramMemoryProvider` is built against this pinned snapshot of
Engram's OpenAPI spec. Bumping the pin is a deliberate cross-repo step — do
not edit the vendored spec by hand.

| Field | Value |
|---|---|
| Source repo | https://github.com/heybeaux/engram |
| Source path | `api-spec.json` |
| Pinned commit | `02d32eb6e3c238e32123cd774ded42a528fde0b9` |
| Pinned date | 2026-05-04 |
| Last verified against | localhost:3002 (engram@02d32eb) |

## When to bump

Bump the pin when **all** of the following are true:
1. Engram has shipped a release whose `api-spec.json` differs from the vendored copy
2. Parliament's integration test (`packages/core/src/__tests__/engram-integration.test.ts`) still passes against the new spec
3. Any breaking changes have an adapter shim in `EngramMemoryProvider`

## How to bump

```bash
# from a checkout of engram at the target commit
cp /path/to/engram/api-spec.json integrations/engram/api-spec.json
# update PIN.md commit + date
# run integration test against an Engram running that commit:
ENGRAM_URL=http://localhost:3002 \
  ENGRAM_API_KEY=$(grep AM_API_KEY /path/to/engram/.env | cut -d= -f2) \
  ENGRAM_AGENT_ID=parliament-bench \
  pnpm --filter @parliament/core test
```

## Known runtime-vs-spec drifts (as of pin date)

These are spec inaccuracies, not Parliament bugs. The integration test is the
source of truth — when the spec disagrees with the live service, the live
service wins.

- **`MemoryLayer` enum**: spec lists `SESSION | PROJECT | IDENTITY | TASK`. Runtime also accepts and emits `INSIGHT` (used by Parliament for deliberation outcomes).
- **`POST /v1/memories` response code**: spec declares 201, observed 201 — fine, but PAR-38's `if (!res.ok)` covers 200-299 either way.
- **`POST /v1/memories/query` agent scoping**: spec declares `agentId` as a required *query string* parameter. The `x-am-agent-id` header is also accepted by some routes but is not the authoritative scoping mechanism for recall — use the query string.
- **`CreateMemoryDto.metadata`**: not declared in the spec. Runtime accepts it but persists it to the `metadata` column verbatim. Treat as best-effort.

If you find new drifts, append them here and add an integration-test
assertion that fails loudly when the runtime catches up to the spec (or vice
versa).
