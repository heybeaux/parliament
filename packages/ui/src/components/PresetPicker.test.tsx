import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FALLBACK_PRESETS, PresetPicker } from './PresetPicker';

const SERVER_PRESETS = [
  {
    id: 'debate',
    name: 'Debate',
    description: 'Server-supplied debate description.',
    best_for: 'Open arguments.',
  },
  {
    id: 'jury',
    name: 'Jury',
    description: 'Server-supplied jury description.',
    best_for: 'Independent panels.',
  },
  {
    id: 'star-chamber',
    name: 'Star Chamber',
    description: 'Adversarial review.',
    best_for: 'Hostile critique.',
    requires_neurotypes: ['skeptic', 'specialist'],
    missing_neurotypes: ['specialist'],
  },
];

function ControlledHarness({
  initial = '',
  onSelect,
}: {
  initial?: string;
  onSelect?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <PresetPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onSelect?.(next);
      }}
    />
  );
}

describe('PresetPicker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders all fallback presets when /presets fetch fails', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('network down'),
    );

    render(<ControlledHarness />);

    const select = await screen.findByLabelText(/deliberation preset/i);
    await waitFor(() => {
      expect((select as HTMLSelectElement).options.length).toBe(FALLBACK_PRESETS.length);
    });
    expect(FALLBACK_PRESETS).toHaveLength(8);
    for (const preset of FALLBACK_PRESETS) {
      expect(select).toHaveTextContent(preset.name);
    }
    expect(screen.getByText(/offline list/i)).toBeInTheDocument();
  });

  it('defaults the selected value to "debate" via onChange when value is empty', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ presets: SERVER_PRESETS, defaultPreset: 'debate' }),
      text: async () => '',
    } as unknown as Response);

    const onSelect = vi.fn();
    render(<ControlledHarness onSelect={onSelect} />);

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('debate');
    });

    const select = (await screen.findByLabelText(/deliberation preset/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('debate'));
  });

  it('calls onChange when the user selects a different preset', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ presets: SERVER_PRESETS, defaultPreset: 'debate' }),
      text: async () => '',
    } as unknown as Response);

    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ControlledHarness onSelect={onSelect} />);

    const select = (await screen.findByLabelText(/deliberation preset/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('debate'));

    await user.selectOptions(select, 'jury');

    expect(onSelect).toHaveBeenCalledWith('jury');
    expect(select.value).toBe('jury');
  });

  it('disables presets with missing neurotypes and surfaces a tooltip', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ presets: SERVER_PRESETS, defaultPreset: 'debate' }),
      text: async () => '',
    } as unknown as Response);

    render(<ControlledHarness />);

    const starChamberOption = (await screen.findByRole('option', {
      name: /star chamber/i,
    })) as HTMLOptionElement;
    expect(starChamberOption).toBeDisabled();
    expect(starChamberOption.getAttribute('title')).toMatch(/specialist/);
  });
});
