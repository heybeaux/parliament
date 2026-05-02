import {
  ModelConnectionError,
  type AdapterResult,
  type ModelAdapter,
} from '../adapters/base.js';
import type { AdapterMeta, Blackboard } from '../types.js';

/**
 * Result of an agent's `generate()` call.
 *
 * Every neurotype-style agent (Proposer, Skeptic, and the eight new neurotypes
 * landing in Stage 1) MUST run its raw model output through `enforceWordCap`
 * (see `./utils.ts`) before returning. The default cap is 200 words and is
 * load-bearing for downstream metrics — the OSI scorer, residue calculation,
 * and Timeline UI all assume this cap. The `truncated` flag MUST faithfully
 * reflect whether the cap was applied; downstream consumers (the Timeline UI
 * truncation badge, in particular) rely on it.
 *
 * The Sentry and Synthesizer agents are exceptions:
 *   - Sentry produces a structured classifier signal, not free prose, and
 *     therefore does not pass through the word cap.
 *   - Synthesizer's `summary` field is capped, but its surrounding JSON
 *     envelope (confidence, consensus, agreed[], unresolved[]) is not.
 *
 * PAR-23 — every agent additionally surfaces the adapter's `AdapterMeta`
 * (latency, tokens, cost, provider) on `meta` so the engine can persist it
 * onto the recorded `Turn`. Optional because Sentry never calls the adapter
 * and stub agents in tests need not populate it.
 */
export interface AgentResult {
  content: string;
  truncated: boolean;
  /** PAR-23 — adapter-reported telemetry passed through from `adapter.generate`. */
  meta?: AdapterMeta;
}

/**
 * Contract for every agent the deliberation engine can step.
 *
 * Implementations MUST:
 *   - expose a stable string `role` (display name in the transcript) and
 *     `neurotype` (kebab-case ID matching the registry, e.g.
 *     `"devils-advocate"`); see `./registry.ts` for the ID convention.
 *   - take a read-only view of the `Blackboard` and return a fresh
 *     `AgentResult`. Agents MUST NOT mutate `blackboard.turns` directly —
 *     the engine appends turns. Agents MAY append to `blackboard.conflicts`
 *     (Skeptic does this when it detects explicit disagreement).
 *   - apply the 200-word cap via `enforceWordCap` before returning.
 */
export interface Agent {
  role: string;
  neurotype: string;
  readonly modelName: string;
  /**
   * Optional plain-language posture label (e.g. "evidence-first" for
   * Empiricist, "adversarial" for Skeptic, "reconciliation" for Synthesizer).
   * The deliberation engine writes this into `Turn.neurotype_posture` so the
   * Stage 3 Observability UI can render a human-readable posture without
   * decoding the kebab-case neurotype ID.
   *
   * Optional for backward-compat with mock agents in existing test files.
   * When omitted, the engine defaults `Turn.neurotype_posture` to the
   * agent's `neurotype` so the wire field is always populated.
   *
   * PAR-10 — additive observability enrichment.
   */
  readonly posture?: string;
  generate(blackboard: Blackboard): Promise<AgentResult>;
}

/**
 * PAR-25 — payload describing a single failover event for the engine's
 * `provider.failover` SystemEvent. Emitted by `AgentBase.generateWithFailover`
 * when the primary adapter throws `ModelConnectionError` AND a fallback is
 * configured. `primary` and `fallback` are the adapter `provider` strings
 * (when populated) or model names — whichever is more descriptive — so the
 * Observability panel can render a human-readable "omlx → openrouter" arrow
 * without inventing additional fields.
 */
export interface ProviderFailoverInfo {
  /** Stable kebab-case neurotype id (e.g. "structured", "skeptic"). */
  neurotype: string;
  /** Display string identifying the primary adapter. */
  primary: string;
  /** Display string identifying the fallback adapter. */
  fallback: string;
  /** `error.message` from the primary adapter's `ModelConnectionError`. */
  error: string;
}

/**
 * PAR-25 — optional runtime hooks every prose agent accepts as a second
 * constructor argument. The shape is additive: existing test fixtures and
 * call sites that pass only the primary adapter (`new ProposerAgent(adapter)`)
 * keep working unchanged because every field is optional.
 *
 *   - `fallbackAdapter` — the adapter retried exactly once when the primary
 *     throws `ModelConnectionError`. Constructed by the engine from the
 *     neurotype's `fallback_provider` / `fallback_model` TOML fields.
 *   - `onProviderFailover` — invoked once per successful failover attempt
 *     (whether the fallback later succeeds or itself throws). Wired by the
 *     engine to push a `provider.failover` SystemEvent onto the run's
 *     `events[]` array.
 *
 * Both fields together = "this neurotype is wired for failover." A consumer
 * supplying only `fallbackAdapter` (no callback) gets failover but no
 * observability; supplying only the callback is a no-op (no fallback to fire).
 */
export interface AgentRuntimeOptions {
  fallbackAdapter?: ModelAdapter;
  onProviderFailover?: (info: ProviderFailoverInfo) => void;
}

