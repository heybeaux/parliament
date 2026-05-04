/**
 * PAR-33 / M1 T1.1 — DB-backed bearer auth.
 *
 * Replaces the prior single-shared-secret `PARLIAMENT_API_KEY` middleware
 * with multi-key argon2id-hashed lookup against the `api_keys` table.
 * Behaviour:
 *
 *   - Empty `api_keys` table → unauthenticated pass-through (matches the
 *     OSS "no auth required by default" promise in API.md self-host
 *     parity). The first time an operator creates a key, the route
 *     becomes authenticated for that account on the next request.
 *   - Missing `Authorization` header → `401 authentication_required`.
 *   - Malformed header / unknown prefix / hash mismatch / revoked key
 *     → `403 authentication_invalid`.
 *   - Valid, non-revoked key → request passes through. The middleware
 *     attaches `account_id`, `key_id`, and `key_type` (`'test'` or
 *     `'live'`) to Hono's `c.set` map so downstream handlers / limiters
 *     can branch on them without re-querying the DB.
 *
 * The error-code values are pinned by the public API.md error model:
 * `authentication_required` for missing-or-malformed, `authentication_invalid`
 * for present-but-not-honored. Tests pin the exact wire shapes.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Database } from '../db.js';
import {
  apiKeyCount,
  type ApiKeyType,
  verifyBearer,
} from '../api-keys.js';

/**
 * Hono context keys set by the auth middleware. Exported so handlers can
 * type-narrow without re-stringing the literal.
 */
export const AUTH_CTX_ACCOUNT_ID = 'authAccountId' as const;
export const AUTH_CTX_KEY_ID = 'authKeyId' as const;
export const AUTH_CTX_KEY_TYPE = 'authKeyType' as const;

/**
 * Wire shape of the auth-failure JSON body. Pinned to the API.md error
 * model: `error.code` is machine-readable, `error.message` is human-readable.
 */
function authError(
  c: Context,
  status: 401 | 403,
  code: 'authentication_required' | 'authentication_invalid',
  message: string,
): Response {
  return c.json(
    {
      error: { code, message },
    },
    status,
  );
}

export interface BearerAuthOptions {
  /**
   * Test seam — when present, called instead of `verifyBearer(db, …)`.
   * Real wiring routes through the DB; tests use this to drive cases
   * without seeding rows.
   */
  verify?: (
    bearer: string,
  ) => Promise<{ row: { account_id: string; id: string; key_type: ApiKeyType }; revoked: boolean } | null>;
  /**
   * Test seam — when present, called instead of `apiKeyCount(db)`. Used to
   * drive the empty-table pass-through path deterministically.
   */
  isEmpty?: () => boolean;
}

/**
 * Build the auth middleware. Captures the DB handle in a closure so the
 * middleware can short-circuit when the table is empty (single COUNT(*),
 * cheap; bypasses the argon2 cost on unauth'd OSS deployments).
 */
export function bearerAuth(
  db: Database.Database,
  options: BearerAuthOptions = {},
): MiddlewareHandler {
  const isEmpty = options.isEmpty ?? (() => apiKeyCount(db) === 0);
  const verify =
    options.verify ?? ((bearer: string) => verifyBearer(db, bearer));

  return async (c, next) => {
    // CORS preflight always passes — the CORS middleware needs to answer.
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    // OSS pass-through: empty table → no auth required. We re-check on
    // every request rather than caching, because once an operator creates
    // their first key the route MUST flip to authenticated immediately.
    // The check is a single COUNT(*) on an indexed table — cheap.
    if (isEmpty()) {
      await next();
      return;
    }

    const header = c.req.header('Authorization') ?? '';
    if (header === '') {
      return authError(
        c,
        401,
        'authentication_required',
        'Missing Authorization header. Send `Authorization: Bearer pk_…`.',
      );
    }
    const match = header.match(/^Bearer\s+(.+)$/);
    if (!match) {
      return authError(
        c,
        401,
        'authentication_required',
        'Malformed Authorization header. Expected `Authorization: Bearer pk_…`.',
      );
    }
    const presented = match[1].trim();

    const result = await verify(presented);
    if (result === null) {
      return authError(
        c,
        403,
        'authentication_invalid',
        'API key is invalid.',
      );
    }
    if (result.revoked) {
      return authError(
        c,
        403,
        'authentication_invalid',
        'API key has been revoked.',
      );
    }

    c.set(AUTH_CTX_ACCOUNT_ID, result.row.account_id);
    c.set(AUTH_CTX_KEY_ID, result.row.id);
    c.set(AUTH_CTX_KEY_TYPE, result.row.key_type);

    await next();
  };
}
