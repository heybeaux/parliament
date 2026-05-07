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
  COOPERATIVE_PROMPTS,
  REBUTTAL_SYSTEM_PROMPT,
  SYNTH_SYSTEM_PROMPT,
  buildCooperativeUserPrompt,
  buildRebuttalUserPrompt,
  buildSynthUserPrompt,
} from './prompts.js';
import type {
  IdeateMode,
  IdeateStyle,
  IdeationStatus,
  LineupAssignment,
  PhaseContribution,
  PhaseRecord,
  Problem,
  ResolvedLineup,
} from './types.js';

/** Hard cap on rebuttal rounds; the spec fixes this in code, not config. */
const REBUTTAL_ROUND_CAP = 2;

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
}

export interface RunIdeationResult {
  status: IdeationStatus;
  phases: PhaseRecord[];
  synthesis: string | null;
  error: string | null;
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

  try {
    const cooperative = await runCooperativeBuild(input, factory);
    phases.push(cooperative);

    let problems: readonly Problem[] = [];
    let unstructuredAdversarial = false;

    if (input.mode === 'adversarial' || input.mode === 'full') {
      const adversarial = await runAdversarialCritique(input, factory);
      phases.push(adversarial);
      problems = collectProblems(adversarial);
      unstructuredAdversarial = adversarial.contributions.some((c) => c.unstructured === true);

      if (problems.length > 0) {
        const rebuttalTurns: string[] = [];
        for (let round: 1 | 2 = 1; round <= REBUTTAL_ROUND_CAP; round = (round + 1) as 1 | 2) {
          const rebuttal = await runRebuttal(input, factory, {
            problems,
            draft: contributionsToProse(cooperative.contributions),
            priorRebuttals: rebuttalTurns,
            round,
          });
          phases.push(rebuttal);
          rebuttalTurns.push(...rebuttal.contributions.map((c) => c.content));
          // Cap is hard — round 2 always synthesizes regardless of unresolved
          // problems. There is no early-exit shortcut on round 1; the spec
          // explicitly forbids configurability and keeps the loop simple.
          if (round === REBUTTAL_ROUND_CAP) break;
        }
      }
    }

    const synth = await runSynth(input, factory, {
      cooperativeTurns: cooperative.contributions.map((c) => c.content),
      adversarialTurns: phases
        .filter((p) => p.phase === 'adversarial-critique')
        .flatMap((p) => p.contributions.map((c) => c.content)),
      rebuttalTurns: phases
        .filter((p) => p.phase === 'rebuttal-1' || p.phase === 'rebuttal-2')
        .flatMap((p) => p.contributions.map((c) => c.content)),
      unstructuredAdversarial,
    });
    phases.push(synth);

    return {
      status: 'complete',
      phases,
      synthesis: synth.synthesis ?? null,
      error: null,
    };
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
): Promise<PhaseRecord> {
  const team = input.lineup.team.cooperative;
  const contributions: PhaseContribution[] =
    input.style === 'individual'
      ? await runCooperativeIndividual(input, factory, team)
      : await runCooperativeCollective(input, factory, team);

  return {
    phase: 'cooperative-build',
    contributions,
    style: input.style,
  };
}

async function runCooperativeIndividual(
  input: RunIdeationInput,
  factory: AdapterFactory,
  team: readonly LineupAssignment[],
): Promise<PhaseContribution[]> {
  // Each agent sees only the original idea, no peers. Run concurrently.
  const tasks = team.map(async (slot) => {
    const adapter = factory(slot.model);
    const userPrompt = buildCooperativeUserPrompt(input.idea, []);
    const systemPrompt = COOPERATIVE_PROMPTS[slot.role as keyof typeof COOPERATIVE_PROMPTS];
    const result = await adapter.generate(userPrompt, systemPrompt);
    return makeContribution(slot, result.content);
  });
  return Promise.all(tasks);
}

async function runCooperativeCollective(
  input: RunIdeationInput,
  factory: AdapterFactory,
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
    const result = await adapter.generate(userPrompt, systemPrompt);
    out.push(makeContribution(slot, result.content));
  }
  return out;
}

