import { type ModelAdapter, ModelConnectionError } from './base.js';

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
}

export class OpenAICompatAdapter implements ModelAdapter {
  readonly modelName: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string = 'local',
    private readonly extraHeaders: Record<string, string> = {},
  ) {
    this.modelName = model;
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];

    if (system !== undefined) {
      messages.push({ role: 'system', content: system });
    }

    messages.push({ role: 'user', content: prompt });

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
    return data.choices[0].message.content;
  }
}
