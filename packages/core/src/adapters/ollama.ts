import {
  type AdapterMeta,
  type AdapterResult,
  type ModelAdapter,
  ModelConnectionError,
  UpstreamProviderError,
  truncateUpstreamBody,
} from './base.js';

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
  /**
   * Ollama's native equivalents of OpenAI `usage.prompt_tokens` /
   * `usage.completion_tokens`. Optional on the wire — older builds may omit
   * them, so read defensively.
   */
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaAdapter implements ModelAdapter {
  readonly modelName: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string = 'http://localhost:11434',
  ) {
    this.modelName = model;
  }

  async generate(prompt: string, system?: string): Promise<AdapterResult> {
    const messages: Array<{ role: string; content: string }> = [];

    if (system !== undefined) {
      messages.push({ role: 'system', content: system });
    }

    messages.push({ role: 'user', content: prompt });

    const startedAt = Date.now();

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
      // PAR-32 / PRD D2: preserve upstream body + status verbatim. Ollama
      // doesn't surface a request-id header, so requestId stays absent.
      const body = await response.text().catch(() => '');
      throw new UpstreamProviderError(
        `Ollama request failed with status ${response.status}`,
        {
          provider: 'ollama',
          status: response.status,
          body: truncateUpstreamBody(body),
        },
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const latencyMs = Date.now() - startedAt;

    // PAR-23: latency + provider always; tokens populated when Ollama
    // returns them. Cost is intentionally omitted — local execution is
    // free, and emitting a sentinel zero would be confusable with a
    // hosted-but-zero-cost call.
    const meta: AdapterMeta = {
      latencyMs,
      provider: 'ollama',
    };
    if (typeof data.prompt_eval_count === 'number') {
      meta.promptTokens = data.prompt_eval_count;
    }
    if (typeof data.eval_count === 'number') {
      meta.completionTokens = data.eval_count;
    }

    return { content: data.message.content, meta };
  }
}
