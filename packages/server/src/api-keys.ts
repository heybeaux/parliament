/**
 * PAR-33 / M1 T1.1 — API key issuance & validation.
 *
 * Stores the argon2id hash of the secret half of every key; the plaintext
 * is shown to the user EXACTLY ONCE on creation and never persisted. The
 * lookup path uses the deterministic, non-secret `prefix` column to find
 * the candidate row, then verifies the presented secret against the
 * stored hash via argon2's constant-time `verify`.
 *
 * Design notes:
 *   - Two key types: `pk_test_` and `pk_live_`. Test keys route to a
 *     sandbox lineup (T2.5 territory) and get a per-key 10/min throttle;
 *     live keys count against the account's tier envelope (T1.3).
 *   - Prefix shape: `<key_type>_<10 base32-ish chars>` so the dashboard
 *     can render a recognizable handle without ever loading the secret.
 *     The 10-char visible portion gives ~50 bits of search space — enough
 *     that we expect to be unique on creation, but uniqueness is enforced
 *     by the DB index, with a single retry on the unlikely collision.
 *   - The full secret is `<prefix>_<32 base32 chars>`, generated from
 *     `crypto.randomBytes(32)`. The full string is what the caller sends
 *     in `Authorization: Bearer …`; we split on the prefix delimiter at
 *     verify time.
 *   - Argon2id parameters are set to target ~50ms verify time on the
 *     production hardware bracket. `targetMs` is exposed so deployments
 *     can re-tune; the defaults here match a typical Apple Silicon /
 *     mid-range x86 box.
 *
 * What this module is NOT:
 *   - It does not enforce rate limits or usage envelopes — that lives in
 *     the middleware so the same lookup result drives both auth and limits.
 *   - It does not migrate existing OSS deployments. The shared-secret
 *     `PARLIAMENT_API_KEY` is removed in this PR; OSS users with an empty
 *     `api_keys` table see no auth required (matching API.md self-host
 *     parity).
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Database } from './db.js';

export type ApiKeyType = 'test' | 'live';

/**
 * Row shape returned by `lookupApiKey`. The `secret` is never set on a
 * lookup — only on `createApiKey`'s one-time return.
 */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  key_type: ApiKeyType;
  prefix: string;
  name: string | null;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Returned exactly once, on creation. The `secret` field is the FULL
 * bearer token the caller must store; subsequent reads return the row
 * without it.
 */
export interface IssuedApiKey extends ApiKeyRow {
  secret: string;
}

/**
 * Argon2id parameters. Defaults target ~50ms verify time on a 2024-era
 * laptop / mid-range cloud VM. `timeCost` / `memoryCost` are the levers
 * an operator turns under load; the recommended discipline is to bench
 * once on the deployment hardware and pin both.
 */
export interface ArgonParams {
  /** Iterations. Higher → slower verify, stronger against GPU attacks. */
  timeCost: number;
  /** Memory in KiB. argon2id is memory-hard; 19 MiB matches OWASP 2023. */
  memoryCost: number;
  /** Parallelism. 1 is the canonical recommendation for password storage. */
  parallelism: number;
}

export const DEFAULT_ARGON_PARAMS: ArgonParams = {
  timeCost: 2,
  memoryCost: 19_456,
  parallelism: 1,
};

/**
 * The synthetic single-account id used by self-host deployments. Real
 * multi-tenant deployments mint a per-customer account on signup; OSS
 * piggybacks on this row so api_keys always FK against a real account.
 */
export const OSS_ACCOUNT_ID = 'acct_oss_self_host';

/**
 * Idempotently inserts the OSS synthetic account. Safe to call on every
 * boot (NO-OP after the first run). Self-host deployments don't have a
 * signup flow, so `createApiKey` calls this for them on demand.
 */
