import Database from 'better-sqlite3';
import type {
  DeliberationResult,
  DeliberationSource,
  DeliberationStatus,
  SystemEvent,
  Turn,
} from '@parliament/core';

export { Database };

/**
 * Initialises (or opens) the SQLite database and ensures the deliberations
 * table exists. Call once at startup.
 *
 * Schema is additive across releases:
 *   - PAR-16 adds a `context` column. Existing databases created before
 *     PAR-16 lack it; we run an idempotent `ALTER TABLE` when the column
 *     is missing so the migration is invisible to operators.
 *   - PAR-18 adds `status` (`in_flight` / `completed` / `failed`) and
 *     `error` columns. Existing rows lack them; the SELECT path falls back
 *     to inferring `completed` for any pre-PAR-18 row that has a populated
 *     `result_json` so historical reads continue to render unchanged.
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

  // better-sqlite3 has no IF NOT EXISTS for ADD COLUMN, so we inspect the
  // schema and only ALTER when each column is missing. The check + add is
  // idempotent on every startup.
  type ColumnInfo = { name: string };
  const columns = db
    .prepare<[], ColumnInfo>(`PRAGMA table_info(deliberations)`)
    .all();
  const colNames = new Set(columns.map((c) => c.name));

  // PAR-16: free-form prose context column (mirrors the field inside
  // result_json so SQL-level queries don't have to parse JSON).
  if (!colNames.has('context')) {
    db.exec(`ALTER TABLE deliberations ADD COLUMN context TEXT`);
  }

  // PAR-18: lifecycle status + error column. Stored deliberations recorded
  // before PAR-18 have NULL here; the SELECT path treats NULL as the
  // `completed` legacy default.
  if (!colNames.has('status')) {
    db.exec(`ALTER TABLE deliberations ADD COLUMN status TEXT`);
  }
  if (!colNames.has('error')) {
    db.exec(`ALTER TABLE deliberations ADD COLUMN error TEXT`);
  }

  return db;
}

// ---------------------------------------------------------------------------
// PAR-18 — In-flight row writes
//
// `POST /deliberate` mints an id and inserts a placeholder row with
// `status: 'in_flight'` BEFORE the engine runs. The route then kicks
// `runTopology()` in the background, which calls `appendTurn` /
// `appendEvent` as turns/events land, and finally `markCompleted` (or
// `markFailed`). Each write is a self-contained UPDATE — there is no
// long-lived transaction across the deliberation, so a server crash
// mid-run leaves the row visible at whatever turn count it reached.
// ---------------------------------------------------------------------------

/**
 * Snapshot of a placeholder deliberation row at insert time. Persisted so
 * `getDeliberation` can return a coherent `DeliberationResult`-shaped
 * partial response while the row's `status` is `in_flight` — the result
 * blob is updated as turns and events land. Mirrors the additive shape of
 * `DeliberationResult` so the SELECT path does not have to special-case
 * placeholders.
 */
function buildPlaceholderResultJson(args: {
  topic: string;
  context?: string | undefined;
  /**
   * PAR-17 — structured sources echoed onto the placeholder so a client
   * polling mid-run sees the same `sources` array the completed run will
   * eventually carry. Empty / undefined → omitted entirely so old client
   * builds and the GET-list endpoint continue to parse rows without sources.
   */
  sources?: readonly DeliberationSource[] | undefined;
  startedAt: string;
}): string {
  const hasSources = args.sources !== undefined && args.sources.length > 0;
  const placeholder: DeliberationResult = {
    topic: args.topic,
    ...(args.context !== undefined && args.context !== '' ? { context: args.context } : {}),
    ...(hasSources ? { sources: [...args.sources!] } : {}),
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: false,
    synthesis: null,
    split: null,
    terminationReason: 'max_rounds',
    totalRounds: 0,
    started_at: args.startedAt,
    completed_at: '',
    events: [],
    status: 'in_flight',
  };
  return JSON.stringify(placeholder);
}

/**
 * Insert a placeholder row for a deliberation that has just been kicked off
 * in the background. The row carries `status: 'in_flight'` and an empty
 * turns/events array; subsequent `appendTurn` / `appendEvent` /
 * `markCompleted` / `markFailed` calls update it in place.
 */
