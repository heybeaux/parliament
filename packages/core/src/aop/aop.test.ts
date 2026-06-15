/**
 * AOP v0.1 reasoning-projection conformance.
 *
 * Proves Parliament can emit a conformant AOP "reasoning" observation without
 * importing Sonder: a projected DeliberationResult validates against the
 * published v0.1 envelope schema (vendored copy; source of truth is
 * heybeaux/sonder). This is the Parliament leg of the AOP dogfooding plan.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsNs from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

import { toAopReasoningObservation, deriveReasoning, AOP_VERSION } from './index.js';
import type { DeliberationResult, Turn } from '../types.js';

const addFormats = (addFormatsNs as unknown as { default: typeof import('ajv-formats').default })
  .default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'agent-observation-event.schema.v0.1.json');

let validate: ValidateFunction;

beforeAll(() => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  validate = ajv.compile(schema);
});

function turn(partial: Partial<Turn> & Pick<Turn, 'agent' | 'neurotype' | 'model'>): Turn {
  return {
    content: 'x',
    timestamp: '2026-06-15T21:00:00.000Z',
    round: 1,
    ...partial,
  };
}

/** A consensus deliberation: synthesizer voted consensus, low residue. */
function consensusResult(): DeliberationResult {
  return {
    topic: 'Should we ship AOP quietly?',
    preset: 'debate',
    turns: [
      turn({ agent: 'Skeptic', neurotype: 'critical', model: 'claude-opus', round: 1 }),
      turn({ agent: 'Empiricist', neurotype: 'evidence-first', model: 'gpt-4o', round: 1 }),
      turn({
        agent: 'Synthesizer',
        neurotype: 'integrative',
        model: 'claude-opus',
        round: 2,
        meta: { confidence: 0.92, consensus: true, agreed: ['quiet moat'], unresolved: [] },
      }),
    ],
    conflicts: [],
    residueScore: 0.05,
    resolved: true,
    synthesis: 'Ship quietly; dogfood across faculties.',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 2,
    started_at: '2026-06-15T20:59:00.000Z',
    completed_at: '2026-06-15T21:00:00.000Z',
    events: [],
    status: 'completed',
  };
}

/** A non-consensus deliberation: max rounds hit, residue high, split present. */
function splitResult(): DeliberationResult {
  return {
    topic: 'Protobuf in v0.1 or defer?',
    preset: 'debate',
    turns: [
      turn({ agent: 'Skeptic', neurotype: 'critical', model: 'claude-opus', round: 1 }),
      turn({ agent: 'Pragmatist', neurotype: 'pragmatic', model: 'gemini-pro', round: 1 }),
      turn({
        agent: 'Synthesizer',
        neurotype: 'integrative',
        model: 'claude-opus',
        round: 3,
        meta: {
          confidence: 0.4,
          consensus: false,
          agreed: ['json schema first'],
          unresolved: ['protobuf timing', 'maintenance cost of two schemas'],
        },
      }),
    ],
    conflicts: [{ between: ['Skeptic', 'Pragmatist'], description: 'proto timing', resolved: false }],
    residueScore: 0.7,
    resolved: false,
    synthesis: null,
    split: {
      positions: { Skeptic: 'defer to v0.2', Pragmatist: 'ship now' },
      irreconcilable: true,
    },
    terminationReason: 'max_rounds',
    totalRounds: 3,
    started_at: '2026-06-15T20:50:00.000Z',
    completed_at: '2026-06-15T20:58:00.000Z',
    events: [],
    status: 'completed',
  };
}

describe('toAopReasoningObservation — conformance', () => {
  it('projects a consensus result that validates against AOP v0.1 schema', () => {
    const obs = toAopReasoningObservation(consensusResult());
    const ok = validate(obs);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
    expect(obs.aop_version).toBe(AOP_VERSION);
  });

  it('projects a split (non-consensus) result that validates against the schema', () => {
    const obs = toAopReasoningObservation(splitResult());
    const ok = validate(obs);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  it('attaches trace_context when supplied (OTel interop)', () => {
    const obs = toAopReasoningObservation(consensusResult(), {
      trace_context: { trace_id: 't1', span_id: 's1' },
    });
    expect(validate(obs)).toBe(true);
    expect(obs.trace_context).toEqual({ trace_id: 't1', span_id: 's1' });
  });

  it('honors caller-supplied identity options', () => {
    const obs = toAopReasoningObservation(consensusResult(), {
      id: 'evt-1',
      agent_id: 'kit',
      task_id: 'task-9',
      parent_id: 'evt-0',
    });
    expect(obs.id).toBe('evt-1');
    expect(obs.agent_id).toBe('kit');
    expect(obs.task_id).toBe('task-9');
    expect(obs.parent_id).toBe('evt-0');
  });
});

describe('deriveReasoning — field mapping', () => {
  it('maps rounds, consensus, and joins models excluding the synthesizer', () => {
    const r = deriveReasoning(consensusResult());
    expect(r.rounds).toBe(2);
    expect(r.consensus).toBe(true);
    // synthesizer's model (claude-opus) appears via a debater too, but the
    // join is over debater turns only: Skeptic=claude-opus, Empiricist=gpt-4o.
    expect(r.model).toBe('claude-opus+gpt-4o');
    expect(r.neurotypes).toEqual(['critical', 'evidence-first']);
    expect(r.dissent).toEqual([]);
    expect(r.osi).toBe(0.05);
  });

  it('derives dissent from split agents + unresolved bullets on non-consensus', () => {
    const r = deriveReasoning(splitResult());
    expect(r.consensus).toBe(false);
    expect(r.rounds).toBe(3);
    expect(r.osi).toBe(0.7);
    // split agents (Skeptic, Pragmatist) then synthesizer's unresolved bullets
    expect(r.dissent).toEqual([
      'Skeptic',
      'Pragmatist',
      'protobuf timing',
      'maintenance cost of two schemas',
    ]);
  });

  it('clamps osi (residueScore) into [0,1]', () => {
    const bad = { ...consensusResult(), residueScore: 1.7 };
    expect(deriveReasoning(bad).osi).toBe(1);
    const neg = { ...consensusResult(), residueScore: -0.2 };
    expect(deriveReasoning(neg).osi).toBe(0);
  });

  it('is pure — does not mutate the source result', () => {
    const src = splitResult();
    const snapshot = JSON.parse(JSON.stringify(src));
    deriveReasoning(src);
    expect(src).toEqual(snapshot);
  });
});
