# Parliament Developer API — v1 Specification

| | |
|---|---|
| **Version** | v1 (draft) |
| **Base URL (hosted)** | `https://api.parliament.app/v1` |
| **Base URL (self-host)** | `http://localhost:3000` (default; configurable) |
| **Auth (hosted)** | `Authorization: Bearer pk_<key>` |
| **Auth (self-host)** | none (private deployment) or custom |
| **Content type** | `application/json` |
| **Rate limits** | tier-dependent; surfaced via `X-RateLimit-*` headers |

This is the v1 specification. It maps 1:1 to a forthcoming OpenAPI 3.1 schema (`docs/product/openapi.yaml`, ships with v1.0). v1 is intentionally narrow: read-only deliberation primitives, presets discovery, and usage. v1.5 adds custom presets, webhooks, retention controls. v2.0 adds writes to in-flight deliberations, custom neurotype injection, agent-to-agent webhooks.

## Design principles (locked from PRD)

1. **Error-forwarding by default.** When the upstream provider (e.g., OpenRouter) returns an error, Parliament returns the equivalent error with the upstream context preserved in the response body. No silent retries, no error masking, no markup transformation by default. Markup is opt-in via `transform` flags. (PRD §8 / D2)
2. **Transcripts are first-class.** Every API consumer can retrieve the full deliberation transcript (every turn, every agent, every model choice, every cost) for any deliberation they created. This is the auditability story.
3. **Streaming is canonical.** Long deliberations stream by default via Server-Sent Events. Polling is the fallback.
4. **Cost is observable per call.** Every deliberation response includes per-turn cost and aggregate cost in USD.
5. **Idempotency is supported.** All `POST` endpoints accept `Idempotency-Key` headers (UUID, scoped per account, 24h retention). Replays return the original response.

## Authentication

Hosted-API requests require a Bearer token issued via the dashboard.

```http
Authorization: Bearer pk_live_a1b2c3d4...
```

Two key types:

- **Test key (`pk_test_…`):** routes to a sandbox lineup (cheap models only); sandbox deliberations don't count against your usage envelope but are rate-limited to 10/min.
- **Live key (`pk_live_…`):** counts against the tier's deliberation envelope; uses the lineup configured for the account's tier.

## Rate limits

Surfaced on every response:

```http
X-RateLimit-Tier: pro
X-RateLimit-Period: 30d
X-RateLimit-Limit: 350
X-RateLimit-Remaining: 312
X-RateLimit-Reset: 2026-06-03T00:00:00Z
X-RateLimit-Concurrency-Limit: 1
X-RateLimit-Concurrency-Current: 1
```

Per-second / per-minute throttles also apply (anti-abuse, surfaced as `Retry-After` on `429`s).

## Error model

Errors are JSON, with `error.code` (machine-readable) and `error.message` (human-readable). Upstream errors preserve the upstream response in `error.upstream` when applicable.

```json
{
  "error": {
    "code": "upstream_provider_error",
    "message": "OpenRouter returned 503 Service Unavailable for model anthropic/claude-opus-4-7",
    "upstream": {
      "provider": "openrouter",
      "status": 503,
      "body": "{ ... raw upstream body ... }",
      "request_id": "or-req-abc123"
    },
    "request_id": "par-req-xyz789",
    "documentation_url": "https://docs.parliament.app/errors/upstream_provider_error"
  }
}
```

Standard codes:

| HTTP | `error.code` | Meaning |
|---|---|---|
| `400` | `invalid_request` | Malformed body, missing required field, validation failure |
| `401` | `authentication_required` | Missing or malformed `Authorization` header |
| `403` | `authentication_invalid` | API key doesn't exist or is revoked |
| `404` | `resource_not_found` | Deliberation ID doesn't exist or isn't owned by this account |
| `409` | `idempotency_conflict` | Idempotency key reused with different request body |
| `409` | `concurrency_exceeded` | Account already at concurrency limit for tier |
| `422` | `preset_unavailable` | Preset exists but is missing neurotypes for current account config |
| `429` | `rate_limited` | Per-account or per-IP throttle |
| `429` | `usage_limit_exceeded` | Account hit its deliberation envelope for the period |
| `500` | `internal_error` | Server-side bug; report with `request_id` |
| `502` | `upstream_provider_error` | OpenRouter (or other configured provider) returned an error |
| `503` | `service_unavailable` | Maintenance or capacity-related downtime |

