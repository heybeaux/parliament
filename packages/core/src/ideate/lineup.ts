/**
 * Default ideate lineups + resolver. Encoded as TypeScript constants so the
 * defaults travel with `@parliament/core` rather than living in a sample
 * `parliament.toml`. TOML overrides are strict-by-default: each role
 * override REPLACES the default for that role; missing entries fall back to
 * defaults. No field-level merging.
 *
 * Spec: `add-ideate-mode/specs/ideate-mode/spec.md` — "Default lineup is
 * encoded in core; TOML overrides are strict-by-default" + "Cooperative
 * and adversarial sub-modes default to closed-team lineup; full uses all 8".
 */

import type {
  IdeateConfig,
  IdeateMode,
  LineupAssignment,
  LineupRole,
  LineupTeam,
  ResolvedLineup,
} from './types.js';

// Closed-team frontier models (4). These run for cooperative + adversarial
// sub-modes by default. The user explicitly preferred Opus 4.6 over 4.7
// for synthesis (see memory feedback_opus_model_preference.md).
export const CLOSED_MODELS = {
  opus: 'anthropic/claude-opus-4-6',
  sonnet: 'anthropic/claude-sonnet-4-6',
  gpt5: 'openai/gpt-5',
  gemini: 'google/gemini-2.5-pro',
} as const;

// Open-team frontier models (4). These join cooperative + adversarial teams
// only in `full` sub-mode. Mistral + Nemotron come via OpenRouter.
export const OPEN_MODELS = {
  qwen: 'qwen/qwen-turbo',
  deepseek: 'deepseek/deepseek-v4-flash',
  mistral: 'mistralai/mistral-nemo',
  // nemotron-nano-9b-v2 was delisted from OpenRouter (paid endpoint 404s);
  // nemotron-3-nano-30b-a3b is its live successor.
  nemotron: 'nvidia/nemotron-3-nano-30b-a3b',
} as const;

// Synthesizer routing — Opus 4.6 for tighter cooperative/adversarial runs;
// Gemini 2.5 Pro for `full` because the 8-model transcript regularly
// exceeds Opus's context window.
export const SYNTH_DEFAULTS: Record<IdeateMode, string> = {
  cooperative: CLOSED_MODELS.opus,
  adversarial: CLOSED_MODELS.opus,
  full: 'google/gemini-2.5-pro',
};

/**
 * Default cooperative team for `cooperative` and `adversarial` sub-modes.
 * Four roles, four closed models. Order is stable so transcripts and tests
 * are deterministic.
 */
const COOPERATIVE_TEAM_CLOSED: readonly LineupAssignment[] = [
  { role: 'proposer', model: CLOSED_MODELS.opus },
  { role: 'expander', model: CLOSED_MODELS.sonnet },
  { role: 'pragmatist', model: CLOSED_MODELS.gpt5 },
  { role: 'lateralist', model: CLOSED_MODELS.gemini },
];

/**
 * Default cooperative team for `full` sub-mode — 8 models. The four extra
 * slots reuse cooperative-team roles in registration order. The role
 * mapping is intentional: more divergent thinkers get the most cognitively
 * loose roles (lateralist, expander); tighter reasoners get pragmatist
 * + proposer.
 */
const COOPERATIVE_TEAM_FULL: readonly LineupAssignment[] = [
  { role: 'proposer', model: CLOSED_MODELS.opus },
  { role: 'expander', model: CLOSED_MODELS.sonnet },
  { role: 'pragmatist', model: CLOSED_MODELS.gpt5 },
  { role: 'lateralist', model: CLOSED_MODELS.gemini },
  { role: 'proposer', model: OPEN_MODELS.qwen },
  { role: 'expander', model: OPEN_MODELS.deepseek },
  { role: 'pragmatist', model: OPEN_MODELS.mistral },
  { role: 'lateralist', model: OPEN_MODELS.nemotron },
];

/**
 * Default adversarial team. Closed models only by default — adversarial
 * critique benefits more from depth than breadth. `full` mode keeps the
 * same closed adversarial team; the open models join only the cooperative
 * side.
 */
const ADVERSARIAL_TEAM: readonly LineupAssignment[] = [
  { role: 'skeptic', model: CLOSED_MODELS.opus },
  { role: 'devils-advocate', model: CLOSED_MODELS.gpt5 },
];

