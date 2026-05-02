/**
 * PAR-16 — UI contract for the optional context textarea on the New
 * Deliberation form. Mirrors the PresetPicker test style: stub `fetch` so
 * the embedded PresetPicker can settle, then drive the form via Testing
 * Library.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewDeliberation } from './NewDeliberation';
import { startDeliberation } from '../lib/api';

const PRESETS_RESPONSE = {
  presets: [
    {
      id: 'debate',
      name: 'Debate',
      description: 'Server-supplied debate description.',
      best_for: 'Open arguments.',
    },
  ],
  defaultPreset: 'debate',
};

function stubFetch(response: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/presets')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => PRESETS_RESPONSE,
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => response,
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('NewDeliberation context textarea (PAR-16)', () => {
  beforeEach(() => {
    // PresetPicker mounts a fetch on render — stub a happy-path response so
    // the form is interactive.
    stubFetch({ id: 'fake-id', topic: 'Topic', context: undefined });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hides the textarea by default and reveals it on click', async () => {
    const user = userEvent.setup();
    render(<NewDeliberation onSubmit={vi.fn()} disabled={false} />);

    // Default collapsed: textarea is not in the DOM.
    expect(screen.queryByLabelText(/deliberation context/i)).toBeNull();

    // The "Add context" toggle is visible.
    const toggle = screen.getByRole('button', { name: /add context/i });
    await user.click(toggle);

    // Textarea now rendered.
    expect(await screen.findByLabelText(/deliberation context/i)).toBeInTheDocument();
  });

  it('forwards trimmed context as the third onSubmit argument', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewDeliberation onSubmit={onSubmit} disabled={false} />);

    // Wait for PresetPicker to settle so its onChange has fired with "debate".
    await waitFor(() => {
      const select = screen.getByLabelText(/deliberation preset/i) as HTMLSelectElement;
      expect(select.value).toBe('debate');
    });

    await user.type(
      screen.getByPlaceholderText(/Should an autonomous AI/i),
      'Should we ship?',
    );

    await user.click(screen.getByRole('button', { name: /add context/i }));
    const textarea = await screen.findByLabelText(/deliberation context/i);
    await user.type(textarea, '   System X background.   ');

    await user.click(screen.getByRole('button', { name: /^deliberate/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [topicArg, presetArg, contextArg] = onSubmit.mock.calls[0]!;
    expect(topicArg).toBe('Should we ship?');
    expect(presetArg).toBe('debate');
    expect(contextArg).toBe('System X background.');
  });

  it('passes undefined context when the textarea is never opened', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewDeliberation onSubmit={onSubmit} disabled={false} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/deliberation preset/i) as HTMLSelectElement;
      expect(select.value).toBe('debate');
    });

    await user.type(
      screen.getByPlaceholderText(/Should an autonomous AI/i),
      'Question only.',
    );
    await user.click(screen.getByRole('button', { name: /^deliberate/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [, , contextArg] = onSubmit.mock.calls[0]!;
    expect(contextArg).toBeUndefined();
  });

  it('passes undefined context when the textarea contains only whitespace', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NewDeliberation onSubmit={onSubmit} disabled={false} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/deliberation preset/i) as HTMLSelectElement;
      expect(select.value).toBe('debate');
    });

    await user.type(screen.getByPlaceholderText(/Should an autonomous AI/i), 'Q?');
    await user.click(screen.getByRole('button', { name: /add context/i }));
    const textarea = await screen.findByLabelText(/deliberation context/i);
    await user.type(textarea, '   \n\t   ');

    await user.click(screen.getByRole('button', { name: /^deliberate/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [, , contextArg] = onSubmit.mock.calls[0]!;
    expect(contextArg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// API client round-trip — the textarea contents reach the POST body.
// ---------------------------------------------------------------------------

describe('startDeliberation context body (PAR-16)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'x', topic: 't' }),
      text: async () => '',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('includes context in the POST body when provided', async () => {
    await startDeliberation('topic', { preset: 'debate', context: 'brief here' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['context']).toBe('brief here');
  });

  it('omits context from the POST body when undefined', async () => {
    await startDeliberation('topic', { preset: 'debate' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('context' in body).toBe(false);
  });

  it('omits context from the POST body when whitespace-only', async () => {
    await startDeliberation('topic', { preset: 'debate', context: '   \n\t  ' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('context' in body).toBe(false);
  });
});
