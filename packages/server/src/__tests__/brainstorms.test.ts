/**
 * Brainstorm persistence tests.
 *
 * Covers: table creation (ensureBrainstormsTable idempotency), write + read
 * round-trip, status transitions (running → complete, running → error),
 * progressive phase write (updateBrainstormProgress), elaborations round-trip,
 * 404 on unknown id, and the in-flight tracker.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import {
  createBrainstormRow,
  finalizeBrainstorm,
  updateBrainstormProgress,
  getBrainstorm,
  brainstormInflight,
  buildBrainstormInflightKey,
} from '../brainstorms.js';
import type { BrainstormRecord } from '../brainstorms.js';

type Db = ReturnType<typeof initDb>;

function freshDb(): Db {
  return initDb(':memory:');
}

// Minimal lineup fixture.
const LINEUP = {
  divergentAuthors: [{ role: 'divergent-author' as const, model: 'test/author-1' }],
  judges: [{ role: 'judge' as const, model: 'test/judge-1' }],
  cluster: { role: 'cluster' as const, model: 'test/cluster' },
  forgeElaborator: { role: 'forge-elaborator' as const, model: 'test/forge' },
};

const PHASE_RECORD = {
  phase: 'divergent-generation' as const,
  ideas: [
    {
      idea_id: 'abc123',
      title: 'Test idea',
      one_liner: 'A short description',
      dimensions: ['tech'],
      rationale: 'Because',
      author_model: 'test/author-1',
    },
  ],
};

const RANKING = {
  idea_id: 'abc123',
  score: 8.5,
  per_criterion: { novelty: 9, feasibility: 8, fit: 8.5, evidence: 8 },
  judges_attempted: ['test/judge-1'],
  judges_skipped: [] as string[],
  judge_skipped: false,
};

describe('ensureBrainstormsTable', () => {
  it('is idempotent — calling initDb twice does not throw', () => {
    // initDb calls ensureBrainstormsTable internally
    const db = freshDb();
    // Calling again on an existing DB should not throw.
    expect(() => initDb(':memory:')).not.toThrow();
    db.close();
  });
});

describe('createBrainstormRow', () => {
  it('inserts a row with status=running and empty phases/rankings', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'test-id-1',
      prompt: 'what should we build?',
      mode: 'brainstorm',
      lineup: LINEUP,
    });
    const record = getBrainstorm(db, 'test-id-1');
    expect(record).not.toBeNull();
    expect(record!.id).toBe('test-id-1');
    expect(record!.prompt).toBe('what should we build?');
    expect(record!.mode).toBe('brainstorm');
    expect(record!.status).toBe('running');
    expect(record!.phases).toEqual([]);
    expect(record!.rankings).toEqual([]);
    expect(record!.elaborations).toBeNull();
    expect(record!.error).toBeNull();
    expect(record!.lineup).toEqual(LINEUP);
  });

  it('records brainstorm/forge mode correctly', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'forge-id-1',
      prompt: 'build something great',
      mode: 'brainstorm/forge',
      lineup: LINEUP,
    });
    const record = getBrainstorm(db, 'forge-id-1');
    expect(record!.mode).toBe('brainstorm/forge');
  });
});

describe('getBrainstorm', () => {
  it('returns null for unknown id', () => {
    const db = freshDb();
    expect(getBrainstorm(db, 'nonexistent')).toBeNull();
  });

  it('round-trips a complete record with all fields', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'rt-1',
      prompt: 'round-trip prompt',
      mode: 'brainstorm',
      lineup: LINEUP,
    });
    finalizeBrainstorm(db, 'rt-1', {
      status: 'complete',
      phases: [PHASE_RECORD],
      rankings: [RANKING],
      elaborations: null,
      error: null,
    });
    const record = getBrainstorm(db, 'rt-1') as BrainstormRecord;
    expect(record.status).toBe('complete');
    expect(record.phases).toHaveLength(1);
    expect(record.phases[0]!.phase).toBe('divergent-generation');
    expect(record.rankings).toHaveLength(1);
    expect(record.rankings[0]!.idea_id).toBe('abc123');
    expect(record.rankings[0]!.score).toBe(8.5);
    expect(record.elaborations).toBeNull();
    expect(record.error).toBeNull();
  });
});

describe('finalizeBrainstorm', () => {
  it('transitions running → complete', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'fin-1',
      prompt: 'p',
      mode: 'brainstorm',
      lineup: LINEUP,
    });
    expect(getBrainstorm(db, 'fin-1')!.status).toBe('running');

    finalizeBrainstorm(db, 'fin-1', {
      status: 'complete',
      phases: [PHASE_RECORD],
      rankings: [RANKING],
      elaborations: null,
      error: null,
    });
    expect(getBrainstorm(db, 'fin-1')!.status).toBe('complete');
  });

  it('transitions running → error with error message', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'fin-err-1',
      prompt: 'p',
      mode: 'brainstorm',
      lineup: LINEUP,
    });
    finalizeBrainstorm(db, 'fin-err-1', {
      status: 'error',
      phases: [],
      rankings: [],
      elaborations: null,
      error: 'something went wrong',
    });
    const record = getBrainstorm(db, 'fin-err-1')!;
    expect(record.status).toBe('error');
    expect(record.error).toBe('something went wrong');
  });

  it('persists elaborations for brainstorm/forge mode', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'forge-fin-1',
      prompt: 'forge run',
      mode: 'brainstorm/forge',
      lineup: LINEUP,
    });
    const elaborations = [
      {
        idea_id: 'abc123',
        elaboration: 'A full project sketch...',
        model: 'test/forge',
        timestamp: '2026-05-24T00:00:00.000Z',
      },
    ];
    finalizeBrainstorm(db, 'forge-fin-1', {
      status: 'complete',
      phases: [PHASE_RECORD],
      rankings: [RANKING],
      elaborations,
      error: null,
    });
    const record = getBrainstorm(db, 'forge-fin-1')!;
    expect(record.elaborations).not.toBeNull();
    expect(record.elaborations).toHaveLength(1);
    expect(record.elaborations![0]!.idea_id).toBe('abc123');
    expect(record.elaborations![0]!.elaboration).toBe('A full project sketch...');
  });
});

describe('updateBrainstormProgress', () => {
  it('persists phases mid-run while status stays running', () => {
    const db = freshDb();
    createBrainstormRow(db, {
      id: 'prog-1',
      prompt: 'progressive run',
      mode: 'brainstorm',
      lineup: LINEUP,
    });
    // Before update — empty phases.
    expect(getBrainstorm(db, 'prog-1')!.phases).toHaveLength(0);

    updateBrainstormProgress(db, 'prog-1', [PHASE_RECORD]);

    const mid = getBrainstorm(db, 'prog-1')!;
    expect(mid.phases).toHaveLength(1);
    expect(mid.status).toBe('running');
  });
});

describe('brainstormInflight tracker', () => {
  beforeEach(() => {
    brainstormInflight.reset();
  });

  it('returns null for unknown key', () => {
    expect(brainstormInflight.lookup('nonexistent')).toBeNull();
  });

  it('returns the registered id within the window', () => {
    const key = buildBrainstormInflightKey({
      accountId: 'acc-1',
      prompt: 'test prompt',
      mode: 'brainstorm',
    });
    brainstormInflight.register(key, 'existing-id');
    expect(brainstormInflight.lookup(key)).toBe('existing-id');
  });

  it('returns null after release', () => {
    const key = buildBrainstormInflightKey({
      accountId: 'acc-1',
      prompt: 'another prompt',
      mode: 'brainstorm',
    });
    brainstormInflight.register(key, 'some-id');
    brainstormInflight.release(key);
    expect(brainstormInflight.lookup(key)).toBeNull();
  });

  it('builds distinct keys for different modes', () => {
    const base = { accountId: 'acc', prompt: 'same prompt' };
    const k1 = buildBrainstormInflightKey({ ...base, mode: 'brainstorm' });
    const k2 = buildBrainstormInflightKey({ ...base, mode: 'brainstorm/forge' });
    expect(k1).not.toBe(k2);
  });
});
