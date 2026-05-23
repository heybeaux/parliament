/**
 * Ideate orchestrator. Drives the four-phase ideation pipeline:
 *
 *   cooperative-build  → (always)
 *   adversarial-critique → (adversarial, full)
 *   rebuttal-1, rebuttal-2 → (adversarial, full; up to 2 rounds)
 *   synth → (always; closes the run)
 *
 * Architecture decision (logged in chat 2026-05-07): this orchestrator does
 * NOT route through `DeliberationEngine.runTopology`. The engine is round-
 * based with mandatory synthesizer-per-round + sentry-after-each-step
 * semantics that don't fit phase-based ideation. Instead, we use the
 * existing `executeParallelBlock` primitive for the parallel paths and a
 * plain sequential loop for the collective style. The synthesizer is a
 * single direct call.
 *
 * Spec source: `openspec/changes/add-ideate-mode/specs/ideate-mode/spec.md`.
 */

import type { ModelAdapter } from '../adapters/base.js';
import {
  ADVERSARIAL_RETRY_INSTRUCTION,
  ADVERSARIAL_SYSTEM_PROMPT,
  parseAdversarialOutput,
} from './adversarial.js';
import {
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_PROVIDER_ORDER,
  runDedupePhase,
  type DedupeEmbedder,
  type DedupeProviderId,
} from './dedupe.js';
import { LatticeRunner } from './lattice.js';
import {
  COOPERATIVE_PROMPTS,
  SYNTH_SYSTEM_PROMPT,
  buildCooperativeUserPrompt,
  buildSynthUserPrompt,
} from './prompts.js';
import {
  DEFENSE_SYSTEM_PROMPT,
  buildDefenseUserPrompt,
  parseDefenseOutput,
} from './defense.js';
import type {
  IdeateMode,
  IdeateStyle,
  IdeationStatus,
  LatticeIdeateOptions,
  LatticeReport,
  LineupAssignment,
  PhaseContribution,
  PhaseRecord,
  Problem,
  ResolvedLineup,
  DefenseMode,
} from './types.js';

/**
 * Adapter factory injected by callers. Production code wires this to
 * `createAdapter` from `provider-factory.ts`; tests pass a stub map keyed
 * by model ID. The orchestrator never imports the production factory
 * directly so unit tests can run without provider env vars.
 */
export type AdapterFactory = (model: string) => ModelAdapter;

export interface RunIdeationInput {
  idea: string;
  mode: IdeateMode;
  style: IdeateStyle;
  lineup: ResolvedLineup;
  /**
   * Optional Lattice coordination wrap. When `lattice.enabled` is `false`
   * (the default — opt-in flag from the CLI), the orchestrator runs the
   * legacy code path with byte-identical behavior.
   */
  lattice?: LatticeIdeateOptions;
  /**
   * Idea-level dedupe between cooperative-build and adversarial-critique.
   * Defaults to enabled with threshold 0.85 and provider order ['local','cloud'].
   * Set `enabled: false` to skip the phase entirely. The `embedder` seam is
   * for tests; production code uses the built-in HTTP embedder.
   *
   * NOTE: dedupe runs on cooperative DRAFTS only. Critiques are NEVER
   * deduped — see `dedupe.ts` architectural lock + `assertCritiquesNotDeduped`.
   */
  dedupe?: {
    enabled?: boolean;
    threshold?: number;
    providerOrder?: readonly DedupeProviderId[];
    embedder?: DedupeEmbedder;
  };
  /**
   * Defense mode governing the defense phase. 
   * Defaults to 'author_choice'.
   */
  defense_mode?: DefenseMode;
}

export interface RunIdeationResult {
  status: IdeationStatus;
  phases: PhaseRecord[];
  synthesis: string | null;
  error: string | null;
  /** Populated only when the run was launched with `--lattice=true`. */
  lattice?: LatticeReport;
}

/**
 * Entry point for one ideation run. Returns a fully-populated result
 * object — including partial `phases` when an error aborts mid-run — so
 * the server can persist whichever state the run reached.
 */
