import {
  type AdapterMeta,
  type AdapterResult,
  type ModelAdapter,
  ModelConnectionError,
  UpstreamProviderError,
  truncateUpstreamBody,
} from './base.js';

/** Default per-call LLM timeout (ms) when env is unset/invalid. */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/**
 * Resolve the per-call LLM timeout from `PARLIAMENT_LLM_TIMEOUT_MS`, falling
 * back to {@link DEFAULT_LLM_TIMEOUT_MS}. A non-positive or unparseable value
 * is ignored (we never want a 0ms timeout that aborts every call instantly).
 */
function resolveLlmTimeoutMs(): number {
  const raw = process.env.PARLIAMENT_LLM_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_LLM_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.floor(parsed);
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
  /**
   * OpenAI-format usage block. Present on every "real" provider we target
   * (OpenAI, OpenRouter, LM Studio, oMLX) but optional on the wire — small
   * local servers occasionally omit it. Read defensively.
   */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Subclass-extension hook used by `OpenRouterAdapter` to read provider-specific
 * response headers (e.g. `X-OR-Cost`, `X-OR-Generation-Id`) and merge them
 * into the returned {@link AdapterMeta}. The base implementation returns
 * `undefined` (no extra fields). Subclasses MAY override.
 *
 * The base adapter does NOT call this hook itself — it's a protected helper
 * exposed for subclasses that override `generate()` to reuse the request-body
 * construction. Kept as an instance method so each subclass can branch on its
 * own `instanceof` without touching the base path.
 */
export type ResponseHeaderParser = (response: Response) => Partial<AdapterMeta> | undefined;

export class OpenAICompatAdapter implements ModelAdapter {
  readonly modelName: string;
  /**
   * Provider discriminator stamped onto every emitted `AdapterMeta.provider`.
   * Subclasses pass their own (`'lm_studio'`, `'omlx'`, `'openrouter'`); the
   * default `'openai_compat'` covers the bare-base case where a caller wires
   * up `OpenAICompatAdapter` directly against a generic OpenAI-API server.
   */
  protected readonly provider: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string = 'local',
    private readonly extraHeaders: Record<string, string> = {},
    provider: string = 'openai_compat',
  ) {
    this.modelName = model;
    this.provider = provider;
  }

  async generate(prompt: string, system?: string): Promise<AdapterResult> {
    const messages: Array<{ role: string; content: string }> = [];

    if (system !== undefined) {
      messages.push({ role: 'system', content: system });
    }

    messages.push({ role: 'user', content: prompt });

    const startedAt = Date.now();

    // Per-call wall-clock timeout. A stalled provider response (no bytes, no
    // close) would otherwise hang this fetch forever — and since the engine
    // runs sequential steps without a block timeout, one hung call freezes the
    // entire deliberation in `in_flight` with no terminal status. Bound it.
    const timeoutMs = resolveLlmTimeoutMs();
    const tag = `${this.provider}/${this.model}`;
    console.error(`[parliament:llm] → ${tag} request (timeout ${timeoutMs}ms)`);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      // AbortSignal.timeout fires a DOMException named 'TimeoutError'.
      if (err instanceof Error && err.name === 'TimeoutError') {
        console.error(
          `[parliament:llm] ✗ ${tag} TIMED OUT after ${elapsed}ms (limit ${timeoutMs}ms)`,
        );
        throw new ModelConnectionError(
          `${this.provider} call to ${this.model} timed out after ${timeoutMs}ms`,
          err,
        );
      }
      console.error(
        `[parliament:llm] ✗ ${tag} connection failed after ${elapsed}ms: ${String(err)}`,
      );
      throw new ModelConnectionError(
        `OpenAI-compat connection failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      // PAR-32 / PRD D2: preserve upstream context verbatim instead of
      // flattening to a status-only string. Body is read as text (cheap; we
      // already failed) and truncated to 4 KiB for safe persistence. The
      // request-id header is surfaced when the provider returns one — every
      // OpenAI-compatible provider we target uses one of two header names.
      const body = await response.text().catch(() => '');
      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('x-generation-id') ??
        undefined;
      throw new UpstreamProviderError(
        `${this.provider} request failed with status ${response.status}`,
        {
          provider: this.provider,
          status: response.status,
          body: truncateUpstreamBody(body),
          ...(requestId !== undefined ? { requestId } : {}),
        },
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const latencyMs = Date.now() - startedAt;
    console.error(`[parliament:llm] ✓ ${tag} ok in ${latencyMs}ms`);

    const meta: AdapterMeta = {
      latencyMs,
      provider: this.provider,
    };
    if (data.usage !== undefined) {
      if (typeof data.usage.prompt_tokens === 'number') {
        meta.promptTokens = data.usage.prompt_tokens;
      }
      if (typeof data.usage.completion_tokens === 'number') {
        meta.completionTokens = data.usage.completion_tokens;
      }
    }

    // Subclass hooks: parse provider-specific fields from the response body
    // and headers. Body merges first (cheaper), then headers can override.
    // Returning `undefined` skips the merge cleanly.
    const bodyMeta = this.parseResponseBody(data as unknown as Record<string, unknown>);
    if (bodyMeta !== undefined) {
      Object.assign(meta, bodyMeta);
    }
    const headerMeta = this.parseResponseHeaders(response);
    if (headerMeta !== undefined) {
      Object.assign(meta, headerMeta);
    }

    return { content: data.choices[0]!.message.content, meta };
  }

  /**
   * Subclass-overridable hook for parsing response headers into AdapterMeta.
   * Default: no extra fields. Subclasses MAY override.
   *
   * Note for OpenRouter callers: cost is in the response body, not headers
   * (PAR-30 fix). Use {@link parseResponseBody} for cost; this hook is for
   * fields that genuinely live only in headers.
   */
  protected parseResponseHeaders(_response: Response): Partial<AdapterMeta> | undefined {
    return undefined;
  }

  /**
   * Subclass-overridable hook for parsing the parsed JSON body into
   * AdapterMeta. Default: no extra fields. `OpenRouterAdapter` overrides to
   * pull `usage.cost` and the response `id` (generation id). Body is the raw
   * decoded JSON; the base has already extracted `choices[0].message.content`
   * and `usage.prompt_tokens`/`usage.completion_tokens` into `meta`, so
   * subclasses should only return *additional* fields.
   */
  protected parseResponseBody(
    _body: Record<string, unknown>,
  ): Partial<AdapterMeta> | undefined {
    return undefined;
  }
}
