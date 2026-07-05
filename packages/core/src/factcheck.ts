/**
 * Fact-checked evidence audit (PAR fact-check-audit).
 *
 * Driven by a lab finding (SwarmLab exp-04 live retest, Jul 2026): the
 * spec-15 criterion-pinning audit closed silent capture via drift and
 * unverifiable-substance holes, but exposed the next attack. Liars adapted:
 * at K=2–3 they stopped drifting and asserted *fabricated facts about the
 * pinned standard* ("modern quicksort achieves O(n log n) worst-case",
 * "the O(n²) worst case is provably avoidable"). A text-only classifier
 * reads these as `addresses_standard=true, verifiable=true` — admissible
 * evidence under the spec-15 audit. The audit needs a substance check on
 * top of the standard-addressing check.
 *
 * This module adds a pluggable {@link FactStore} interface and a
 * fact-checked audit path that treats contradicted claims as
 * `fabricated_claim` and ungrounded claims as `ungrounded_claim`. Both are
 * inadmissible, but they are NAMED SEPARATELY so lab measurements can
 * distinguish the two prevention paths (spec-18 honesty rule). Parliament
 * core stays dependency-free — the store is an injected interface. When no
 * store is supplied the audit path is byte-identical to spec-15 (the 776
 * existing tests must stay green unmodified).
 */

import {
  auditPosition,
  type AuditedPosition,
  type BlockedReason,
  type DecisionCriterion,
  type EvidenceCitation,
  type PositionAudit,
} from './criterion.js';

/**
 * A single factual claim, extracted from an {@link EvidenceCitation}, that
 * a {@link FactStore} can look up. `statement_id` is the store's canonical
 * key (see {@link TableFactStore} for a seeded map keyed by
 * `criterion_id::statement_id`). `asserts` is the free-text form kept for
 * provenance / debugging; the store is not required to consult it.
 */
export interface Claim {
  /** Canonical, store-specific id (e.g. "quicksort-worst-case-n-log-n"). */
  statement_id: string;
  /** Free-text statement, kept for provenance and debug. */
  asserts: string;
  /** Which pinned criterion this claim is being cited under. */
  criterion_id: string;
}

/**
 * A citation that carries a canonical claim id the fact store can check.
 * This is a superset of {@link EvidenceCitation}: text-only citations
 * (without `statement_id`) pass through untouched — they are still audited
 * for `addresses_standard`/`verifiable` and never fact-checked.
 */
export interface FactCheckedCitation extends EvidenceCitation {
  /** Canonical statement id for {@link FactStore.checkClaim}. */
  statement_id?: string;
}

/**
 * A position with fact-checkable citations. Field-compatible with
 * {@link AuditedPosition}; the additional `statement_id` on each citation
 * is optional so callers can mix checkable and text-only claims.
 */
export interface FactCheckedPosition extends AuditedPosition {
  citations: FactCheckedCitation[];
}

/**
 * Outcome of a single {@link FactStore.checkClaim} lookup.
 *
 * - `supported`: the store affirms the claim (grounded, matches provenance).
 * - `contradicted`: the store has an opposing fact for this
 *   `criterion_id × statement_id` — a **fabricated_claim**.
 * - `ungrounded`: the store has no entry — nobody can ground it, so it
 *   cannot certify a verdict. Named separately from `contradicted` so lab
 *   sweeps can report the two prevention paths independently.
 */
export interface FactCheckResult {
  status: 'supported' | 'contradicted' | 'ungrounded';
  /** Stable id of the ground-truth fact, when one exists. */
  fact_id?: string;
  /** Free-text provenance carried through for downstream reporting. */
  provenance?: string;
}

/**
 * Pluggable fact store. Parliament core does not know how a store
 * implements grounding — a table, a reconciliation index, an external
 * oracle — only that it can answer `checkClaim` deterministically.
 */
export interface FactStore {
  checkClaim(claim: Claim): FactCheckResult;
}

