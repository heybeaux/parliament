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
