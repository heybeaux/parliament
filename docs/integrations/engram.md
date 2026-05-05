# Engram integration

Parliament integrates with [Engram](https://github.com/heybeaux/engram) for
long-term memory: recall past decisions before deliberation, write outcomes
back after termination. This doc describes the contract, how to test
against a real Engram, and how to bump the pinned spec version.

## Surface

Two HTTP calls, both via `EngramMemoryProvider` in `packages/core/src/memory.ts`:

| Operation | Method | Path | Auth |
|---|---|---|---|
| Recall | `POST` | `/v1/memories/query?agentId=<id>` | `X-AM-API-Key` |
| Remember | `POST` | `/v1/memories` | `X-AM-API-Key` + `x-am-agent-id` header |

`agentId` is a **required query-string parameter** on recall (not a
header). The `x-am-agent-id` header is also sent for routes that read it,
but recall scoping flows through the query string.

## Contract pin

The integration is built against a vendored copy of Engram's OpenAPI spec
at `integrations/engram/api-spec.json`. Version pin and bump procedure
live in `integrations/engram/PIN.md`.

The spec is **a guide, not the source of truth**. Where the live service
disagrees with the spec, the live service wins. Known drifts are
documented in `PIN.md`.

## Testing against a real Engram

PAR-38 originally shipped with mock-only tests that asserted Parliament's
*assumptions* about Engram. All three core assumptions were wrong against
the live service. To prevent recurrence, every change to
`EngramMemoryProvider` must be exercised against a running Engram before
merging.

### Local (recommended for development)

```bash
# 1. Start Engram (from your engram checkout)
cd /path/to/engram && pnpm start

# 2. Read the API key from Engram's .env
ENGRAM_API_KEY=$(grep '^AM_API_KEY=' /path/to/engram/.env | cut -d= -f2)

# 3. Run the gated integration test
ENGRAM_URL=http://localhost:3002 \
  ENGRAM_API_KEY=$ENGRAM_API_KEY \
  ENGRAM_AGENT_ID=parliament-bench \
  pnpm --filter @parliament/core test engram-integration
```

The test round-trips a uniquely-marked deliberation outcome through
`remember()` and `recall()`. If it fails, the contract has drifted —
read the error, then check `integrations/engram/PIN.md` for the field
mappings you need to update.

### CI

The integration test is gated on `ENGRAM_URL` being set. CI should run it:

- **Pre-merge** for any PR touching `packages/core/src/memory.ts` or
  `integrations/engram/`.
- **Nightly** on `main` against a staging Engram, regardless of what the
  PR touched — to catch upstream breakage before users do.

CI configuration for the staging Engram lives outside this repo (cloud
deploy concern). The test self-skips when env vars are absent, so its
cost on PRs that don't touch the integration is zero.

## Configuring Parliament

In `parliament.toml`:

```toml
[memory]
provider = "engram"
endpoint = "http://localhost:3002"
api_key = "eng_kit_local_dev_2026"  # or read from env
agent_id = "parliament-bench"        # default tenant for OSS / single-tenant
layers = ["INSIGHT", "PROJECT"]      # filter — INSIGHT is runtime-valid even
                                     # though the spec doesn't list it
recall_limit = 5
```

For multi-tenant cloud deployments, the `agent_id` from the API-key
auth context overrides this default. See
`packages/server/src/routes.ts` (`buildTopologyDeliberationConfig`).

## When you change the integration

1. Read this doc and `integrations/engram/PIN.md`.
2. If the change is to match a new Engram release, bump the spec pin per
   `PIN.md`'s "How to bump" section.
3. Run the integration test locally against an Engram running the target
   version before opening the PR.
4. Update `PIN.md`'s "Known runtime-vs-spec drifts" section if you
   discover new mismatches.
5. Update the unit-test mocks in `packages/core/src/__tests__/memory.test.ts`
   to match the new contract — but remember, the mocks aren't authoritative,
   the integration test is.

## Neurotype / memory contract

Recall is plumbing; *interrogation of recalled context* is what makes memory
useful. Each neurotype has a defined relationship to the `## Memory` block
the engine injects on the blackboard before round 1:

| Neurotype | Relationship to `## Memory` | Encoded in |
|---|---|---|
| **Proposer** | Memory-blind by design — first-mover, no need to interrogate the past | default prompt (no memory clause) |
| **Skeptic** | Engages explicitly: challenge stale entries, note relevant context, or flag if a prior decision shouldn't influence the current debate | `packages/core/src/agents/skeptic.ts` SYSTEM_PROMPT |
| **Synthesizer** | Makes the relationship explicit: notes whether the current synthesis is *consistent with*, *refines*, or *overrides* the prior decision | `packages/core/src/agents/synthesizer.ts` SYSTEM_PROMPT |
| **RedAgent** | May target a stale prior decision as the weakest assumption (no explicit prompt clause; the disruptor brief is general enough) | default prompt |
| **Sentry** | Memory-blind — its job is structural collapse detection, not memory | not applicable (no model adapter call) |

Memory is **context, not constraint** — a recalled past decision can be
superseded if the current debate warrants it. The Skeptic and Synthesizer
clauses are deliberately worded to grant that latitude rather than treat
recalled outcomes as ground truth.

If you add a new neurotype, decide its memory contract during the prompt
design phase. Add a row to this table when you do.

## Anti-patterns to avoid

- **Don't** add a second mocked test that asserts the new contract without
  also running the integration test. Mocks describe what we *think* the
  contract is; only integration tests describe what it *actually* is.
- **Don't** branch the adapter to handle "what if Engram returns the old
  shape?" without first verifying which shape the live service actually
  returns. The fallback chain in `recall()` (`raw` → `content` → `text`)
  is the maximum acceptable level of paranoia.
- **Don't** silently swallow a contract mismatch. The integration test
  asserts what we round-trip; if Engram returns nothing where we expected
  a hit, the test must fail loudly so we investigate.
