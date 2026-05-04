/**
 * PAR-36 / M1 T1.5 — account-scoped list helper for `GET /v1/deliberations`.
 *
 * Why a separate module:
 *   - `db.ts` already owns the row-level CRUD; this file owns the list-shape
 *     concerns (cursor encoding, filter composition, list-item projection)
 *     so we don't keep widening `listDeliberations`'s signature every time
 *     a milestone bolts on another query parameter.
 *   - The OpenAPI `DeliberationListItem` shape diverges from the legacy
 *     dashboard summary (different field names, different optional fields,
 *     ISO `completed_at`, aggregated `cost_usd`). Keeping the projection
 *     here lets the legacy `listDeliberations` keep serving the unchanged
 *     dashboard payload without regressions.
 *
 * Cursor design:
 *   - Opaque base64url of `${created_at}|${id}`. The composite key
 *     `(created_at DESC, id DESC)` is the keyset used by the index, so we
 *     paginate via `WHERE (created_at, id) < (?, ?)` after the first page.
 *   - The `id` tie-break makes the order deterministic when two rows share
 *     a millisecond timestamp (sub-ms test bursts hit this).
 *   - Encoding is reversible without server-side state — the next caller
 *     can be a different process and pagination still works.
 *
 * Filter precedence:
 *   - All filters AND together. `created_after` / `created_before` are
 *     half-open: `created_at > created_after` and `created_at < created_before`
 *     so a window expressed as `[T0, T1]` includes neither boundary, matching
 *     the OpenAPI prose. Validation of the date strings happens at the route
 *     layer (Zod). The helper trusts whatever it receives.
 */

import type { Database } from './db.js';
import type { DeliberationResult, DeliberationStatus } from '@parliament/core';
import { OSS_ACCOUNT_ID } from './api-keys.js';

/** Default page size when the caller omits `limit`. */
export const DEFAULT_LIMIT = 25;
/** Hard ceiling enforced after Zod parsing — clamps adversarial requests. */
export const MAX_LIMIT = 100;

/**
 * The OpenAPI `DeliberationListItem` shape. `completed_at`, `resolved`,
 * `residue_score`, and `cost_usd` are nullable to handle in-flight rows and
 * pre-PAR-20 / pre-cost-tracking history without dropping items.
 */
export interface DeliberationListItem {
  id: string;
  preset: string;
  topic: string;
  status: DeliberationStatus;
  created_at: string;
  completed_at: string | null;
  resolved: boolean | null;
  residue_score: number | null;
  cost_usd: number | null;
}

export interface DeliberationListPage {
  data: DeliberationListItem[];
  next_cursor: string | null;
}

export interface ListFilters {
  /** PAR-33-derived account scope. The OSS bucket leaks pre-PAR-36 rows. */
  accountId: string;
  limit?: number;
  cursor?: string | undefined;
  status?: DeliberationStatus | undefined;
  preset?: string | undefined;
  /** ISO-8601 lower bound (exclusive). */
  createdAfter?: string | undefined;
  /** ISO-8601 upper bound (exclusive). */
  createdBefore?: string | undefined;
}

interface DecodedCursor {
  created_at: string;
  id: string;
}

/**
 * Encode a cursor pointing at the row immediately AFTER the given anchor.
 * The next page returns rows ordered strictly before this `(created_at, id)`
 * pair under the index's DESC ordering.
 */
