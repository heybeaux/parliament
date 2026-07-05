import { describe, it, expect } from 'vitest';
import {
  auditPosition,
  criterionId,
  makeCriterion,
  tallyWithAudit,
  type AuditedPosition,
  type DecisionCriterion,
  type EvidenceCitation,
} from '../criterion.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRITERION: DecisionCriterion = makeCriterion({
  question: 'which sort should we ship?',
  standard: 'worst-case time complexity',
  admissible_evidence: ['complexity bound with derivation'],
});

function cite(
  claim: string,
  addresses_standard: boolean,
  verifiable: boolean,
): EvidenceCitation {
  return { claim, addresses_standard, verifiable };
}

/** On-standard, verifiable citation — the honest, admissible pattern. */
function onStandard(claim = 'O(n log n) worst case, proven'): EvidenceCitation {
  return cite(claim, true, true);
}

/** Off-standard citation — the criterion-drift pattern (average-case reframe). */
function offStandard(
  claim = 'faster average-case in practice',
): EvidenceCitation {
  return cite(claim, false, true);
}

function pos(
  agent_id: string,
  answer: string,
  confidence: number,
  citations: EvidenceCitation[],
): AuditedPosition {
  return { agent_id, answer, confidence, citations };
}

// ---------------------------------------------------------------------------
// (a) sneaky liar with inadmissible evidence is flagged despite honest-band conf
// ---------------------------------------------------------------------------

