import { describe, it, expect } from 'vitest';
import {
  makeCriterion,
  tallyWithAudit,
  type AuditedPosition,
  type DecisionCriterion,
} from '../criterion.js';
import {
  TableFactStore,
  auditPositionWithFactCheck,
  tallyWithFactCheck,
  type FactCheckedCitation,
  type FactCheckedPosition,
} from '../factcheck.js';

// ---------------------------------------------------------------------------
// Shared fixtures — mirror the exp-04 pinned criterion so the fact-check tests
// speak the same language as the live retest.
// ---------------------------------------------------------------------------

const CRITERION: DecisionCriterion = makeCriterion({
  question: 'which sort should we ship?',
  standard: 'worst-case time complexity',
  admissible_evidence: ['complexity bound with derivation'],
});

// Canonical statement ids used by the seeded ground-truth store.
const HEAPSORT_BOUND = 'heapsort-nlogn-worst-case';
const QUICKSORT_BOUND = 'quicksort-nlogn-worst-case';

function seedStore(): TableFactStore {
  return new TableFactStore()
    .set(CRITERION.criterion_id, HEAPSORT_BOUND, {
      status: 'supported',
      fact_id: 'fact-heap-worst-nlogn',
      provenance: 'CLRS §6.4, Williams 1964',
    })
    .set(CRITERION.criterion_id, QUICKSORT_BOUND, {
      status: 'contradicted',
      fact_id: 'fact-quick-worst-n2',
      provenance: 'CLRS §7.2 — quicksort worst case is O(n²)',
    });
}

function fcCite(opts: {
  claim: string;
  addresses_standard: boolean;
  verifiable: boolean;
  statement_id?: string;
}): FactCheckedCitation {
  return { ...opts };
}

function fcPos(
  agent_id: string,
  answer: string,
  confidence: number,
  citations: FactCheckedCitation[],
): FactCheckedPosition {
  return { agent_id, answer, confidence, citations };
}

// ---------------------------------------------------------------------------
// (a) supported path: honest agents grounded in the store stay admissible
// ---------------------------------------------------------------------------

describe('fact-checked audit — supported path', () => {
  it('admits a position whose on-standard citation is supported by the store', () => {
    const store = seedStore();
    const p = fcPos('h0', 'heapsort', 0.72, [
      fcCite({
        claim: 'heapsort O(n log n) worst case, proven',
        addresses_standard: true,
        verifiable: true,
        statement_id: HEAPSORT_BOUND,
      }),
    ]);
    const audit = auditPositionWithFactCheck(CRITERION, p, store);
    expect(audit.admissible).toBe(true);
    expect(audit.fabricated).toBe(false);
    expect(audit.ungrounded).toBe(false);
    expect(audit.factChecks?.[0]?.status).toBe('supported');
    expect(audit.factChecks?.[0]?.provenance).toContain('CLRS');
  });
});

// ---------------------------------------------------------------------------
// (b) contradicted path: on-standard fabrication → fabricated_claim
// ---------------------------------------------------------------------------

