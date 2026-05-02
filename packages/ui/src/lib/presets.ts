/**
 * PAR-20 — single source of truth for per-preset visual identity.
 *
 * Three places in the UI render a marker for "which preset produced this
 * deliberation": the deliberation list rows, the result-view header, and the
 * PresetPicker option list. They all read from this file so a new preset
 * only needs to register one entry here to get a consistent color and
 * plain-language label everywhere it shows up.
 *
 * Palette discipline:
 *   The neurotype role chips on `TurnCard` consume `roleStyle()` from
 *   `./roles.ts`; that palette currently uses emerald (proposer), amber
 *   (skeptic), blue (synthesizer), rose (redAgent), violet (sentry), and
 *   zinc (fallback). The preset palette below deliberately stays out of
 *   those families so a Star-Chamber-with-Skeptic turn doesn't render two
 *   amber chips that the eye reads as the same thing. The fallback for
 *   unknown / legacy presets is also zinc — but it carries the em-dash
 *   label so it never gets confused with the role fallback chip.
 *
 * Shape mirrors `roleStyle()` so the badge component can render dot/ring/
 * bg/text the same way regardless of whether it's drawing a role or a
 * preset chip. Only Tailwind classes that already work in this codebase
 * are used — see `packages/ui/tailwind.config.cjs`.
 */

export interface PresetStyle {
  /** Plain-language preset label (e.g. "Star Chamber"). */
  label: string;
  /** Solid dot — the smallest visual marker, used inside list rows. */
  dot: string;
  /** Ring class — used by the result-view header for emphasis. */
  ring: string;
  /** Background tint class — pairs with `text` to form the chip body. */
  bg: string;
  /** Text color class — pairs with `bg`. */
  text: string;
}

/**
 * Stable per-preset visual identity. Keys are the kebab-case preset IDs
 * the engine emits on `DeliberationResult.preset` and the server returns on
 * each preset listing entry. Plain-language labels mirror what the server's
 * `/presets` endpoint returns under `name`, so list rows that pre-date the
 * server roundtrip still render a useful label.
 *
 * Colors picked to be visually well-separated from each other AND from the
 * neurotype palette in `roleStyle()`:
 *   - Debate              → indigo (cool, debate-of-ideas)
 *   - Star Chamber        → orange (warm-pressure, distinct from amber/skeptic)
 *   - Chain-of-Verifiers  → teal   (sequential checks, distinct from emerald)
 *   - Socratic            → sky    (questioning, distinct from blue/synthesizer)
 *   - Long-View           → fuchsia (time-spectrum, distinct from violet/sentry)
 *   - Reframe             → pink   (creative re-angle, distinct from rose/redAgent)
 *   - Jury                → lime   (parallel/fresh, distinct from emerald/proposer)
 */
const PRESET_STYLES: Record<string, PresetStyle> = {
  debate: {
    label: 'Debate',
    dot: 'bg-indigo-400',
    ring: 'ring-indigo-400/25',
    bg: 'bg-indigo-500/10',
    text: 'text-indigo-300',
  },
  'star-chamber': {
    label: 'Star Chamber',
    dot: 'bg-orange-400',
    ring: 'ring-orange-400/25',
    bg: 'bg-orange-500/10',
    text: 'text-orange-300',
  },
  'chain-of-verifiers': {
    label: 'Chain of Verifiers',
    dot: 'bg-teal-400',
    ring: 'ring-teal-400/25',
    bg: 'bg-teal-500/10',
    text: 'text-teal-300',
  },
  socratic: {
    label: 'Socratic',
    dot: 'bg-sky-400',
    ring: 'ring-sky-400/25',
    bg: 'bg-sky-500/10',
    text: 'text-sky-300',
  },
  'long-view': {
    label: 'Long View',
    dot: 'bg-fuchsia-400',
    ring: 'ring-fuchsia-400/25',
    bg: 'bg-fuchsia-500/10',
    text: 'text-fuchsia-300',
  },
  reframe: {
    label: 'Reframe',
    dot: 'bg-pink-400',
    ring: 'ring-pink-400/25',
    bg: 'bg-pink-500/10',
    text: 'text-pink-300',
  },
  jury: {
    label: 'Jury',
    dot: 'bg-lime-400',
    ring: 'ring-lime-400/25',
    bg: 'bg-lime-500/10',
    text: 'text-lime-300',
  },
};

/**
 * Neutral fallback used when:
 *   - the preset id is missing on a stored deliberation (legacy rows
 *     recorded before PAR-20),
 *   - the id is not in the registry (a user-defined preset the UI hasn't
 *     learned a color for yet),
 *   - the value is an empty / whitespace-only string.
 *
 * The em-dash label keeps the row layout stable while signalling "no preset
 * info" — it must never collapse the list-row line and never trigger a
 * missing-prop warning.
 */
const FALLBACK_STYLE: PresetStyle = {
  label: '\u2014', // em dash
  dot: 'bg-zinc-500',
  ring: 'ring-zinc-500/25',
  bg: 'bg-zinc-500/10',
  text: 'text-zinc-400',
};

/**
 * Resolve the style + label for a preset id. Treats missing / unknown /
 * blank inputs as legacy and returns the neutral fallback so callers never
 * have to branch.
 *
 * The `name` argument lets the caller pass through a server-supplied label
 * for unknown ids — e.g. a user-defined preset the registry doesn't know
 * about yet. We still render the neutral palette in that case (so the
 * preset color stays opt-in), but we surface the human name instead of
 * an em-dash so the row reads correctly.
 */
export function presetStyle(
  presetId: string | null | undefined,
  name?: string | null,
): PresetStyle {
  if (typeof presetId !== 'string' || presetId.trim() === '') {
    return FALLBACK_STYLE;
  }
  const known = PRESET_STYLES[presetId];
  if (known !== undefined) return known;
  // Unknown preset id but the caller knows the human name — keep the
  // neutral palette but surface the name so the chip is still useful.
  if (typeof name === 'string' && name.trim() !== '') {
    return { ...FALLBACK_STYLE, label: name.trim() };
  }
  return FALLBACK_STYLE;
}

/**
 * Test-only export. Lets specs assert "every built-in preset has a
 * non-fallback style" and that the seven built-in dots are pairwise
 * distinct. Not part of the runtime API.
 */
export const __PRESET_STYLES_FOR_TESTS = PRESET_STYLES;