## Endpoints

### `GET /v1/presets`

List available deliberation presets.

**Response 200:**

```json
{
  "presets": [
    {
      "id": "debate",
      "name": "Debate",
      "description": "The original two-voice deliberation: a Proposer opens, a Skeptic challenges, and the Synthesizer reconciles each round.",
      "best_for": "Quick directional decisions where two strong perspectives need airing.",
      "agent_count": 5,
      "missing_neurotypes": []
    },
    {
      "id": "adversarial",
      "name": "Adversarial Analysis",
      "description": "A failure-mode-first deliberation: the Proposer states the feature or decision, the Adversary imagines it has shipped and surfaces the highest-leverage failure mode, the Empiricist tests whether the threat-model rests on real evidence, and the Pragmatist constrains by what is actually feasible to mitigate before the Synthesizer reconciles.",
      "best_for": "Software-development decisions about new features or next-best-steps where the interesting answer is what breaks first when this ships.",
      "agent_count": 5,
      "missing_neurotypes": []
    }
  ],
  "default_preset": "debate"
}
```

Presets with non-empty `missing_neurotypes` exist in the catalog but cannot be invoked by the requester (their account configuration lacks one or more required neurotypes). `POST /v1/deliberations` with such a preset returns `422 preset_unavailable`.

### `POST /v1/deliberations`

Kick off a new deliberation. Returns immediately (`202 Accepted`) with a deliberation ID; clients poll `GET /v1/deliberations/:id` or stream from `GET /v1/deliberations/:id/stream`.

**Request:**

```json
{
  "topic": "Should we adopt event sourcing for our user service?",
  "preset": "socratic",
  "context": "We're a 12-person engineering team running a Node + Postgres stack. Current write throughput is 200 RPS; projected 2,000 RPS in 18 months. Compliance requirements include audit trail of every user state change.",
  "sources": [
    {
      "title": "Martin Fowler on Event Sourcing",
      "url": "https://martinfowler.com/eaaDev/EventSourcing.html",
      "excerpt": "..."
    }
  ],
  "config": {
    "max_rounds": 5,
    "confidence_threshold": 0.85,
    "max_source_words": 800
  },
  "transform": {
    "structured_output": false,
    "retry_on_upstream_500": false
  }
}
```

**Required fields:**

- `topic` (string, 1-2000 chars): the question for the panel.

**Optional fields:**

- `preset` (string): preset ID. Defaults to `default_preset`.
- `context` (string, ≤ 8000 chars): prose context the engine prepends to every non-Sentry agent's user prompt.
- `sources` (array, ≤ 10 items): references the Empiricist evaluates evidence-backed claims against. Each item has `title`, `url`, optional `excerpt`.
- `config` (object): per-run overrides (subject to tier limits).
  - `max_rounds` (integer, 1-10): override default rounds. Tier-capped.
  - `confidence_threshold` (float, 0-1): early-exit threshold.
  - `max_source_words` (integer): truncation cap for sources.
- `transform` (object): opt-in transformations. **All default to `false`** in v1 (PRD §8 / D2).
  - `structured_output` (bool): enforce JSON schema on synthesizer output. Off by default; on adds latency and may fail validation.
  - `retry_on_upstream_500` (bool): retry transient upstream errors once with exponential backoff. Off by default; on may mask intermittent issues.

**Headers:**

- `Idempotency-Key: <uuid>` (optional; replays within 24h return the same response)

**Response 202:**

```json
{
  "id": "del_8257b737-eb60-457a-841e-e0675b71be20",
  "status": "in_flight",
  "preset": "socratic",
  "created_at": "2026-05-03T17:42:00.000Z",
  "stream_url": "https://api.parliament.app/v1/deliberations/del_8257b737-eb60-457a-841e-e0675b71be20/stream"
}
```

