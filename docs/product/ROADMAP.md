# Parliament — Implementation Roadmap & Tickets

| | |
|---|---|
| **Version** | v1.0 (target Q3 2026) |
| **Source of truth** | This file. PRD §11 stays at the strategic-summary level; concrete tickets live here. |
| **Sequencing** | Tickets are listed in build order within each milestone. Cross-team blockers explicit. |

This document decomposes the v1.0 wedge release (PRD §11) into engineering tickets sized for individual PRs. Each ticket lists scope, acceptance criteria, dependencies, and the estimated working-day cost — for solo execution at the current pace (one engineer + Claude). Estimates are deliberately rough.

## Milestone overview

| Milestone | Target | Theme | Tickets | Days (est.) |
|---|---|---|---|---|
| **M0** | now | Foundation (already mostly built) | 0 new | – |
| **M1** | wk 1–2 | API hardening + auth | T1.1 → T1.6 | ~9 |
| **M2** | wk 3–4 | Billing + metering | T2.1 → T2.5 | ~9 |
| **M3** | wk 5–6 | Telemetry-as-art consumer UI | T3.1 → T3.6 | ~10 |
| **M4** | wk 7 | Marketing artifacts | T4.1 → T4.3 | ~6 |
| **M5** | wk 8 | Launch hygiene | T5.1 → T5.5 | ~5 |
| **Total v1.0** | 8 wks | | 28 tickets | ~39 days |

39 working days within an 8-week (40-day) window — buffer is intentionally thin; the v1.0 envelope is "Q3 2026" so a slip into Sep is acceptable, a slip into Q4 is not.

---

## M1 — API hardening + auth (wk 1–2)

The OSS server already serves the deliberation primitives. M1 turns it into a hosted product surface with auth, rate limits, idempotency, and the OpenAPI contract.

### T1.1 — API key issuance & validation
**Scope:** Dashboard route + DB model for `api_keys` (id, account_id, prefix `pk_test_`/`pk_live_`, hashed_secret, name, created_at, revoked_at). Hono middleware that hashes the bearer token and looks up the key. Test keys route to a sandbox lineup; live keys route to the tier's lineup.
**Accepts:**
- `POST /dashboard/api/keys` creates a key (returns secret once)
- `DELETE /dashboard/api/keys/:id` revokes
- API requests with no auth → 401; revoked key → 403
- Test-key requests bypass usage envelope, get 10/min throttle
**Depends on:** none.
**Days:** 1.5

### T1.2 — Idempotency-Key support
**Scope:** Hono middleware that, when `Idempotency-Key` header is present on POST, records `(account_id, key, request_hash, response_body)` in a 24h-TTL table. Replays return the original response. Different body with same key → 409 `idempotency_conflict`.
**Accepts:**
- Replay within 24h returns identical response (verified by request_id match)
- Body mismatch returns 409
- TTL eviction works (Postgres `expires_at` column + nightly job)
**Depends on:** T1.1.
**Days:** 1

### T1.3 — Rate-limit middleware + headers
**Scope:** Per-account token bucket (Redis) for both per-period envelope (350/Pro, 2000/Team-seat) and per-second anti-abuse (10 RPS). Adds `X-RateLimit-*` headers per spec. 429 with `Retry-After`.
**Accepts:**
- Headers present on every authenticated response
- Envelope exhaustion → `usage_limit_exceeded`
- Burst-throttle → `rate_limited` with `Retry-After`
- Concurrency limiter: max-1 in-flight for Pro, max-3 for Team-seat
**Depends on:** T1.1, T2.1 (for the envelope counter — but can ship behind a flag).
**Days:** 1.5

### T1.4 — Error-forwarding wire-up (PRD D2)
**Scope:** Audit `packages/server` for any place we currently swallow upstream errors. Replace with the `upstream_provider_error` envelope shape that preserves provider, status, body, request_id verbatim. Add `transform.retry_on_upstream_500` flag (opt-in, default false). Add `transform.structured_output` flag.
**Accepts:**
- `cat parliament.toml` set to a deliberately-broken provider; POST returns 502 with full upstream body
- `transform.retry_on_upstream_500: true` retries once with backoff
- Test: kill upstream mid-stream → SSE `error` event fires with upstream context
**Depends on:** none.
**Days:** 1.5