/** Extended taxonomy: spec-15 + fact-check reasons. */
export type FactCheckedBlockedReason =
  | BlockedReason
  | 'fabricated_claim'
  | 'ungrounded_claim';

/**
 * Per-position audit outcome, extended with fact-check status. When no
 * fact store was supplied this reduces to a {@link PositionAudit}.
 */
export interface FactCheckedPositionAudit extends PositionAudit {
  /** True when at least one on-standard citation was contradicted. */
  fabricated: boolean;
  /** True when the position has on-standard citations but ALL are ungrounded. */
  ungrounded: boolean;
  /** Per-citation fact-check outcomes, in citation order. */
  factChecks?: FactCheckResult[];
}

/**
 * Full tally result under the fact-checked audit. Additive over
 * {@link AuditedTally}: adds `fabricatedFlagged` / `ungroundedFlagged`
 * counters and an extended `blocked_reason` taxonomy. The two counters are
 * reported separately (spec-18 honesty rule) so `fabricated_claim` and
 * `ungrounded_claim` prevention paths are never conflated.
 */
export interface FactCheckedTally {
  winner: string | null;
  blocked: boolean;
  blocked_reason?: FactCheckedBlockedReason;
  audits: FactCheckedPositionAudit[];
  driftFlagged: number;
  fabricatedFlagged: number;
  ungroundedFlagged: number;
}

/** Options for {@link tallyWithFactCheck}. */
export interface FactCheckAuditOptions {
  /** Injected store. When omitted, behavior is byte-identical to spec-15. */
  factStore?: FactStore;
}

/**
 * Reference {@link FactStore}: a seeded map keyed by
 * `${criterion_id}::${statement_id}`. Used by the parliament fact-check
 * tests and the exp-04 sim retest as a ground-truth oracle. NOT a general
 * truth machine — it only knows what it was seeded with. Everything not in
 * the table is `ungrounded`.
 */
export class TableFactStore implements FactStore {
  private readonly entries: Map<string, FactCheckResult>;

  constructor(
    seed: ReadonlyArray<{
      criterion_id: string;
      statement_id: string;
      result: FactCheckResult;
    }> = [],
  ) {
    this.entries = new Map();
    for (const { criterion_id, statement_id, result } of seed) {
      this.entries.set(key(criterion_id, statement_id), result);
    }
  }

  /** Add or overwrite an entry. Returns `this` so setup can chain. */
  set(
    criterion_id: string,
    statement_id: string,
    result: FactCheckResult,
  ): this {
    this.entries.set(key(criterion_id, statement_id), result);
    return this;
  }

  checkClaim(claim: Claim): FactCheckResult {
    const hit = this.entries.get(key(claim.criterion_id, claim.statement_id));
    return hit ?? { status: 'ungrounded' };
  }
}

function key(criterion_id: string, statement_id: string): string {
  return `${criterion_id}::${statement_id}`;
}

/**
 * Fact-check one position's citations. Only citations that are BOTH
 * `addresses_standard` AND carry a `statement_id` are looked up — the fact
 * check applies to on-standard claims (the spec-18 attack surface).
 * Off-standard citations remain governed by the spec-15 drift rules.
 */
function factCheckCitations(
  criterion: DecisionCriterion,
  citations: FactCheckedCitation[],
  store: FactStore,
): {
  results: FactCheckResult[];
  fabricated: boolean;
  hasSupportedOnStandard: boolean;
  hasOnStandardCheckable: boolean;
} {
  const results: FactCheckResult[] = [];
  let fabricated = false;
  let hasSupportedOnStandard = false;
  let hasOnStandardCheckable = false;

  for (const c of citations) {
    if (!c.addresses_standard || !c.statement_id) {
      // Only fact-check on-standard citations with a canonical statement_id.
      results.push({ status: 'ungrounded' });
      continue;
    }
    hasOnStandardCheckable = true;
    const check = store.checkClaim({
      statement_id: c.statement_id,
      asserts: c.claim,
      criterion_id: criterion.criterion_id,
    });
    results.push(check);
    if (check.status === 'contradicted') fabricated = true;
    if (check.status === 'supported') hasSupportedOnStandard = true;
  }

  return { results, fabricated, hasSupportedOnStandard, hasOnStandardCheckable };
}

