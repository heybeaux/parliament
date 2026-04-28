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
    case 'omlx':
      return new OMLXAdapter(model);
    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}
