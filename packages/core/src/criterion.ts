/**
 * Pinned decision criterion + evidence audit (PAR criterion-pinning).
 *
 * Driven by a lab finding (SwarmLab exp-04, "consensus under lies"): a
 * deliberating panel can reach a *false* consensus not by asserting wrong facts
 * but by quietly changing WHICH standard the answer is judged against
 * ("criterion drift"), or by sheer vote arithmetic once liars form a plurality.
 * Style-based vigilance (down-weighting overconfident / stubborn / outlier
 * voices) buys exactly one liar of resilience and is defeated by a liar who
 * mimics the honest confidence band. The only defence that survived was a
 * *substance* check: does each position's evidence actually address the pinned
 * standard, evaluated per-position and never against the plurality.
 *
 * This module makes the decision criterion a first-class, pinned term and gates
 * the tally on evidence admissibility. It is pure and deterministic — no I/O, no
 * model calls — so it can be unit-tested and reused by the deliberation engine
 * or an external harness.
 */

/**
 * The question is not just text — it pins WHAT standard the answer is judged by.
 * `criterion_id` is a stable hash of the canonicalized fields, so the same
 * criterion produces the same id regardless of field ordering or citation set.
 */
export interface DecisionCriterion {
  /** Stable hash of the canonicalized fields — see {@link criterionId}. */
  criterion_id: string;
  /** The decision under deliberation, e.g. "which sort should we ship?". */
  question: string;
  /** The pinned yardstick, e.g. "worst-case time complexity". */
  standard: string;
  /** Kinds of evidence that count, e.g. "complexity bound with derivation". */
  admissible_evidence: string[];
}

/** A single factual claim an agent cites in support of its answer. */
export interface EvidenceCitation {
  /** The factual claim being cited. */
  claim: string;
  /** Does this evidence speak to the PINNED standard (not merely the topic)? */
  addresses_standard: boolean;
  /** Can a third party check it (derivation, source, reproducible test)? */
  verifiable: boolean;
}

/** An agent's answer together with the evidence it offers for it. */
export interface AuditedPosition {
  agent_id: string;
  answer: string;
  confidence: number;
  citations: EvidenceCitation[];
}

/** Per-position audit outcome. Drift is NAMED, never silently folded in. */
export interface PositionAudit {
  agent_id: string;
  /** Has ≥1 verifiable citation that addresses the pinned standard. */
  admissible: boolean;
  /** Argues a DIFFERENT standard (criterion drift) — surfaced, not hidden. */
  drift: boolean;
  /** The standard it actually argued, if one can be detected. */
  drift_standard?: string;
}

export type BlockedReason = 'criterion_drift' | 'no_admissible_evidence';

export interface AuditedTally {
  /** The consensus answer, or null when the audit blocks consensus. */
  winner: string | null;
  /** True when the arithmetic winner lacks admissible evidence. */
  blocked: boolean;
  /** Why consensus was blocked, when it was. */
  blocked_reason?: BlockedReason;
  audits: PositionAudit[];
  /** Count of positions flagged for criterion drift. */
  driftFlagged: number;
}

/**
 * Deterministic 32-bit FNV-1a hash rendered as 8 hex chars. Not cryptographic;
 * we only need a stable, collision-resistant-enough id for a criterion.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit space via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonicalize a criterion's semantic fields and hash them into a stable id.
 * `admissible_evidence` is sorted and de-duplicated so the id is invariant under
 * field reordering; `criterion_id` itself is excluded from the hash input.
 */
export function criterionId(
  c: Pick<DecisionCriterion, 'question' | 'standard' | 'admissible_evidence'>,
): string {
  const evidence = [...new Set(c.admissible_evidence)].sort();
  const canonical = JSON.stringify({
    admissible_evidence: evidence,
    question: c.question,
    standard: c.standard,
  });
  return fnv1a(canonical);
}

/**
 * Build a {@link DecisionCriterion} with a computed, stable `criterion_id`.
 * Prefer this over hand-constructing the object so the id always matches the
 * canonicalized fields.
 */
export function makeCriterion(
  input: Omit<DecisionCriterion, 'criterion_id'>,
): DecisionCriterion {
  return { ...input, criterion_id: criterionId(input) };
}