// ---------- adversarial-critique phase ----------

async function runAdversarialCritique(
  input: RunIdeationInput,
  factory: AdapterFactory,
): Promise<PhaseRecord> {
  const team = input.lineup.team.adversarial;
  // Critique is style-independent: always parallel. Each adversarial agent
  // reads the cooperative draft (so far) and emits structured problem-fix.
  // Tasks are independent — Promise.all preserves registration order.
  const tasks = team.map((slot) => runAdversarialOne(input, factory, slot));
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
  slot: LineupAssignment,
): Promise<PhaseContribution> {
  const adapter = factory(slot.model);
  // First attempt with the canonical system prompt.
  const userPrompt = `# Idea\n\n${input.idea.trim()}\n\n# Your structured critique`;
  const first = await adapter.generate(userPrompt, ADVERSARIAL_SYSTEM_PROMPT);
  const firstParsed = parseAdversarialOutput(first.content);
  if (firstParsed !== null) {
    return makeContribution(slot, first.content, {
      problems: firstParsed,
      attempts: 1,
    });
  }

  // Retry once with a stricter "JSON only" instruction.
  const retryPrompt = `${userPrompt}\n\n${ADVERSARIAL_RETRY_INSTRUCTION}`;
  const second = await adapter.generate(retryPrompt, ADVERSARIAL_SYSTEM_PROMPT);
  const secondParsed = parseAdversarialOutput(second.content);
  if (secondParsed !== null) {
    return makeContribution(slot, second.content, {
      problems: secondParsed,
      attempts: 2,
    });
  }

  // Both attempts failed — preserve raw prose from the SECOND attempt
  // (it's the more recent and was prompted with stricter instructions).
  return makeContribution(slot, second.content, {
    attempts: 2,
    unstructured: true,
  });
}

// ---------- rebuttal phase ----------

interface RebuttalContext {
  problems: readonly Problem[];
  draft: string;
  priorRebuttals: readonly string[];
  round: 1 | 2;
}

async function runRebuttal(
  input: RunIdeationInput,
  factory: AdapterFactory,
  ctx: RebuttalContext,
): Promise<PhaseRecord> {
  const team = input.lineup.team.cooperative;
  const out: PhaseContribution[] = [];
  // Sequential — rebuttal builds a coherent response, not parallel takes.
  for (const slot of team) {
    const adapter = factory(slot.model);
    const userPrompt = buildRebuttalUserPrompt({
      idea: input.idea,
      draft: ctx.draft,
      problems: ctx.problems.map((p) => ({ problem: p.problem, proposed_fix: p.proposed_fix })),
      priorRebuttals: ctx.round === 1 ? [] : ctx.priorRebuttals,
    });
    const result = await adapter.generate(userPrompt, REBUTTAL_SYSTEM_PROMPT);
    out.push(makeContribution(slot, result.content));
  }
  return {
    phase: ctx.round === 1 ? 'rebuttal-1' : 'rebuttal-2',
    contributions: out,
  };
}

// ---------- synth phase ----------

interface SynthContext {
  cooperativeTurns: readonly string[];
  adversarialTurns: readonly string[];
  rebuttalTurns: readonly string[];
  unstructuredAdversarial: boolean;
}

async function runSynth(
  input: RunIdeationInput,
  factory: AdapterFactory,
  ctx: SynthContext,
): Promise<PhaseRecord> {
  const adapter = factory(input.lineup.synth);
  const userPrompt = buildSynthUserPrompt({
    idea: input.idea,
    cooperativeTurns: ctx.cooperativeTurns,
    adversarialTurns: ctx.adversarialTurns,
    rebuttalTurns: ctx.rebuttalTurns,
    unstructuredAdversarial: ctx.unstructuredAdversarial,
  });
  const result = await adapter.generate(userPrompt, SYNTH_SYSTEM_PROMPT);
  const synthesis = result.content.trim();
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
