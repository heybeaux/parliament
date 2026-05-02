import Database from 'better-sqlite3';
import type { DeliberationResult } from '@parliament/core';

export { Database };

/**
 * Initialises (or opens) the SQLite database and ensures the deliberations
 * table exists. Call once at startup.
 *
 * Schema is additive across releases:
 *   - PAR-16 adds a `context` column. Existing databases created before
 *     PAR-16 lack it; we run an idempotent `ALTER TABLE` when the column
 *     is missing so the migration is invisible to operators.
 *
 * @param path - Filesystem path for the database file. Defaults to
 *               "parliament.db" in the current working directory.
 */
export function initDb(path = 'parliament.db'): Database.Database {
  const db = new Database(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deliberations (
      id         TEXT PRIMARY KEY,
      topic      TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // PAR-16: additive `context` column. better-sqlite3 has no IF NOT EXISTS
  // for ADD COLUMN, so we inspect the schema and only ALTER when the
  // column is missing. The check + add are idempotent on every startup.
  type ColumnInfo = { name: string };
  const columns = db
    .prepare<[], ColumnInfo>(`PRAGMA table_info(deliberations)`)
    .all();
  const hasContext = columns.some((col) => col.name === 'context');
  if (!hasContext) {
    db.exec(`ALTER TABLE deliberations ADD COLUMN context TEXT`);
  }

  return db;
}

/**
 * Persists a completed deliberation result.
 *
 * The full `DeliberationResult` (including the optional PAR-16 `context`
 * field) is JSON-encoded into `result_json` so round-trips are exact. We
 * also write `context` into its own dedicated column so summary listings
 * and SQL-level queries can read it without parsing the JSON blob.
 */
export function saveDeliberation(
  db: Database.Database,
  id: string,
  topic: string,
  result: DeliberationResult,
): void {
  const stmt = db.prepare(
    `INSERT INTO deliberations (id, topic, result_json, created_at, context)
     VALUES (?, ?, ?, ?, ?)`,
  );

  stmt.run(
    id,
    topic,
    JSON.stringify(result),
    new Date().toISOString(),
    result.context ?? null,
  );
}

/**
 * Retrieves a deliberation result by id.
 * Returns null when no record exists with that id.
 *
 * The PAR-16 `context` field travels inside `result_json` so the JSON
 * round-trip is exact. We also fall back to the dedicated `context`
 * column when the parsed result lacks it (e.g. rows whose JSON predates
 * PAR-16 but were re-saved with the column populated).
 */
export function getDeliberation(
  db: Database.Database,
  id: string,
): DeliberationResult | null {
  const stmt = db.prepare<[string], { result_json: string; context: string | null }>(
    `SELECT result_json, context FROM deliberations WHERE id = ?`,
  );

  const row = stmt.get(id);
  if (row === undefined) return null;

  const parsed = JSON.parse(row.result_json) as DeliberationResult;
  if (parsed.context === undefined && row.context !== null && row.context !== '') {
    parsed.context = row.context;
  }
  return parsed;
}

export interface DeliberationSummary {
  id: string;
  topic: string;
  created_at: string;
  resolved: number;
  total_rounds: number;
  termination_reason: string;
}

/**
 * Lists all stored deliberations, newest first.
 * Returns lightweight summary rows for use in dashboard listings.
 */
export function listDeliberations(db: Database.Database): DeliberationSummary[] {
  const stmt = db.prepare<[], { id: string; topic: string; created_at: string; result_json: string }>(
    `SELECT id, topic, created_at, result_json
       FROM deliberations
   ORDER BY created_at DESC`,
  );

  return stmt.all().map((row) => {
    let resolved = 0;
    let total_rounds = 0;
    let termination_reason = 'unknown';
    try {
      const r = JSON.parse(row.result_json) as DeliberationResult;
      resolved = r.resolved ? 1 : 0;
      total_rounds = r.totalRounds;
      termination_reason = r.terminationReason;
    } catch {
      // ignore malformed rows
    }
    return {
      id: row.id,
      topic: row.topic,
      created_at: row.created_at,
      resolved,
      total_rounds,
      termination_reason,
    };
  });
}