/**
 * PAR-25 — shared base implementation for every prose agent (Proposer,
 * Skeptic, Synthesizer, RedAgent, Sentry-as-prose, and the eight Stage 1
 * neurotypes). Centralises:
 *
 *   - the `adapter` / `fallbackAdapter` / `onProviderFailover` plumbing,
 *   - the single-retry failover semantics (only `ModelConnectionError`
 *     triggers the fallback; every other error propagates as-is so a
 *     malformed-JSON bug in the model's output is never masked),
 *   - the `modelName` mirror used by the engine when recording turns.
 *
 * The class is deliberately abstract — agents still implement their own
 * `generate(blackboard)` because the user-prompt construction is
 * agent-specific. Subclasses MUST call `this.generateWithFailover(prompt,
 * system)` instead of `this.adapter.generate(...)` so the failover branch
 * is reachable. Calling `this.adapter.generate(...)` directly bypasses
 * failover and is therefore reserved for paths (e.g. the synthesizer's
 * structured-output retry) where the agent already wraps each call.
 */
export abstract class AgentBase implements Agent {
  abstract readonly role: string;
  abstract readonly neurotype: string;
  readonly modelName: string;

  /**
   * Primary adapter — the one the agent's prompt contract was authored
   * against. `protected` (not `private`) so subclasses (e.g. the
   * synthesizer's two-step JSON path) can fall back to direct calls when
   * they intentionally manage their own retry logic. Direct callers must
   * NOT trigger failover themselves; route through `generateWithFailover`.
   */
  protected readonly adapter: ModelAdapter;
  protected readonly fallbackAdapter: ModelAdapter | undefined;
  protected readonly onProviderFailover:
    | ((info: ProviderFailoverInfo) => void)
    | undefined;

  constructor(adapter: ModelAdapter, options: AgentRuntimeOptions = {}) {
    this.adapter = adapter;
    this.modelName = adapter.modelName;
    this.fallbackAdapter = options.fallbackAdapter;
    this.onProviderFailover = options.onProviderFailover;
  }

  abstract generate(blackboard: Blackboard): Promise<AgentResult>;

  /**
   * PAR-25 — the single channel every prose agent uses to call its
   * adapter. Tries the primary; on `ModelConnectionError`, retries once on
   * `fallbackAdapter` (when configured) and notifies `onProviderFailover`
   * exactly once with the primary's error message.
   *
   * Behaviour matrix (decided in PAR-25):
   *   - primary OK → return primary's result; callback never fires.
   *   - primary `ModelConnectionError`, no fallback → rethrow primary
   *     error; callback never fires.
   *   - primary `ModelConnectionError`, fallback OK → return fallback's
   *     result; callback fires once with the primary's error message.
   *   - primary `ModelConnectionError`, fallback `ModelConnectionError` →
   *     rethrow the FALLBACK's error; callback already fired once. Why
   *     fallback over primary: the fallback's error is the most recent
   *     signal the operator can use to diagnose "are both providers
   *     simultaneously down?" — propagating the primary error would hide
   *     the fact that the failover was even attempted.
   *   - primary throws non-connection error (e.g. parse error) → rethrow
   *     as-is; fallback is NOT tried (would mask logic bugs); callback
   *     never fires.
   */
  protected async generateWithFailover(
    prompt: string,
    system?: string,
  ): Promise<AdapterResult> {
    try {
      return await this.adapter.generate(prompt, system);
    } catch (err) {
      // Only ModelConnectionError triggers failover. Every other error
      // (JSON parse failures, model-side malformed responses, our own
      // input-validation throws) propagates unchanged so callers see the
      // real signal instead of a duplicated retry obscuring the bug.
      if (!(err instanceof ModelConnectionError) || this.fallbackAdapter === undefined) {
        throw err;
      }

      // Notify BEFORE the retry so the observability event reflects "we
      // attempted failover" even when the fallback itself errors out a
      // moment later. Callback is best-effort: we swallow throws so a
      // misbehaving sink can't itself break the deliberation.
      const callback = this.onProviderFailover;
      if (callback !== undefined) {
        try {
          callback({
            neurotype: this.neurotype,
            primary: describeAdapter(this.adapter),
            fallback: describeAdapter(this.fallbackAdapter),
            error: err.message,
          });
        } catch {
          // Intentionally silent — see callback contract on
          // `AgentRuntimeOptions.onProviderFailover`. The deliberation
          // continues regardless of whether the engine's event sink
          // accepted the notification.
        }
      }

      // Single retry. If this throws (whether ModelConnectionError or
      // anything else) we propagate as-is — no second fallback, no
      // cascading chain. The ticket pins single-retry semantics.
      return await this.fallbackAdapter.generate(prompt, system);
    }
  }
}

/**
 * Picks a stable display string for an adapter when populating
 * `ProviderFailoverInfo`. Prefers the adapter's `modelName` because every
 * adapter in the package guarantees it; the provider-name string lives on
 * the per-call `AdapterMeta.provider` field (only available AFTER a call),
 * which is too late for a pre-retry log message.
 */
function describeAdapter(adapter: ModelAdapter): string {
  return adapter.modelName;
}
