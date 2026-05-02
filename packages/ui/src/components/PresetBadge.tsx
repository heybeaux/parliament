import { presetStyle } from '../lib/presets';

/**
 * PAR-20 — small per-preset chip used in three places:
 *
 *   - `TranscriptList` row → `size="sm"` (a tiny dot + label next to the
 *     topic so same-topic, different-preset runs are visually distinct
 *     without a click).
 *   - `Timeline` header    → `size="md"` (a more prominent chip when a
 *     deliberation is loaded so the result-view answers "what flavor was
 *     this?" at a glance).
 *   - `PresetPicker`       → also `size="sm"` on each option chip so the
 *     pre-submit color matches the post-submit color exactly.
 *
 * Legacy fallback contract: when `presetId` is `null` / `undefined` /
 * empty, `presetStyle()` returns the neutral zinc style with an em-dash
 * label. The badge therefore always renders SOMETHING — it never crashes
 * and it never logs a missing-prop warning.
 */
interface Props {
  /** Preset id from `DeliberationResult.preset` / `DeliberationSummary.preset`. */
  presetId: string | null | undefined;
  /**
   * Optional human label override. Mostly used by `PresetPicker` so the
   * server-supplied `name` shows up for unknown user-defined presets that
   * the static registry doesn't carry a built-in label for.
   */
  name?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}

export function PresetBadge({ presetId, name, size = 'sm', className }: Props) {
  const style = presetStyle(presetId, name);
  // `sm` is the list-row chip — tight padding so it doesn't crowd the
  // topic line. `md` is the result-header chip — chunkier to anchor the
  // hero region.
  const sizeClasses =
    size === 'md'
      ? 'gap-1.5 px-2.5 py-1 text-xs font-semibold'
      : 'gap-1 px-1.5 py-0.5 text-2xs font-semibold';
  const dotSize = size === 'md' ? 'h-2 w-2' : 'h-1.5 w-1.5';

  return (
    <span
      data-testid="preset-badge"
      data-preset-id={presetId ?? ''}
      className={[
        'inline-flex items-center rounded-md ring-1 uppercase tracking-wider',
        sizeClasses,
        style.bg,
        style.text,
        style.ring,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={`Preset: ${style.label}`}
    >
      <span
        aria-hidden="true"
        className={['shrink-0 rounded-full', dotSize, style.dot].join(' ')}
      />
      <span className="truncate normal-case tracking-normal">{style.label}</span>
    </span>
  );
}
