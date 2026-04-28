import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelConnectionError } from '../base.js';
import { OllamaAdapter } from '../ollama.js';
import { OpenAICompatAdapter } from '../openai-compat.js';
import { LMStudioAdapter } from '../lm-studio.js';
import { OMLXAdapter } from '../omlx.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchOk(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
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

    expect(result).toBe('Hello from Ollama');

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

    expect(result).toBe('Hi from OpenAI compat');

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

    expect(result).toBe('Hi from LM Studio');

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

    expect(result).toBe('Hi from oMLX');

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
});
