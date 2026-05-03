import {
  type AdapterMeta,
  type AdapterResult,
  type ModelAdapter,
  ModelConnectionError,
} from './base.js';

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
      });
    } catch (err) {
      throw new ModelConnectionError(
        `OpenAI-compat connection failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new ModelConnectionError(
        `OpenAI-compat request failed with status ${response.status}`,
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const latencyMs = Date.now() - startedAt;

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
