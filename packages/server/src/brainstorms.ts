/**
 * Brainstorm persistence + in-flight tracker. Sibling of `ideations.ts`.
 *
 * Why a dedicated module:
 *   - The spec mandates `brainstorms` is a separate table from `ideations`
 *     ("Brainstorm runs MUST NOT write to the ideations table.").
 *   - `GET /brainstorm/:id` MUST NOT fall back to `ideations`. Keeping the
 *     reader in this module makes that lock easy to enforce.
 *
 * Schema (SQLite):
 *   id              TEXT PRIMARY KEY
 *   created_at      TEXT NOT NULL              -- ISO 8601
 *   prompt          TEXT NOT NULL
 *   mode            TEXT NOT NULL              -- 'brainstorm' | 'brainstorm/forge'
 *   status          TEXT NOT NULL              -- 'running' | 'complete' | 'error'
 *   lineup_json     TEXT NOT NULL              -- BrainstormLineup
 *   phases_json     TEXT NOT NULL              -- BrainstormPhaseRecord[]
 *   rankings_json   TEXT NOT NULL              -- BrainstormRanking[]
 *   elaborations_json TEXT                     -- ForgeElaboration[] | NULL
 *   error           TEXT                       -- error message | NULL
 *
 * Spec: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

import type Database from 'better-sqlite3';
import type {
  BrainstormLineup,
  BrainstormMode,
  BrainstormPhaseRecord,
  BrainstormRanking,
  BrainstormStatus,
  ForgeElaboration,
} from '@parliament/core';

type Db = Database.Database;

export function ensureBrainstormsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brainstorms (
      id                TEXT PRIMARY KEY,
      created_at        TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      mode              TEXT NOT NULL,
      status            TEXT NOT NULL,
      lineup_json       TEXT NOT NULL,
      phases_json       TEXT NOT NULL,
      rankings_json     TEXT NOT NULL,
      elaborations_json TEXT,
      error             TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_brainstorms_created
       ON brainstorms(created_at DESC, id DESC)`,
  );
}

/**
 * Public-facing record shape. Mirrors the spec's GET /brainstorm/:id contract.
 * `elaborations` is `null` on plain brainstorm; an array (possibly with
 * per-entry `error` strings) when mode === 'brainstorm/forge'.
 */
export interface BrainstormRecord {
  id: string;
  created_at: string;
  prompt: string;
  mode: BrainstormMode;
  status: BrainstormStatus;
  lineup: BrainstormLineup;
  phases: readonly BrainstormPhaseRecord[];
  rankings: readonly BrainstormRanking[];
  elaborations: readonly ForgeElaboration[] | null;
  error: string | null;
}

interface BrainstormRow {
  id: string;
  created_at: string;
  prompt: string;
  mode: string;
  status: string;
  lineup_json: string;
  phases_json: string;
  rankings_json: string;
  elaborations_json: string | null;
  error: string | null;
}

function rowToRecord(row: BrainstormRow): BrainstormRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    prompt: row.prompt,
    mode: row.mode as BrainstormMode,
    status: row.status as BrainstormStatus,
    lineup: JSON.parse(row.lineup_json) as BrainstormLineup,
    phases: JSON.parse(row.phases_json) as BrainstormPhaseRecord[],
    rankings: JSON.parse(row.rankings_json) as BrainstormRanking[],
    elaborations:
      row.elaborations_json === null
        ? null
        : (JSON.parse(row.elaborations_json) as ForgeElaboration[]),
    error: row.error,
  };
}

/**
 * Insert a placeholder row at run start with status='running' and empty
 * phases/rankings arrays. The background runner updates it via
 * `updateBrainstormProgress` (as phases land) and `finalizeBrainstorm` (once
 * the run terminates).
 */
export function createBrainstormRow(
  db: Db,
  args: {
    id: string;
    prompt: string;
    mode: BrainstormMode;
    lineup: BrainstormLineup;
  },
): void {
  const stmt = db.prepare(
    `INSERT INTO brainstorms (
       id, created_at, prompt, mode, status,
       lineup_json, phases_json, rankings_json, elaborations_json, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  stmt.run(
    args.id,
    new Date().toISOString(),
    args.prompt,
    args.mode,
    'running',
    JSON.stringify(args.lineup),
    JSON.stringify([]),
    JSON.stringify([]),
  );
}

/**
 * Progressive phase write — called once per phase as the orchestrator
 * completes them. Status remains 'running' until the final
 * `finalizeBrainstorm` call lands.
 */
export function updateBrainstormProgress(
  db: Db,
  id: string,
  phases: readonly BrainstormPhaseRecord[],
): void {
  const stmt = db.prepare(
    `UPDATE brainstorms SET phases_json = ? WHERE id = ?`,
  );
  stmt.run(JSON.stringify(phases), id);
}

/**
 * Single-shot terminal write — fired once the orchestrator resolves (success
 * or error). Writes phases + rankings + elaborations + status + error in one
 * UPDATE so polling clients never observe a half-finalised row.
 */
export function finalizeBrainstorm(
  db: Db,
  id: string,
  outcome: {
    status: BrainstormStatus;
    phases: readonly BrainstormPhaseRecord[];
    rankings: readonly BrainstormRanking[];
    elaborations: readonly ForgeElaboration[] | null;
    error: string | null;
  },
): void {
  const stmt = db.prepare(
    `UPDATE brainstorms
       SET status = ?, phases_json = ?, rankings_json = ?,
           elaborations_json = ?, error = ?
     WHERE id = ?`,
  );
  stmt.run(
    outcome.status,
    JSON.stringify(outcome.phases),
    JSON.stringify(outcome.rankings),
    outcome.elaborations === null ? null : JSON.stringify(outcome.elaborations),
    outcome.error,
    id,
  );
}

/**
 * Fetch one brainstorm by id. Returns `null` when no row exists. MUST NOT
 * fall back to the `ideations` table (spec lock).
 */
export function getBrainstorm(db: Db, id: string): BrainstormRecord | null {
  const stmt = db.prepare<[string], BrainstormRow>(
    `SELECT id, created_at, prompt, mode, status,
            lineup_json, phases_json, rankings_json,
            elaborations_json, error
       FROM brainstorms WHERE id = ?`,
  );
  const row = stmt.get(id);
  if (row === undefined) return null;
  return rowToRecord(row);
}

// ---------------------------------------------------------------------------
// In-flight tracker — collapse concurrent dupes within a window. Mirrors
// `ideationInflight` but uses a separate key namespace so brainstorm and
// ideate dedupes never collide.
// ---------------------------------------------------------------------------

interface InflightEntry {
  id: string;
  startedAt: number;
}

class BrainstormInflightTracker {
  private byHash = new Map<string, InflightEntry>();
  private windowMs: number;

  constructor(windowMs = 30_000) {
    this.windowMs = windowMs;
  }

  lookup(key: string): string | null {
    const entry = this.byHash.get(key);
    if (entry === undefined) return null;
    if (Date.now() - entry.startedAt > this.windowMs) {
      this.byHash.delete(key);
      return null;
    }
    return entry.id;
  }

  register(key: string, id: string): void {
    this.byHash.set(key, { id, startedAt: Date.now() });
  }

  release(key: string): void {
    this.byHash.delete(key);
  }

  reset(): void {
    this.byHash.clear();
  }
}

export const brainstormInflight = new BrainstormInflightTracker();

export function buildBrainstormInflightKey(args: {
  accountId: string;
  prompt: string;
  mode: BrainstormMode;
}): string {
  return [args.accountId, args.mode, args.prompt.trim().toLowerCase()].join('|');
}
