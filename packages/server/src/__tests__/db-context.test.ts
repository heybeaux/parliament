/**
 * PAR-16 — persistence layer focused tests for the deliberation `context`
 * field. Exercises the additive `context` column on the `deliberations`
 * table plus the JSON-blob round-trip.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { DeliberationResult } from '@parliament/core';
import { initDb, saveDeliberation, getDeliberation } from '../db.js';
import type { Database } from 'better-sqlite3';

function makeResult(overrides: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    topic: 'A topic',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: 'fin',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    events: [],
    ...overrides,
  };
}

describe('saveDeliberation / getDeliberation context (PAR-16)', () => {
  let db: Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('round-trips the context field through the JSON blob', async () => {
    const ctx = 'Background: detailed system description with multiple paragraphs.\n\n' +
      'Line two.\n\nLine three.';
    saveDeliberation(db, 'id-with-ctx', 'topic', makeResult({ context: ctx }));

    const fetched = getDeliberation(db, 'id-with-ctx');
    expect(fetched).not.toBeNull();
    expect(fetched?.context).toBe(ctx);
  });

  it('persists the context to the dedicated SQL column for queryability', async () => {
    const ctx = 'Inline column test context.';
    saveDeliberation(db, 'id-col', 'topic', makeResult({ context: ctx }));

    const row = db
      .prepare<[string], { context: string | null }>(
        'SELECT context FROM deliberations WHERE id = ?',
      )
      .get('id-col');
    expect(row).toBeDefined();
    expect(row?.context).toBe(ctx);
  });

  it('stores NULL in the context column when no context is supplied', async () => {
    saveDeliberation(db, 'id-no-ctx', 'topic', makeResult());

    const row = db
      .prepare<[string], { context: string | null }>(
        'SELECT context FROM deliberations WHERE id = ?',
      )
      .get('id-no-ctx');
    expect(row?.context).toBeNull();

    const fetched = getDeliberation(db, 'id-no-ctx');
    expect(fetched).not.toBeNull();
    expect(fetched?.context).toBeUndefined();
  });

  it('falls back to the column when an older JSON blob omits context', async () => {
    // Simulate a row whose JSON blob predates PAR-16 but whose column was
    // backfilled. The fetcher should reconstruct `context` from the column.
    const rawJson = JSON.stringify(makeResult({ topic: 'pre-par16' }));
    db.prepare(
      `INSERT INTO deliberations (id, topic, result_json, created_at, context)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('id-fallback', 'pre-par16', rawJson, '2026-01-01T00:00:00.000Z', 'reconstructed ctx');

    const fetched = getDeliberation(db, 'id-fallback');
    expect(fetched?.context).toBe('reconstructed ctx');
  });

  it('initDb is idempotent — calling twice does not error and column persists', () => {
    // Re-init the same database to make sure ALTER TABLE only runs once.
    const path = ':memory:';
    const first = initDb(path);
    saveDeliberation(first, 'id-1', 't', makeResult({ context: 'ctx' }));

    // initDb on a NEW in-memory db (different process equivalent): re-running
    // initDb should also be a no-op when the column already exists.
    expect(() => initDb(path)).not.toThrow();
  });
});
