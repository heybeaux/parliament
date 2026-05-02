import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PresetBadge } from './PresetBadge';
import { __PRESET_STYLES_FOR_TESTS, presetStyle } from '../lib/presets';

/**
 * PAR-20 — `<PresetBadge>` is the single visual marker shared by the
 * deliberation list, the result-view header, and the preset picker. These
 * tests pin three load-bearing contracts:
 *
 *   1. Every built-in preset has a non-fallback style — i.e. the registry
 *      covers the seven shipped presets and a future addition that forgets
 *      to register a color is caught at test time.
 *   2. The seven built-in dot colors are pairwise distinct so a list with
 *      same-topic-different-preset rows is visually unambiguous (this is
 *      the explicit ticket acceptance criterion).
 *   3. Legacy / missing / unknown preset ids fall back to the neutral em-dash
 *      badge instead of crashing or logging a missing-prop warning.
 */
describe('PresetBadge', () => {
  afterEach(() => cleanup());

  it('renders a non-fallback style for each of the 7 built-in presets', () => {
    const builtinIds = [
      'debate',
      'star-chamber',
      'chain-of-verifiers',
      'socratic',
      'long-view',
      'reframe',
      'jury',
    ];

    expect(Object.keys(__PRESET_STYLES_FOR_TESTS).sort()).toEqual(
      [...builtinIds].sort(),
    );

    for (const id of builtinIds) {
      const style = presetStyle(id);
      // The fallback dot is `bg-zinc-500` and the fallback label is the em
      // dash. Anything else means the registry has a real entry.
      expect(style.dot).not.toBe('bg-zinc-500');
      expect(style.label).not.toBe('\u2014');
    }
  });

  it('uses pairwise-distinct dot colors for all 7 built-in presets', () => {
    const dots = new Set<string>();
    for (const id of Object.keys(__PRESET_STYLES_FOR_TESTS)) {
      dots.add(presetStyle(id).dot);
    }
    expect(dots.size).toBe(7);
  });

  it('does not collide with the neurotype role palette in roleStyle()', () => {
    // Sanity: the role palette uses emerald/amber/blue/rose/violet/zinc;
    // the preset palette must avoid those families to keep neurotype and
    // preset chips visually separable.
    const presetDots = Object.values(__PRESET_STYLES_FOR_TESTS).map(
      (s) => s.dot,
    );
    for (const dot of presetDots) {
      expect(dot).not.toMatch(/^bg-(emerald|amber|blue|rose|violet|zinc)-/);
    }
  });

  it('renders the neutral em-dash badge when preset id is null/undefined/empty', () => {
    for (const id of [null, undefined, '', '   ']) {
      cleanup();
      render(<PresetBadge presetId={id as unknown as string | null | undefined} />);
      const chip = screen.getByTestId('preset-badge');
      expect(chip).toHaveTextContent('\u2014');
      // Neutral dot uses zinc-500.
      expect(chip.querySelector('[aria-hidden="true"]')?.className).toContain(
        'bg-zinc-500',
      );
    }
  });

  it('renders the registry label for known preset ids', () => {
    render(<PresetBadge presetId="star-chamber" />);
    expect(screen.getByTestId('preset-badge')).toHaveTextContent(/star chamber/i);
  });

  it('falls back to neutral palette but uses the supplied name for unknown ids', () => {
    render(<PresetBadge presetId="custom-thing" name="My Custom Preset" />);
    const chip = screen.getByTestId('preset-badge');
    expect(chip).toHaveTextContent(/my custom preset/i);
    // Still neutral dot since the color isn't registered.
    expect(chip.querySelector('[aria-hidden="true"]')?.className).toContain(
      'bg-zinc-500',
    );
  });
});