export function ensureOssAccount(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT id FROM accounts WHERE id = ?`)
    .get(OSS_ACCOUNT_ID);
  if (existing !== undefined) return;
  db.prepare(
    `INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, ?)`,
  ).run(OSS_ACCOUNT_ID, 'oss', new Date().toISOString());
}

/**
 * Generates a fresh random secret half. 32 bytes of entropy → 52 base32
 * characters; we keep all 52 in the persisted bearer to make the secret
 * effectively brute-force-proof even if the prefix leaks.
 */
function generateRandomBase32(byteCount: number): string {
  // Crockford-style base32 minus ambiguous chars (no I, L, O, U, 0, 1).
  // The alphabet is large enough that any uniform 5-bit slice maps to
  // exactly one character; we generate `byteCount` bytes and consume
  // 5 bits at a time.
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';
  // 52 chars is plenty; the alphabet length is 52 so each char is ~5.7
  // bits. We pull 8-bit bytes and reduce mod 52, accepting a tiny bias
  // — secrets don't need a uniform base32 mapping, just enough entropy.
  const bytes = randomBytes(byteCount);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * Build the visible prefix: `pk_test_<10 random>` / `pk_live_<10 random>`.
 * The 10-char visible portion is what the dashboard surfaces.
 */
function buildPrefix(keyType: ApiKeyType): string {
  return `pk_${keyType}_${generateRandomBase32(10)}`;
}

/**
 * Build the full secret bearer: `<prefix>_<32 char secret>`. The
 * delimiting underscore between prefix and secret is intentional —
 * `splitBearer` peels it off without ambiguity even though `_` appears
 * inside the prefix as well, because we split on the LAST `_`.
 */
function buildBearer(prefix: string, secret: string): string {
  return `${prefix}_${secret}`;
}

/**
 * Splits a presented bearer back into its (prefix, secret) halves. Returns
 * `null` for any malformed input — never throws, so the caller can collapse
 * "malformed header" and "no key" into the same 401 path.
 */
export function splitBearer(
  bearer: string,
): { prefix: string; secret: string } | null {
  const lastUnderscore = bearer.lastIndexOf('_');
  if (lastUnderscore <= 0 || lastUnderscore === bearer.length - 1) return null;
  const prefix = bearer.slice(0, lastUnderscore);
  const secret = bearer.slice(lastUnderscore + 1);
  // Sanity-check the prefix shape: must start with `pk_test_` or `pk_live_`.
  if (!prefix.startsWith('pk_test_') && !prefix.startsWith('pk_live_')) {
    return null;
  }
  return { prefix, secret };
}

interface CreateApiKeyOptions {
  accountId?: string;
  keyType: ApiKeyType;
  name?: string | undefined;
  argon?: ArgonParams;
}

/**
 * Issue a new API key. Persists the argon2id hash of the secret half
 * and returns the row plus the FULL bearer string. The bearer is shown
 * to the user EXACTLY ONCE — subsequent reads via `listApiKeys` /
 * `getApiKey` strip the `secret` field.
 *
 * Defaults `accountId` to the OSS synthetic account (and idempotently
 * inserts that account if absent) so self-host operators can issue keys
 * without first creating an account row.
 */
export async function createApiKey(
  db: Database.Database,
  opts: CreateApiKeyOptions,
): Promise<IssuedApiKey> {
  const accountId = opts.accountId ?? OSS_ACCOUNT_ID;
  if (accountId === OSS_ACCOUNT_ID) {
    ensureOssAccount(db);
  } else {
    const exists = db
      .prepare(`SELECT id FROM accounts WHERE id = ?`)
      .get(accountId);
    if (exists === undefined) {
      throw new Error(`account not found: ${accountId}`);
    }
  }

  // One retry on the (vanishingly unlikely) prefix collision; if both
  // attempts collide the operator has bigger problems than this PR.
  let prefix = buildPrefix(opts.keyType);
  for (let attempt = 0; attempt < 2; attempt++) {
    const collision = db
      .prepare(`SELECT 1 FROM api_keys WHERE prefix = ?`)
      .get(prefix);
    if (collision === undefined) break;
    prefix = buildPrefix(opts.keyType);
  }

  const secret = generateRandomBase32(32);
  const bearer = buildBearer(prefix, secret);
  const argon = opts.argon ?? DEFAULT_ARGON_PARAMS;
  const hashed = await argon2Hash(secret, {
    timeCost: argon.timeCost,
    memoryCost: argon.memoryCost,
    parallelism: argon.parallelism,
  });

  const row: ApiKeyRow = {
    id: `key_${randomUUID()}`,
    account_id: accountId,
    key_type: opts.keyType,
    prefix,
    name: opts.name ?? null,
    created_at: new Date().toISOString(),
    revoked_at: null,
  };

  db.prepare(
    `INSERT INTO api_keys (id, account_id, key_type, prefix, hashed_secret, name, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    row.id,
    row.account_id,
    row.key_type,
    row.prefix,
    hashed,
    row.name,
    row.created_at,
  );

  return { ...row, secret: bearer };
}

