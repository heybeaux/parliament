/**
 * /ideate route integration tests.
 *
 * Pins the wire shape and lifecycle of the ideate endpoints:
 *   - POST /ideate validates body, mints a UUID, returns 202 + running.
 *   - `mode: 'full'` requires `confirm: true` — without it, 400.
 *   - GET /ideate/:id returns the persisted record (including a 404 on
 *     unknown ids and the final IdeationRecord shape after the background
 *     runner settles).
 *   - The in-flight tracker collapses concurrent dupes to the same id.
 *
 * `runIdeation` is mocked so we can drive deterministic outcomes without
 * spinning up real adapters; the rest of the route surface (db, lineup
 * resolution, validation, in-flight tracker) runs unmocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { PhaseRecord, RunIdeationResult } from '@parliament/core';
import { initDb } from '../db.js';
import { ideationInflight } from '../ideations.js';
import type { RouterVariables } from '../routes.js';

interface IdeateScript {
  result?: RunIdeationResult;
  error?: Error;
  hold?: () => Promise<void>;
}

const ideateScripts: { current: IdeateScript | null } = { current: null };

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();
  return {
    ...actual,
    runIdeation: vi.fn().mockImplementation(async () => {
      const script = ideateScripts.current;
      if (script === null) {
        throw new Error('ideate mock: no script set');
      }
      if (script.hold !== undefined) {
        await script.hold();
      }
      if (script.error !== undefined) {
        throw script.error;
      }
      if (script.result === undefined) {
        throw new Error('ideate mock: script has neither result nor error');
      }
      return script.result;
    }),
    createAdapter: vi.fn().mockReturnValue({
      modelName: 'mock-model',
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
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
  };
});

const { createRouter } = await import('../routes.js');

function makeApp(): { app: Hono<RouterVariables>; db: ReturnType<typeof initDb> } {
  const db = initDb(':memory:');
  const app = createRouter(db);
  return { app, db };
}

function phase(over: Partial<PhaseRecord> = {}): PhaseRecord {
  return {
    phase: 'cooperative-build',
    contributions: [
      {
        role: 'proposer',
        model: 'anthropic/claude-opus-4-6',
        content: 'cooperative draft',
        timestamp: '2026-05-07T00:00:00.000Z',
      },
    ],
    ...over,
  };
}

function ideateResult(over: Partial<RunIdeationResult> = {}): RunIdeationResult {
  return {
    status: 'complete',
    phases: [
      phase(),
      phase({
        phase: 'synth',
        contributions: [
          {
            role: 'synthesizer',
            model: 'anthropic/claude-opus-4-6',
            content: 'final synthesis',
            timestamp: '2026-05-07T00:00:30.000Z',
          },
        ],
        synthesis: 'final synthesis',
      }),
    ],
    synthesis: 'final synthesis',
    error: null,
    ...over,
  };
}

beforeEach(() => {
  ideateScripts.current = null;
  ideationInflight.reset();
});

// ---------------------------------------------------------------------------
// Validation + mint-on-submit
// ---------------------------------------------------------------------------

describe('POST /ideate — validation', () => {
  it('returns 400 on missing idea', async () => {
    const { app } = makeApp();
    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid mode value', async () => {
    const { app } = makeApp();
    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'x', mode: 'unknown' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on malformed JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /ideate — confirm gate for mode=full', () => {
  it('rejects mode=full without confirm:true with 400 confirm_required', async () => {
    const { app } = makeApp();
    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'eight model run', mode: 'full' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('confirm_required');
  });

  it('accepts mode=full when confirm:true is present', async () => {
    const { app } = makeApp();
    ideateScripts.current = { result: ideateResult() };

    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'big run', mode: 'full', confirm: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(typeof body.id).toBe('string');
    expect(body.status).toBe('running');
    await new Promise((r) => setImmediate(r));
  });
});

describe('POST /ideate — mint and 202', () => {
  it('returns 202 with {id, status: running} for cooperative default', async () => {
    const { app } = makeApp();
    ideateScripts.current = { result: ideateResult() };
    const res = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'a fresh idea' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.status).toBe('running');
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// GET /ideate/:id — round-trip
// ---------------------------------------------------------------------------

describe('GET /ideate/:id', () => {
  it('returns 404 when the id is unknown', async () => {
    const { app } = makeApp();
    const res = await app.request('/ideate/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('round-trips a complete ideation after the background runner finalises', async () => {
    const { app } = makeApp();
    ideateScripts.current = { result: ideateResult() };
    const post = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'round trip me' }),
    });
    const { id } = (await post.json()) as { id: string };

    // Wait for the fire-and-forget runner to write the final row. One
    // microtask flush is enough since the mock resolves synchronously.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const get = await app.request(`/ideate/${id}`);
    expect(get.status).toBe(200);
    const record = (await get.json()) as {
      id: string;
      idea: string;
      mode: string;
      style: string;
      status: string;
      synthesis: string | null;
      phases: PhaseRecord[];
    };
    expect(record.id).toBe(id);
    expect(record.idea).toBe('round trip me');
    expect(record.mode).toBe('cooperative');
    expect(record.style).toBe('collective');
    expect(record.status).toBe('complete');
    expect(record.synthesis).toBe('final synthesis');
    expect(Array.isArray(record.phases)).toBe(true);
    expect(record.phases.length).toBeGreaterThan(0);
  });

  it('persists the running placeholder before the runner finalises', async () => {
    const { app } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ideateScripts.current = { hold: () => gate, result: ideateResult() };

    const post = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'mid run' }),
    });
    const { id } = (await post.json()) as { id: string };

    await new Promise((r) => setImmediate(r));

    const mid = await app.request(`/ideate/${id}`);
    expect(mid.status).toBe(200);
    const midRecord = (await mid.json()) as { status: string; phases: unknown[] };
    expect(midRecord.status).toBe('running');
    expect(midRecord.phases).toEqual([]);

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('records error status when the runner returns status=error', async () => {
    const { app } = makeApp();
    ideateScripts.current = {
      result: {
        status: 'error',
        phases: [],
        synthesis: null,
        error: 'adapter blew up',
      },
    };
    const post = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'will fail' }),
    });
    const { id } = (await post.json()) as { id: string };

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const get = await app.request(`/ideate/${id}`);
    expect(get.status).toBe(200);
    const record = (await get.json()) as { status: string; error: string | null };
    expect(record.status).toBe('error');
    expect(record.error).toBe('adapter blew up');
  });
});

// ---------------------------------------------------------------------------
// In-flight dedup
// ---------------------------------------------------------------------------

describe('POST /ideate — in-flight dedup', () => {
  it('returns the existing id when a concurrent dupe lands within the window', async () => {
    const { app } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ideateScripts.current = { hold: () => gate, result: ideateResult() };

    const first = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'dedup target' }),
    });
    const { id: firstId } = (await first.json()) as { id: string };

    const second = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'dedup target' }),
    });
    expect(second.status).toBe(202);
    const { id: secondId } = (await second.json()) as { id: string };
    expect(secondId).toBe(firstId);

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('mints a fresh id once the previous run finalises and releases the inflight key', async () => {
    const { app } = makeApp();
    ideateScripts.current = { result: ideateResult() };
    const first = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'release test' }),
    });
    const { id: firstId } = (await first.json()) as { id: string };

    // Drain the runner so the inflight entry is released.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    ideateScripts.current = { result: ideateResult() };
    const second = await app.request('/ideate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'release test' }),
    });
    const { id: secondId } = (await second.json()) as { id: string };
    expect(secondId).not.toBe(firstId);
    await new Promise((r) => setImmediate(r));
  });
});
