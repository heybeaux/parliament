import { type ModelAdapter } from './base.js';
import { OllamaAdapter } from './ollama.js';
import { LMStudioAdapter } from './lm-studio.js';
import { OMLXAdapter } from './omlx.js';
import {
  OpenRouterAdapter,
  type OpenRouterAdapterOptions,
} from './openrouter.js';

export function createAdapter(model: string, provider?: string): ModelAdapter {
  const p = provider ?? process.env.PARLIAMENT_PROVIDER ?? 'ollama';
  switch (p) {
    case 'ollama':
      return new OllamaAdapter(model);
    case 'lm_studio':
      return new LMStudioAdapter(model);
    case 'omlx': {
      const baseUrl = process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1';
      const apiKey = process.env.OMLX_API_KEY ?? '12345678';
      return new OMLXAdapter(model, baseUrl, apiKey);
    }
    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OPENROUTER_API_KEY env var is required for provider "openrouter"',
        );
      }
      // Treat empty strings the same as unset for these optional knobs so a
      // blank entry in `.env` doesn't override the default base URL with `''`
      // or stamp blank attribution headers on every request.
      const baseUrl =
        process.env.OPENROUTER_BASE_URL && process.env.OPENROUTER_BASE_URL.length > 0
          ? process.env.OPENROUTER_BASE_URL
          : 'https://openrouter.ai/api/v1';
      const options: OpenRouterAdapterOptions = {};
      if (process.env.OPENROUTER_HTTP_REFERER) {
        options.httpReferer = process.env.OPENROUTER_HTTP_REFERER;
      }
      if (process.env.OPENROUTER_X_TITLE) {
        options.xTitle = process.env.OPENROUTER_X_TITLE;
      }
      return new OpenRouterAdapter(model, apiKey, baseUrl, options);
    }
    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}