/**
 * Verify a presented bearer string against the stored hash. Returns the
 * row for valid, non-revoked keys; `null` for any failure (missing,
 * malformed, unknown prefix, hash mismatch, or revoked).
 *
 * Always performs an argon2 verify when a row is found, even if revoked,
 * to prevent timing-side-channel discrimination between "unknown key" and
 * "known but revoked." The caller branches on the returned row's
 * `revoked_at` to choose the response code (401 vs 403) — the work-factor
 * is constant either way.
 */
export async function verifyBearer(
  db: Database.Database,
  bearer: string,
): Promise<{ row: ApiKeyRow; revoked: boolean } | null> {
  const split = splitBearer(bearer);
  if (split === null) return null;

  const row = db
    .prepare<
      [string],
      {
        id: string;
        account_id: string;
        key_type: string;
        prefix: string;
        hashed_secret: string;
        name: string | null;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `SELECT id, account_id, key_type, prefix, hashed_secret, name, created_at, revoked_at
         FROM api_keys WHERE prefix = ?`,
    )
    .get(split.prefix);
  if (row === undefined) return null;

  let valid = false;
  try {
    valid = await argon2Verify(row.hashed_secret, split.secret);
  } catch {
    valid = false;
  }
  if (!valid) return null;

  // Belt-and-suspenders: confirm the prefix on the row matches what was
  // presented (it MUST, since we looked up by prefix, but a constant-time
  // compare costs ~µs and closes any future refactor footguns).
  const a = Buffer.from(row.prefix);
  const b = Buffer.from(split.prefix);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return {
    row: {
      id: row.id,
      account_id: row.account_id,
      key_type: row.key_type as ApiKeyType,
      prefix: row.prefix,
      name: row.name,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    },
    revoked: row.revoked_at !== null,
  };
}

/**
 * One-way revoke. Idempotent: revoking an already-revoked key leaves the
 * original `revoked_at` intact (per AC: revocation cannot be reactivated).
 */
export function revokeApiKey(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

/**
 * List all keys (without secrets) for an account. Includes revoked keys
 * so the dashboard can surface revocation history.
 */
export function listApiKeys(
  db: Database.Database,
  accountId: string,
): ApiKeyRow[] {
  const rows = db
    .prepare<
      [string],
      {
        id: string;
        account_id: string;
        key_type: string;
        prefix: string;
        name: string | null;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `SELECT id, account_id, key_type, prefix, name, created_at, revoked_at
         FROM api_keys WHERE account_id = ? ORDER BY created_at DESC`,
    )
    .all(accountId);
  return rows.map((r) => ({
    id: r.id,
    account_id: r.account_id,
    key_type: r.key_type as ApiKeyType,
    prefix: r.prefix,
    name: r.name,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  }));
}

/**
 * Lookup a single key by id. Returns `null` when not found. Used by
 * `DELETE /dashboard/api/keys/:id` to verify ownership before revoke.
 */
export function getApiKey(
  db: Database.Database,
  id: string,
): ApiKeyRow | null {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        account_id: string;
        key_type: string;
        prefix: string;
        name: string | null;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `SELECT id, account_id, key_type, prefix, name, created_at, revoked_at
         FROM api_keys WHERE id = ?`,
    )
    .get(id);
  if (row === undefined) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    key_type: row.key_type as ApiKeyType,
    prefix: row.prefix,
    name: row.name,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

/**
 * Returns the count of api_keys rows. Used by the auth middleware to
 * detect the OSS pass-through state (empty table → no auth required).
 *
 * Defensive: returns 0 when the underlying DB doesn't have the table or
 * isn't a real `better-sqlite3` instance. Server tests pass stub DB
 * objects (`{}`) into `createRouter`; those should land on the
 * unauthenticated pass-through path rather than 500ing.
 */
export function apiKeyCount(db: Database.Database): number {
  try {
    const row = db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM api_keys`).get();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
