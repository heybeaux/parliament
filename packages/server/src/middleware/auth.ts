/**
 * Optional bearer-token authentication.
 *
 * When `PARLIAMENT_API_KEY` is set in the environment, every request must
 * carry an `Authorization: Bearer <key>` header that matches via a
 * timing-safe comparison. When the env var is unset, requests pass through
 * unauthenticated — this preserves the localhost-dev experience while making
 * `secure-by-default-when-configured` an opt-in.
 *
 * Compared via {@link timingSafeEqual} on equal-length byte buffers, with an
 * up-front length check; mismatched lengths skip the constant-time compare
 * but still always reject (no early-return leak of useful information).
 */

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const API_KEY_ENV_VAR = 'PARLIAMENT_API_KEY';

/**
 * Startup warning emitted when the API key env var is unset. Exported so
 * tests and operators can grep for the exact wording.
 */
export const API_KEY_UNSET_WARNING =
  `Parliament: ${API_KEY_ENV_VAR} is not set — API is unauthenticated. ` +
  `Set ${API_KEY_ENV_VAR}=<secret> to require Authorization: Bearer <key> on all routes.`;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns auth middleware bound to `expectedKey`. When `expectedKey` is
 * `undefined` the middleware is a no-op (all requests allowed).
 */
export function bearerAuth(expectedKey: string | undefined): MiddlewareHandler {
  if (expectedKey === undefined || expectedKey === '') {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    // Always allow CORS preflight to reach the CORS middleware.
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    const header = c.req.header('Authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/);
    const presented = match ? match[1].trim() : '';

    if (!presented || !safeEqual(presented, expectedKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}
