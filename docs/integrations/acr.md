# ACR integration

Parliament integrates with [ACR](https://github.com/heybeaux/acr) (Agent
Capability Runtime) for pre-deliberation context injection: resolved
capabilities, hard constraints, and token budget — delivered as a pinned
system turn before round 0.

## Surface

ACR is a **programmatic SDK**, not an HTTP service. Parliament imports
`@acr/core` directly and calls two functions:

| Call | Signature | Purpose |
|---|---|---|
| `resolve` | `resolve(manifests, opts?) → ResolutionPlan` | Dependency resolution, conflict detection, topological sort, budget fitting |
| `calculateBudget` | `calculateBudget(plan) → BudgetReport` | Per-capability token budget + burst analysis |

These are called through `ACRContextProvider` in
`packages/core/src/context.ts` before each deliberation. The provider
runs in parallel with Engram recall so neither blocks the other.

## Contract pin

The integration is built against a vendored copy of ACR's exported types at
`integrations/acr/types.ts`. Version pin and bump procedure live in
`integrations/acr/PIN.md`.

ACR has no HTTP spec to vendor, so the contract artifact is the TypeScript
types snapshot. Where the installed package's runtime behaviour disagrees with
the vendored types, the live package wins. Known drifts are documented in
`PIN.md`.

## Testing against real ACR

PAR-38 demonstrated the cost of mock-only tests: all three contract
assumptions were wrong against the live service. PAR-41 ensures ACR ships
with the same live-test protection from day one.

### Local (recommended for development)

```bash
# Point at a real .acr manifest directory (your project's ACR config)
ACR_MANIFEST_PATH=/path/to/project/.acr \
  pnpm --filter @parliament/core test acr-integration
```

The test loads manifests from `ACR_MANIFEST_PATH`, calls `resolve()` and
`calculateBudget()`, and asserts the live shapes match what the adapter
parses. If it fails, the contract has drifted — read the error, then check
`integrations/acr/PIN.md` for the field mappings to update.

### CI

The integration test is gated on `ACR_MANIFEST_PATH` being set. CI should
run it:

- **Pre-merge** for any PR touching `packages/core/src/context.ts` or
  `integrations/acr/`.
- **Nightly** on `main` against a known-good manifest set, to catch ACR
  package drift before users do.

The test self-skips when `ACR_MANIFEST_PATH` is absent, so its cost on
unrelated PRs is zero.

## Configuring Parliament

In `parliament.toml`:

```toml
[context]
provider = "acr"
manifest_path = "/path/to/.acr"
budget_multiplier = 1.0   # scale the ACR budget envelope; 1.0 = use as-is
```

To disable context injection (OSS standalone mode):

```toml
[context]
provider = "none"
```

`provider = "none"` is the default. No ACR dependency is loaded unless
explicitly configured.

## Engine injection shape

When ACR resolution succeeds, the engine injects a pinned system turn before
round 0 (after Engram recall, run in parallel):

```
[Context] Available capabilities: jira-search, postgres-readonly, slack-notify
[Constraints] Decision must respect: SLA-2026-Q2, Compliance-PII-v3
[Budget] 50,000 tokens remaining · deadline in 5 min
```

If the budget hits 80% of the envelope during deliberation, the engine
terminates early and sets `incomplete: true` on the outcome.

## Fail-soft behaviour

ACR resolution errors are non-fatal. If `resolve()` throws or the manifest
directory is unreadable:

1. A `warn`-level trace event is emitted: `context.resolve.error`
2. Deliberation proceeds without the context turn
3. The outcome does **not** include capability/constraint metadata

This preserves OSS standalone behaviour when ACR is misconfigured.

## When you change the integration

1. Read this doc and `integrations/acr/PIN.md`.
2. If the change targets a new ACR release, bump the type snapshot per
   `PIN.md`'s "How to bump" section.
3. Run the integration test locally against a real `.acr` manifest directory
   before opening the PR.
4. Update `PIN.md`'s "Known runtime-vs-type drifts" if you discover new
   mismatches.
5. Note: `resolve()` in `@acr/core` takes `CapabilityManifest[]` directly —
   there is no `resolveDependencies()` export. The PAR-39 spec used a
   placeholder name; the real call is `resolve(manifests)`.

## Anti-patterns to avoid

- **Don't** add a mock that asserts the `resolve()` return shape without also
  running the integration test. Mocks describe what we *think* the contract
  is; only the integration test describes what it *actually* is.
- **Don't** silently swallow a resolution error without the trace event.
  Fail-soft is intentional, but silent failure makes debugging impossible.
- **Don't** call `resolve()` on every agent turn — it's designed to run once
  pre-deliberation, cached by query hash (60s TTL).