export function encodeCursor(anchor: { created_at: string; id: string }): string {
  const raw = `${anchor.created_at}|${anchor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decode a cursor token. Returns `null` for malformed input — the route layer
 * surfaces a 400 in that case rather than silently restarting from the top
 * (a silent restart would let a corrupt cursor mask client bugs).
 */
export function decodeCursor(token: string): DecodedCursor | null {
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const idx = raw.indexOf('|');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const created_at = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  // Sanity-check the timestamp shape — caller-controlled input.
  if (Number.isNaN(Date.parse(created_at))) return null;
  return { created_at, id };
}

interface RawRow {
  id: string;
  topic: string;
  created_at: string;
  result_json: string;
  status: string | null;
}

function projectRow(row: RawRow): DeliberationListItem {
  let preset = 'unknown';
  let completed_at: string | null = null;
  let resolved: boolean | null = null;
  let residue_score: number | null = null;
  let cost_usd: number | null = null;

  try {
    const r = JSON.parse(row.result_json) as DeliberationResult & {
      preset?: string;
    };
    if (typeof r.preset === 'string' && r.preset.length > 0) {
      preset = r.preset;
    }
    if (typeof r.completed_at === 'string' && r.completed_at.length > 0) {
      completed_at = r.completed_at;
    }
    if (typeof r.resolved === 'boolean') resolved = r.resolved;
    if (typeof r.residueScore === 'number') residue_score = r.residueScore;

    // Aggregate cost from per-turn `costUsd` so the list endpoint can answer
    // "how expensive was this run" without a second round-trip. Pre-cost
    // history (turns with no `costUsd`) yields `null`, matching the
    // OpenAPI nullable contract.
    if (Array.isArray(r.turns)) {
      let total = 0;
      let any = false;
      for (const t of r.turns) {
        const c = t.meta?.costUsd;
        if (typeof c === 'number') {
          total += c;
          any = true;
        }
      }
      if (any) cost_usd = total;
    }
  } catch {
    // Malformed JSON — surface the row anyway with conservative defaults so a
    // single bad blob doesn't poison the whole page.
  }

  let status: DeliberationStatus = 'completed';
  if (row.status === 'in_flight' || row.status === 'failed' || row.status === 'completed') {
    status = row.status;
  }

  return {
    id: row.id,
    preset,
    topic: row.topic,
    status,
    created_at: row.created_at,
    completed_at,
    resolved,
    residue_score,
    cost_usd,
  };
}

/**
 * Account-scoped list with keyset pagination + the four PAR-36 filters.
 * Returns up to `limit` items plus `next_cursor` (null when no further page).
 */
export function listDeliberationsScoped(
  db: Database.Database,
  filters: ListFilters,
): DeliberationListPage {
  const limit = Math.min(
    Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );

  // Build the WHERE clause incrementally so we can layer the cursor
  // predicate on top without string-stitching SQL fragments at the call
  // site. better-sqlite3's `.prepare` works fine with parameter arrays of
  // unknown length as long as `?` count matches.
  const wheres: string[] = [];
  const params: unknown[] = [];

  // PAR-36 — coalesce NULL `account_id` (pre-migration rows) onto the OSS
  // bucket so existing self-host installs don't lose history when this
  // ticket lands.
  wheres.push(`COALESCE(account_id, ?) = ?`);
  params.push(OSS_ACCOUNT_ID);
  params.push(filters.accountId);

  if (filters.status !== undefined) {
    // The legacy default for NULL `status` is `'completed'` (mirrors the
    // listDeliberations projection logic). Match that semantic on filter
    // too: `?status=completed` should include pre-PAR-18 rows.
    if (filters.status === 'completed') {
      wheres.push(`(status = ? OR status IS NULL)`);
      params.push('completed');
    } else {
      wheres.push(`status = ?`);
      params.push(filters.status);
    }
  }

  if (filters.preset !== undefined) {
    // Preset lives inside `result_json`; SQLite's json_extract handles it
    // without a column migration. Indexing on this is M2+ work — for M1's
    // 10k-rows-per-account budget this is still a quick scan within the
    // account-scoped predicate.
    wheres.push(`json_extract(result_json, '$.preset') = ?`);
    params.push(filters.preset);
  }

  if (filters.createdAfter !== undefined) {
    wheres.push(`created_at > ?`);
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore !== undefined) {
    wheres.push(`created_at < ?`);
    params.push(filters.createdBefore);
  }

  if (filters.cursor !== undefined && filters.cursor !== '') {
    const decoded = decodeCursor(filters.cursor);
    if (decoded === null) {
      // The route layer pre-validates and returns 400 — this branch only
      // triggers when callers reach the helper directly with a junk cursor.
      // Treat it as "no further pages" rather than throwing.
      return { data: [], next_cursor: null };
    }
    // Tuple comparison: rows STRICTLY older than the anchor under DESC order.
    wheres.push(`(created_at, id) < (?, ?)`);
    params.push(decoded.created_at);
    params.push(decoded.id);
  }

  // Fetch `limit + 1` so we can detect "more rows beyond this page" without
  // a second COUNT query. The +1th row is dropped from `data` and its
  // `(created_at, id)` becomes the next page's anchor.
  const sql = `SELECT id, topic, created_at, result_json, status
                 FROM deliberations
                WHERE ${wheres.join(' AND ')}
             ORDER BY created_at DESC, id DESC
                LIMIT ?`;
  params.push(limit + 1);

  const rows = db.prepare<unknown[], RawRow>(sql).all(...params);

  let next_cursor: string | null = null;
  let pageRows = rows;
  if (rows.length > limit) {
    pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    if (last !== undefined) {
      next_cursor = encodeCursor({ created_at: last.created_at, id: last.id });
    }
  }

  return {
    data: pageRows.map(projectRow),
    next_cursor,
  };
}
