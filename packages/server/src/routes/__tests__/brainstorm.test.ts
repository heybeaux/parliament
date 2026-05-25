/**
 * Brainstorm route tests.
 *
 * Covers:
 *   - POST /brainstorm: validation (400 on bad body), 202 with { id, status }
 *   - POST /brainstorm/forge: same plus forge-specific `k` field
 *   - GET /brainstorm/:id: 200 on found, 404 on unknown
 *   - POST /brainstorm: in-flight dedup returns same id on concurrent request
 *   - Schema: old /brainstorm aliases (handleIdeate shape) are GONE — these
 *     routes return the new brainstorm shape, not ideation shape.
 *
 * `runBrainstorm` is mocked so tests don't spin real adapters. The persistence
 * layer (db) runs unmocked on an in-memory SQLite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { initDb } from '../../db.js';
import { brainstormInflight } from '../../brainstorms.js';
import type { RouterVariables } from '../../routes.js';

// ---- Mock runBrainstorm ----

interface BrainstormScript {
  result?: {
    status: 'complete' | 'error';
    phases: unknown[];
    rankings: unknown[];
    elaborations?: unknown[] | null;
    error: string | null;
  };
  error?: Error;
  hold?: () => Promise<void>;
}

const brainstormScripts: { current: BrainstormScript | null } = { current: null };

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();
  return {
    ...actual,
    runBrainstorm: vi.fn().mockImplementation(async () => {
      const script = brainstormScripts.current;
      if (script === null) throw new Error('brainstorm mock: no script set');
      if (script.hold !== undefined) await script.hold();
      if (script.error !== undefined) throw script.error;
      if (script.result === undefined) throw new Error('brainstorm mock: no result');
      return script.result;
    }),
    resolveBrainstormLineup: vi.fn().mockReturnValue({
      divergentAuthors: [{ role: 'divergent-author', model: 'mock/author' }],
      judges: [{ role: 'judge', model: 'mock/judge' }],
      cluster: { role: 'cluster', model: 'mock/cluster' },
      forgeElaborator: { role: 'forge-elaborator', model: 'mock/forge' },
    }),
    resolveRankWeights: vi.fn().mockReturnValue({
      novelty: 0.25,
      feasibility: 0.25,
      fit: 0.25,
      evidence: 0.25,
    }),
    createAdapter: vi.fn().mockReturnValue({
      modelName: 'mock-model',
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
    }),
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {},
    }),
  };
});

const { createRouter } = await import('../../routes.js');

function makeApp(): { app: Hono<RouterVariables>; db: ReturnType<typeof initDb> } {
  const db = initDb(':memory:');
  const app = createRouter(db);
  return { app, db };
}

function completeResult(over: Partial<BrainstormScript['result']> = {}): BrainstormScript['result'] {
  return {
    status: 'complete',
    phases: [{ phase: 'divergent-generation', ideas: [] }],
    rankings: [
      {
        idea_id: 'idea-1',
        score: 8,
        per_criterion: { novelty: 8, feasibility: 8, fit: 8, evidence: 8 },
        judges_attempted: ['mock/judge'],
        judges_skipped: [],
        judge_skipped: false,
      },
    ],
    elaborations: null,
    error: null,
    ...over,
  };
}

describe('POST /brainstorm', () => {
  beforeEach(() => {
    brainstormInflight.reset();
    brainstormScripts.current = null;
  });

  it('returns 400 on missing prompt', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Validation failed');
  });

  it('returns 400 on empty prompt string', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 202 with { id, status: running } on valid request', async () => {
    const { app } = makeApp();
    brainstormScripts.current = { result: completeResult() };
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'what should we build?' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string; status: string };
    expect(body.status).toBe('running');
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('returns same id on concurrent duplicate within inflight window', async () => {
    const { app } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    brainstormScripts.current = { hold: () => gate, result: completeResult() };

    const first = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'duplicate prompt' }),
    });
    const firstBody = await first.json() as { id: string; status: string };
    expect(first.status).toBe(202);

    // Second request with same prompt while the first is still held.
    const second = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'duplicate prompt' }),
    });
    const secondBody = await second.json() as { id: string; status: string };
    expect(second.status).toBe(202);
    expect(secondBody.id).toBe(firstBody.id);

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('accepts optional ideas_per_author and rank_weights fields', async () => {
    const { app } = makeApp();
    brainstormScripts.current = { result: completeResult() };
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'what should we build?',
        ideas_per_author: 3,
        rank_weights: { novelty: 2, feasibility: 1 },
      }),
    });
    expect(res.status).toBe(202);
  });

  it('rejects ideas_per_author outside [1, 20]', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', ideas_per_author: 99 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /brainstorm/forge', () => {
  beforeEach(() => {
    brainstormInflight.reset();
    brainstormScripts.current = null;
  });

  it('returns 202 with { id, status: running }', async () => {
    const { app } = makeApp();
    brainstormScripts.current = {
      result: completeResult({
        elaborations: [
          {
            idea_id: 'idea-1',
            elaboration: 'Here is the full project sketch...',
            model: 'mock/forge',
            timestamp: '2026-05-24T00:00:00.000Z',
          },
        ],
      }),
    };
    const res = await app.request('/brainstorm/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'forge this idea' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string; status: string };
    expect(body.status).toBe('running');
    expect(typeof body.id).toBe('string');
  });

  it('accepts optional k field in [1, 10]', async () => {
    const { app } = makeApp();
    brainstormScripts.current = { result: completeResult({ elaborations: [] }) };
    const res = await app.request('/brainstorm/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', k: 5 }),
    });
    expect(res.status).toBe(202);
  });

  it('rejects k outside [1, 10]', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', k: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing prompt', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: 3 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /brainstorm/:id', () => {
  beforeEach(() => {
    brainstormInflight.reset();
    brainstormScripts.current = null;
  });

  it('returns 404 for unknown id', async () => {
    const { app } = makeApp();
    const res = await app.request('/brainstorm/nonexistent-id');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 200 with the brainstorm record after creation', async () => {
    const { app, db } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    brainstormScripts.current = { hold: () => gate, result: completeResult() };

    // POST to create a brainstorm row.
    const postRes = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'get test prompt' }),
    });
    expect(postRes.status).toBe(202);
    const postBody = await postRes.json() as { id: string };
    const id = postBody.id;

    // GET while the background runner is still held — row is 'running'.
    await new Promise((r) => setImmediate(r));
    const getRes = await app.request(`/brainstorm/${id}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as {
      id: string;
      status: string;
      prompt: string;
      phases: unknown[];
      rankings: unknown[];
      elaborations: null;
    };
    expect(getBody.id).toBe(id);
    expect(getBody.status).toBe('running');
    expect(getBody.prompt).toBe('get test prompt');
    expect(Array.isArray(getBody.phases)).toBe(true);
    expect(Array.isArray(getBody.rankings)).toBe(true);
    // Plain brainstorm: elaborations is null.
    expect(getBody.elaborations).toBeNull();

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    void db;
  });
});

describe('/brainstorm route shape is distinct from /ideate', () => {
  it('POST /brainstorm does not return the ideation `mode`/`style`/`idea` fields', async () => {
    const { app } = makeApp();
    brainstormScripts.current = { result: completeResult() };

    const postRes = await app.request('/brainstorm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'shape check' }),
    });
    const postBody = await postRes.json() as { id: string };
    const id = postBody.id;

    const getRes = await app.request(`/brainstorm/${id}`);
    const record = await getRes.json() as Record<string, unknown>;
    // Brainstorm record has `prompt`, not `idea`.
    expect('prompt' in record).toBe(true);
    expect('idea' in record).toBe(false);
    // Brainstorm record has `rankings`, not `synthesis`.
    expect('rankings' in record).toBe(true);
    expect('synthesis' in record).toBe(false);
  });
});
