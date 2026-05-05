import type { ModelAdapter } from '../adapters/base.js';
import type { Agent, AgentRuntimeOptions } from './base.js';
import { ProposerAgent } from './proposer.js';
import { SkepticAgent } from './skeptic.js';
import { HistorianAgent } from './historian.js';
import { ForecasterAgent } from './forecaster.js';
import { PragmatistAgent } from './pragmatist.js';
import { EmpiricistAgent } from './empiricist.js';
import { SteelmannerAgent } from './steelmanner.js';
import { DevilsAdvocateAgent } from './devils-advocate.js';
import { LateralistAgent } from './lateralist.js';
import { TranslatorAgent } from './translator.js';
import { AdversaryAgent } from './adversary.js';

/**
 * ----------------------------------------------------------------------------
 * Built-in neurotype registry
 * ----------------------------------------------------------------------------
 *
 * This registry is the single source of truth for the kebab-case neurotype
 * IDs that `parliament.toml` step definitions and the topology runtime
 * resolve against.
 *
 * ID convention (matches `add-topology-spec`):
 *   - Lowercase ASCII letters, digits, hyphens.
 *   - MUST match the regex `^[a-z][a-z0-9-]*$` (kebab-case, leading letter).
 *   - Multi-word names use a single hyphen, e.g. `devils-advocate`.
 *   - One ID per neurotype. Aliases are NOT supported — picking a single
 *     canonical name keeps preset definitions diff-able and prevents
 *     "did you mean" suggestions from misfiring.
 *
 * Operational contract (matches `base.ts`):
 *   - Every factory takes a `ModelAdapter` and returns an `Agent` whose
 *     `generate()` enforces the 200-word cap (via `enforceWordCap`) and
 *     populates the `truncated` flag.
 *   - The Sentry and Synthesizer agents are excluded — they are structural
 *     infrastructure, not steppable neurotypes, and are wired by the
 *     deliberation engine directly. Including them here would risk
 *     user-defined presets putting Sentry in `steps`, which is a hard
 *     error per the topology runtime spec.
 *   - The RedAgent is also excluded — it is a Stage 1 runtime concern
 *     (intervention agent, not a posture) and will be wired by the
 *     runtime separately.
 *
 * Stage 1 stubs:
 *   The eight Stage 1 neurotypes (`historian`, `forecaster`, `pragmatist`,
 *   `empiricist`, `steelmanner`, `devils-advocate`, `lateralist`,
 *   `translator`) are registered here in their stub form so that:
 *     1. The TOML loader can validate `neurotype = "historian"` against
 *        the registry while the per-agent implementations land
 *        independently.
 *     2. Each per-agent task touches only its own file
 *        (`agents/<name>.ts`), avoiding merge conflicts on this registry.
 *
 *   Replacing a stub: implement the full agent in `agents/<id>.ts`. The
 *   registry import does not change; per-agent tasks do not modify this
 *   file.
 * ----------------------------------------------------------------------------
 */

/**
 * PAR-25 — factories accept the same `AgentRuntimeOptions` (fallback adapter
 * + failover callback) every prose agent now takes via `AgentBase`. The
 * second argument is optional so existing call sites (`factory(adapter)`)
 * keep working unchanged; supplying it wires the agent for failover.
 */
export type AgentFactory = (
  adapter: ModelAdapter,
  options?: AgentRuntimeOptions,
) => Agent;

/**
 * Built-in neurotype factories keyed by their kebab-case ID. Order is
 * informative: the first two entries are the original built-ins; the rest
 * are the Stage 1 additions.
 */
export const BUILTIN_AGENT_REGISTRY: Readonly<Record<string, AgentFactory>> = Object.freeze({
  proposer: (adapter, options) => new ProposerAgent(adapter, options),
  skeptic: (adapter, options) => new SkepticAgent(adapter, options),
  historian: (adapter, options) => new HistorianAgent(adapter, options),
  forecaster: (adapter, options) => new ForecasterAgent(adapter, options),
  pragmatist: (adapter, options) => new PragmatistAgent(adapter, options),
  empiricist: (adapter, options) => new EmpiricistAgent(adapter, options),
  steelmanner: (adapter, options) => new SteelmannerAgent(adapter, options),
  'devils-advocate': (adapter, options) => new DevilsAdvocateAgent(adapter, options),
  lateralist: (adapter, options) => new LateralistAgent(adapter, options),
  translator: (adapter, options) => new TranslatorAgent(adapter, options),
  adversary: (adapter, options) => new AdversaryAgent(adapter, options),
});

/** All known built-in neurotype IDs, in registration order. */
export const BUILTIN_AGENT_IDS: readonly string[] = Object.freeze(
  Object.keys(BUILTIN_AGENT_REGISTRY),
);

/**
 * Structural-infrastructure neurotypes — wired by the engine on every run
 * (synthesizer summarizes; redAgent injects on cadence; sentry monitors
 * out-of-band). They are NOT registered in `BUILTIN_AGENT_REGISTRY` because
 * they cannot appear as preset steps, but they DO ship class-level
 * `SYSTEM_PROMPT` constants in `agents/<id>.ts` and so may legitimately omit
 * `system_prompt` in `[neurotypes.<id>]` blocks (the runtime falls back to
 * the class default — same contract as the registry built-ins for PAR-40).
 */
export const STRUCTURAL_BUILTIN_NEUROTYPES: ReadonlySet<string> = new Set([
  'synthesizer',
  'redAgent',
  'sentry',
]);

/**
 * True when `id` resolves to a built-in neurotype factory.
 *
 * NOTE: this returns false for structural-infrastructure neurotypes
 * (`synthesizer`, `redAgent`, `sentry`) — they aren't steppable, so callers
 * doing step-validation correctly reject them. Callers that need to know
 * "does this ID have a class-level default prompt?" (e.g. config-loader
 * `system_prompt`-optional gating) should use `hasBuiltinDefaultPrompt`.
 */
export function isBuiltinNeurotype(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_AGENT_REGISTRY, id);
}

/**
 * True when `id` is any built-in neurotype that ships a class-level default
 * `SYSTEM_PROMPT` — registry built-ins (proposer, skeptic, …) plus structural
 * built-ins (synthesizer, redAgent, sentry). Used by config loaders to decide
 * whether `system_prompt` may be omitted in a `[neurotypes.<id>]` block.
 */
export function hasBuiltinDefaultPrompt(id: string): boolean {
  return isBuiltinNeurotype(id) || STRUCTURAL_BUILTIN_NEUROTYPES.has(id);
}

/**
 * Resolve a kebab-case neurotype ID to an Agent instance.
 *
 * Throws when `id` is not a registered built-in. Callers that also support
 * user-defined neurotypes (the topology runtime) MUST consult this registry
 * first and fall back to the user-defined registry only for unknown IDs.
 */
export function createBuiltinAgent(
  id: string,
  adapter: ModelAdapter,
  options?: AgentRuntimeOptions,
): Agent {
  const factory = BUILTIN_AGENT_REGISTRY[id];
  if (!factory) {
    throw new Error(
      `Unknown built-in neurotype "${id}". Known IDs: ${BUILTIN_AGENT_IDS.join(', ')}`,
    );
  }
  return factory(adapter, options);
}