**Errors:**

- `400 invalid_request`: validation failure
- `409 concurrency_exceeded`: account at concurrency limit
- `422 preset_unavailable`: preset exists but missing neurotypes
- `429 usage_limit_exceeded`: deliberation envelope exhausted

### `GET /v1/deliberations/:id`

Retrieve a deliberation's current state. Polled by clients that aren't using SSE; safe to call at any frequency (no cost).

**Response 200:**

```json
{
  "id": "del_8257b737-eb60-457a-841e-e0675b71be20",
  "status": "completed",
  "preset": "socratic",
  "topic": "Should we adopt event sourcing for our user service?",
  "context": "We're a 12-person engineering team...",
  "sources": [...],
  "created_at": "2026-05-03T17:42:00.000Z",
  "completed_at": "2026-05-03T17:44:18.000Z",
  "duration_ms": 138000,
  "total_rounds": 4,
  "termination_reason": "consensus_reached",
  "resolved": true,
  "residue_score": 0.18,
  "split": null,
  "synthesis": {
    "summary": "Adopting event sourcing introduces real operational overhead but solves the audit-trail compliance requirement directly...",
    "confidence": 0.84,
    "consensus": true,
    "agreed": [
      "compliance audit trail is the load-bearing requirement",
      "operational overhead is real but bounded"
    ],
    "unresolved": [
      "whether the team has CQRS expertise to operate it"
    ]
  },
  "turns": [
    {
      "round": 1,
      "agent": "Translator",
      "role": "translator",
      "neurotype": "translator",
      "model": "mistralai/mistral-large-2512",
      "content": "The load-bearing assumption here is that...",
      "started_at": "2026-05-03T17:42:01.000Z",
      "completed_at": "2026-05-03T17:42:08.500Z",
      "meta": {
        "provider": "openrouter",
        "latency_ms": 7500,
        "prompt_tokens": 1240,
        "completion_tokens": 312,
        "cost_usd": 0.0028
      }
    }
  ],
  "events": [...],
  "cost": {
    "total_usd": 0.0420,
    "by_provider": {
      "openrouter": 0.0420
    }
  },
  "tier_metadata": {
    "lineup": "frontier",
    "rate_limit_remaining": 312
  }
}
```

`status` values: `in_flight` · `completed` · `failed` · `cancelled`.

`termination_reason` values: `consensus_reached` · `max_rounds` · `confidence_threshold` · `cancelled` · `error`.

`split`: present (non-null) only when the panel could not converge. Contains `positions` (per-agent final stance) and `axis` (machine-readable label of the disagreement axis).

### `GET /v1/deliberations/:id/stream`

Server-Sent Events stream of a deliberation as it executes. Connection holds open until `status` is terminal.

**Headers (response):**

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event types:**

- `turn` — a new turn has been generated by an agent
- `event` — system event (e.g., Sentry alert, OSI threshold crossed, residue spike)
- `status` — deliberation status changed
- `cost` — per-turn or running-total cost update
- `error` — an error occurred; deliberation may continue or terminate
- `done` — deliberation reached terminal state; client can close

**Example wire format:**

```
event: turn
data: {"id":"del_8257b737...","round":1,"agent":"Translator","role":"translator","model":"mistralai/mistral-large-2512","content":"The load-bearing assumption...","meta":{"latency_ms":7500,"prompt_tokens":1240,"completion_tokens":312,"cost_usd":0.0028}}

event: cost
data: {"total_usd":0.0028}

event: turn
data: {"id":"del_8257b737...","round":1,"agent":"Empiricist","role":"empiricist","model":"mistralai/mistral-large-2512","content":"Demand evidence: provide..."}

event: status
data: {"status":"completed","resolved":true,"residue_score":0.18}

event: done
data: {"id":"del_8257b737..."}
```