export function createDeliberationRow(
  db: Database.Database,
  args: {
    id: string;
    topic: string;
    context?: string | undefined;
    /**
     * PAR-20 — preset id stamp. Optional because an in-flight row mints
     * before `runTopology()` has had a chance to populate it on the result;
     * we accept it eagerly so `GET /deliberate/:id` and the deliberation
     * list show the correct preset badge during the live run.
     */
    preset?: string | undefined;
    /**
     * PAR-17 — caller-supplied sources echoed onto the placeholder row so a
     * client polling mid-run sees the same `sources` array the completed
     * run will carry. Persisted only inside `result_json` (no dedicated
     * column) per the ticket: round-trip is sufficient, query-by-source is
     * out of scope.
     */
    sources?: readonly DeliberationSource[] | undefined;
  },
): void {
  const startedAt = new Date().toISOString();
  const placeholder = JSON.parse(
    buildPlaceholderResultJson({
      topic: args.topic,
      context: args.context,
      sources: args.sources,
      startedAt,
    }),
  ) as DeliberationResult;
  if (args.preset !== undefined && args.preset !== '') {
    placeholder.preset = args.preset;
  }

  const stmt = db.prepare(
    `INSERT INTO deliberations (id, topic, result_json, created_at, context, status, error)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  stmt.run(
    args.id,
    args.topic,
    JSON.stringify(placeholder),
    startedAt,
    args.context !== undefined && args.context !== '' ? args.context : null,
    'in_flight',
  );
}

/**
 * Read the current persisted result blob for a row. Used by the
 * append-turn/append-event helpers to merge a single record into the
 * existing JSON. Returns `null` when no row exists with that id.
 */
function readResultJson(
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

/**
 * Append a single turn to the row's `result_json.turns` array.
 *
 * No-op if the row does not exist (the background runner cannot crash a
 * fresh deliberation just because someone DELETE'd the row).
 */
export function appendTurn(
  db: Database.Database,
  id: string,
  turn: Turn,
): void {
  const current = readResultJson(db, id);
  if (current === null) return;
  current.turns.push(turn);
  const stmt = db.prepare(
    `UPDATE deliberations SET result_json = ? WHERE id = ?`,
  );
  stmt.run(JSON.stringify(current), id);
}

/**
 * Append a single event to the row's `result_json.events` array.
 *
 * No-op if the row does not exist; tolerant of a missing `events` array on
 * the persisted blob (pre-PAR-10 placeholders).
 */
export function appendEvent(
  db: Database.Database,
  id: string,
  event: SystemEvent,
): void {
  const current = readResultJson(db, id);
  if (current === null) return;
  if (!Array.isArray(current.events)) {
    current.events = [];
  }
  current.events.push(event);
  const stmt = db.prepare(
    `UPDATE deliberations SET result_json = ? WHERE id = ?`,
  );
  stmt.run(JSON.stringify(current), id);
}

/**
 * Flip the row to `status: 'completed'` and rewrite the result blob to the
 * canonical engine result. Called once when `runTopology()` resolves.
 */
export function markCompleted(
  db: Database.Database,
  id: string,
  result: DeliberationResult,
): void {
  // The engine's resolved value already carries the full final transcript
  // (richer than the progressively-appended turns since synthesizer meta
  // and convergence_delta land on the same records). We overwrite with
  // the engine's snapshot rather than diffing — the source of truth for a
  // completed run is the engine's return value.
  const final: DeliberationResult = { ...result, status: 'completed' };
  const stmt = db.prepare(
    `UPDATE deliberations
        SET result_json = ?, status = ?, error = NULL, context = COALESCE(?, context)
      WHERE id = ?`,
  );
  stmt.run(
    JSON.stringify(final),
    'completed',
    result.context ?? null,
    id,
  );
}

/**
 * Flip the row to `status: 'failed'` and stamp the error message. Called
 * when `runTopology()` throws in the background. The progressively-written
 * turns/events stay on the row so a client can read whatever partial
 * state existed at the time of the crash.
 */
export function markFailed(
  db: Database.Database,
  id: string,
  errorMessage: string,
): void {
  const current = readResultJson(db, id);
  if (current === null) return;
  current.status = 'failed';
  current.error = errorMessage;
  // Stamp completed_at so consumers reading partial state know when the
  // failure was observed.
  current.completed_at = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE deliberations SET result_json = ?, status = ?, error = ? WHERE id = ?`,
  );
  stmt.run(JSON.stringify(current), 'failed', errorMessage, id);
}

/**
 * Persists a completed deliberation result.
 *
 * The full `DeliberationResult` (including the optional PAR-16 `context`
 * field) is JSON-encoded into `result_json` so round-trips are exact. We
 * also write `context` into its own dedicated column so summary listings
 * and SQL-level queries can read it without parsing the JSON blob.
 *
 * This single-shot path is preserved for tests and for callers that prefer
 * to write the row in one go (the legacy synchronous shape pre-PAR-18).
 * The new fire-and-forget POST /deliberate path uses
 * `createDeliberationRow` + `appendTurn` + `markCompleted` instead.
 */
