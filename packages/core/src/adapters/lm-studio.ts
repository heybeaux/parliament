import { type ModelAdapter } from './base.js';
import { OpenAICompatAdapter } from './openai-compat.js';

export class LMStudioAdapter implements ModelAdapter {
  private readonly inner: OpenAICompatAdapter;
  readonly modelName: string;

  constructor(
    model: string,
    baseUrl: string = 'http://localhost:1234/v1',
    apiKey: string = 'local',
  ) {
    this.inner = new OpenAICompatAdapter(model, baseUrl, apiKey);
    this.modelName = model;
  }

  generate(prompt: string, system?: string): Promise<string> {
    return this.inner.generate(prompt, system);
  }
}
