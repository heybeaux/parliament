/**
 * Lattice integration for the ideate orchestrator.
 *
 * Wraps individual model calls with `wrapParliamentModel` so each response
 * becomes a typed State Contract validated through a tiered Circuit Breaker
 * (L1+L2 for cooperative, L1 only for adversarial), then feeds the
 * cooperative-team contracts into a `ParliamentReducer` to detect conflicts
 * and compute an agreement ratio.
 *
 * Defaults are deliberately permissive:
 *   - `shadowMode: true` — breakers never block a deliberation; failures are
 *     reported but the cooperative/adversarial response is still surfaced.
 *   - `auditLogPath: './parliament-audit.jsonl'` — opt-in via the CLI flag,
 *     but always populated when the wrap runs.
 *   - `minAgreementRatio: 0.6` — same threshold the spec calls out.
 *
 * The orchestrator only constructs a `LatticeRunner` when the caller passes
 * `lattice.enabled === true`. Disabled runs go through the original
 * `adapter.generate` path with zero Lattice cost, so legacy `/ideate`
 * behavior is byte-identical.
 */

import { promises as fs } from 'node:fs';
import {
  ParliamentReducer,
  runParliamentDeliberation,
  wrapParliamentModel,
  type ParliamentDeliberationResult,
  type ParliamentModel,
} from '@heybeaux/lattice-adapter-parliament';
import { createContract, type StateContract } from '@heybeaux/lattice-core';
import type { LatticeIdeateOptions, LatticeReport } from './types.js';

/** Audit log default — matches the CLI default and the spec. */
export const DEFAULT_AUDIT_LOG_PATH = './parliament-audit.jsonl';
/** ConsensusReducer default min agreement — matches the spec. */
export const DEFAULT_MIN_AGREEMENT_RATIO = 0.6;

/** Fields we treat as the "consensus surface" for cooperative responses. */
const CONSENSUS_FIELDS = ['mainPoint', 'supportingArguments', 'conclusion'] as const;

/**
 * Resolve user-supplied options against defaults. Centralised so the CLI,
 * server, and orchestrator all interpret the same flag the same way.
 */
export function resolveLatticeOptions(opts: LatticeIdeateOptions): Required<LatticeIdeateOptions> {
  return {
    enabled: opts.enabled,
    auditLogPath: opts.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH,
    minAgreementRatio: opts.minAgreementRatio ?? DEFAULT_MIN_AGREEMENT_RATIO,
    shadowMode: opts.shadowMode ?? true,
  };
}

/**
 * Per-call result from `wrapAdapterCall`. Mirrors a normal adapter return
 * (`content` is the model text) but adds the `passed`/`agentId` bookkeeping
 * the orchestrator needs to assemble a `LatticeReport`.
 */
export interface WrappedCallOutcome {
  content: string;
  passed: boolean;
  agentId: string;
  role: string;
  isAdversarial: boolean;
}

/**
 * Coordinator that owns the per-run Lattice state — the trace ID, the
 * cumulative `WrappedCallOutcome` list, the audit log path, and the reducer.
 * The orchestrator instantiates one of these per `runIdeation` call and
 * threads it through the cooperative/adversarial/rebuttal helpers.
 */
export class LatticeRunner {
  readonly traceId: string;
  readonly options: Required<LatticeIdeateOptions>;
  private readonly outcomes: WrappedCallOutcome[] = [];

  constructor(options: LatticeIdeateOptions, traceId?: string) {
    this.options = resolveLatticeOptions(options);
    this.traceId = traceId ?? makeTraceId();
  }

  /**
   * Wrap a single `adapter.generate(prompt, system)` style call with the
   * Lattice adapter. Returns the original model text plus pass/fail data.
   *
   * The wrapped function signature is `(prompt) => unknown` per the
   * adapter's contract; we serialise our `(prompt, system)` into a single
   * blob so the State Contract still receives full context, but the
   * orchestrator's invocation point only changes from
   * `adapter.generate(p, s)` to `runner.wrap(...).call(p, s)`.
   */
  async wrap(
    model: ParliamentModel,
    modelCall: () => Promise<string>,
  ): Promise<WrappedCallOutcome> {
    // Wall-clock measurement of Lattice's overhead per wrap. We can't get
    // per-tier (L1/L2/L3) latency out of `@heybeaux/lattice-adapter-parliament`
    // today — it returns `{ contract, passed }` only — so we capture the
    // total round-trip and the raw model call separately and report the
    // delta as `latticeOverheadMs`. That answers the practical question
    // (how much wall-clock does Lattice cost?) without depending on
    // adapter internals.
    let modelCallMs = 0;
    const wrapStart = Date.now();
    const wrapped = wrapParliamentModel(
      model,
      async () => {
        const innerStart = Date.now();
        const content = await modelCall();
        modelCallMs = Date.now() - innerStart;
        return { content };
      },
      {
        shadowMode: this.options.shadowMode,
      },
    );
    const { contract, passed } = await wrapped(model.id, this.traceId);
    const wrapMs = Date.now() - wrapStart;
    const latticeOverheadMs = Math.max(0, wrapMs - modelCallMs);
    // The wrap layer puts the model call's return value under
    // `contract.outputs.payload`. Our model call returns `{ content }` so
    // we extract `.content` directly. Fall back to a JSON encoding so the
    // orchestrator never crashes if the adapter shape evolves.
    const outputs = (contract.outputs?.payload ?? {}) as { content?: unknown };
    const content =
      typeof outputs.content === 'string'
        ? outputs.content
        : JSON.stringify(contract.outputs?.payload ?? null);

    const outcome: WrappedCallOutcome = {
      content,
      passed,
      agentId: model.id,
      role: model.role,
      isAdversarial: model.isAdversarial === true,
    };
    this.outcomes.push(outcome);

    if (this.options.auditLogPath !== null) {
      await appendAuditLog(this.options.auditLogPath, {
        traceId: this.traceId,
        agentId: model.id,
        role: model.role,
        isAdversarial: model.isAdversarial === true,
        passed,
        timestamp: new Date().toISOString(),
        contractId: contract.id,
        wrapMs,
        modelCallMs,
        latticeOverheadMs,
      });
    }

    return outcome;
  }

