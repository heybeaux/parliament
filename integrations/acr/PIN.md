# ACR contract pin

Parliament's `ACRContextProvider` is built against this pinned snapshot of
ACR's TypeScript types. ACR is a programmatic SDK (no HTTP API), so we vendor
the exported types from `@acr/schema` rather than an OpenAPI spec.

| Field | Value |
|---|---|
| Source repo | https://github.com/heybeaux/acr |
| Source path | `packages/schema/src/types.ts` |
| Pinned commit | `92daba5c36843c0e6703a98002e20ae01237e7ed` |
| Pinned date | 2026-05-05 |
| Package | `@acr/core@0.1.0`, `@acr/schema@0.1.0` |
| Key exports used | `resolve`, `calculateBudget` from `@acr/core`; types from `@acr/schema` |

## When to bump

Bump when **all** of the following are true:
1. ACR has shipped a commit whose `packages/schema/src/types.ts` differs from the vendored copy
2. Parliament's integration test (`packages/core/src/__tests__/acr-integration.test.ts`) still passes against the new version
3. Any breaking type changes have adapter shims in `ACRContextProvider`

## How to bump

```bash
# from a checkout of acr at the target commit
cp /path/to/acr/packages/schema/src/types.ts integrations/acr/types.ts
# update PIN.md commit + date + package version
# run integration test against a real .acr manifest directory:
ACR_MANIFEST_PATH=/path/to/a/.acr \
  pnpm --filter @parliament/core test acr-integration
```

## Known runtime-vs-type drifts (as of pin date)

None discovered yet. Append here as drifts are found.

If you find new drifts, add an integration-test assertion that fails loudly
when the runtime catches up to the types (or vice versa).