**Reconnection:** if the connection drops, clients can reconnect by including `Last-Event-ID` (the most recent event's ID) in the reconnect request. The server replays events from that point.

### `GET /v1/deliberations`

List deliberations for the authenticated account.

**Query parameters:**

- `limit` (integer, 1-100, default 25)
- `cursor` (string, opaque pagination cursor)
- `status` (string, optional filter: `in_flight` | `completed` | `failed` | `cancelled`)
- `preset` (string, optional filter)
- `created_after` (ISO 8601 timestamp)
- `created_before` (ISO 8601 timestamp)

**Response 200:**

```json
{
  "data": [
    {
      "id": "del_8257b737...",
      "preset": "socratic",
      "topic": "Should we adopt event sourcing...",
      "status": "completed",
      "created_at": "2026-05-03T17:42:00.000Z",
      "completed_at": "2026-05-03T17:44:18.000Z",
      "resolved": true,
      "residue_score": 0.18,
      "cost_usd": 0.0420
    }
  ],
  "next_cursor": "Y3Vyc29yX2FiYzEyMw=="
}
```

### `DELETE /v1/deliberations/:id`

Cancel an in-flight deliberation. Completed deliberations cannot be deleted via API in v1 (use the dashboard); v1.5 adds retention-based deletion.

**Response 200:**

```json
{
  "id": "del_8257b737...",
  "status": "cancelled",
  "cancelled_at": "2026-05-03T17:43:30.000Z",
  "partial_turns": 4,
  "partial_cost_usd": 0.0210
}
```

**Errors:**

- `404 resource_not_found`
- `409 invalid_state`: deliberation already in terminal state

### `GET /v1/usage`

Current period usage for the authenticated account.

**Response 200:**

```json
{
  "tier": "pro",
  "period": {
    "start": "2026-05-01T00:00:00Z",
    "end": "2026-06-01T00:00:00Z"
  },
  "deliberations": {
    "limit": 350,
    "used": 38,
    "remaining": 312
  },
  "cost": {
    "total_usd": 0.83,
    "by_provider": { "openrouter": 0.83 }
  },
  "concurrency": {
    "limit": 1,
    "current": 0
  }
}
```

### `GET /v1/health`

Health check. Public (no auth required). Returns 200 if the service is operational.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "upstream_providers": [
    { "name": "openrouter", "status": "ok", "p99_latency_ms": 1840 }
  ]
}
```

## Versioning

- **URL versioned (`/v1`).** Breaking changes ship under `/v2`; both versions run for at least 12 months.
- **Additive changes are non-breaking.** New optional fields, new event types, new endpoints, new error codes don't trigger a major version bump.
- **Deprecation notices** are surfaced via `Sunset` and `Deprecation` HTTP headers and via the `X-Parliament-Deprecation: <field>; sunset=<date>` custom header on responses that touch deprecated fields.

## Webhooks (v1.5, not in v1)

- `deliberation.completed` — fires when a deliberation reaches `completed`
- `deliberation.failed` — fires on terminal failure
- `deliberation.cancelled` — fires on explicit cancellation
- `usage.threshold_crossed` — fires when account crosses 50% / 80% / 100% of envelope

Webhooks are signed (`X-Parliament-Signature: t=…,v1=hmac_sha256(secret, t + body)`). Retried with exponential backoff on non-2xx for 24h.

## SDK (v1.5)

Official SDKs ship in v1.5: TypeScript (`@parliament/sdk`), Python (`parliament-py`). v1 customers integrate directly via fetch / requests — every endpoint is straightforward enough that an SDK is convenience, not necessity.

## OpenAPI 3.1 schema

Ships as `docs/product/openapi.yaml` with v1.0. Serves as the source of truth for SDK generation, dashboard playground, and the public docs site (`docs.parliament.app`).

## Self-host parity

The OSS server (`packages/server`) implements the same routes under the same shapes. Differences:

- No `Authorization` header required by default (private deployment).
- No usage envelope (`/v1/usage` returns `unlimited`).
- Lineup is whatever the operator configures via `parliament.toml`.
- Webhooks (v1.5+) require operator config.

This is a deliberate design choice (PRD D4): OSS users get genuine API parity, not a crippled subset. The hosted product is defended by reliability, frontier-lineup access, billing, audit logs, and enterprise features — not by API gating.
