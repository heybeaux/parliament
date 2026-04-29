/**
 * CORS middleware with an origin allowlist.
 *
 * Origins in the allowlist may be exact strings (`http://example.com`) or
 * port-wildcard forms (`http://localhost:*`, `http://127.0.0.1:*`). When the
 * request `Origin` matches, that exact origin is echoed back; otherwise the
 * `Access-Control-Allow-Origin` header is omitted entirely (browsers will
 * then refuse the response, which is the desired behaviour).
 *
 * No wildcard `*` is ever emitted, even when configured — `*` would defeat
 * the purpose of the allowlist.
 */

import type { MiddlewareHandler } from 'hono';

function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  // Port-wildcard form: scheme://host:* matches any port (or no port).
  const wildcardMatch = pattern.match(/^(https?:\/\/[^:/]+):\*$/);
  if (wildcardMatch) {
    const base = wildcardMatch[1];
    return origin === base || origin.startsWith(base + ':');
  }
  return false;
}

export function corsMiddleware(allowed: string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const matched = origin && allowed.some((p) => originMatches(origin, p));

    if (matched && origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  };
}
