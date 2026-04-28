import { type ModelAdapter, ModelConnectionError } from './base.js';

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
}

export class OllamaAdapter implements ModelAdapter {
  constructor(
    private readonly model: string,
    private readonly baseUrl: string = 'http://localhost:11434',
  ) {}

  async generate(prompt: string, system?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];

    if (system !== undefined) {
      messages.push({ role: 'system', content: system });
    }

    messages.push({ role: 'user', content: prompt });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
        }),
      });
    } catch (err) {
      throw new ModelConnectionError(
        `Ollama connection failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new ModelConnectionError(
        `Ollama request failed with status ${response.status}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    return data.message.content;
  }
}
