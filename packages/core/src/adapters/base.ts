/**
 * Provider-reported metadata captured by every adapter alongside the prose.
 *
 * Populated additively per provider:
 *   - All adapters populate `latencyMs` (wall-clock generate() duration) and
 *     `provider` (string discriminator).
 *   - OpenAI-compat-derived adapters (lm_studio, omlx, openrouter) populate
 *     `promptTokens` / `completionTokens` from `data.usage` when the provider
 *     returns it.
 *   - OpenRouter additionally populates `costUsd` (from the `X-OR-Cost`
 *     response header) and `generationId` (from `X-OR-Generation-Id`).
 *   - Ollama populates `promptTokens` / `completionTokens` from the native
 *     `prompt_eval_count` / `eval_count` fields when present. Cost is always
 *     omitted (local execution is free).
 *
 * Every field is optional: a provider that does not report a particular
 * signal simply leaves it absent. Downstream consumers (engine persistence,
 * UI surfacing in PAR-24, future budget-cap gating) MUST therefore treat
 * any single field as "may be undefined."
 *
 * PAR-23.
 */
export interface AdapterMeta {
  /** Wall-clock duration of the adapter's `generate` call, in milliseconds. */
  latencyMs?: number;
  /** Prompt-side token count reported by the provider, when available. */
  promptTokens?: number;
  /** Completion-side token count reported by the provider, when available. */
  completionTokens?: number;
  /**
   * Cost in USD as reported by the provider. OpenRouter populates this from
   * the `X-OR-Cost` response header. Local providers leave this absent.
   */
  costUsd?: number;
  /**
   * Provider-side generation id useful for trace lookups (e.g. the
   * OpenRouter dashboard). Populated only when the provider returns one.
   */
  generationId?: string;
  /**
   * Stable provider discriminator string. Matches the provider keys accepted
   * by `createAdapter` — `'ollama' | 'lm_studio' | 'omlx' | 'openrouter'`
   * — plus the neutral `'openai_compat'` fallback for the bare base adapter.
   */
  provider?: string;
}

/**
 * Structured return shape of `ModelAdapter.generate`.
 *
 * `content` is the same prose string the legacy `Promise<string>` shape
 * returned. `meta` carries provider-reported telemetry when available.
 *
 * PAR-23 — breaking change to the adapter contract. Every callsite reading
 * a string from `adapter.generate(...)` must now read `result.content`.
 */
export interface AdapterResult {
  content: string;
  meta?: AdapterMeta;
}

export interface ModelAdapter {
  readonly modelName: string;
  generate(prompt: string, system?: string): Promise<AdapterResult>;
}

export class ModelConnectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ModelConnectionError';
  }
}

/**
 * Structured context preserved verbatim from an upstream provider's failure
 * response. Surfaces on every layer of the stack — adapter throw → engine
 * propagation → DB row → SSE `error` event → API JSON envelope — so callers
 * never see an upstream failure flattened to a single string (PAR-32, PRD D2).
 *
 * `body` is the raw upstream response body, truncated to a safe ceiling
 * (4 KiB) to keep persistence cheap; full body lives in adapter logs only.
 */
export interface UpstreamErrorContext {
  /** Stable provider key (`'openrouter'`, `'ollama'`, `'lm_studio'`, `'omlx'`, `'openai_compat'`). */
  provider: string;
  /** HTTP status returned by the upstream. */
  status: number;
  /** Raw upstream response body (text), truncated to 4 KiB. */
  body: string;
  /**
   * Provider request id, when surfaced. OpenRouter uses `x-generation-id`;
   * OpenAI proper uses `x-request-id`. Absent on providers that don't return one.
   */
  requestId?: string;
}

/**
 * Subclass of {@link ModelConnectionError} that carries the structured
 * `UpstreamErrorContext` block. Existing failover semantics (engine retries
 * once on a configured fallback adapter when `err instanceof
 * ModelConnectionError`) continue to apply because of the inheritance — only
 * the surfaced shape gets richer (PAR-32, PRD D2).
 */
export class UpstreamProviderError extends ModelConnectionError {
  constructor(message: string, public readonly upstream: UpstreamErrorContext) {
    super(message);
    this.name = 'UpstreamProviderError';
  }
}

/**
 * Truncate an upstream response body to a safe ceiling for persistence and
 * wire transmission. 4 KiB is large enough to capture every error envelope
 * we've seen from OpenRouter / Ollama / LM Studio while keeping DB rows and
 * SSE event payloads small. Truncation is signaled with a trailing
 * `… [truncated, N total]` marker so the operator knows logs are the source
 * of truth for the full body.
 */
export function truncateUpstreamBody(body: string, maxBytes = 4096): string {
  if (body.length <= maxBytes) return body;
  return `${body.slice(0, maxBytes)}… [truncated, ${body.length} total]`;
}
