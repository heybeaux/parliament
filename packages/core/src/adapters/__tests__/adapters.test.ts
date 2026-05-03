import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelConnectionError } from '../base.js';
import { OllamaAdapter } from '../ollama.js';
import { OpenAICompatAdapter } from '../openai-compat.js';
import { LMStudioAdapter } from '../lm-studio.js';
import { OMLXAdapter } from '../omlx.js';
import { OpenRouterAdapter } from '../openrouter.js';
import { createAdapter } from '../provider-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * PAR-23: helpers can now optionally stamp response headers on the mock
 * `Response`. We model headers as a plain `Record<string, string>` and expose
 * a real `Headers` instance via `response.headers` so case-insensitive
 * `Headers.get` works the way OpenRouterAdapter expects.
 */
function makeFetchOk(body: unknown, headers?: Record<string, string>): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(headers ?? {}),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function makeFetchError(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message));
}

function makeFetchNotOk(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// OllamaAdapter
// ---------------------------------------------------------------------------

describe('OllamaAdapter', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the correct Ollama endpoint and returns message content', async () => {
    const mockFetch = makeFetchOk({
      message: { role: 'assistant', content: 'Hello from Ollama' },
    });
    globalThis.fetch = mockFetch;

    const adapter = new OllamaAdapter('llama3', 'http://localhost:11434');
    const result = await adapter.generate('What is 2+2?', 'You are helpful.');

    expect(result.content).toBe('Hello from Ollama');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.model).toBe('llama3');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);
  });

  it('omits system message when system is undefined', async () => {
    const mockFetch = makeFetchOk({
      message: { role: 'assistant', content: 'pong' },
    });
    globalThis.fetch = mockFetch;

    const adapter = new OllamaAdapter('llama3');
    await adapter.generate('ping');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('throws ModelConnectionError when fetch rejects', async () => {
    globalThis.fetch = makeFetchError('ECONNREFUSED');

    const adapter = new OllamaAdapter('llama3');
    await expect(adapter.generate('hello')).rejects.toThrow(
      ModelConnectionError,
    );
    await expect(adapter.generate('hello')).rejects.toThrow('ECONNREFUSED');
  });

  it('throws ModelConnectionError when response is not ok', async () => {
    globalThis.fetch = makeFetchNotOk(500);

    const adapter = new OllamaAdapter('llama3');
    await expect(adapter.generate('hello')).rejects.toThrow(
      ModelConnectionError,
    );
    await expect(adapter.generate('hello')).rejects.toThrow('500');
  });

  // -------------------------------------------------------------------------
  // PAR-23: meta telemetry
  // -------------------------------------------------------------------------

  it('PAR-23: stamps latencyMs and provider="ollama" on every call', async () => {
    globalThis.fetch = makeFetchOk({
      message: { role: 'assistant', content: 'ok' },
    });

    const adapter = new OllamaAdapter('llama3');
    const result = await adapter.generate('hi');

    expect(result.meta).toBeDefined();
    expect(typeof result.meta!.latencyMs).toBe('number');
    expect(result.meta!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.meta!.provider).toBe('ollama');
    // Cost is intentionally omitted — local execution.
    expect(result.meta!.costUsd).toBeUndefined();
  });

  it('PAR-23: maps prompt_eval_count/eval_count to promptTokens/completionTokens', async () => {
    globalThis.fetch = makeFetchOk({
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 12,
      eval_count: 34,
    });

    const adapter = new OllamaAdapter('llama3');
    const result = await adapter.generate('hi');

    expect(result.meta!.promptTokens).toBe(12);
    expect(result.meta!.completionTokens).toBe(34);
  });

  it('PAR-23: leaves token fields undefined when Ollama omits them', async () => {
    globalThis.fetch = makeFetchOk({
      message: { role: 'assistant', content: 'ok' },
    });

    const adapter = new OllamaAdapter('llama3');
    const result = await adapter.generate('hi');

    expect(result.meta!.promptTokens).toBeUndefined();
    expect(result.meta!.completionTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatAdapter
// ---------------------------------------------------------------------------

describe('OpenAICompatAdapter', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the correct endpoint with custom baseUrl and model', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'Hi from OpenAI compat' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OpenAICompatAdapter(
      'gpt-4o',
      'http://my-proxy:8080',
      'sk-test',
    );
    const result = await adapter.generate('Tell me a joke', 'Be funny.');

    expect(result.content).toBe('Hi from OpenAI compat');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe('http://my-proxy:8080/chat/completions');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be funny.' },
      { role: 'user', content: 'Tell me a joke' },
    ]);
  });

  it('uses default apiKey of "local" when not provided', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OpenAICompatAdapter('mistral', 'http://localhost:1234');
    await adapter.generate('hello');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer local');
  });

  it('throws ModelConnectionError when fetch rejects', async () => {
    globalThis.fetch = makeFetchError('network error');

    const adapter = new OpenAICompatAdapter('gpt-4o', 'http://my-proxy:8080');
    await expect(adapter.generate('hello')).rejects.toThrow(
      ModelConnectionError,
    );
    await expect(adapter.generate('hello')).rejects.toThrow('network error');
  });

  it('throws ModelConnectionError when response is not ok', async () => {
    globalThis.fetch = makeFetchNotOk(401);

    const adapter = new OpenAICompatAdapter('gpt-4o', 'http://my-proxy:8080');
    await expect(adapter.generate('hello')).rejects.toThrow(
      ModelConnectionError,
    );
    await expect(adapter.generate('hello')).rejects.toThrow('401');
  });

  // -------------------------------------------------------------------------
  // PAR-23: meta telemetry
  // -------------------------------------------------------------------------

  it('PAR-23: stamps latencyMs + provider="openai_compat" by default', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });

    const adapter = new OpenAICompatAdapter('gpt-4o', 'http://my-proxy:8080');
    const result = await adapter.generate('hi');

    expect(result.meta).toBeDefined();
    expect(typeof result.meta!.latencyMs).toBe('number');
    expect(result.meta!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.meta!.provider).toBe('openai_compat');
  });

  it('PAR-23: parses usage block into promptTokens/completionTokens', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 17, completion_tokens: 42, total_tokens: 59 },
    });

    const adapter = new OpenAICompatAdapter('gpt-4o', 'http://my-proxy:8080');
    const result = await adapter.generate('hi');

    expect(result.meta!.promptTokens).toBe(17);
    expect(result.meta!.completionTokens).toBe(42);
  });

  it('PAR-23: leaves token fields undefined when usage block is absent', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });

    const adapter = new OpenAICompatAdapter('gpt-4o', 'http://my-proxy:8080');
    const result = await adapter.generate('hi');

    expect(result.meta!.promptTokens).toBeUndefined();
    expect(result.meta!.completionTokens).toBeUndefined();
    expect(result.meta!.costUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LMStudioAdapter
// ---------------------------------------------------------------------------

describe('LMStudioAdapter', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the LM Studio /v1/chat/completions endpoint and returns content', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'Hi from LM Studio' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new LMStudioAdapter('mistral', 'http://localhost:1234/v1', 'local');
    const result = await adapter.generate('Hello', 'Be concise.');

    expect(result.content).toBe('Hi from LM Studio');

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('mistral');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('uses default baseUrl of http://localhost:1234/v1', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new LMStudioAdapter('mistral');
    await adapter.generate('ping');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('throws ModelConnectionError when fetch rejects', async () => {
    globalThis.fetch = makeFetchError('ECONNREFUSED lm-studio');

    const adapter = new LMStudioAdapter('mistral');
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('ECONNREFUSED lm-studio');
  });

  it('throws ModelConnectionError when response is not ok', async () => {
    globalThis.fetch = makeFetchNotOk(503);

    const adapter = new LMStudioAdapter('mistral');
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('503');
  });

  it('PAR-23: stamps provider="lm_studio" and forwards usage tokens', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 11 },
    });

    const adapter = new LMStudioAdapter('mistral');
    const result = await adapter.generate('hi');

    expect(result.meta!.provider).toBe('lm_studio');
    expect(typeof result.meta!.latencyMs).toBe('number');
    expect(result.meta!.promptTokens).toBe(5);
    expect(result.meta!.completionTokens).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// OMLXAdapter
// ---------------------------------------------------------------------------

describe('OMLXAdapter', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the oMLX /v1/chat/completions endpoint and returns content', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'Hi from oMLX' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OMLXAdapter('phi3', 'http://localhost:8080/v1', 'local');
    const result = await adapter.generate('Hello', 'Be precise.');

    expect(result.content).toBe('Hi from oMLX');

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://localhost:8080/v1/chat/completions');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('phi3');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be precise.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('uses default baseUrl of http://localhost:8080/v1', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OMLXAdapter('phi3');
    await adapter.generate('ping');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
  });

  it('throws ModelConnectionError when fetch rejects', async () => {
    globalThis.fetch = makeFetchError('ECONNREFUSED omlx');

    const adapter = new OMLXAdapter('phi3');
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('ECONNREFUSED omlx');
  });

  it('throws ModelConnectionError when response is not ok', async () => {
    globalThis.fetch = makeFetchNotOk(502);

    const adapter = new OMLXAdapter('phi3');
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('502');
  });

  it('PAR-23: stamps provider="omlx" and forwards usage tokens', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 7 },
    });

    const adapter = new OMLXAdapter('phi3');
    const result = await adapter.generate('hi');

    expect(result.meta!.provider).toBe('omlx');
    expect(typeof result.meta!.latencyMs).toBe('number');
    expect(result.meta!.promptTokens).toBe(3);
    expect(result.meta!.completionTokens).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// OpenRouterAdapter
