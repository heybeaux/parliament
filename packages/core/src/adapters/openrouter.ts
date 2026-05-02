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
 *   - parses OpenRouter-specific response headers `X-OR-Cost` and
 *     `X-OR-Generation-Id` into the returned `AdapterMeta` (PAR-23). When
 *     either header is absent or unparseable, the corresponding field is
 *     simply left undefined — never NaN.
 *
 * The header parse path overrides `OpenAICompatAdapter.parseResponseHeaders`
 * rather than re-implementing `generate()`, so latency and `usage`-based
 * token telemetry come "for free" from the base.
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
   * PAR-23: OpenRouter reports per-call cost in the `X-OR-Cost` header (USD
   * decimal string) and a stable trace id in `X-OR-Generation-Id`. Both
   * headers are optional on the wire — when absent we leave the corresponding
   * `AdapterMeta` fields undefined rather than emitting `NaN` or an empty
   * string. `Headers.get` is case-insensitive per the Fetch spec, so the
   * `X-OR-*` casing here is just for readability.
   */
  protected override parseResponseHeaders(
    response: Response,
  ): Partial<AdapterMeta> | undefined {
    const out: Partial<AdapterMeta> = {};

    const rawCost = response.headers.get('X-OR-Cost');
    if (rawCost !== null && rawCost.length > 0) {
      const parsed = Number(rawCost);
      if (Number.isFinite(parsed)) {
        out.costUsd = parsed;
      }
    }

    const generationId = response.headers.get('X-OR-Generation-Id');
    if (generationId !== null && generationId.length > 0) {
      out.generationId = generationId;
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }
}