### T1.5 — `GET /v1/deliberations` list + filters
**Scope:** Account-scoped list endpoint with cursor pagination and the filters in API.md (`status`, `preset`, `created_after`/`before`). Already partially built — verify coverage and add tests.
**Accepts:**
- Cursor pagination round-trips correctly
- All four filters compose
- Returns the list-item shape (not full transcript)
**Depends on:** T1.1.
**Days:** 1

### T1.6 — OpenAPI contract test in CI
**Scope:** CI step that runs `redocly lint docs/product/openapi.yaml` (already passing) plus a contract test that hits each endpoint against a running server and asserts response shapes match the schema (use `jest-openapi` or equivalent).
**Accepts:**
- CI fails when an endpoint drifts from the schema
- Schema changes that aren't reflected in code also fail
**Depends on:** T1.1–T1.5.
**Days:** 1.5

---

## M2 — Billing + metering (wk 3–4)

Stripe is the path of least resistance for v1. Self-host stays unmetered.

### T2.1 — Usage-event ledger
**Scope:** `usage_events` table: `(id, account_id, deliberation_id, kind, units, cost_usd, occurred_at)`. Every completed deliberation writes one event. Used by `/v1/usage`, billing rollup, and the rate-limit envelope counter.
**Accepts:**
- Ledger entry on every `completed`/`cancelled`/`failed` deliberation
- Cost matches the deliberation's `cost.total_usd`
- `/v1/usage` reads from this table for the current period
**Depends on:** none.
**Days:** 1

### T2.2 — Stripe customer + subscription wiring
**Scope:** Account → Stripe customer mapping. Subscription creation on tier upgrade. Webhook handler for `customer.subscription.{created,updated,deleted}` that flips `account.tier` accordingly. Pro = `$19/mo` price, Team = `$99/seat/mo` price (multi-seat handled in M2.5 follow-up; v1.0 is single-seat Team).
**Accepts:**
- Sign up → choose tier → Stripe checkout → webhook flips tier → API key now works against tier's envelope
- Cancellation → tier reverts to `free` at period end
- Failed payment → tier degrades to `free` with grace period (3 days)
**Depends on:** T1.1.
**Days:** 2.5

### T2.3 — Tier gates on the deliberation request path
**Scope:** Middleware that checks the requested config against tier limits before kicking off a deliberation. Pro caps `max_rounds` ≤ 5; Team ≤ 7. Pro caps source count ≤ 5; Team ≤ 10. Frontier lineup is Team-only; Pro gets the standard lineup.
**Accepts:**
- Pro POST with `max_rounds: 7` → 400 with explicit message
- Team POST with `max_rounds: 7` → accepted
- Pro account never routes to frontier lineup
**Depends on:** T1.1, T2.2.
**Days:** 1

### T2.4 — Dashboard: usage + key management
**Scope:** Three-page dashboard. (1) `/dashboard` — tier card, usage gauge, recent deliberations. (2) `/dashboard/keys` — key CRUD. (3) `/dashboard/billing` — Stripe customer portal link.
**Accepts:**
- All three pages render with real data
- Usage gauge updates within 30s of a completed deliberation
- Customer portal link works (verifies via test card)
**Depends on:** T1.1, T2.1, T2.2.
**Days:** 2.5

### T2.5 — Sandbox lineup config
**Scope:** Define the cheap-models lineup that test keys route to. Six neurotypes mapped to `qwen3.6-mini`, `mistral-small-2512`, `glm-4.5-air`, etc. — total cost per deliberation ≤ $0.005. Wire test keys to this config via the existing `parliament.toml` mechanism.
**Accepts:**
- Test-key deliberations cost ≤ $0.005 each
- Test-key deliberations don't appear in the live `/v1/usage` endpoint
- 5 deliberations in a row through test keys complete cleanly
**Depends on:** T1.1.
**Days:** 1

---