// ---------------------------------------------------------------------------

describe('OpenRouterAdapter', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('defaults base URL to https://openrouter.ai/api/v1 and sends Bearer auth', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'Hi from OpenRouter' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('Say hi', 'Be brief.');

    expect(result.content).toBe('Hi from OpenRouter');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-test');
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    // Model string must pass through verbatim — the slash must NOT be URL-encoded.
    expect(body.model).toBe('anthropic/claude-3.5-sonnet');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Say hi' },
    ]);
  });

  it('uses a custom base URL when supplied', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
      'https://example.test/api/v1',
    );
    await adapter.generate('hi');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://example.test/api/v1/chat/completions');
  });

  it('sends HTTP-Referer and X-Title when provided via options', async () => {
    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
      'https://openrouter.ai/api/v1',
      { httpReferer: 'https://parliament.local', xTitle: 'Parliament' },
    );
    await adapter.generate('hi');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-test');
    expect(headers['HTTP-Referer']).toBe('https://parliament.local');
    expect(headers['X-Title']).toBe('Parliament');
  });

  it('throws ModelConnectionError when fetch rejects', async () => {
    globalThis.fetch = makeFetchError('network down');

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('network down');
  });

  it('throws ModelConnectionError when response is not ok', async () => {
    globalThis.fetch = makeFetchNotOk(401);

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    await expect(adapter.generate('hello')).rejects.toThrow(ModelConnectionError);
    await expect(adapter.generate('hello')).rejects.toThrow('401');
  });

  // -------------------------------------------------------------------------
  // PAR-30: meta telemetry — body-based cost, body-or-header generation id
  //
  // Replaces the original PAR-23 tests, which were written against assumed
  // `X-OR-Cost` / `X-OR-Generation-Id` headers that do not exist on the live
  // OpenRouter API. Real shape (verified 2026-05-02 via direct probe):
  //
  //   header  x-generation-id: gen-1777773347-Jz7XIWDdPEhCkYSHctwz
  //   body    {"id":"gen-...","usage":{"prompt_tokens":11,"completion_tokens":3,
  //                                    "cost":3.4e-7,
  //                                    "cost_details":{...}}}
  // -------------------------------------------------------------------------

  it('PAR-30: parses usage.cost (body) and id (body) into AdapterMeta', async () => {
    globalThis.fetch = makeFetchOk(
      {
        id: 'gen-1777773347-Jz7XIWDdPEhCkYSHctwz',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 8, completion_tokens: 16, cost: 3.4e-7 },
      },
      {
        'x-generation-id': 'gen-1777773347-Jz7XIWDdPEhCkYSHctwz',
      },
    );

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('hi');

    expect(result.meta!.provider).toBe('openrouter');
    expect(result.meta!.costUsd).toBe(3.4e-7);
    expect(result.meta!.generationId).toBe('gen-1777773347-Jz7XIWDdPEhCkYSHctwz');
    expect(result.meta!.promptTokens).toBe(8);
    expect(result.meta!.completionTokens).toBe(16);
  });

  it('PAR-30: leaves costUsd / generationId undefined when body lacks them', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('hi');

    expect(result.meta!.provider).toBe('openrouter');
    expect(result.meta!.costUsd).toBeUndefined();
    expect(result.meta!.generationId).toBeUndefined();
  });

  it('PAR-30: leaves costUsd undefined when usage.cost is non-numeric junk', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 'banana' },
    });

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('hi');

    expect(result.meta!.costUsd).toBeUndefined();
    expect(Number.isNaN(result.meta!.costUsd as unknown as number)).toBe(false);
  });

  it('PAR-30: parses usage.cost when it arrives as a numeric string', async () => {
    globalThis.fetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: '0.0042' },
    });

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('hi');

    expect(result.meta!.costUsd).toBe(0.0042);
  });

  it('PAR-30: falls back to x-generation-id header when body has no id', async () => {
    globalThis.fetch = makeFetchOk(
      {
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        // Note: no top-level `id` in body — header should fill in.
      },
      { 'x-generation-id': 'gen-from-header-only' },
    );

    const adapter = new OpenRouterAdapter(
      'anthropic/claude-3.5-sonnet',
      'sk-or-test',
    );
    const result = await adapter.generate('hi');

    expect(result.meta!.generationId).toBe('gen-from-header-only');
  });
});

