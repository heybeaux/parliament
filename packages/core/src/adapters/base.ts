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