export async function runIdeation(
  input: RunIdeationInput,
  factory: AdapterFactory,
): Promise<RunIdeationResult> {
  const phases: PhaseRecord[] = [];
  // Lattice wrap is strict opt-in (`lattice.enabled === true`). When absent
  // or disabled the orchestrator behaves exactly as it did pre-integration.
  const runner =
    input.lattice?.enabled === true ? new LatticeRunner(input.lattice) : null;

  try {
    const cooperative = await runCooperativeBuild(input, factory, runner);
    phases.push(cooperative);

    // Dedupe phase. Runs by default; opt-out via dedupe.enabled === false.
    // Soft-fails — provider outage surfaces as phase warning, drafts pass
    // through untouched so the rest of the pipeline keeps running. The
    // resulting PhaseRecord is the canonical "phase.dedupe" event surface
    // (ideate has no separate event bus; consumers read phases[]).
    //
    // We preserve the original cooperative PhaseRecord (transcript fidelity)
    // and route `liveDrafts` — the dedupe survivors — into downstream phases.
    let liveDrafts: readonly PhaseContribution[] = cooperative.contributions;
    const dedupePhase = await runIdeaDedupePhase(input, cooperative.contributions);
    if (dedupePhase !== null) {
      phases.push(dedupePhase);
      liveDrafts = dedupePhase.contributions;
    }

    let problems: readonly Problem[] = [];
    let unstructuredAdversarial = false;

    if (input.mode === 'adversarial' || input.mode === 'full') {
      const adversarial = await runAdversarialCritique(input, factory, runner);
      phases.push(adversarial);
      problems = collectProblems(adversarial);
      unstructuredAdversarial = adversarial.contributions.some((c) => c.unstructured === true);

      if (problems.length > 0) {
        const defense = await runDefensePhase(input, factory, runner, {
          problems,
          draft: contributionsToProse(liveDrafts),
        });
        phases.push(defense);
      }
    }

    // Build the Lattice report BEFORE synthesis so the synthesizer can
    // reference agreement ratios and conflicts in its output prose.
    const latticeReport = runner !== null ? runner.buildReport() : null;

    const synth = await runSynth(input, factory, {
      cooperativeTurns: liveDrafts.map((c) => c.content),
      adversarialTurns: phases
        .filter((p) => p.phase === 'adversarial-critique')
        .flatMap((p) => p.contributions.map((c) => c.content)),
      rebuttalTurns: phases
        .filter((p) => p.phase === 'defense')
        .flatMap((p) => p.contributions.map((c) => c.content)),
      unstructuredAdversarial,
      lattice: latticeReport,
    });
    phases.push(synth);

    const result: RunIdeationResult = {
      status: 'complete',
      phases,
      synthesis: synth.synthesis ?? null,
      error: null,
    };
    if (latticeReport !== null) result.lattice = latticeReport;
    return result;
  } catch (err) {
    return {
      status: 'error',
      phases,
      synthesis: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- cooperative-build phase ----------

async function runCooperativeBuild(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
): Promise<PhaseRecord> {
  const team = input.lineup.team.cooperative;
  const contributions: PhaseContribution[] =
    input.style === 'individual'
      ? await runCooperativeIndividual(input, factory, runner, team)
      : await runCooperativeCollective(input, factory, runner, team);

  return {
    phase: 'cooperative-build',
    contributions,
    style: input.style,
  };
}

async function runCooperativeIndividual(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
  team: readonly LineupAssignment[],
): Promise<PhaseContribution[]> {
  // Each agent sees only the original idea, no peers. Run concurrently.
  const tasks = team.map(async (slot) => {
    const adapter = factory(slot.model);
    const userPrompt = buildCooperativeUserPrompt(input.idea, []);
    const systemPrompt = COOPERATIVE_PROMPTS[slot.role as keyof typeof COOPERATIVE_PROMPTS];
    const content = await callModel(runner, slot, false, () =>
      adapter.generate(userPrompt, systemPrompt).then((r) => r.content),
    );
    return makeContribution(slot, content);
  });
  return Promise.all(tasks);
}

async function runCooperativeCollective(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
  team: readonly LineupAssignment[],
): Promise<PhaseContribution[]> {
  // Each agent sees prior turns and builds on them. Sequential by definition.
  const out: PhaseContribution[] = [];
  for (const slot of team) {
    const adapter = factory(slot.model);
    const userPrompt = buildCooperativeUserPrompt(
      input.idea,
      out.map((c) => c.content),
    );
    const systemPrompt = COOPERATIVE_PROMPTS[slot.role as keyof typeof COOPERATIVE_PROMPTS];
    const content = await callModel(runner, slot, false, () =>
      adapter.generate(userPrompt, systemPrompt).then((r) => r.content),
    );
    out.push(makeContribution(slot, content));
  }
  return out;
}

// ---------- adversarial-critique phase ----------

async function runAdversarialCritique(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
): Promise<PhaseRecord> {
  const team = input.lineup.team.adversarial;
  // Critique is style-independent: always parallel. Each adversarial agent
  // reads the cooperative draft (so far) and emits structured problem-fix.
  // Tasks are independent — Promise.all preserves registration order.
  const tasks = team.map((slot) => runAdversarialOne(input, factory, runner, slot));
  const contributions = await Promise.all(tasks);

  const warnings: string[] = [];
  for (const c of contributions) {
    if (c.unstructured === true) {
      warnings.push(
        `${c.role} (${c.model}) emitted unstructured prose after one retry; surfaced as best-effort.`,
      );
    }
  }

  const record: PhaseRecord = {
    phase: 'adversarial-critique',
    contributions,
  };
  if (warnings.length > 0) record.warnings = warnings;
  return record;
}

async function runAdversarialOne(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
  slot: LineupAssignment,
): Promise<PhaseContribution> {
  const adapter = factory(slot.model);
  // First attempt with the canonical system prompt. Adversarial roles use
  // L1-only validation — the wrap layer infers this from `isAdversarial`.
  const userPrompt = `# Idea\n\n${input.idea.trim()}\n\n# Your structured critique`;
  const firstContent = await callModel(runner, slot, true, () =>
    adapter.generate(userPrompt, ADVERSARIAL_SYSTEM_PROMPT).then((r) => r.content),
  );
  const firstParsed = parseAdversarialOutput(firstContent);
  if (firstParsed !== null) {
    return makeContribution(slot, firstContent, {
      problems: firstParsed,
      attempts: 1,
    });
  }

  // Retry once with a stricter "JSON only" instruction.
  const retryPrompt = `${userPrompt}\n\n${ADVERSARIAL_RETRY_INSTRUCTION}`;
  const secondContent = await callModel(runner, slot, true, () =>
    adapter.generate(retryPrompt, ADVERSARIAL_SYSTEM_PROMPT).then((r) => r.content),
  );
  const secondParsed = parseAdversarialOutput(secondContent);
  if (secondParsed !== null) {
    return makeContribution(slot, secondContent, {
      problems: secondParsed,
      attempts: 2,
    });
  }

  // Both attempts failed — preserve raw prose from the SECOND attempt
  // (it's the more recent and was prompted with stricter instructions).
  return makeContribution(slot, secondContent, {
    attempts: 2,
    unstructured: true,
  });
}

// ---------- defense phase ----------

interface DefenseContext {
  problems: readonly Problem[];
  draft: string;
}

async function runDefensePhase(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
  ctx: DefenseContext,
): Promise<PhaseRecord> {
  const team = input.lineup.team.cooperative;
  const out: PhaseContribution[] = [];
  const warnings: string[] = [];

  // Sequential - defense is a coherent response to the pooled critiques.
  for (const slot of team) {
    const adapter = factory(slot.model);
    const mode = input.defense_mode ?? 'author_choice';
    const userPrompt = buildDefenseUserPrompt(
      input.idea,
      ctx.draft,
      ctx.problems,
      mode,
    );

    // First attempt with the canonical system prompt.
    const firstContent = await callModel(runner, slot, false, () =>
      adapter.generate(userPrompt, DEFENSE_SYSTEM_PROMPT).then((r) => r.content),
    );
    let firstParsed = parseDefenseOutput(firstContent);

    // Stance validation for 'address' or 'double_down' modes.
    if (firstParsed !== null && mode !== 'author_choice') {
      const violates = firstParsed.defenses.some((d) => d.stance !== mode);
      if (violates) firstParsed = null; // Trigger retry
    }

    if (firstParsed !== null) {
      out.push(makeContribution(slot, firstContent, {
        defenses: firstParsed.defenses,
      }));
    } else {
      // Retry once with a stricter instruction.
      const retryPrompt = `${userPrompt}\n\n${DEFENSE_RETRY_INSTRUCTION}`;
      const secondContent = await callModel(runner, slot, false, () =>
        adapter.generate(retryPrompt, DEFENSE_SYSTEM_PROMPT).then((r) => r.content),
      );
      const secondParsed = parseDefenseOutput(secondContent);

      if (secondParsed !== null) {
        // Even on retry, if mode is strict and it still violates, we persist but warn.
        let finalParsed = secondParsed;
        if (mode !== 'author_choice' && secondParsed.defenses.some((d) => d.stance !== mode)) {
          warnings.push(`${slot.role} (${slot.model}) violated defense_mode ${mode} after retry; persisted as best-effort.`);
        }

        out.push(makeContribution(slot, secondContent, {
          defenses: finalParsed.defenses,
        }));
      } else {
        // Both attempts failed parsing - preserve raw prose.
        warnings.push(`${slot.role} (${slot.model}) emitted unstructured defense after one retry; surfaced as best-effort.`);
        out.push(makeContribution(slot, secondContent));
      }
    }
  }

  const record: PhaseRecord = {
    phase: 'defense',
    contributions: out,
  };

  // Roll up all structured defenses for the phase record.
  const allDefenses: DefenseEntry[] = [];
  for (const c of out) {
    if (c.defenses) allDefenses.push(...c.defenses);
  }
  record.defenses = allDefenses;

  if (warnings.length > 0) record.warnings = warnings;
  return record;
}

/** @deprecated use runDefensePhase */
export async function runRebuttal(
  input: RunIdeationInput,
  factory: AdapterFactory,
  runner: LatticeRunner | null,
  _ctx: unknown, // legacy context shape
): Promise<PhaseRecord> {
  const ctx = _ctx as Record<string, unknown>;
  return runDefensePhase(input, factory, runner, {
    problems: ctx.problems as Problem[],
    draft: ctx.draft as string,
  });
}

// ---------- synth phase ----------

interface SynthContext {
  cooperativeTurns: readonly string[];
  adversarialTurns: readonly string[];
  rebuttalTurns: readonly string[];
  unstructuredAdversarial: boolean;
  /** Lattice report when --lattice was passed; null otherwise. */
  lattice: LatticeReport | null;
}

async function runSynth(
  input: RunIdeationInput,
  factory: AdapterFactory,
  ctx: SynthContext,
): Promise<PhaseRecord> {
  const adapter = factory(input.lineup.synth);
  const baseUserPrompt = buildSynthUserPrompt({
    idea: input.idea,
    cooperativeTurns: ctx.cooperativeTurns,
    adversarialTurns: ctx.adversarialTurns,
    rebuttalTurns: ctx.rebuttalTurns,
    unstructuredAdversarial: ctx.unstructuredAdversarial,
  });
  // When Lattice ran, prepend a small advisory block so the synthesizer can
  // reference agreement ratios + conflicts in its prose, and append the
  // canonical "Lattice Coordination Report" section to the synthesis output
  // for downstream rendering.
  const userPrompt =
    ctx.lattice !== null
      ? `${buildLatticeSynthHeader(ctx.lattice)}\n\n${baseUserPrompt}`
      : baseUserPrompt;
  const result = await adapter.generate(userPrompt, SYNTH_SYSTEM_PROMPT);
  const trimmed = result.content.trim();
  const synthesis =
    ctx.lattice !== null
      ? `${trimmed}\n\n${formatLatticeReport(ctx.lattice)}`
      : trimmed;
  return {
    phase: 'synth',
    contributions: [
      {
        role: 'synthesizer',
        model: input.lineup.synth,
        content: synthesis,
        timestamp: new Date().toISOString(),
      },
    ],
    synthesis,
  };
}

// ---------- dedupe phase ----------

/**
 * Run the idea-level dedupe phase between cooperative-build and
 * adversarial-critique. Returns `null` when dedupe is disabled (caller
 * skips pushing anything onto `phases`). Otherwise returns a fully-formed
 * `PhaseRecord` whose `contributions` are the kept survivors (in original
 * order), with `record.dedupe` carrying the merge map, threshold, provider,
 * and skip flag, and `record.warnings` set on soft-fail.
 *
 * Note: ideate does not have a separate event bus. The "phase.dedupe event"
 * called for in the spec is realized as this PhaseRecord pushed onto
 * `phases` — same payload, same observability, single channel.
 */
async function runIdeaDedupePhase(
  input: RunIdeationInput,
  drafts: readonly PhaseContribution[],
): Promise<PhaseRecord | null> {
  const dedupeOpts = input.dedupe;
  if (dedupeOpts?.enabled === false) return null;

  const result = await runDedupePhase(drafts, {
    threshold: dedupeOpts?.threshold ?? DEFAULT_DEDUPE_THRESHOLD,
    providerOrder: dedupeOpts?.providerOrder ?? DEFAULT_PROVIDER_ORDER,
    ...(dedupeOpts?.embedder !== undefined ? { embedder: dedupeOpts.embedder } : {}),
  });

  // Build synthetic IDs in the SAME shape dedupe used (`role#index`) so the
  // kept-IDs list on the record matches the merge_into map keys/values.
  const allIds = drafts.map((d, i) => `${d.role}#${i}`);
  const keptIds: string[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(result.merged_into, allIds[i]!)) {
      keptIds.push(allIds[i]!);
    }
  }

  const record: PhaseRecord = {
    phase: 'dedupe',
    contributions: result.kept,
    dedupe: {
      kept: keptIds,
      merged_into: result.merged_into,
      threshold: result.threshold,
      provider: result.provider,
      skipped: result.skipped,
    },
  };
  if (result.warning !== undefined) {
    record.warnings = [result.warning];
  }
  return record;
}

// ---------- helpers ----------

function makeContribution(
  slot: LineupAssignment,
  content: string,
  extras: Partial<Pick<PhaseContribution, 'problems' | 'attempts' | 'unstructured'>> = {},
): PhaseContribution {
  const c: PhaseContribution = {
    role: slot.role,
    model: slot.model,
    content,
    timestamp: new Date().toISOString(),
  };
  if (extras.problems !== undefined) c.problems = extras.problems;
  if (extras.attempts !== undefined) c.attempts = extras.attempts;
  if (extras.unstructured !== undefined) c.unstructured = extras.unstructured;
  return c;
}

function contributionsToProse(contributions: readonly PhaseContribution[]): string {
  return contributions.map((c, i) => `## ${c.role} (turn ${i + 1})\n${c.content}`).join('\n\n');
}

function collectProblems(record: PhaseRecord): readonly Problem[] {
  const out: Problem[] = [];
  for (const c of record.contributions) {
    if (c.problems !== undefined) out.push(...c.problems);
  }
  return out;
}

/**
 * Bridge between Parliament's `adapter.generate(prompt, system)` shape and
 * the Lattice wrap. When `runner` is null we just await the underlying call
 * and return its content directly — pre-integration code path. When the
 * runner is present, we register a Lattice-wrapped invocation that creates
 * a State Contract, runs Circuit Breaker validation, and persists an audit
 * log entry. The returned content is identical in both branches; only the
 * side effects (contract creation + audit logging) differ.
 */
async function callModel(
  runner: LatticeRunner | null,
  slot: LineupAssignment,
  isAdversarial: boolean,
  modelCall: () => Promise<string>,
): Promise<string> {
  if (runner === null) {
    return modelCall();
  }
  const outcome = await runner.wrap(
    {
      id: slot.model,
      role: slot.role,
      isAdversarial,
    },
    modelCall,
  );
  return outcome.content;
}

/**
 * Synthesis prompt prefix used only when Lattice ran. The synthesizer reads
 * agreement ratio + conflicts so it can call them out in prose without
 * re-deriving them from raw transcripts.
 */
function buildLatticeSynthHeader(report: LatticeReport): string {
  const conflicts = report.conflicts.length === 0
    ? 'No conflicts surfaced.'
    : report.conflicts
        .map(
          (c) =>
            `- ${c.field}: ${c.values.length} divergent positions (resolution: ${c.resolution})`,
        )
        .join('\n');
  return [
    '# Lattice Coordination Context',
    '',
    `Trace ID: ${report.traceId}`,
    `Agreement ratio: ${report.agreementRatio.toFixed(2)}`,
    `Consensus reached: ${report.consensusReached ? 'yes' : 'no'}`,
    `Conflicts:\n${conflicts}`,
    '',
    'Use this context only as supplementary signal — do not block on it.',
  ].join('\n');
}

/**
 * Render the canonical "Lattice Coordination Report" section appended to the
 * synthesis output when --lattice=true. Format matches the spec exactly so
 * downstream parsers (UI, audit pipelines) see a stable surface.
 */
export function formatLatticeReport(report: LatticeReport): string {
  const passRates = report.modelOutcomes
    .map((o) => `${o.agentId} ${o.passed ? 'passed' : `failed (${o.breakerTier})`}`)
    .join(', ');
  const conflictsLine =
    report.conflicts.length === 0
      ? '0'
      : `${report.conflicts.length} (${report.conflicts
          .map((c) => c.field)
          .join(', ')})`;
  const consensus = report.consensusReached
    ? 'Reached'
    : report.agreementRatio > 0
      ? 'Partial'
      : 'None';
  const auditLine =
    report.auditLogPath !== null ? `\`${report.auditLogPath}\`` : '(disabled)';
  return [
    '## Lattice Coordination Report',
    `- Trace ID: \`${report.traceId}\``,
    `- Agreement Ratio: ${report.agreementRatio.toFixed(2)}`,
    `- Consensus: ${consensus}`,
    `- Conflicts: ${conflictsLine}`,
    `- Model Pass Rates: ${passRates}`,
    `- Audit Log: ${auditLine}`,
  ].join('\n');
}
