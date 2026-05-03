import type { AdapterMeta } from './base.js';
import { OpenAICompatAdapter } from './openai-compat.js';

export interface OpenRouterAdapterOptions {
  /**
   * Optional `HTTP-Referer` header. OpenRouter uses this to attribute traffic
   * to your app on its public leaderboard.
   */
  httpReferer?: string;
  /**
   * Optional `X-Title` header. OpenRouter uses this as the app display name on
   * its public leaderboard.
   */
  xTitle?: string;
}

/**
 * OpenRouter (https://openrouter.ai) is an OpenAI-API-compatible router for
 * hosted models. This adapter is a thin subclass of {@link OpenAICompatAdapter}
 * that:
 *
 *   - defaults the base URL to `https://openrouter.ai/api/v1`
 *   - forwards the API key via `Authorization: Bearer <key>`
 *   - threads OpenRouter's optional `HTTP-Referer` / `X-Title` attribution
 *     headers when supplied via {@link OpenRouterAdapterOptions}
 *   - parses OpenRouter-specific telemetry into {@link AdapterMeta} (PAR-23 +
 *     PAR-30): `costUsd` from `usage.cost` in the response body, and
 *     `generationId` from the body's top-level `id` field (preferred) with
 *     the `x-generation-id` response header as a fallback.
 *
 * PAR-30 corrects the original PAR-23 implementation, which read non-existent
 * `X-OR-Cost` and `X-OR-Generation-Id` headers. The real OpenRouter API
 * surfaces cost only in the body and uses `x-generation-id` (no `or-`
 * prefix) for the header form of the generation id.
 *
 * The body / header parse paths override
 * `OpenAICompatAdapter.parseResponseBody` and `parseResponseHeaders` rather
 * than re-implementing `generate()`, so latency and `usage`-based token
 * telemetry come "for free" from the base.
 */
export class OpenRouterAdapter extends OpenAICompatAdapter {
  constructor(
    model: string,
    apiKey: string,
    baseUrl: string = 'https://openrouter.ai/api/v1',
    options: OpenRouterAdapterOptions = {},
  ) {
    const extraHeaders: Record<string, string> = {};
    if (options.httpReferer !== undefined) {
      extraHeaders['HTTP-Referer'] = options.httpReferer;
    }
    if (options.xTitle !== undefined) {
      extraHeaders['X-Title'] = options.xTitle;
    }
    super(model, baseUrl, apiKey, extraHeaders, 'openrouter');
  }

  /**
   * PAR-30: OpenRouter reports per-call cost as `usage.cost` (USD number)
   * inside the response body, alongside the OpenAI-compat `prompt_tokens` /
   * `completion_tokens` the base adapter already reads. The top-level `id`
   * field is the generation id (e.g. `gen-1777773347-Jz7XIWDdPEhCkYSHctwz`).
   *
   * When fields are absent or unparseable, leave the corresponding
   * `AdapterMeta` field undefined rather than emitting NaN.
   */
  protected override parseResponseBody(
    body: Record<string, unknown>,
  ): Partial<AdapterMeta> | undefined {
    const out: Partial<AdapterMeta> = {};

    const usage = body['usage'];
    if (usage !== null && typeof usage === 'object') {
      const cost = (usage as Record<string, unknown>)['cost'];
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        out.costUsd = cost;
      } else if (typeof cost === 'string' && cost.length > 0) {
        const parsed = Number(cost);
        if (Number.isFinite(parsed)) {
          out.costUsd = parsed;
        }
      }
    }

    const id = body['id'];
    if (typeof id === 'string' && id.length > 0) {
      out.generationId = id;
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * PAR-30: OpenRouter exposes the generation id in the `x-generation-id`
   * response header as well (no `or-` prefix — the original PAR-23 code
   * read `X-OR-Generation-Id`, which does not exist). The body lookup
   * above already covers the common case; this header path is a fallback
   * for the unusual case where a body field is absent but the header is
   * present (or for API-shape changes).
   *
   * `Headers.get` is case-insensitive per the Fetch spec.
   */
  protected override parseResponseHeaders(
    response: Response,
  ): Partial<AdapterMeta> | undefined {
    const generationId = response.headers.get('x-generation-id');
    if (generationId !== null && generationId.length > 0) {
      return { generationId };
    }
    return undefined;
  }
}
