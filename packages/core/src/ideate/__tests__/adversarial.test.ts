import { describe, expect, it } from 'vitest';
import { parseAdversarialOutput } from '../adversarial.js';

describe('parseAdversarialOutput', () => {
  it('parses well-formed JSON with a single problem-fix pair', () => {
    const raw = JSON.stringify({
      problems: [
        {
          problem: 'Latency is unbounded.',
          proposed_fix: 'Add a 30s SLA timeout.',
          dimension: 'technical',
        },
      ],
    });
    const out = parseAdversarialOutput(raw);
    expect(out).toEqual([
      {
        problem: 'Latency is unbounded.',
        proposed_fix: 'Add a 30s SLA timeout.',
        dimension: 'technical',
      },
    ]);
  });

  it('parses JSON wrapped in ```json fences```', () => {
    const raw = '```json\n' +
      JSON.stringify({
        problems: [
          {
            problem: 'No retries.',
            proposed_fix: 'Use exponential backoff.',
            dimension: 'technical',
          },
        ],
      }) +
      '\n```';
    const out = parseAdversarialOutput(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.problem).toBe('No retries.');
  });

  it('parses JSON preceded by a "Sure, here is the JSON:" preamble via balanced-brace fallback', () => {
    const raw =
      'Sure, here is the JSON:\n' +
      JSON.stringify({
        problems: [
          { problem: 'P1', proposed_fix: 'F1', dimension: 'ux' },
          { problem: 'P2', proposed_fix: 'F2', dimension: 'business' },
        ],
      });
    const out = parseAdversarialOutput(raw);
    expect(out).toHaveLength(2);
  });

  it('returns null when the response is plain prose', () => {
    expect(parseAdversarialOutput('I think this idea has a few issues...')).toBeNull();
  });

  it('returns null when the JSON has no "problems" key', () => {
    expect(parseAdversarialOutput(JSON.stringify({ critique: 'something' }))).toBeNull();
  });

  it('returns null when "problems" is empty', () => {
    expect(parseAdversarialOutput(JSON.stringify({ problems: [] }))).toBeNull();
  });

  it('returns null when an entry is missing "proposed_fix"', () => {
    expect(
      parseAdversarialOutput(JSON.stringify({ problems: [{ problem: 'p' }] })),
    ).toBeNull();
  });

  it('returns null when an entry has an empty string field', () => {
    expect(
      parseAdversarialOutput(
        JSON.stringify({ problems: [{ problem: '   ', proposed_fix: 'f' }] }),
      ),
    ).toBeNull();
  });

  it('trims whitespace on parsed strings', () => {
    const raw = JSON.stringify({
      problems: [{ problem: '  P1  ', proposed_fix: '  F1  ', dimension: 'ux' }],
    });
    expect(parseAdversarialOutput(raw)).toEqual([
      { problem: 'P1', proposed_fix: 'F1', dimension: 'ux' },
    ]);
  });

  it('rejects problems missing the required `dimension` field (one-shot, returns null)', () => {
    // Section 3.2: parser MUST reject missing/unknown dimension.
    const raw = JSON.stringify({
      problems: [{ problem: 'p', proposed_fix: 'f' }],
    });
    expect(parseAdversarialOutput(raw)).toBeNull();
  });

  it('rejects problems with an unknown dimension value', () => {
    const raw = JSON.stringify({
      problems: [{ problem: 'p', proposed_fix: 'f', dimension: 'nope' }],
    });
    expect(parseAdversarialOutput(raw)).toBeNull();
  });
});