## M3 — Telemetry-as-art consumer UI (wk 5–6)

The PRD §9 animation primitives turned into a deliverable, plus the polish pass on the existing UI.

### T3.1 — Real-time turn animation
**Scope:** When SSE `turn` events arrive, the new turn fades in with a per-character typewriter animation tied to the actual streaming-token rate. No mock animations.
**Accepts:**
- Visual confirms tokens stream at the rate the model is producing them
- Pause/resume works (drop the SSE, reconnect with `Last-Event-ID`)
- 60fps on a Macbook Pro for a 5-agent debate
**Depends on:** existing UI, SSE already wired.
**Days:** 2

### T3.2 — OSI gauge + residue meter
**Scope:** Two animated gauges in the deliberation-detail view: Opinion Shift Index over time, and the running residue score. Both derived from existing engine telemetry — no new compute, just expose + render.
**Accepts:**
- Gauges update on every `cost`/`event` SSE message
- Final values match the API response
- Hover tooltip explains what each metric means in one sentence
**Depends on:** T3.1.
**Days:** 2

### T3.3 — Cost ticker
**Scope:** Running-total USD cost, ticking up per `cost` event. Animation is a smooth lerp, not a snap-update. Per-turn cost shown on each turn card.
**Accepts:**
- Smooth animation (no snap)
- Final value matches `cost.total_usd`
- Per-turn breakdown visible on click
**Depends on:** T3.1.
**Days:** 1

### T3.4 — Preset picker polish
**Scope:** The existing PresetPicker gets per-preset color badges, a "best for" line, and a sample-question hover preview. Sample questions card #8 (adversarial) gets enabled now that #54 is merged.
**Accepts:**
- All 8 presets show the new badge style
- Hover-preview surfaces the sample question that pairs with that preset
- Adversarial card resolves correctly post-#54-merge
**Depends on:** PR #54 merged.
**Days:** 1

### T3.5 — Public deliberation pages (`parliament.app/d/:slug`)
**Scope:** Read-only public view of a deliberation, given a sluggable ID. SEO meta tags. Open Graph card showing topic + residue score + cost. Owner can flip a deliberation public/private from the dashboard.
**Accepts:**
- Public URL works without auth
- OG card renders correctly on Twitter/Slack/iMessage previews
- Private deliberations 404 publicly
**Depends on:** T2.4.
**Days:** 2.5

### T3.6 — Sample questions gallery (post-#55)
**Scope:** Currently in PR #55 — the gallery component on the new-deliberation form. After merge, wire transcript_url for each sample to a public deliberation (T3.5) and remove the placeholder text.
**Accepts:**
- All 8 sample cards link to a real public transcript
- Click-to-fill works
**Depends on:** PR #55 merged, T3.5.
**Days:** 1.5

---

## M4 — Marketing artifacts (wk 7)

Three deliverables called out in PRD §10. These ship before the launch announce.

### T4.1 — Cost-of-being-wrong calculator
**Scope:** Standalone single-page tool at `parliament.app/cost-calculator`. Inputs: hourly engineering rate, hours-to-rebuild estimate, decision frequency. Output: annual expected cost of acting on bad single-shot LLM advice vs. cost of running Parliament. Embeds a "try Parliament" CTA tied to the test-key flow.
**Accepts:**
- Standalone HTML works without backend
- Inputs persist via URL params (sharable)
- Comparison math is documented in tooltip + footnote
- CTA conversion event fires to analytics
**Depends on:** none (standalone). Embedding into the app post-T3.5.
**Days:** 2

### T4.2 — Benchmark corpus build (50 questions)
**Scope:** Curate 50 hard software-decision questions across categories: architecture, security, performance, debugging, product trade-off. Methodology doc + grading rubric (correctness, completeness, identified failure modes, novel insights). Run all 50 through Parliament (frontier lineup) and a single-shot Claude/GPT/Gemini baseline. Publish results as `parliament.app/benchmark`.
**Note:** PRD §10 calls for 100; v1.0 ships 50, v1.5 expands to 100.
**Accepts:**
- 50 questions in `docs/benchmark/corpus.md`
- All 50 have a Parliament transcript and three baseline single-shot answers
- Grading rubric applied — published winner per question
- Aggregate residue-score win rate published
**Depends on:** T3.5 (each transcript becomes a public link).
**Days:** 3