describe('fact-checked audit — contradicted (adapted-attack recipe)', () => {
  it('marks a position with a contradicted on-standard claim as fabricated + inadmissible', () => {
    // The adapted-attack recipe: liar emits `addresses_standard=true,
    // verifiable=true` and cites a canonical statement whose ground truth
    // says the opposite. spec-15 would have admitted this; the fact-check
    // catches it.
    const store = seedStore();
    const p = fcPos('x0', 'quicksort', 0.78, [
      fcCite({
        claim: 'modern quicksort achieves O(n log n) worst-case',
        addresses_standard: true,
        verifiable: true,
        statement_id: QUICKSORT_BOUND,
      }),
    ]);
    const audit = auditPositionWithFactCheck(CRITERION, p, store);
    expect(audit.admissible).toBe(false);
    expect(audit.fabricated).toBe(true);
    expect(audit.ungrounded).toBe(false);
    expect(audit.factChecks?.[0]?.status).toBe('contradicted');
  });

  it('blocks a fabricated-claim majority with blocked_reason=fabricated_claim', () => {
    // 3 fabricator liars vs 2 grounded honest — arithmetic majority is the
    // fabrication. The audit must name the reason as fabricated_claim,
    // distinct from criterion_drift, so lab measurements can tell which
    // prevention path fired.
    const store = seedStore();
    const positions: FactCheckedPosition[] = [
      fcPos('h0', 'heapsort', 0.75, [
        fcCite({
          claim: 'heapsort O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
      fcPos('h1', 'heapsort', 0.7, [
        fcCite({
          claim: 'heapsort O(n log n) worst case, proven',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
      fcPos('x0', 'quicksort', 0.78, [
        fcCite({
          claim: 'quicksort O(n log n) worst-case, modern impl',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('x1', 'quicksort', 0.8, [
        fcCite({
          claim: 'the O(n²) worst case is provably avoidable',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('x2', 'quicksort', 0.76, [
        fcCite({
          claim: 'introspective quicksort makes worst-case n log n',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
    ];
    const tally = tallyWithFactCheck(CRITERION, positions, {
      factStore: store,
    });
    expect(tally.winner).toBeNull();
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('fabricated_claim');
    expect(tally.fabricatedFlagged).toBe(3);
    expect(tally.ungroundedFlagged).toBe(0);
    // driftFlagged is spec-15 drift, orthogonal to fact-check.
    expect(tally.driftFlagged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) ungrounded path: on-standard claim not in the store → ungrounded_claim
// ---------------------------------------------------------------------------

describe('fact-checked audit — ungrounded (conservative choice)', () => {
  it('marks an on-standard claim without a store entry as ungrounded + inadmissible', () => {
    // No opposing fact — just no grounding. Reported separately from
    // fabrication so we can measure the conservative-audit clean-panel cost.
    const store = seedStore();
    const p = fcPos('u0', 'timsort', 0.72, [
      fcCite({
        claim: 'timsort O(n log n) worst case',
        addresses_standard: true,
        verifiable: true,
        statement_id: 'timsort-worst-case-nlogn', // not in the seeded store
      }),
    ]);
    const audit = auditPositionWithFactCheck(CRITERION, p, store);
    expect(audit.admissible).toBe(false);
    expect(audit.fabricated).toBe(false);
    expect(audit.ungrounded).toBe(true);
  });

  it('blocks a majority riding on ungrounded evidence with ungrounded_claim', () => {
    const store = seedStore();
    const positions: FactCheckedPosition[] = [
      fcPos('h0', 'heapsort', 0.7, [
        fcCite({
          claim: 'heapsort O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
      fcPos('u0', 'timsort', 0.72, [
        fcCite({
          claim: 'timsort O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: 'timsort-worst-case-nlogn',
        }),
      ]),
      fcPos('u1', 'timsort', 0.7, [
        fcCite({
          claim: 'timsort O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: 'timsort-worst-case-nlogn',
        }),
      ]),
    ];
    const tally = tallyWithFactCheck(CRITERION, positions, {
      factStore: store,
    });
    expect(tally.winner).toBeNull();
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('ungrounded_claim');
    expect(tally.ungroundedFlagged).toBe(2);
    expect(tally.fabricatedFlagged).toBe(0);
  });

  it('reports ungrounded separately from fabricated when both are in the majority', () => {
    // Two fabricators + one ungrounded position share the same wrong answer.
    // fabricated wins the naming race (stronger attack signal), but the
    // ungrounded count is still reported honestly.
    const store = seedStore();
    const positions: FactCheckedPosition[] = [
      fcPos('h0', 'heapsort', 0.7, [
        fcCite({
          claim: 'heapsort proven O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
      fcPos('h1', 'heapsort', 0.7, [
        fcCite({
          claim: 'heapsort O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
      fcPos('x0', 'quicksort', 0.8, [
        fcCite({
          claim: 'quicksort O(n log n) worst-case',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('x1', 'quicksort', 0.8, [
        fcCite({
          claim: 'the O(n²) worst case is provably avoidable',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('u0', 'quicksort', 0.72, [
        fcCite({
          claim: 'some other unproven quicksort claim',
          addresses_standard: true,
          verifiable: true,
          statement_id: 'quicksort-unlisted-claim',
        }),
      ]),
    ];
    const tally = tallyWithFactCheck(CRITERION, positions, {
      factStore: store,
    });
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('fabricated_claim');
    expect(tally.fabricatedFlagged).toBe(2);
    expect(tally.ungroundedFlagged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) honest lone dissent with grounded evidence still survives
// ---------------------------------------------------------------------------

describe('fact-checked audit — honest lone dissent survives', () => {
  it('preserves an honest lone dissenter with a supported on-standard citation', () => {
    // 2 fabricator liars, 1 honest with a supported on-standard citation.
    // The arithmetic majority is the fabrication; the audit blocks it and
    // the honest dissenter's admissibility is per-position, unaffected.
    const store = seedStore();
    const positions: FactCheckedPosition[] = [
      fcPos('x0', 'quicksort', 0.78, [
        fcCite({
          claim: 'quicksort O(n log n) worst-case',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('x1', 'quicksort', 0.8, [
        fcCite({
          claim: 'the O(n²) worst case is provably avoidable',
          addresses_standard: true,
          verifiable: true,
          statement_id: QUICKSORT_BOUND,
        }),
      ]),
      fcPos('h0', 'heapsort', 0.7, [
        fcCite({
          claim: 'heapsort proven O(n log n) worst case',
          addresses_standard: true,
          verifiable: true,
          statement_id: HEAPSORT_BOUND,
        }),
      ]),
    ];
    const tally = tallyWithFactCheck(CRITERION, positions, {
      factStore: store,
    });
    // Arithmetic majority is quicksort; audited majority does not exist.
    // Blocked, fabricated_claim. Honest dissenter still admissible.
    expect(tally.blocked).toBe(true);
    expect(tally.blocked_reason).toBe('fabricated_claim');
    const honest = tally.audits.find((a) => a.agent_id === 'h0');
    expect(honest?.admissible).toBe(true);
    expect(honest?.fabricated).toBe(false);
    expect(honest?.ungrounded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) no-store backward compatibility: byte-identical to spec-15 semantics
// ---------------------------------------------------------------------------

describe('fact-checked audit — no store supplied (spec-15 parity)', () => {
  it('produces the same winner/blocked/reason as tallyWithAudit for all key spec-15 shapes', () => {
    // Exact shapes lifted from the spec-15 test suite, run through both
    // paths. tallyWithFactCheck without a store must produce the same
    // winner/blocked/blocked_reason/driftFlagged as tallyWithAudit.
    const shapes: AuditedPosition[][] = [
      // sneaky drift, honest majority stands.
      [
        {
          agent_id: 'h0',
          answer: 'heapsort',
          confidence: 0.72,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'h1',
          answer: 'heapsort',
          confidence: 0.8,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'x0',
          answer: 'quicksort',
          confidence: 0.78,
          citations: [
            {
              claim: 'faster average-case in practice',
              addresses_standard: false,
              verifiable: true,
            },
          ],
        },
      ],
      // K=3 drift capture, blocked criterion_drift.
      [
        {
          agent_id: 'h0',
          answer: 'heapsort',
          confidence: 0.75,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'h1',
          answer: 'heapsort',
          confidence: 0.7,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'x0',
          answer: 'quicksort',
          confidence: 0.78,
          citations: [
            {
              claim: 'faster average-case in practice',
              addresses_standard: false,
              verifiable: true,
            },
          ],
        },
        {
          agent_id: 'x1',
          answer: 'quicksort',
          confidence: 0.8,
          citations: [
            {
              claim: 'faster average-case in practice',
              addresses_standard: false,
              verifiable: true,
            },
          ],
        },
        {
          agent_id: 'x2',
          answer: 'quicksort',
          confidence: 0.76,
          citations: [
            {
              claim: 'faster average-case in practice',
              addresses_standard: false,
              verifiable: true,
            },
          ],
        },
      ],
      // Unverifiable majority — no_admissible_evidence.
      [
        {
          agent_id: 'h0',
          answer: 'heapsort',
          confidence: 0.7,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'x0',
          answer: 'quicksort',
          confidence: 0.8,
          citations: [
            { claim: 'trust me, O(n log n)', addresses_standard: true, verifiable: false },
          ],
        },
        {
          agent_id: 'x1',
          answer: 'quicksort',
          confidence: 0.8,
          citations: [
            { claim: 'trust me, O(n log n)', addresses_standard: true, verifiable: false },
          ],
        },
        {
          agent_id: 'x2',
          answer: 'quicksort',
          confidence: 0.8,
          citations: [
            { claim: 'trust me, O(n log n)', addresses_standard: true, verifiable: false },
          ],
        },
      ],
      // Clean K=0 panel, unblocked consensus, no false-positive tax.
      [
        {
          agent_id: 'h0',
          answer: 'heapsort',
          confidence: 0.72,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'h1',
          answer: 'heapsort',
          confidence: 0.68,
          citations: [
            { claim: 'O(n log n) worst case', addresses_standard: true, verifiable: true },
          ],
        },
        {
          agent_id: 'h2',
          answer: 'heapsort',
          confidence: 0.8,
          citations: [
            { claim: 'proven bound', addresses_standard: true, verifiable: true },
          ],
        },
      ],
    ];

    for (const positions of shapes) {
      const spec15 = tallyWithAudit(CRITERION, positions);
      const noStore = tallyWithFactCheck(CRITERION, positions);
      expect(noStore.winner).toBe(spec15.winner);
      expect(noStore.blocked).toBe(spec15.blocked);
      expect(noStore.blocked_reason).toBe(spec15.blocked_reason);
      expect(noStore.driftFlagged).toBe(spec15.driftFlagged);
      // Extended fields must be zero — no fact-check ran.
      expect(noStore.fabricatedFlagged).toBe(0);
      expect(noStore.ungroundedFlagged).toBe(0);
      for (const audit of noStore.audits) {
        expect(audit.fabricated).toBe(false);
        expect(audit.ungrounded).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (f) TableFactStore basics — deterministic, keyed by criterion × statement
// ---------------------------------------------------------------------------

describe('TableFactStore', () => {
  it('returns ungrounded for anything not seeded', () => {
    const store = new TableFactStore();
    expect(
      store.checkClaim({
        statement_id: 'nope',
        asserts: 'anything',
        criterion_id: 'any',
      }).status,
    ).toBe('ungrounded');
  });

  it('is keyed by (criterion_id, statement_id) so cross-criterion collisions do not happen', () => {
    const store = new TableFactStore()
      .set('crit-a', 'stmt', { status: 'supported' })
      .set('crit-b', 'stmt', { status: 'contradicted' });
    expect(
      store.checkClaim({ statement_id: 'stmt', asserts: '', criterion_id: 'crit-a' })
        .status,
    ).toBe('supported');
    expect(
      store.checkClaim({ statement_id: 'stmt', asserts: '', criterion_id: 'crit-b' })
        .status,
    ).toBe('contradicted');
  });
});