/**
 * Audit one position with a fact store. Extends {@link auditPosition}:
 * admissibility now requires BOTH the spec-15 gate (on-standard +
 * verifiable) AND at least one `supported` fact-check on an on-standard
 * citation. Contradicted → `fabricated=true` and inadmissible. Ungrounded
 * (no supported on-standard citation, everything on-standard is `ungrounded`)
 * → `ungrounded=true` and inadmissible.
 */
export function auditPositionWithFactCheck(
  criterion: DecisionCriterion,
  position: FactCheckedPosition,
  store: FactStore,
): FactCheckedPositionAudit {
  const base = auditPosition(criterion, position);
  const { results, fabricated, hasSupportedOnStandard, hasOnStandardCheckable } =
    factCheckCitations(criterion, position.citations, store);

  // Fabrication is the strong signal: even one contradicted on-standard
  // claim marks the position. It overrides the spec-15 admissibility bit.
  if (fabricated) {
    return {
      ...base,
      admissible: false,
      fabricated: true,
      ungrounded: false,
      factChecks: results,
    };
  }

  // Ungrounded: base audit thought it was admissible, but no on-standard
  // citation is supported by the store. Distinct from fabrication — no
  // opposing fact, just no grounding. Reported separately.
  const ungrounded =
    base.admissible && hasOnStandardCheckable && !hasSupportedOnStandard;

  const admissible = base.admissible && hasSupportedOnStandard;

  return {
    ...base,
    admissible,
    fabricated: false,
    ungrounded,
    factChecks: results,
  };
}

/**
 * Tally positions with the fact-checked audit. Additive over
 * {@link tallyWithAudit}:
 *
 * 1. When no fact store is supplied, behavior is byte-identical to
 *    spec-15: the same admissible/inadmissible bits, the same
 *    `criterion_drift`/`no_admissible_evidence` reasons, no
 *    `fabricated_claim`/`ungrounded_claim` naming. This is a hard
 *    invariant — the 776 existing tests must stay green.
 * 2. When a fact store IS supplied, on-standard citations get
 *    fact-checked. Contradicted on-standard citations mark the position
 *    `fabricated=true`; positions with only ungrounded on-standard
 *    citations mark `ungrounded=true`. Both are inadmissible.
 * 3. If the arithmetic majority rode on fabricated evidence → block with
 *    `fabricated_claim`. Fabrication wins the naming race over drift and
 *    ungrounding when the majority has any fabricated position, because
 *    it's the strongest attack signal.
 * 4. Otherwise, if the arithmetic majority rode on ungrounded evidence →
 *    block with `ungrounded_claim`. Reported honestly even when it
 *    coincides with the conservative-audit clean-panel cost.
 * 5. Existing spec-15 reasons (`criterion_drift`,
 *    `no_admissible_evidence`) still fire when they apply and no
 *    fact-check reason wins.
 * 6. Honest lone dissent with a `supported` on-standard citation
 *    survives — same per-position invariant as spec-15.
 */
