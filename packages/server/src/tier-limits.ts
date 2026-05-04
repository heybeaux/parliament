/**
 * PAR-35 / M1 T1.3 — static tier → rate-limit policy table.
 *
 * Maps each `accounts.tier` value to the four levers PAR-35 enforces:
 *   - envelopeLimit:    deliberations allowed per billing period (Pro = 350,
 *                       Team = 2000/seat). `null` means unlimited (free /
 *                       oss / enterprise self-host).
 *   - concurrencyLimit: max in-flight deliberations per account (Pro = 1,
 *                       Team = 3 per seat). `null` means unlimited.
 *   - burstPerSecond:   per-second anti-abuse cap. AC fixes this at 10 RPS
 *                       across all paying tiers. OSS keeps the legacy
 *                       per-IP limiter and bypasses this layer.
 *   - periodMs:         length of the billing window for envelope checks.
 *                       30 days for paid tiers; not used when envelopeLimit
 *                       is null.
 *
 * Why a static table and not a DB row: tier policy changes are deploy-time
 * decisions (pricing/marketing), not runtime config. Folding them into DB
 * rows would add a migration for every pricing tweak. This file is the
 * single source of truth — bump the constants, redeploy, done.
 *
 * Seat-multiplied limits (Team) are computed at lookup time by passing
 * `seats` to {@link resolveTierPolicy}. The table itself stores per-seat
 * values; the multiplier lives in the resolver.
 */

export type AccountTier = 'oss' | 'free' | 'pro' | 'team' | 'enterprise';

export interface TierPolicy {
  /** Deliberations allowed per billing period. `null` = unlimited. */
  envelopeLimit: number | null;
  /** Max in-flight deliberations. `null` = unlimited. */
  concurrencyLimit: number | null;
  /** Per-second burst cap (token-bucket refill rate). `null` = unlimited. */
  burstPerSecond: number | null;
  /** Length of the billing period in milliseconds. */
  periodMs: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const BURST_PER_SECOND = 10;

/**
 * Per-tier defaults. `team` values are PER SEAT; the resolver multiplies
 * envelope and concurrency by the seat count when the tier is `team`.
 *
 * `oss` and `enterprise` are unlimited on envelope/concurrency by default
 * — self-host operators set their own ceilings via the legacy per-IP
 * limiter (or, for enterprise, a contract-driven overlay we'll add later).
 */
const TIER_DEFAULTS: Record<AccountTier, TierPolicy> = {
  oss: {
    envelopeLimit: null,
    concurrencyLimit: null,
    burstPerSecond: null,
    periodMs: THIRTY_DAYS_MS,
  },
  free: {
    envelopeLimit: 25,
    concurrencyLimit: 1,
    burstPerSecond: BURST_PER_SECOND,
    periodMs: THIRTY_DAYS_MS,
  },
  pro: {
    envelopeLimit: 350,
    concurrencyLimit: 1,
    burstPerSecond: BURST_PER_SECOND,
    periodMs: THIRTY_DAYS_MS,
  },
  team: {
    envelopeLimit: 2000,
    concurrencyLimit: 3,
    burstPerSecond: BURST_PER_SECOND,
    periodMs: THIRTY_DAYS_MS,
  },
  enterprise: {
    envelopeLimit: null,
    concurrencyLimit: null,
    burstPerSecond: null,
    periodMs: THIRTY_DAYS_MS,
  },
};

/**
 * Resolve the effective policy for an account. `seats` only multiplies for
 * the Team tier (per AC: "2000/seat", "3 in-flight per seat"); other tiers
 * ignore it. Defaults to `1` so single-account lookups can omit the arg.
 *
 * Unknown tiers fall back to the most restrictive paid tier (`free`) so a
 * bad data row fails closed rather than handing out unlimited usage.
 */
export function resolveTierPolicy(tier: string, seats = 1): TierPolicy {
  const known = TIER_DEFAULTS[tier as AccountTier];
  if (known === undefined) return TIER_DEFAULTS.free;
  if (tier !== 'team') return known;
  // Team: multiply per-seat values by seat count.
  return {
    ...known,
    envelopeLimit: known.envelopeLimit === null ? null : known.envelopeLimit * Math.max(1, seats),
    concurrencyLimit:
      known.concurrencyLimit === null ? null : known.concurrencyLimit * Math.max(1, seats),
  };
}

/**
 * Returns true when the policy enforces nothing — used by the middleware
 * to short-circuit header-emission and bucket-bookkeeping for unlimited
 * tiers (oss / enterprise default).
 */
export function isUnlimitedPolicy(policy: TierPolicy): boolean {
  return (
    policy.envelopeLimit === null &&
    policy.concurrencyLimit === null &&
    policy.burstPerSecond === null
  );
}