  /**
   * Build the report surfaced on `RunIdeationResult.lattice` (and ultimately
   * the persisted `IdeationRecord.lattice`). Computes the consensus pass on
   * the cooperative outcomes only — adversarial responses are intentionally
   * contrarian and would skew the agreement ratio.
   */
  buildReport(): LatticeReport {
    const reducer = new ParliamentReducer({
      consensusFields: [...CONSENSUS_FIELDS],
      minAgreementRatio: this.options.minAgreementRatio,
    });

    // For the consensus pass, project the cooperative outcomes back into
    // synthetic State Contracts. The reducer treats each `payload` as the
    // candidate consensus surface.
    const cooperative = this.outcomes.filter((o) => !o.isAdversarial);
    const fakeContracts = cooperative.map((o) => buildSyntheticContract(o, this.traceId));

    let agreementRatio = 1;
    let consensusReached = true;
    let conflicts: LatticeReport['conflicts'] = [];
    if (fakeContracts.length >= 2) {
      const reduced = reducer.reduce(fakeContracts, this.traceId);
      agreementRatio = reduced.agreementRatio;
      consensusReached = reduced.consensusReached;
      conflicts = reduced.conflicts;
    }

    return {
      enabled: true,
      traceId: this.traceId,
      agreementRatio,
      consensusReached,
      conflicts,
      modelOutcomes: this.outcomes.map((o) => ({
        agentId: o.agentId,
        role: o.role,
        isAdversarial: o.isAdversarial,
        passed: o.passed,
        breakerTier: o.isAdversarial ? 'L1' : 'L1+L2',
      })),
      auditLogPath: this.options.auditLogPath,
    };
  }
}

/**
 * Re-export of `runParliamentDeliberation` for callers that want the bundled
 * cooperative-only one-shot. The orchestrator currently uses the per-call
 * wrap path so it can preserve Parliament's existing phase pipeline; this
 * export is kept so future callers can run a single Lattice deliberation
 * without touching Parliament's phase loop.
 */
export async function runOneShotLattice(
  topic: string,
  models: ParliamentModel[],
  modelCalls: Map<string, (prompt: string) => Promise<unknown>>,
  options: LatticeIdeateOptions,
): Promise<ParliamentDeliberationResult> {
  const resolved = resolveLatticeOptions(options);
  return runParliamentDeliberation(topic, models, modelCalls, {
    auditLogPath: resolved.auditLogPath,
    reducer: {
      consensusFields: [...CONSENSUS_FIELDS],
      minAgreementRatio: resolved.minAgreementRatio,
    },
    defaultModelConfig: { shadowMode: resolved.shadowMode },
  });
}

// ---------- helpers ----------

/**
 * Append a single JSONL record to the audit log. Best-effort — file system
 * errors are swallowed because the spec calls for shadow-mode behavior end
 * to end. Tests inject a temp dir so writes always succeed.
 */
async function appendAuditLog(path: string, record: Record<string, unknown>): Promise<void> {
  try {
    await fs.appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Audit log failure must not block deliberation.
  }
}

/**
 * Project a `WrappedCallOutcome` into a real State Contract for the reducer.
 * `ParliamentReducer.reduce` reads `outputs.payload.{mainPoint,
 * supportingArguments, conclusion}` from each contract — we project the
 * cooperative model's prose into those fields so the agreement ratio has
 * something concrete to compare even when the upstream response was
 * unstructured prose.
 */
function buildSyntheticContract(
  outcome: WrappedCallOutcome,
  traceId: string,
): StateContract<{ trace: string }, {
  mainPoint: string;
  supportingArguments: string[];
  conclusion: string;
}> {
  const firstSentence = outcome.content.split(/(?<=[.!?])\s+/)[0] ?? outcome.content;
  return createContract({
    fromAgent: outcome.agentId,
    traceId,
    inputs: { trace: traceId },
    outputs: {
      mainPoint: firstSentence.slice(0, 200),
      supportingArguments: [outcome.content.slice(0, 500)],
      conclusion: outcome.content.slice(-200),
    },
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  });
}

/**
 * Generate a ULID-ish identifier without pulling `ulidx` directly. Lattice
 * already pulls it via `@heybeaux/lattice-core`, but the orchestrator
 * shouldn't reach into a transitive dep — this is local-only and only used
 * when the caller doesn't provide a trace ID.
 */
function makeTraceId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  )
    .join('')
    .toUpperCase();
  return `01${ts}${rand}`.slice(0, 26);
}