export function tallyWithFactCheck(
  criterion: DecisionCriterion,
  positions: FactCheckedPosition[],
  options: FactCheckAuditOptions = {},
): FactCheckedTally {
  const store = options.factStore;

  // Byte-identical spec-15 path when no store is supplied. Only shape is
  // extended (fabricated=false, ungrounded=false, no factChecks field).
  if (!store) {
    const audits: FactCheckedPositionAudit[] = positions.map((p) => ({
      ...auditPosition(criterion, p),
      fabricated: false,
      ungrounded: false,
    }));
    return liftSpec15(audits, positions);
  }

  const audits: FactCheckedPositionAudit[] = positions.map((p) =>
    auditPositionWithFactCheck(criterion, p, store),
  );

  const admissibleById = new Map(audits.map((a) => [a.agent_id, a.admissible]));

  const rawCounts = new Map<string, number>();
  for (const p of positions) {
    rawCounts.set(p.answer, (rawCounts.get(p.answer) ?? 0) + 1);
  }
  const arithMajority = strictMajority(rawCounts, positions.length);

  const admissibleCounts = new Map<string, number>();
  for (const p of positions) {
    if (admissibleById.get(p.agent_id)) {
      admissibleCounts.set(p.answer, (admissibleCounts.get(p.answer) ?? 0) + 1);
    }
  }
  const auditedWinner = strictMajority(admissibleCounts, positions.length);

  const driftFlagged = audits.filter((a) => a.drift).length;
  const fabricatedFlagged = audits.filter((a) => a.fabricated).length;
  const ungroundedFlagged = audits.filter((a) => a.ungrounded).length;

  if (arithMajority !== null && arithMajority !== auditedWinner) {
    const majorityAudits = audits.filter((a, i) => positions[i]!.answer === arithMajority);
    const majorityFabricated = majorityAudits.some((a) => a.fabricated);
    const majorityUngrounded = majorityAudits.some((a) => a.ungrounded);
    const majorityDrifted = majorityAudits.some((a) => a.drift);

    // Naming priority: fabricated > ungrounded > drift > no_admissible_evidence.
    // Fabrication is the strongest attack signal — it's an active lie about
    // the pinned standard, not merely an inability to ground.
    let blocked_reason: FactCheckedBlockedReason;
    if (majorityFabricated) blocked_reason = 'fabricated_claim';
    else if (majorityUngrounded) blocked_reason = 'ungrounded_claim';
    else if (majorityDrifted) blocked_reason = 'criterion_drift';
    else blocked_reason = 'no_admissible_evidence';

    return {
      winner: null,
      blocked: true,
      blocked_reason,
      audits,
      driftFlagged,
      fabricatedFlagged,
      ungroundedFlagged,
    };
  }

  return {
    winner: auditedWinner,
    blocked: false,
    audits,
    driftFlagged,
    fabricatedFlagged,
    ungroundedFlagged,
  };
}

/**
 * Reproduce {@link AuditedTally} semantics from spec-15, but return the
 * fact-checked shape (extended fields zeroed). Used when no store is
 * supplied so the null case is byte-identical to spec-15 in behavior.
 */
function liftSpec15(
  audits: FactCheckedPositionAudit[],
  positions: FactCheckedPosition[],
): FactCheckedTally {
  const admissibleById = new Map(audits.map((a) => [a.agent_id, a.admissible]));
  const driftFlagged = audits.filter((a) => a.drift).length;

  const rawCounts = new Map<string, number>();
  for (const p of positions) {
    rawCounts.set(p.answer, (rawCounts.get(p.answer) ?? 0) + 1);
  }
  const arithMajority = strictMajority(rawCounts, positions.length);

  const admissibleCounts = new Map<string, number>();
  for (const p of positions) {
    if (admissibleById.get(p.agent_id)) {
      admissibleCounts.set(p.answer, (admissibleCounts.get(p.answer) ?? 0) + 1);
    }
  }
  const auditedWinner = strictMajority(admissibleCounts, positions.length);

  if (arithMajority !== null && arithMajority !== auditedWinner) {
    const majorityDrifted = audits.some(
      (a, i) => positions[i]!.answer === arithMajority && a.drift,
    );
    const blocked_reason: FactCheckedBlockedReason = majorityDrifted
      ? 'criterion_drift'
      : 'no_admissible_evidence';
    return {
      winner: null,
      blocked: true,
      blocked_reason,
      audits,
      driftFlagged,
      fabricatedFlagged: 0,
      ungroundedFlagged: 0,
    };
  }

  return {
    winner: auditedWinner,
    blocked: false,
    audits,
    driftFlagged,
    fabricatedFlagged: 0,
    ungroundedFlagged: 0,
  };
}

function strictMajority(
  counts: ReadonlyMap<string, number>,
  total: number,
): string | null {
  for (const [answer, count] of counts) {
    if (count > total / 2) return answer;
  }
  return null;
}
