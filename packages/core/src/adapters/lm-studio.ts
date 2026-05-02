import { type AdapterResult, type ModelAdapter } from './base.js';
import { OpenAICompatAdapter } from './openai-compat.js';

export class LMStudioAdapter implements ModelAdapter {
  private readonly inner: OpenAICompatAdapter;
  readonly modelName: string;

  constructor(
    model: string,
    baseUrl: string = 'http://localhost:1234/v1',
    apiKey: string = 'local',
  ) {
    // PAR-23: provider discriminator is threaded through the constructor so
    // emitted `AdapterMeta.provider` is `'lm_studio'`, not the base default.
    this.inner = new OpenAICompatAdapter(model, baseUrl, apiKey, {}, 'lm_studio');
    this.modelName = model;
  }

  generate(prompt: string, system?: string): Promise<AdapterResult> {
    return this.inner.generate(prompt, system);
  }
}
