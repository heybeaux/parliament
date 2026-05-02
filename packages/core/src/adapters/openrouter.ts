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
 *
 * The subclass exists for `instanceof` / debugging clarity and as a hook for
 * future OpenRouter-specific behaviour (model fallbacks, cost telemetry, etc.).
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
    super(model, baseUrl, apiKey, extraHeaders);
  }
}
