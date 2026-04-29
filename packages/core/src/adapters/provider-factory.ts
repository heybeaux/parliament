import { type ModelAdapter } from './base.js';
import { OllamaAdapter } from './ollama.js';
import { LMStudioAdapter } from './lm-studio.js';
import { OMLXAdapter } from './omlx.js';

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
    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}
