/**
 * PAR-32 / PRD D2 — route-level upstream error forwarding.
 *
 * Pins the wire-shape contract:
 *   1. When the background runner throws an `UpstreamProviderError`,
 *      `GET /deliberate/:id` returns the structured upstream context on the
 *      persisted row.
 *   2. The terminal SSE `status` event carries the same upstream context so
 *      streaming consumers see the upstream failure without reaching back to
 *      the REST endpoint.
 *   3. Non-upstream failures (bare `Error`, `ModelConnectionError` from a
 *      DNS/connection failure) flip `status: failed` with `error` set but
 *      WITHOUT an `upstream` key — the field is reserved for HTTP-level
 *      provider failures.
 *
 * The engine mock pattern follows par18-inflight.test.ts — only
 * `@parliament/core` is mocked so we exercise the real db + real broker +
 * real router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliberationResult, Turn, SystemEvent } from '@parliament/core';
import {
  ModelConnectionError,
  UpstreamProviderError,
} from '@parliament/core';
import { Hono } from 'hono';
import { initDb } from '../db.js';
import { inflightBroker } from '../inflight.js';
import type { RouterVariables } from '../routes.js';

interface ScriptedRun {
  turns?: Turn[];
  events?: SystemEvent[];
  result?: DeliberationResult;
  error?: Error;
  hold?: () => Promise<void>;
}

const scripts: { current: ScriptedRun | null } = { current: null };

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  const MockEngine = vi.fn().mockImplementation(() => ({
    runTopology: vi.fn().mockImplementation(
      async (
        _topic: string,
        config: {
          onTurn?: (turn: Turn) => void;
          onEvent?: (event: SystemEvent) => void;
        },
      ) => {
        const script = scripts.current;
        if (script === null) {
          throw new Error('engine mock: no script set');
        }
        for (const turn of script.turns ?? []) {
          config.onTurn?.(turn);
        }
        for (const event of script.events ?? []) {
          config.onEvent?.(event);
        }
        if (script.hold !== undefined) {
          await script.hold();
        }
        if (script.error !== undefined) {
          throw script.error;
        }
        if (script.result === undefined) {
          throw new Error('engine mock: script has neither result nor error');
        }
        return script.result;
      },
    ),
    run: vi.fn().mockResolvedValue(null),
  }));

  return {
    ...actual,
    DeliberationEngine: MockEngine,
    loadTopologyConfig: vi.fn().mockReturnValue({
      activePreset: actual.BUILTIN_PRESETS['debate']!,
      presets: { ...actual.BUILTIN_PRESETS },
      userNeurotypes: {},
    }),
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'mock', system_prompt: '' },
        skeptic: { model: 'mock', system_prompt: '' },
        synthesizer: { model: 'mock', system_prompt: '' },
        redAgent: { model: 'mock', system_prompt: '' },
        sentry: { model: 'mock', system_prompt: '' },
      },
    }),
    createAdapter: vi.fn().mockReturnValue({
      modelName: 'mock-model',
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
    }),
  };
});

const { createRouter } = await import('../routes.js');

function makeApp(): { app: Hono<RouterVariables>; db: ReturnType<typeof initDb> } {
  const db = initDb(':memory:');
  const app = createRouter(db);
  return { app, db };
}

beforeEach(() => {
  scripts.current = null;
  inflightBroker.reset();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('PAR-32 — upstream context surfaced on failed deliberation', () => {
  it('GET /deliberate/:id includes upstream provider+status+body+requestId on a 4xx failure', async () => {
    const { app } = makeApp();
    scripts.current = {
      error: new UpstreamProviderError(
        'openai_compat request failed with status 401',
        {
          provider: 'openai_compat',
          status: 401,
          body: '{"error":"invalid_api_key"}',
          requestId: 'req_4xx_abc',
        },
      ),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'upstream 4xx' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;
    await flush();

    const get = await app.request(`/deliberate/${id}`);
    const body = (await get.json()) as {
      status: string;
      error?: string;
      upstream?: {
        provider: string;
        status: number;
        body: string;
        requestId?: string;
      };
    };
    expect(body.status).toBe('failed');
    expect(body.error).toContain('401');
    expect(body.upstream).toBeDefined();
    expect(body.upstream!.provider).toBe('openai_compat');
    expect(body.upstream!.status).toBe(401);
    expect(body.upstream!.body).toBe('{"error":"invalid_api_key"}');
    expect(body.upstream!.requestId).toBe('req_4xx_abc');
  });

  it('GET /deliberate/:id includes upstream context on a 5xx failure', async () => {
    const { app } = makeApp();
    scripts.current = {
      error: new UpstreamProviderError(
        'openai_compat request failed with status 503',
        {
          provider: 'openai_compat',
          status: 503,
          body: 'gateway timeout',
        },
      ),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'upstream 5xx' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;
    await flush();

    const get = await app.request(`/deliberate/${id}`);
    const body = (await get.json()) as {
      status: string;
      upstream?: { status: number; body: string; requestId?: string };
    };
    expect(body.status).toBe('failed');
    expect(body.upstream).toBeDefined();
    expect(body.upstream!.status).toBe(503);
    expect(body.upstream!.body).toBe('gateway timeout');
    expect(body.upstream!.requestId).toBeUndefined();
  });

  it('does NOT add an upstream key when the error is a bare connection failure', async () => {
    const { app } = makeApp();
    scripts.current = {
      error: new ModelConnectionError('ECONNREFUSED'),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'connection drop' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;
    await flush();

    const get = await app.request(`/deliberate/${id}`);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body['status']).toBe('failed');
    expect(body['error']).toBe('ECONNREFUSED');
    expect(body['upstream']).toBeUndefined();
  });

  it('does NOT add an upstream key when the error is a generic Error (mid-stream kill)', async () => {
    const { app } = makeApp();
    // PRD D2 covers a "killed mid-stream" scenario. Once the body has been
    // partially consumed, the json/text decode throws a plain TypeError or
    // SyntaxError; the route's catch block treats anything that isn't an
    // UpstreamProviderError as a status-only failure with no upstream key.
    scripts.current = {
      error: new TypeError('Unexpected end of JSON input'),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'mid-stream kill' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;
    await flush();

    const get = await app.request(`/deliberate/${id}`);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body['status']).toBe('failed');
    expect(body['error']).toBe('Unexpected end of JSON input');
    expect(body['upstream']).toBeUndefined();
  });
});

describe('PAR-32 — SSE stream forwards upstream context on terminal failure', () => {
  it('terminal SSE status event carries upstream provider context', async () => {
    const { app } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scripts.current = {
      hold: () => gate,
      error: new UpstreamProviderError(
        'openrouter request failed with status 502',
        {
          provider: 'openrouter',
          status: 502,
          body: 'Bad Gateway',
          requestId: 'req_sse_502',
        },
      ),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'sse upstream' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;

    // Subscribe BEFORE we release the engine so we observe the live broker
    // push (rather than the post-completion replay path).
    const streamPromise = app.request(`/deliberate/${id}/stream`);

    // Give the SSE handler a moment to subscribe, then let the engine
    // throw so the broker emits the terminal status.
    await new Promise((r) => setImmediate(r));
    release();

    const streamRes = await streamPromise;
    const text = await streamRes.text();

    // Format: each event block has `event: status\ndata: {…}\n\n`.
    const statusBlock = text
      .split('\n\n')
      .find((block) => block.includes('event: status'));
    expect(statusBlock).toBeDefined();
    const dataLine = statusBlock!
      .split('\n')
      .find((line) => line.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice('data: '.length)) as {
      status: string;
      error?: string;
      upstream?: {
        provider: string;
        status: number;
        body: string;
        requestId?: string;
      };
    };

    expect(payload.status).toBe('failed');
    expect(payload.error).toContain('502');
    expect(payload.upstream).toBeDefined();
    expect(payload.upstream!.provider).toBe('openrouter');
    expect(payload.upstream!.status).toBe(502);
    expect(payload.upstream!.body).toBe('Bad Gateway');
    expect(payload.upstream!.requestId).toBe('req_sse_502');
  });
});
