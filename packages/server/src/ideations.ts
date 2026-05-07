/**
 * Ideate persistence + in-flight tracker.
 *
 * Why a separate module from `db.ts` / `inflight.ts`:
 *   - The deliberation persistence path is mature (turn-by-turn appends,
 *     SSE streaming, multiple migration columns). Ideate is simpler: one
 *     phase record at a time, no streaming in v1, single-row updates. A
 *     dedicated module keeps the deliberation hot path stable while
 *     ideate lands.
 *   - The `ideations` table is intentionally separate from `deliberations`
 *     per the spec ("ideate does not affect deliberation transcripts").
 *
 * Schema (SQLite):
 *   id           TEXT PRIMARY KEY
 *   created_at   TEXT NOT NULL              -- ISO 8601
 *   account_id   TEXT                       -- OSS pass-through coalesces
 *   idea         TEXT NOT NULL
 *   mode         TEXT NOT NULL              -- 'cooperative' | 'adversarial' | 'full'
 *   style        TEXT NOT NULL              -- 'individual' | 'collective'
 *   status       TEXT NOT NULL              -- 'running' | 'complete' | 'error'
 *   lineup_json  TEXT NOT NULL              -- ResolvedLineup serialized
 *   phases_json  TEXT NOT NULL              -- PhaseRecord[] serialized
 *   synthesis    TEXT                       -- final synth text or NULL
 *   error        TEXT                       -- error message or NULL
 */

import type Database from 'better-sqlite3';
import type {
  IdeateMode,
  IdeateStyle,
  IdeationRecord,
  IdeationStatus,
  PhaseRecord,
  ResolvedLineup,
} from '@parliament/core';

type Db = Database.Database;

export function ensureIdeationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ideations (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL,
      account_id  TEXT,
      idea        TEXT NOT NULL,
      mode        TEXT NOT NULL,
      style       TEXT NOT NULL,
      status      TEXT NOT NULL,
      lineup_json TEXT NOT NULL,
      phases_json TEXT NOT NULL,
      synthesis   TEXT,
      error       TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ideations_account_created
       ON ideations(account_id, created_at DESC, id DESC)`,
  );
}

interface IdeationRow {
  id: string;
  created_at: string;
  account_id: string | null;
  idea: string;
  mode: string;
  style: string;
  status: string;
  lineup_json: string;
  phases_json: string;
  synthesis: string | null;
  error: string | null;
}

function rowToRecord(row: IdeationRow): IdeationRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    idea: row.idea,
    mode: row.mode as IdeateMode,
    style: row.style as IdeateStyle,
    status: row.status as IdeationStatus,
    lineup: JSON.parse(row.lineup_json) as ResolvedLineup,
    phases: JSON.parse(row.phases_json) as PhaseRecord[],
    synthesis: row.synthesis,
    error: row.error,
  };
}

/**
 * Insert a placeholder row at run start with status='running' and an empty
 * phases array. The orchestrator updates the row in place via
 * `finalizeIdeation` once the run completes (success or error).
 */
export function createIdeationRow(
  db: Db,
  args: {
    id: string;
    accountId?: string | undefined;
    idea: string;
    mode: IdeateMode;
    style: IdeateStyle;
    lineup: ResolvedLineup;
  },
): void {
  const stmt = db.prepare(
    `INSERT INTO ideations (
       id, created_at, account_id, idea, mode, style, status,
       lineup_json, phases_json, synthesis, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  stmt.run(
    args.id,
    new Date().toISOString(),
    args.accountId ?? null,
    args.idea,
    args.mode,
    args.style,
    'running',
    JSON.stringify(args.lineup),
    JSON.stringify([]),
  );
}

/**
 * Persist the final outcome of an ideation run. Writes phases + synthesis +
 * error in a single UPDATE so a polling client never sees a half-updated row.
 */
export function finalizeIdeation(
  db: Db,
  id: string,
  outcome: {
    status: IdeationStatus;
    phases: readonly PhaseRecord[];
    synthesis: string | null;
    error: string | null;
  },
): void {
  const stmt = db.prepare(
    `UPDATE ideations
       SET status = ?, phases_json = ?, synthesis = ?, error = ?
     WHERE id = ?`,
  );
  stmt.run(
    outcome.status,
    JSON.stringify(outcome.phases),
    outcome.synthesis,
    outcome.error,
    id,
  );
}

/**
 * Fetch one ideation by id. Returns `null` when no row exists — the route
 * layer surfaces a 404 in that case.
 */
export function getIdeation(db: Db, id: string): IdeationRecord | null {
  const stmt = db.prepare<[string], IdeationRow>(
    `SELECT id, created_at, account_id, idea, mode, style, status,
            lineup_json, phases_json, synthesis, error
       FROM ideations WHERE id = ?`,
  );
  const row = stmt.get(id);
  if (row === undefined) return null;
  return rowToRecord(row);
}

// ---------------------------------------------------------------------------
// In-flight tracker — light-weight idempotency for "POST /ideate twice with
// the same idea-hash within a window returns the existing id." Mirrors the
// deliberation in-flight pattern but is intentionally a separate map so the
// two surfaces don't share key space.
// ---------------------------------------------------------------------------

interface InflightEntry {
  id: string;
  startedAt: number;
}

class IdeationInflightTracker {
  private byHash = new Map<string, InflightEntry>();
  private windowMs: number;

  constructor(windowMs = 30_000) {
    this.windowMs = windowMs;
  }

  /**
   * Return the in-flight ideation id for a given (account, idea, mode, style)
   * tuple if one is still within the dedup window, else `null`.
   */
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

  /** Drop the entry — called when the ideation reaches a terminal state. */
  release(key: string): void {
    this.byHash.delete(key);
  }

  /** Test seam — wipe state between runs. */
  reset(): void {
    this.byHash.clear();
  }
}

export const ideationInflight = new IdeationInflightTracker();

/**
 * Build a stable in-flight key from the request. The hash function is
 * deliberately simple (concat + lowercase) — collisions only matter
 * within the dedup window, and a single user is unlikely to issue two
 * different ideas that collide in 30 seconds.
 */
export function buildIdeationInflightKey(args: {
  accountId: string;
  idea: string;
  mode: IdeateMode;
  style: IdeateStyle;
}): string {
  return [args.accountId, args.mode, args.style, args.idea.trim().toLowerCase()].join('|');
}
