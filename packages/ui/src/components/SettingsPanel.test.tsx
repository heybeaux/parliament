import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';

// ---------------------------------------------------------------------------
// Settings → Models section.
//
// The panel fetches `/api/settings` (now carrying the per-role model map)
// and `/api/models` (the server-side OpenRouter catalog proxy). One select
// per role, pre-selected on the effective model; a configured model that is
// missing from the catalog (e.g. delisted upstream) still renders, marked
// "(not available)"; when the catalog fetch fails the picker degrades to a
// free-text input. Saving PUTs `{ model_overrides }` where a value equal to
// the config default is sent as null (clears the override).
// ---------------------------------------------------------------------------

const ROLE_KEYS = ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'] as const;

function settingsBody(overrides?: Partial<Record<string, string>>) {
  const models: Record<string, unknown> = {};
  for (const role of ROLE_KEYS) {
    const def = `default/${role}`;
    const override = overrides?.[role];
    models[role] = {
      default: def,
      effective: override ?? def,
      override_active: override !== undefined,
    };
  }
  return {
    provider: 'openrouter',
    openrouter_key_configured: true,
    openrouter_key_hint: '…abcd',
    key_source: 'file',
    models,
  };
}

const CATALOG = [
  ...ROLE_KEYS.map((role) => ({ id: `default/${role}`, name: `Default ${role}` })),
  { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini' },
];

interface StubOptions {
  overrides?: Partial<Record<string, string>>;
  catalog?: Array<{ id: string; name: string }> | 'fail';
}

function stubFetch({ overrides, catalog = CATALOG }: StubOptions = {}) {
  const putBodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (url.endsWith('/settings') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify(settingsBody(overrides)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/settings/models') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        model_overrides: Record<string, string | null>;
      };
      putBodies.push(body);
      const next: Partial<Record<string, string>> = {};
      for (const [role, value] of Object.entries(body.model_overrides)) {
        if (typeof value === 'string') next[role] = value;
      }
      return new Response(
        JSON.stringify({ ok: true, models: settingsBody(next).models }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/models')) {
      if (catalog === 'fail') {
        return new Response(JSON.stringify({ error: 'models_fetch_failed' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ models: catalog, cached: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, putBodies };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SettingsPanel — Models section', () => {
  it('renders one select per role with the effective model selected', async () => {
    stubFetch();
    render(<SettingsPanel open onClose={() => {}} />);

    const proposer = await screen.findByLabelText<HTMLSelectElement>('Proposer');
    expect(proposer.tagName).toBe('SELECT');
    expect(proposer.value).toBe('default/proposer');

    for (const label of ['Skeptic', 'Synthesizer', 'Red Agent', 'Sentry']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('marks a configured model missing from the catalog as "(not available)"', async () => {
    // Simulates the delisted-synthesizer failure mode: the override points at
    // a model the catalog no longer lists.
    stubFetch({ overrides: { synthesizer: 'nvidia/nemotron-nano-9b-v2' } });
    render(<SettingsPanel open onClose={() => {}} />);

    const synth = await screen.findByLabelText<HTMLSelectElement>(/Synthesizer/);
    expect(synth.value).toBe('nvidia/nemotron-nano-9b-v2');
    expect(
      screen.getByRole('option', { name: 'nvidia/nemotron-nano-9b-v2 (not available)' }),
    ).toBeInTheDocument();
  });

  it('falls back to a text input pre-filled with the effective model when the catalog fetch fails', async () => {
    stubFetch({ catalog: 'fail' });
    render(<SettingsPanel open onClose={() => {}} />);

    const proposer = await screen.findByLabelText<HTMLInputElement>('Proposer');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Proposer').tagName).toBe('INPUT');
    });
    expect(proposer.value).toBe('default/proposer');
    expect(screen.getByText(/Couldn’t load the model list/)).toBeInTheDocument();
  });

  it('saves overrides via PUT (default-valued roles sent as null) and shows the saved feedback', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { putBodies } = stubFetch();
    render(<SettingsPanel open onClose={() => {}} onSaved={onSaved} />);

    const skeptic = await screen.findByLabelText<HTMLSelectElement>('Skeptic');
    await user.selectOptions(skeptic, 'openai/gpt-5-mini');
    await user.click(screen.getByRole('button', { name: 'Save models' }));

    await waitFor(() => {
      expect(screen.getByText(/Models saved/)).toBeInTheDocument();
    });
    expect(onSaved).toHaveBeenCalled();

    expect(putBodies).toHaveLength(1);
    expect(putBodies[0]).toEqual({
      model_overrides: {
        proposer: null,
        skeptic: 'openai/gpt-5-mini',
        synthesizer: null,
        redAgent: null,
        sentry: null,
      },
    });

    // The saved override is now flagged as custom.
    expect(screen.getByText('custom')).toBeInTheDocument();
  });

  it('resets an overridden role back to its default via the per-role reset', async () => {
    const user = userEvent.setup();
    const { putBodies } = stubFetch({ overrides: { redAgent: 'openai/gpt-5-mini' } });
    render(<SettingsPanel open onClose={() => {}} />);

    const red = await screen.findByLabelText<HTMLSelectElement>(/Red Agent/);
    expect(red.value).toBe('openai/gpt-5-mini');

    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(screen.getByLabelText<HTMLSelectElement>(/Red Agent/).value).toBe(
      'default/redAgent',
    );

    await user.click(screen.getByRole('button', { name: 'Save models' }));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(
      (putBodies[0] as { model_overrides: Record<string, string | null> }).model_overrides[
        'redAgent'
      ],
    ).toBeNull();
  });

  it('shows an error message when the save fails', async () => {
    const user = userEvent.setup();
    const { fetchMock } = stubFetch();

    render(<SettingsPanel open onClose={() => {}} />);
    await screen.findByLabelText('Proposer');

    // Make the PUT fail while leaving the GET stubs intact.
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response('boom', { status: 500 });
      }
      return original(input, init);
    });

    await user.click(screen.getByRole('button', { name: 'Save models' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/HTTP 500/);
    });
  });
});
