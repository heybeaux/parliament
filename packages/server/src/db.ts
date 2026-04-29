import Database from 'better-sqlite3';
import type { DeliberationResult } from '@parliament/core';

export { Database };

/**
 * Initialises (or opens) the SQLite database and ensures the deliberations
 * table exists.  Call once at startup.
 *
 * @param path - Filesystem path for the database file.  Defaults to
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

  return db;
}

/**
 * Persists a completed deliberation result.
 */
export function saveDeliberation(
  db: Database.Database,
  id: string,
  topic: string,
  result: DeliberationResult,
): void {
  const stmt = db.prepare(
    `INSERT INTO deliberations (id, topic, result_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  stmt.run(id, topic, JSON.stringify(result), new Date().toISOString());
}

/**
 * Retrieves a deliberation result by id.
 * Returns null when no record exists with that id.
 */
export function getDeliberation(
  db: Database.Database,
  id: string,
): DeliberationResult | null {
  const stmt = db.prepare<[string], { result_json: string }>(
    `SELECT result_json FROM deliberations WHERE id = ?`,
  );

  const row = stmt.get(id);
  if (row === undefined) return null;

  return JSON.parse(row.result_json) as DeliberationResult;
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