describe('sneaky liar in honest confidence band', () => {
  it('is flagged for drift and excluded despite confidence sitting in the honest band', () => {
    // Honest agents: confidence 0.72 / 0.80 — the "honest band". The liar mimics
    // it at 0.78 but its evidence argues a DIFFERENT standard (average-case).
    const positions = [
      pos('h0', 'heapsort', 0.72, [onStandard()]),
      pos('h1', 'heapsort', 0.8, [onStandard()]),
      pos('x0', 'quicksort', 0.78, [offStandard()]),
    ];
    const audit = auditPosition(CRITERION, positions[2]!);
    expect(audit.admissible).toBe(false);
    expect(audit.drift).toBe(true);
    expect(audit.drift_standard).toBe('faster average-case in practice');

    const tally = tallyWithAudit(CRITERION, positions);
    // The honest majority still wins on substance; the liar's vote never counts.
    expect(tally.winner).toBe('heapsort');
    expect(tally.blocked).toBe(false);
    expect(tally.driftFlagged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (b) K=3 arithmetic majority with drift → blocked, criterion_drift
// ---------------------------------------------------------------------------

describe('K=3 arithmetic majority built on drift', () => {
  it('blocks consensus with blocked_reason=criterion_drift', () => {
    // 3 liars form the arithmetic majority (5 agents), all arguing off-standard.
    const positions = [
      pos('h0', 'heapsort', 0.75, [onStandard()]),
      pos('h1', 'heapsort', 0.7, [onStandard()]),
      pos('x0', 'quicksort', 0.78, [offStandard()]),
      pos('x1', 'quicksort', 0.8, [offStandard()]),
      pos('x2', 'quicksort', 0.76, [offStandard()]),
    ];
    const tally = tallyWithAudit(CRITERION, positions);
    expect(tally.winner).toBeNull();
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('criterion_drift');
    expect(tally.driftFlagged).toBe(3);
  });

  it('blocks with no_admissible_evidence when the majority simply lacks verifiable citations', () => {
    // Majority answers the RIGHT standard but with unverifiable evidence — not
    // drift, just inadmissible. Still cannot outrun evidence.
    const unverifiable = cite('trust me, O(n log n)', true, false);
    const positions = [
      pos('h0', 'heapsort', 0.7, [onStandard()]),
      pos('x0', 'quicksort', 0.8, [unverifiable]),
      pos('x1', 'quicksort', 0.8, [unverifiable]),
      pos('x2', 'quicksort', 0.8, [unverifiable]),
    ];
    const tally = tallyWithAudit(CRITERION, positions);
    expect(tally.winner).toBeNull();
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('no_admissible_evidence');
    expect(tally.driftFlagged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) honest lone dissenter with verifiable on-standard citation stays admissible
// ---------------------------------------------------------------------------

describe('honest lone dissenter', () => {
  it('stays admissible even when parked off the plurality', () => {
    // One honest agent dissents from a same-answer pair, but its evidence is
    // on-standard and verifiable. Admissibility is per-position, never vs peers.
    const positions = [
      pos('x0', 'quicksort', 0.78, [offStandard()]),
      pos('x1', 'quicksort', 0.78, [offStandard()]),
      pos('h0', 'heapsort', 0.7, [onStandard()]),
    ];
    const audit = auditPosition(CRITERION, positions[2]!);
    expect(audit.admissible).toBe(true);
    expect(audit.drift).toBe(false);

    // Arithmetic majority (quicksort) is all drift → blocked, not out-voted.
    const tally = tallyWithAudit(CRITERION, positions);
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('criterion_drift');
  });
});

// ---------------------------------------------------------------------------
// (d) K=0 all-honest panel reaches unblocked consensus (no false-positive tax)
// ---------------------------------------------------------------------------

describe('K=0 all-honest panel', () => {
  it('reaches unblocked consensus with no false-positive tax', () => {
    const positions = [
      pos('h0', 'heapsort', 0.72, [onStandard()]),
      pos('h1', 'heapsort', 0.68, [onStandard('O(n log n) worst case')]),
      pos('h2', 'heapsort', 0.8, [onStandard('proven bound')]),
    ];
    const tally = tallyWithAudit(CRITERION, positions);
    expect(tally.winner).toBe('heapsort');
    expect(tally.blocked).toBe(false);
    expect(tally.blocked_reason).toBeUndefined();
    expect(tally.driftFlagged).toBe(0);
  });

  it('preserves a lone admissible dissenter without blocking a clean split', () => {
    // No arithmetic majority at all: nobody is captured, so nothing is blocked.
    const positions = [
      pos('h0', 'heapsort', 0.7, [onStandard()]),
      pos('h1', 'mergesort', 0.7, [onStandard('O(n log n) worst case, proven')]),
    ];
    const tally = tallyWithAudit(CRITERION, positions);
    expect(tally.blocked).toBe(false);
    expect(tally.winner).toBeNull(); // no strict majority, but not blocked
  });
});

// ---------------------------------------------------------------------------
// (e) criterion_id is stable under field reordering
// ---------------------------------------------------------------------------

describe('criterion_id stability', () => {
  it('is invariant under admissible_evidence reordering and duplication', () => {
    const a = criterionId({
      question: 'which sort should we ship?',
      standard: 'worst-case time complexity',
      admissible_evidence: ['complexity bound with derivation', 'reproducible benchmark'],
    });
    const b = criterionId({
      question: 'which sort should we ship?',
      standard: 'worst-case time complexity',
      admissible_evidence: [
        'reproducible benchmark',
        'complexity bound with derivation',
        'reproducible benchmark', // duplicate — must not change the id
      ],
    });
    expect(a).toBe(b);
  });

  it('changes when the pinned standard changes', () => {
    const a = criterionId({
      question: 'q',
      standard: 'worst-case time complexity',
      admissible_evidence: ['x'],
    });
    const b = criterionId({
      question: 'q',
      standard: 'average-case time complexity',
      admissible_evidence: ['x'],
    });
    expect(a).not.toBe(b);
  });

  it('makeCriterion computes a criterion_id matching criterionId()', () => {
    const c = makeCriterion({
      question: 'q',
      standard: 's',
      admissible_evidence: ['e'],
    });
    expect(c.criterion_id).toBe(
      criterionId({ question: 'q', standard: 's', admissible_evidence: ['e'] }),
    );
  });
});
