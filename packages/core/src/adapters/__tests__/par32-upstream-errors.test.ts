/**
 * PAR-32 / PRD D2 — adapter-level upstream error preservation.
 *
 * The four failure paths called out in the AC:
 *   1. Provider returns HTTP 4xx → UpstreamProviderError with full body + status,
 *      no retry (4xx is deterministic; retrying just doubles the latency).
 *   2. Provider returns HTTP 5xx → UpstreamProviderError with full body + status;
 *      `Retrying5xxAdapter` retries exactly once.
 *   3. Provider connection fails outright (DNS, ECONNREFUSED, AbortError) →
 *      ModelConnectionError, NOT UpstreamProviderError. The retry decorator
 *      MUST NOT retry these (no upstream response was observed).
 *   4. Mid-stream kill (server hung up after sending 200 OK) — for the v1 wire
 *      this surfaces as a `response.json()` parse failure inside the adapter
 *      and bubbles up as a generic error. The route layer treats anything that
 *      is not an UpstreamProviderError as a plain failure (`upstream` absent
 *      on the SSE status), which is the documented contract.
 *
 * Body truncation is also covered here because the persisted upstream body has
 * a 4 KiB cap and the marker is part of the wire contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModelConnectionError,
  UpstreamProviderError,
  truncateUpstreamBody,
} from '../base.js';
import { OllamaAdapter } from '../ollama.js';
import { OpenAICompatAdapter } from '../openai-compat.js';
import { Retrying5xxAdapter } from '../retry.js';

function makeFetchUpstream(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

describe('PAR-32: UpstreamProviderError preservation (OpenAICompatAdapter)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves provider, status, body, and request-id on 4xx', async () => {
    const errorBody = '{"error":{"message":"invalid api key","code":"401"}}';
    globalThis.fetch = makeFetchUpstream(401, errorBody, {
      'x-request-id': 'req_test_4xx_abc123',
    });
    const adapter = new OpenAICompatAdapter(
      'gpt-4o',
      'http://proxy:8080',
      'sk-bad',
    );

    let caught: unknown;
    try {
      await adapter.generate('hello');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamProviderError);
    // Inheritance: UpstreamProviderError extends ModelConnectionError so
    // PAR-25 failover continues to trigger on this error class.
    expect(caught).toBeInstanceOf(ModelConnectionError);
    const upstream = (caught as UpstreamProviderError).upstream;
    expect(upstream.provider).toBe('openai_compat');
    expect(upstream.status).toBe(401);
    expect(upstream.body).toBe(errorBody);
    expect(upstream.requestId).toBe('req_test_4xx_abc123');
  });

  it('preserves the body verbatim on 5xx', async () => {
    const errorBody = 'upstream gateway timed out';
    globalThis.fetch = makeFetchUpstream(503, errorBody);
    const adapter = new OpenAICompatAdapter(
      'gpt-4o',
      'http://proxy:8080',
    );

    let caught: unknown;
    try {
      await adapter.generate('hello');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamProviderError);
    const upstream = (caught as UpstreamProviderError).upstream;
    expect(upstream.status).toBe(503);
    expect(upstream.body).toBe(errorBody);
    expect(upstream.requestId).toBeUndefined();
  });

  it('falls back to x-generation-id when x-request-id is absent', async () => {
    globalThis.fetch = makeFetchUpstream(500, 'boom', {
      'x-generation-id': 'gen_xyz',
    });
    const adapter = new OpenAICompatAdapter(
      'gpt-4o',
      'http://proxy:8080',
    );
    try {
      await adapter.generate('hello');
      throw new Error('expected upstream error');
    } catch (err) {
      expect((err as UpstreamProviderError).upstream.requestId).toBe('gen_xyz');
    }
  });

  it('truncates the body at 4 KiB and stamps the marker', async () => {
    const huge = 'A'.repeat(8192);
    globalThis.fetch = makeFetchUpstream(500, huge);
    const adapter = new OpenAICompatAdapter(
      'gpt-4o',
      'http://proxy:8080',
    );
    try {
      await adapter.generate('hello');
      throw new Error('expected upstream error');
    } catch (err) {
      const body = (err as UpstreamProviderError).upstream.body;
      expect(body.length).toBeLessThan(huge.length);
      expect(body).toContain('… [truncated, 8192 total]');
      expect(body.startsWith('A'.repeat(4096))).toBe(true);
    }
  });
});

describe('PAR-32: UpstreamProviderError preservation (OllamaAdapter)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports provider="ollama" with no requestId', async () => {
    globalThis.fetch = makeFetchUpstream(500, 'model not loaded');
    const adapter = new OllamaAdapter('llama3');
    try {
      await adapter.generate('hello');
      throw new Error('expected upstream error');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamProviderError);
      const upstream = (err as UpstreamProviderError).upstream;
      expect(upstream.provider).toBe('ollama');
      expect(upstream.status).toBe(500);
      expect(upstream.body).toBe('model not loaded');
      expect(upstream.requestId).toBeUndefined();
    }
  });
});

describe('PAR-32: Retrying5xxAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries once on 5xx and resolves when the second attempt succeeds', async () => {
    const okResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: 'assistant', content: 'recovered' } }],
        }),
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: () => Promise.resolve('temporary'),
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const inner = new OpenAICompatAdapter('gpt-4o', 'http://proxy:8080');
    const adapter = new Retrying5xxAdapter(inner, 1);
    const result = await adapter.generate('hello');
    expect(result.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: () => Promise.resolve('unauthorized'),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const inner = new OpenAICompatAdapter('gpt-4o', 'http://proxy:8080');
    const adapter = new Retrying5xxAdapter(inner, 1);
    await expect(adapter.generate('hello')).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on bare connection errors (no upstream response)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const inner = new OpenAICompatAdapter('gpt-4o', 'http://proxy:8080');
    const adapter = new Retrying5xxAdapter(inner, 1);
    let caught: unknown;
    try {
      await adapter.generate('hello');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelConnectionError);
    expect(caught).not.toBeInstanceOf(UpstreamProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows when both attempts return 5xx', async () => {
    const fail = {
      ok: false,
      status: 502,
      headers: new Headers(),
      text: () => Promise.resolve('still bad'),
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const inner = new OpenAICompatAdapter('gpt-4o', 'http://proxy:8080');
    const adapter = new Retrying5xxAdapter(inner, 1);
    await expect(adapter.generate('hello')).rejects.toBeInstanceOf(
      UpstreamProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PAR-32: truncateUpstreamBody', () => {
  it('returns the body unchanged when under the cap', () => {
    expect(truncateUpstreamBody('short')).toBe('short');
  });

  it('truncates and annotates with the original length', () => {
    const result = truncateUpstreamBody('A'.repeat(5000), 4096);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('… [truncated, 5000 total]');
  });
});
