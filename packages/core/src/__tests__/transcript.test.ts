import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DebateResult, Turn } from '../types.js';
import {
  topicSlug,
  formatTimestamp,
  saveTranscript,
  formatTurnHeader,
  printTurn,
  printSummary,
} from '../transcript.js';

// ---------------------------------------------------------------------------
// topicSlug
// ---------------------------------------------------------------------------

describe('topicSlug', () => {
  it('lowercases and replaces spaces with underscores', () => {
    expect(topicSlug('Hello World')).toBe('hello_world');
  });

  it('strips non-alphanumeric characters (except underscores)', () => {
    // "&" is stripped, spaces collapse to "_", "!" is stripped
    expect(topicSlug('AI & the Future!')).toBe('ai__the_future');
  });

  it('collapses multiple consecutive spaces into a single underscore', () => {
    expect(topicSlug('a  b')).toBe('a_b');
  });

  it('returns empty string for an empty input', () => {
    expect(topicSlug('')).toBe('');
  });

  it('handles a typical topic string', () => {
    expect(topicSlug('Should AI replace human judges?')).toBe(
      'should_ai_replace_human_judges',
    );
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('formats a date as YYYYMMDD_HHMMSS', () => {
    // Use a fixed date: 2026-04-28 15:03:07 local
    const d = new Date(2026, 3, 28, 15, 3, 7); // month is 0-indexed
    expect(formatTimestamp(d)).toBe('20260428_150307');
  });

  it('zero-pads month, day, hours, minutes, seconds', () => {
    const d = new Date(2026, 0, 5, 9, 4, 2); // Jan 5, 09:04:02
    expect(formatTimestamp(d)).toBe('20260105_090402');
  });
});

// ---------------------------------------------------------------------------
// saveTranscript
// ---------------------------------------------------------------------------

describe('saveTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parliament-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeResult = (topic: string): DebateResult => ({
    topic,
    turns: [],
    conflicts: [],
    residue: [],
    resolved: true,
    total_rounds: 2,
    termination_reason: 'max_rounds',
  });

  it('creates the transcripts directory if it does not exist', () => {
    const dir = path.join(tmpDir, 'transcripts');
    saveTranscript(makeResult('test topic'), dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('writes a valid JSON file', () => {
    const dir = path.join(tmpDir, 'transcripts');
    const filepath = saveTranscript(makeResult('test topic'), dir);
    const raw = fs.readFileSync(filepath, 'utf8');
    const parsed = JSON.parse(raw) as DebateResult;
    expect(parsed.topic).toBe('test topic');
    expect(parsed.total_rounds).toBe(2);
  });

  it('names the file with YYYYMMDD_HHMMSS_{slug}.json pattern', () => {
    const dir = path.join(tmpDir, 'transcripts');
    const filepath = saveTranscript(makeResult('Hello World'), dir);
    const filename = path.basename(filepath);
    expect(filename).toMatch(/^\d{8}_\d{6}_hello_world\.json$/);
  });
});

// ---------------------------------------------------------------------------
// formatTurnHeader
// ---------------------------------------------------------------------------

describe('formatTurnHeader', () => {
  const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
    agent: 'Proposer',
    neurotype: 'structured',
    model: 'llama3.2',
    content: 'content',
    timestamp: new Date().toISOString(),
    round: 1,
    ...overrides,
  });

  it('formats without osi_score when undefined', () => {
    expect(formatTurnHeader(makeTurn())).toBe(
      '[Proposer | structured | llama3.2]',
    );
  });

  it('includes osi_score when present', () => {
    expect(formatTurnHeader(makeTurn({ osi_score: 0.75 }))).toBe(
      '[Proposer | structured | llama3.2 | osi:0.75]',
    );
  });

  it('includes osi_score of 0 (falsy but defined)', () => {
    expect(formatTurnHeader(makeTurn({ osi_score: 0 }))).toBe(
      '[Proposer | structured | llama3.2 | osi:0]',
    );
  });
});

// ---------------------------------------------------------------------------
// printTurn — stdout capture
// ---------------------------------------------------------------------------

describe('printTurn', () => {
  let output: string;
  let original: typeof process.stdout.write;

  beforeEach(() => {
    output = '';
    original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = original;
  });

  it('prints the turn header and content to stdout', () => {
    const turn: Turn = {
      agent: 'Skeptic',
      neurotype: 'critical',
      model: 'mistral',
      content: 'I disagree.',
      timestamp: new Date().toISOString(),
      round: 1,
    };
    printTurn(turn);
    expect(output).toContain('[Skeptic | critical | mistral]');
    expect(output).toContain('I disagree.');
  });
});

// ---------------------------------------------------------------------------
// printSummary — stdout capture
// ---------------------------------------------------------------------------

describe('printSummary', () => {
  let output: string;
  let original: typeof process.stdout.write;

  beforeEach(() => {
    output = '';
    original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = original;
  });

  it('prints unresolved conflicts in the summary', () => {
    const result: DebateResult = {
      topic: 'Test',
      turns: [],
      conflicts: [
        {
          between: ['Skeptic', 'Proposer'],
          description: 'fundamental disagreement on X',
          resolved: false,
        },
      ],
      residue: [],
      resolved: false,
      total_rounds: 3,
      termination_reason: 'max_rounds',
    };
    printSummary(result);
    expect(output).toContain('UNRESOLVED CONFLICTS');
    expect(output).toContain('Skeptic vs Proposer');
    expect(output).toContain('fundamental disagreement on X');
  });

  it('prints residue items', () => {
    const result: DebateResult = {
      topic: 'Test',
      turns: [],
      conflicts: [],
      residue: ['unresolved claim about Y'],
      resolved: false,
      total_rounds: 3,
      termination_reason: 'max_rounds',
    };
    printSummary(result);
    expect(output).toContain('UNRESOLVED CONFLICTS');
    expect(output).toContain('unresolved claim about Y');
  });

  it('does not print the unresolved section when all conflicts are resolved', () => {
    const result: DebateResult = {
      topic: 'Test',
      turns: [],
      conflicts: [
        {
          between: ['A', 'B'],
          description: 'resolved conflict',
          resolved: true,
        },
      ],
      residue: [],
      resolved: true,
      total_rounds: 1,
      termination_reason: 'consensus',
    };
    printSummary(result);
    expect(output).not.toContain('UNRESOLVED CONFLICTS');
    expect(output).toContain('RESOLVED');
  });

  it('prints the termination reason and round count', () => {
    const result: DebateResult = {
      topic: 'Test',
      turns: [],
      conflicts: [],
      residue: [],
      resolved: true,
      total_rounds: 5,
      termination_reason: 'consensus',
    };
    printSummary(result);
    expect(output).toContain('rounds:5');
    expect(output).toContain('reason:consensus');
  });
});
