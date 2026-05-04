/**
 * PAR-33 / M1 T1.1 — helper-level coverage for the api-keys module.
 *
 * Pins the contracts the auth middleware (and dashboard routes) rely on:
 *   - Bearer issuance returns the secret EXACTLY ONCE; subsequent reads
 *     never include it.
 *   - The persisted column stores an argon2id hash, not the plaintext.
 *   - `splitBearer` is total: malformed inputs return null instead of
 *     throwing, so the middleware can collapse them into a 401.
 *   - `verifyBearer` rejects unknown prefixes, wrong secrets, and mangled
 *     inputs; surfaces revoked rows with `revoked: true` so the middleware
 *     picks the 403 message branch.
 *   - `revokeApiKey` is one-way: a second revoke is a no-op (idempotent),
 *     and a revoked key cannot be re-validated.
 *   - `apiKeyCount` is defensive: stub DBs (no schema) report 0 instead
 *     of throwing, so OSS pass-through still works in tests.
 *
 * Argon2 verifies cost ~50ms each. We use a tiny argon override on
 * `createApiKey` calls where the test only cares about the structural
 * round-trip (not the production work-factor) to keep the suite fast.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import {
  apiKeyCount,
  createApiKey,
  ensureOssAccount,
  getApiKey,
  listApiKeys,
  OSS_ACCOUNT_ID,
  revokeApiKey,
  splitBearer,
  verifyBearer,
  type ArgonParams,
} from '../api-keys.js';

// Cheap argon parameters — keep the suite under a second per test. The
// production defaults (DEFAULT_ARGON_PARAMS) are exercised implicitly by
// the route-integration tests and by manual benchmarks; here we just need
// to confirm the round-trip logic.
const FAST_ARGON: ArgonParams = {
  timeCost: 1,
  memoryCost: 1024,
  parallelism: 1,
};

describe('splitBearer', () => {
  it('splits a well-formed test bearer on the LAST underscore', () => {
    // The prefix itself contains underscores; splitBearer must split on
    // the FINAL one to avoid mistakenly splitting `pk` from `test_…`.
    const parts = splitBearer('pk_test_ABCDEFGHJK_secretsecretsecret');
    expect(parts).toEqual({
      prefix: 'pk_test_ABCDEFGHJK',
      secret: 'secretsecretsecret',
    });
  });

  it('splits a well-formed live bearer on the LAST underscore', () => {
    const parts = splitBearer('pk_live_ABCDEFGHJK_xyz');
    expect(parts).toEqual({
      prefix: 'pk_live_ABCDEFGHJK',
      secret: 'xyz',
    });
  });

  it('returns null for empty input', () => {
    expect(splitBearer('')).toBeNull();
  });

  it('returns null for an input with no underscore', () => {
    expect(splitBearer('pk-test-no-underscores')).toBeNull();
  });

  it('returns null when the secret half is empty (trailing underscore)', () => {
    expect(splitBearer('pk_test_ABCDEFGHJK_')).toBeNull();
  });

  it('returns null for a leading underscore (no prefix half)', () => {
    expect(splitBearer('_secret')).toBeNull();
  });

  it('returns null when the prefix does not start with pk_test_ or pk_live_', () => {
    expect(splitBearer('sk_test_ABCDEFGHJK_secret')).toBeNull();
    expect(splitBearer('pk_other_ABCDEFGHJK_secret')).toBeNull();
    expect(splitBearer('hello_world_secret')).toBeNull();
  });
});

describe('createApiKey', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns the FULL bearer (prefix + secret) exactly once on creation', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    expect(issued.secret.startsWith(issued.prefix + '_')).toBe(true);
    expect(issued.secret.length).toBeGreaterThan(issued.prefix.length + 1);
    // The persisted row never carries the plaintext secret. We confirm
    // by re-reading via `getApiKey` and checking the shape.
    const reread = getApiKey(db, issued.id);
    expect(reread).not.toBeNull();
    expect(reread).not.toHaveProperty('secret');
    expect(reread!.prefix).toBe(issued.prefix);
  });

  it('persists an argon2id hash, not the plaintext secret', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    const row = db
      .prepare<[string], { hashed_secret: string }>(
        `SELECT hashed_secret FROM api_keys WHERE id = ?`,
      )
      .get(issued.id);
    expect(row).toBeDefined();
    // argon2 encoded hashes start with `$argon2id$` (or argon2i/d). Anything
    // other than that means we accidentally persisted plaintext.
    expect(row!.hashed_secret.startsWith('$argon2id$')).toBe(true);
    // And the plaintext secret never appears anywhere in the persisted row.
    const plaintext = issued.secret.split('_').pop()!;
    expect(row!.hashed_secret.includes(plaintext)).toBe(false);
  });

  it('builds a prefix shaped pk_<type>_<10 chars>', async () => {
    const test = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    const live = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    expect(test.prefix).toMatch(/^pk_test_[A-Za-z2-9]{10}$/);
    expect(live.prefix).toMatch(/^pk_live_[A-Za-z2-9]{10}$/);
  });

  it('idempotently bootstraps the OSS synthetic account', async () => {
    // First call: account does not exist yet → ensureOssAccount inserts.
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    expect(issued.account_id).toBe(OSS_ACCOUNT_ID);

    const accounts = db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM accounts`)
      .get();
    expect(accounts!.c).toBe(1);

    // Second call: must NOT duplicate the row.
    await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    const after = db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM accounts`)
      .get();
    expect(after!.c).toBe(1);
  });

  it('rejects unknown account ids when accountId is explicitly passed', async () => {
    await expect(
      createApiKey(db, {
        accountId: 'acct_does_not_exist',
        keyType: 'test',
        argon: FAST_ARGON,
      }),
    ).rejects.toThrow(/account not found/);
  });

  it('persists optional name verbatim', async () => {
    const issued = await createApiKey(db, {
      keyType: 'test',
      name: 'CI smoke',
      argon: FAST_ARGON,
    });
    expect(issued.name).toBe('CI smoke');
    expect(getApiKey(db, issued.id)!.name).toBe('CI smoke');
  });

  it('mints unique prefixes across many issuances', async () => {
    // 25 keys is more than the test-suite needs to survive, but it pins
    // the collision-retry path: if two keys ever shared a prefix, the
    // INSERT would fail on the UNIQUE index and surface here.
    const prefixes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
      prefixes.add(issued.prefix);
    }
    expect(prefixes.size).toBe(25);
  });
});

describe('verifyBearer', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns the row for a freshly issued, valid bearer', async () => {
    const issued = await createApiKey(db, {
      keyType: 'test',
      argon: FAST_ARGON,
      name: 'verify-me',
    });
    const result = await verifyBearer(db, issued.secret);
    expect(result).not.toBeNull();
    expect(result!.revoked).toBe(false);
    expect(result!.row.id).toBe(issued.id);
    expect(result!.row.account_id).toBe(OSS_ACCOUNT_ID);
    expect(result!.row.key_type).toBe('test');
    expect(result!.row.prefix).toBe(issued.prefix);
    expect(result!.row.name).toBe('verify-me');
  });

  it('returns null for a malformed bearer', async () => {
    expect(await verifyBearer(db, 'not-a-key')).toBeNull();
    expect(await verifyBearer(db, '')).toBeNull();
    expect(await verifyBearer(db, 'pk_other_ABCDEFGHJK_xyz')).toBeNull();
  });

  it('returns null for a well-formed bearer with an unknown prefix', async () => {
    // The prefix passes the shape check but no row exists for it.
    expect(
      await verifyBearer(db, 'pk_test_ABCDEFGHJK_irrelevantsecret'),
    ).toBeNull();
  });

  it('returns null when the prefix matches but the secret is wrong', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    // Tamper with the secret half (last underscore segment); the prefix
    // is intact so the lookup hits the row, but argon2.verify must fail.
    const tampered = `${issued.prefix}_BADBADBADBADBADBADBADBADBADBADBA`;
    expect(await verifyBearer(db, tampered)).toBeNull();
  });

  it('flags revoked keys with revoked: true (not null)', async () => {
    const issued = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    expect(revokeApiKey(db, issued.id)).toBe(true);

    const result = await verifyBearer(db, issued.secret);
    expect(result).not.toBeNull();
    expect(result!.revoked).toBe(true);
    expect(result!.row.revoked_at).not.toBeNull();
  });

  it('still distinguishes a wrong secret on a revoked row from a hit', async () => {
    // Revocation does not bypass the hash check — a wrong secret on a
    // revoked key still returns null, not `{ revoked: true }`.
    const issued = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    revokeApiKey(db, issued.id);
    const tampered = `${issued.prefix}_BADBADBADBADBADBADBADBADBADBADBA`;
    expect(await verifyBearer(db, tampered)).toBeNull();
  });
});

describe('revokeApiKey', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns true on first revoke, false on subsequent revokes (idempotent)', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    expect(revokeApiKey(db, issued.id)).toBe(true);
    expect(revokeApiKey(db, issued.id)).toBe(false);
    expect(revokeApiKey(db, issued.id)).toBe(false);
  });

  it('returns false for an unknown id', () => {
    expect(revokeApiKey(db, 'key_does_not_exist')).toBe(false);
  });

  it('preserves the original revoked_at on subsequent revoke attempts', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    revokeApiKey(db, issued.id);
    const firstRow = getApiKey(db, issued.id)!;
    const firstStamp = firstRow.revoked_at;
    expect(firstStamp).not.toBeNull();

    // Wait long enough that a second UPDATE would mint a different ISO
    // timestamp if the WHERE clause guard was removed. Then attempt and
    // confirm the original timestamp is untouched.
    await new Promise((r) => setTimeout(r, 5));
    revokeApiKey(db, issued.id);
    const secondRow = getApiKey(db, issued.id)!;
    expect(secondRow.revoked_at).toBe(firstStamp);
  });

  it('cannot be reactivated — verifyBearer keeps reporting revoked: true', async () => {
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    revokeApiKey(db, issued.id);

    // Attempting a "re-activation" by clearing revoked_at directly would
    // require SQL outside the public API. We confirm the public API has
    // no helper to do so: there is no function exported that flips
    // revoked_at back to null. (See module exports — only `revokeApiKey`,
    // which is one-way.) The contract is enforced by absence; here we
    // assert the verify result stays revoked across multiple checks.
    const a = await verifyBearer(db, issued.secret);
    const b = await verifyBearer(db, issued.secret);
    expect(a!.revoked).toBe(true);
    expect(b!.revoked).toBe(true);
  });
});

describe('listApiKeys', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns rows without secrets, including revoked rows, newest first', async () => {
    const first = await createApiKey(db, {
      keyType: 'test',
      name: 'old',
      argon: FAST_ARGON,
    });
    // Force a different created_at — better-sqlite3 + `new Date().toISOString()`
    // can collide at millisecond resolution if we go too fast.
    await new Promise((r) => setTimeout(r, 5));
    const second = await createApiKey(db, {
      keyType: 'live',
      name: 'new',
      argon: FAST_ARGON,
    });
    revokeApiKey(db, first.id);

    const rows = listApiKeys(db, OSS_ACCOUNT_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(rows[0]!.revoked_at).toBeNull();
    expect(rows[1]!.revoked_at).not.toBeNull();
    // No row carries the secret.
    for (const row of rows) {
      expect(row).not.toHaveProperty('secret');
      expect(row).not.toHaveProperty('hashed_secret');
    }
  });

  it('returns [] for an account with no keys', () => {
    ensureOssAccount(db);
    expect(listApiKeys(db, OSS_ACCOUNT_ID)).toEqual([]);
  });

  it('scopes results to the requested account', async () => {
    // Create the OSS account + one key, then a second account with one key.
    await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    db.prepare(
      `INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, ?)`,
    ).run('acct_other', 'tier_a', new Date().toISOString());
    const other = await createApiKey(db, {
      accountId: 'acct_other',
      keyType: 'live',
      argon: FAST_ARGON,
    });

    expect(listApiKeys(db, OSS_ACCOUNT_ID).map((r) => r.id)).not.toContain(
      other.id,
    );
    const otherList = listApiKeys(db, 'acct_other');
    expect(otherList).toHaveLength(1);
    expect(otherList[0]!.id).toBe(other.id);
  });
});

describe('apiKeyCount', () => {
  it('returns 0 on a freshly initialised DB', () => {
    const db = initDb(':memory:');
    expect(apiKeyCount(db)).toBe(0);
  });

  it('reflects new rows', async () => {
    const db = initDb(':memory:');
    await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    expect(apiKeyCount(db)).toBe(1);
    await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    expect(apiKeyCount(db)).toBe(2);
  });

  it('counts revoked rows too (presence of any row → auth required)', async () => {
    const db = initDb(':memory:');
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    revokeApiKey(db, issued.id);
    // Pre-condition for the middleware: once any row exists, even a revoked
    // one, the route stops being unauthenticated. The intent is "you've
    // configured auth," not "you have at least one usable key."
    expect(apiKeyCount(db)).toBe(1);
  });

  it('returns 0 (not throws) when the DB has no schema', () => {
    // Stub: object that throws on `.prepare()`. The middleware passes stub
    // DBs in some tests; apiKeyCount must absorb the failure rather than
    // 500ing the whole request.
    const stub = {
      prepare() {
        throw new Error('no schema');
      },
    } as unknown as ReturnType<typeof initDb>;
    expect(apiKeyCount(stub)).toBe(0);
  });
});