// ---------------------------------------------------------------------------
// createAdapter (provider factory)
// ---------------------------------------------------------------------------

describe('createAdapter (openrouter)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns an OpenRouterAdapter when OPENROUTER_API_KEY is set', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-from-env');
    vi.stubEnv('OPENROUTER_BASE_URL', '');
    vi.stubEnv('OPENROUTER_HTTP_REFERER', '');
    vi.stubEnv('OPENROUTER_X_TITLE', '');

    const adapter = createAdapter('anthropic/claude-3.5-sonnet', 'openrouter');
    expect(adapter).toBeInstanceOf(OpenRouterAdapter);
    expect(adapter.modelName).toBe('anthropic/claude-3.5-sonnet');
  });

  it('points the OpenRouterAdapter at the default base URL when env override is unset', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-from-env');
    vi.stubEnv('OPENROUTER_BASE_URL', '');

    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = createAdapter('anthropic/claude-3.5-sonnet', 'openrouter');
    await adapter.generate('hi');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('honors OPENROUTER_BASE_URL when set', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-from-env');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://example.test/api/v1');

    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = createAdapter('anthropic/claude-3.5-sonnet', 'openrouter');
    await adapter.generate('hi');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://example.test/api/v1/chat/completions');
  });

  it('forwards OPENROUTER_HTTP_REFERER and OPENROUTER_X_TITLE as headers', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-from-env');
    vi.stubEnv('OPENROUTER_HTTP_REFERER', 'https://parliament.local');
    vi.stubEnv('OPENROUTER_X_TITLE', 'Parliament');

    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = createAdapter('anthropic/claude-3.5-sonnet', 'openrouter');
    await adapter.generate('hi');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-from-env');
    expect(headers['HTTP-Referer']).toBe('https://parliament.local');
    expect(headers['X-Title']).toBe('Parliament');
  });

  it('omits attribution headers when env vars are unset', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-from-env');
    vi.stubEnv('OPENROUTER_HTTP_REFERER', '');
    vi.stubEnv('OPENROUTER_X_TITLE', '');

    const mockFetch = makeFetchOk({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    globalThis.fetch = mockFetch;

    const adapter = createAdapter('anthropic/claude-3.5-sonnet', 'openrouter');
    await adapter.generate('hi');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();
  });

  it('throws a clear error naming OPENROUTER_API_KEY when the env var is unset', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');

    expect(() =>
      createAdapter('anthropic/claude-3.5-sonnet', 'openrouter'),
    ).toThrow(/OPENROUTER_API_KEY/);
  });
});