const DEFAULT_TEAMS: Record<IdeateMode, LineupTeam> = {
  cooperative: { cooperative: COOPERATIVE_TEAM_CLOSED, adversarial: [] },
  adversarial: { cooperative: COOPERATIVE_TEAM_CLOSED, adversarial: ADVERSARIAL_TEAM },
  full: { cooperative: COOPERATIVE_TEAM_FULL, adversarial: ADVERSARIAL_TEAM },
};

/**
 * Returns the default lineup for `mode` with no overrides applied. Useful
 * for the CLI's `--print-lineup` flag and for tests that want a baseline.
 */
export function defaultLineup(mode: IdeateMode): ResolvedLineup {
  const team = DEFAULT_TEAMS[mode];
  return {
    mode,
    synth: SYNTH_DEFAULTS[mode],
    team: { cooperative: team.cooperative, adversarial: team.adversarial },
  };
}

function applyTeamOverrides(
  team: readonly LineupAssignment[],
  overrides: Partial<Record<LineupRole, string>> | undefined,
): readonly LineupAssignment[] {
  if (overrides === undefined) return team;
  // Strict-by-default per-role replacement: walk the team in order, swap
  // model when an override exists for that role. We replace the FIRST
  // occurrence of each role — `full` mode has duplicate role IDs (closed +
  // open) and we want the override to land on the closed slot, which is
  // listed first. Subsequent same-role slots keep their default model.
  const consumed = new Set<LineupRole>();
  return team.map((slot) => {
    if (consumed.has(slot.role)) return slot;
    const next = overrides[slot.role];
    if (next === undefined) return slot;
    consumed.add(slot.role);
    return { role: slot.role, model: next };
  });
}

/**
 * Resolves the in-code defaults against optional TOML overrides. Throws
 * `Error` when an override targets an unknown role for the sub-mode (e.g.
 * `[ideate.lineup.cooperative.skeptic]` is invalid because `skeptic` is an
 * adversarial role). Returns a fully-resolved `ResolvedLineup` ready for
 * persistence on the ideation row.
 */
export function resolveLineup(mode: IdeateMode, config?: IdeateConfig): ResolvedLineup {
  const base = defaultLineup(mode);
  const lineupOverrides = config?.lineup?.[mode];
  const synthOverride = config?.synth?.[mode];

  if (lineupOverrides !== undefined) {
    validateLineupRoles(mode, lineupOverrides);
  }

  return {
    mode,
    synth: synthOverride ?? base.synth,
    team: {
      cooperative: applyTeamOverrides(base.team.cooperative, pickRoles(lineupOverrides, COOP_ROLES)),
      adversarial: applyTeamOverrides(
        base.team.adversarial,
        pickRoles(lineupOverrides, ADV_ROLES),
      ),
    },
  };
}

const COOP_ROLES: readonly LineupRole[] = ['proposer', 'expander', 'pragmatist', 'lateralist'];
const ADV_ROLES: readonly LineupRole[] = ['skeptic', 'devils-advocate'];

function pickRoles(
  overrides: Partial<Record<LineupRole, string>> | undefined,
  allowed: readonly LineupRole[],
): Partial<Record<LineupRole, string>> | undefined {
  if (overrides === undefined) return undefined;
  const subset: Partial<Record<LineupRole, string>> = {};
  for (const role of allowed) {
    const value = overrides[role];
    if (value !== undefined) subset[role] = value;
  }
  return Object.keys(subset).length === 0 ? undefined : subset;
}

function validateLineupRoles(
  mode: IdeateMode,
  overrides: Partial<Record<LineupRole, string>>,
): void {
  const allKnown: readonly LineupRole[] = [...COOP_ROLES, ...ADV_ROLES];
  for (const key of Object.keys(overrides)) {
    if (!allKnown.includes(key as LineupRole)) {
      throw new Error(
        `Parliament: ideate lineup override for "${mode}" targets unknown role "${key}". ` +
          `Valid roles: ${allKnown.join(', ')}.`,
      );
    }
    // `cooperative` sub-mode rejects adversarial-role overrides — they would
    // resolve to a no-op and silently mislead users.
    if (mode === 'cooperative' && ADV_ROLES.includes(key as LineupRole)) {
      throw new Error(
        `Parliament: ideate lineup override "${key}" is adversarial-only and cannot be set ` +
          `under [ideate.lineup.cooperative].`,
      );
    }
  }
}