### T4.3 — Landing page rewrite
**Scope:** `parliament.app/` rewritten around the locked positioning. Above-the-fold: live deliberation animation (T3.1), residue score animating in real-time, cost ticker. Below: cost-of-being-wrong CTA, benchmark teaser, code sample for the API.
**Accepts:**
- Lighthouse perf ≥ 90 mobile
- Renders without JS for SEO crawler
- The hero animation actually runs a real deliberation, not a video loop
**Depends on:** T3.1, T4.1, T4.2.
**Days:** 1

---

## M5 — Launch hygiene (wk 8)

### T5.1 — Status page
**Scope:** `status.parliament.app` driven by `/v1/health` plus synthetic deliberation runs every 5min. Incidents page, RSS/email subscription.
**Accepts:** Live; reflects a real outage within 60s.
**Days:** 1

### T5.2 — Docs site (`docs.parliament.app`)
**Scope:** Static site (Astro or similar) generated from `docs/product/*.md` + the OpenAPI spec rendered via Redoc/Stoplight. Search via Algolia DocSearch or equivalent.
**Accepts:** Every endpoint has a working "Try it" with the user's test key.
**Days:** 1.5

### T5.3 — SDK skeletons
**Scope:** TypeScript and Python SDK package skeletons that wrap the v1 API. v1.0 ships generated-from-OpenAPI clients only; v1.5 adds hand-tuned ergonomics. Publish to npm/PyPI as `0.1.0-beta`.
**Accepts:**
- `pnpm add @parliament/sdk` works
- `pip install parliament-sdk` works
- Quickstart in docs runs end-to-end
**Days:** 1

### T5.4 — Self-host parity audit
**Scope:** Run the contract tests (T1.6) against the OSS server. Document any gaps in `packages/server/README.md`. Goal: zero gaps.
**Accepts:** Contract tests pass against `pnpm dev` with no auth.
**Days:** 0.5

### T5.5 — Launch checklist + rollback plan
**Scope:** Pre-launch checklist (DNS, SSL, monitoring alerts, on-call rota, kill switches per major surface). Documented rollback procedure if a launch-day failure mode appears.
**Accepts:** Walked through the checklist; everything green.
**Days:** 1

---

## Cross-cutting concerns (not separate tickets, but tracked)

- **Observability:** every endpoint emits structured logs with `request_id`, `account_id`, `deliberation_id`, `cost_usd`, `latency_ms`. Tracked in Grafana board pre-launch.
- **Security:** API keys hashed at rest (argon2id, not bcrypt — argon2 is the modern default). Stripe webhooks verified by signature. SSE auth over query-string fallback for clients that can't send headers.
- **Migration safety:** every DB change is a forward-only migration with a written rollback. The `usage_events` table is the only large one; it's append-only so partition-by-month from day 1.

## v1.5 preview (not built in v1.0, but architecturally provisioned)

- Webhooks endpoint scaffolding lives in `packages/server` behind a flag from M2 onward, even though it ships in v1.5 — avoids a refactor.
- Custom-preset upload is similarly provisioned: the preset registry (PR #54 modifies it) accepts an account_id-scoped namespace from day 1 even though only built-ins are exposed in v1.0.

## Acknowledged risks to the timeline

1. **Stripe wiring is the load-bearing unknown.** First-time integration in this codebase. Estimate may be light.
2. **Telemetry-as-art polish has soft gates.** "Smooth lerp" and "60fps" are subjective; a perfectionist pass could eat days. Hard-cap M3 to wk-6 EOD; ship the version that works on a Macbook Pro and iterate post-launch.
3. **Benchmark corpus quality matters more than the count.** 50 carefully chosen and graded questions beat 100 sloppy ones — this is why v1.0 ships 50.
4. **The 8-week envelope assumes Claude as a force multiplier.** Estimates degrade by ~30% without it.