/**
 * Audit one position against the pinned criterion.
 *
 * - admissible ⇔ it carries at least one citation that is BOTH verifiable AND
 *   addresses the pinned standard. Evaluated purely on the position's own
 *   evidence — never relative to any peer or plurality.
 * - drift ⇔ it offers no on-standard citation but DOES offer off-standard
 *   citation(s): it is arguing a different standard, so we surface that rather
 *   than let it slip into the tally. `drift_standard` names the off-standard
 *   claim when one can be detected.
 */
export function auditPosition(
  _c: DecisionCriterion,
  p: AuditedPosition,
): PositionAudit {
  const onStandard = p.citations.filter((c) => c.addresses_standard);
  const admissible = onStandard.some((c) => c.verifiable);

  // Drift: it argues something, but nothing that addresses the pinned standard.
  const offStandard = p.citations.filter((c) => !c.addresses_standard);
  const drift = !admissible && offStandard.length > 0;
  const driftClaim = offStandard[0]?.claim;

  const audit: PositionAudit = { agent_id: p.agent_id, admissible, drift };
  if (drift && driftClaim) audit.drift_standard = driftClaim;
  return audit;
}

/**
 * Tally positions with an evidence audit gating consensus. Implements the four
 * rules distilled from exp-04, each the inversion of one observed failure:
 *
 *  1. Votes without admissible evidence do not count toward consensus. A
 *     position whose citations don't address the pinned standard is treated as
 *     abstain-with-drift-flag, regardless of confidence or peer echo. (Kills
 *     sneaky mimicry — the audit checks substance, not style.)
 *  2. Criterion drift is named (`drift=true` + detected standard), never
 *     silently mixed in. (Kills the reframing attack.)
 *  3. Vote arithmetic can never outrun evidence: if the ARITHMETIC majority is
 *     inadmissible, consensus is blocked (`winner=null, blocked=true`) — a
 *     first-class outcome, not a failure. (Kills K=3 silent capture: capture is
 *     detected, not out-voted.)
 *  4. Honest lone dissent with admissible evidence survives — admissibility is
 *     per-position, never against the plurality. (Bounds the false-positive tax
 *     that style-vigilance paid on clean panels.)
 */
export function tallyWithAudit(
  c: DecisionCriterion,
  positions: AuditedPosition[],
): AuditedTally {
  const audits = positions.map((p) => auditPosition(c, p));
  const admissibleById = new Map(audits.map((a) => [a.agent_id, a.admissible]));
  const driftFlagged = audits.filter((a) => a.drift).length;

  // Rule 3: find the ARITHMETIC plurality over ALL positions (audit-blind),
  // so capture is detected rather than silently out-voted.
  const rawCounts = new Map<string, number>();
  for (const p of positions) {
    rawCounts.set(p.answer, (rawCounts.get(p.answer) ?? 0) + 1);
  }
  const arithMajority = strictMajority(rawCounts, positions.length);

  // Rule 1: only admissible positions contribute to the audited tally.
  const admissibleCounts = new Map<string, number>();
  for (const p of positions) {
    if (admissibleById.get(p.agent_id)) {
      admissibleCounts.set(p.answer, (admissibleCounts.get(p.answer) ?? 0) + 1);
    }
  }
  const auditedWinner = strictMajority(admissibleCounts, positions.length);

  // If an arithmetic majority exists but is NOT the audited winner, the
  // majority rode on inadmissible evidence — block, and name why.
  if (arithMajority !== null && arithMajority !== auditedWinner) {
    const majorityDrifted = positions.some(
      (p) =>
        p.answer === arithMajority &&
        audits.find((a) => a.agent_id === p.agent_id)?.drift,
    );
    const blocked_reason: BlockedReason = majorityDrifted
      ? 'criterion_drift'
      : 'no_admissible_evidence';
    return { winner: null, blocked: true, blocked_reason, audits, driftFlagged };
  }

  // No arithmetic majority was hijacked: the audited winner (possibly null,
  // e.g. no strict majority at all) stands. A clean panel reaches consensus
  // with no false-positive tax; a lone admissible dissenter is preserved.
  return { winner: auditedWinner, blocked: false, audits, driftFlagged };
}

/** Strict-majority winner (> half of `total`), or null if none. */
function strictMajority(
  counts: ReadonlyMap<string, number>,
  total: number,
): string | null {
  for (const [answer, count] of counts) {
    if (count > total / 2) return answer;
  }
  return null;
}