export function saveDeliberation(
  db: Database.Database,
  id: string,
  topic: string,
  result: DeliberationResult,
): void {
  // Default the persisted status to `completed` so a one-shot caller's row
  // matches what the new background runner would produce.
  const persisted: DeliberationResult = {
    ...result,
    status: result.status ?? 'completed',
  };

  const stmt = db.prepare(
    `INSERT INTO deliberations (id, topic, result_json, created_at, context, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  stmt.run(
    id,
    topic,
    JSON.stringify(persisted),
    new Date().toISOString(),
    result.context ?? null,
    persisted.status,
    persisted.error ?? null,
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
 *
 * PAR-18: `status` and `error` are pulled from their dedicated columns
 * when the JSON blob lacks them. Pre-PAR-18 rows have NULL for both —
 * we surface `completed` as the legacy default since those rows can only
 * have been written by the pre-refactor synchronous path.
 */
export function getDeliberation(
  db: Database.Database,
  id: string,
): DeliberationResult | null {
  const stmt = db.prepare<
    [string],
    {
      result_json: string;
      context: string | null;
      status: string | null;
      error: string | null;
    }
  >(
    `SELECT result_json, context, status, error
       FROM deliberations
      WHERE id = ?`,
  );

  const row = stmt.get(id);
  if (row === undefined) return null;

  const parsed = JSON.parse(row.result_json) as DeliberationResult;
  if (parsed.context === undefined && row.context !== null && row.context !== '') {
    parsed.context = row.context;
  }
  if (parsed.status === undefined) {
    // Pre-PAR-18 rows: NULL → legacy completed; populated → trust the column.
    if (row.status === null || row.status === '') {
      parsed.status = 'completed';
    } else if (
      row.status === 'in_flight' ||
      row.status === 'completed' ||
      row.status === 'failed'
    ) {
      parsed.status = row.status;
    } else {
      parsed.status = 'completed';
    }
  }
  if (parsed.error === undefined && row.error !== null && row.error !== '') {
    parsed.error = row.error;
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
  /**
   * PAR-20: topology preset id (e.g. `debate`, `star-chamber`, `jury`) that
   * produced this deliberation. Surfaced on the summary so the deliberation
   * list can render a per-preset color/badge without re-fetching the full
   * record.
   *
   * Optional / additive: deliberations recorded before PAR-20 lack this
   * field on their stored `result_json`; the listing query reads `null` in
   * that case and the UI renders a neutral fallback badge. Old client
   * builds keep parsing because no existing field is renamed or removed.
   */
  preset?: string | null;
  /**
   * PAR-18: lifecycle status surfaced on the list so an in-flight
   * deliberation appears with a "running…" affordance instead of the
   * neutral completed badge. Pre-PAR-18 rows surface `'completed'`
   * (their legacy default) so old client builds keep rendering unchanged.
   */
  status?: DeliberationStatus;
}

/**
 * Lists all stored deliberations, newest first.
 * Returns lightweight summary rows for use in dashboard listings.
 */
export function listDeliberations(db: Database.Database): DeliberationSummary[] {
  const stmt = db.prepare<
    [],
    { id: string; topic: string; created_at: string; result_json: string; status: string | null }
  >(
    `SELECT id, topic, created_at, result_json, status
       FROM deliberations
   ORDER BY created_at DESC`,
  );

  return stmt.all().map((row) => {
    let resolved = 0;
    let total_rounds = 0;
    let termination_reason = 'unknown';
    let preset: string | null = null;
    try {
      const r = JSON.parse(row.result_json) as DeliberationResult;
      resolved = r.resolved ? 1 : 0;
      total_rounds = r.totalRounds;
      termination_reason = r.terminationReason;
      // PAR-20: stored deliberations recorded after PAR-20 carry the preset
      // id inside `result_json`; older rows omit it and we surface `null`
      // so the UI's badge renders the neutral fallback.
      if (typeof r.preset === 'string' && r.preset.length > 0) {
        preset = r.preset;
      }
    } catch {
      // ignore malformed rows
    }
    let status: DeliberationStatus = 'completed';
    if (row.status === 'in_flight' || row.status === 'failed' || row.status === 'completed') {
      status = row.status;
    }
    return {
      id: row.id,
      topic: row.topic,
      created_at: row.created_at,
      resolved,
      total_rounds,
      termination_reason,
      preset,
      status,
    };
  });
}
