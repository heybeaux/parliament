import { describe, it, expect } from 'vitest';
import type { Agent, AgentResult } from '../../agents/base.js';
import type { Blackboard, Conflict } from '../../types.js';
import {
  executeParallelBlock,
  ParallelBlockTimeoutError,
} from '../parallel.js';
import type { TopologyStep } from '../types.js';

/**
 * Parallel-executor tests.
 *
 * Maps to acceptance criteria for task 6483cac1:
 *   AC1: Snapshot is taken AFTER prior persistence (caller invariant; we
 *        verify the executor reads from the snapshot it's handed and never
 *        mutates the live blackboard before merging).
 *   AC2: Parallel agents do not see each other's mid-block output.
 *   AC3: Sibling results are appended in registration order regardless of
 *        completion order.
 *   AC4: Block timeout aborts with an error naming the slow agent.
 *   AC5: Every parallel turn carries a unique random-UUID parallel_group.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestAgent extends Agent {
  /** Captured prompt context — the blackboard the agent saw at generate-time. */
  seenTurns: Blackboard['turns'];
  seenConflicts: Blackboard['conflicts'];
}

/**
 * Builds a sibling agent that resolves after `delayMs` and records the
 * prompt context it observed. Optionally appends `pushConflict` to its
 * snapshot's conflicts (mimicking Skeptic's behaviour).
 */
function makeAgent(opts: {
  role: string;
  neurotype: string;
  content: string;
  delayMs?: number;
  pushConflict?: Conflict;
  modelName?: string;
}): TestAgent {
  const captured: TestAgent = {
    role: opts.role,
    neurotype: opts.neurotype,
    modelName: opts.modelName ?? `mock-${opts.neurotype}`,
    seenTurns: [],
    seenConflicts: [],
    generate: async (blackboard: Blackboard): Promise<AgentResult> => {
      // Snapshot what we saw immediately on entry — before anything could
      // have changed in the live board (which it can't, because the
      // executor hands us a clone, but we want to be sure).
      captured.seenTurns = [...blackboard.turns];
      captured.seenConflicts = [...blackboard.conflicts];
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.pushConflict !== undefined) {
        blackboard.conflicts.push(opts.pushConflict);
      }
      return { content: opts.content, truncated: false };
    },
  };
  return captured;
}

function step(id: string, neurotype: string): TopologyStep {
  return { id, neurotype, optional: false };
}

function emptyBoard(extras: Partial<Blackboard> = {}): Blackboard {
  return {
    topic: 'topic',
    turns: [],
    conflicts: [],
    metadata: {},
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeParallelBlock — snapshot isolation (AC1, AC2)', () => {
  it('every sibling sees the same snapshot — none observe each other\'s output', async () => {
    const skeptic = makeAgent({
      role: 'Skeptic',
      neurotype: 'skeptic',
      content: 'skeptic output',
      delayMs: 10,
    });
    const empiricist = makeAgent({
      role: 'Empiricist',
      neurotype: 'empiricist',
      content: 'empiricist output',
    });

    const agents: Record<string, Agent> = { skeptic, empiricist };
    const board = emptyBoard({
      turns: [
        {
          agent: 'Proposer',
          neurotype: 'proposer',
          model: 'mock',
          content: 'proposal',
          timestamp: '2026-04-30T00:00:00Z',
          round: 1,
        },
      ],
    });

    await executeParallelBlock(
      [step('s', 'skeptic'), step('e', 'empiricist')],
      board,
      (s) => agents[s.neurotype]!,
      1,
    );

    // Both agents saw exactly the proposer turn — neither saw the other's.
    expect(skeptic.seenTurns).toHaveLength(1);
    expect(skeptic.seenTurns[0]!.agent).toBe('Proposer');
    expect(empiricist.seenTurns).toHaveLength(1);
    expect(empiricist.seenTurns[0]!.agent).toBe('Proposer');
  });

  it('sibling Skeptic mutating its snapshot conflicts does not affect siblings', async () => {
    const skeptic = makeAgent({
      role: 'Skeptic',
      neurotype: 'skeptic',
      content: 'skeptic',
      pushConflict: {
        between: ['skeptic', 'proposer'],
        description: 'disagree',
        resolved: false,
      },
    });
    const empiricist = makeAgent({
      role: 'Empiricist',
      neurotype: 'empiricist',
      content: 'empiricist',
      delayMs: 10,
    });

    const agents: Record<string, Agent> = { skeptic, empiricist };
    const board = emptyBoard();

    await executeParallelBlock(
      [step('s', 'skeptic'), step('e', 'empiricist')],
      board,
      (s) => agents[s.neurotype]!,
      1,
    );

    // Empiricist ran AFTER skeptic pushed (since it has 10ms delay) but it
    // saw zero conflicts — proving snapshot isolation.
    expect(empiricist.seenConflicts).toHaveLength(0);
  });

  it('does not mutate the live blackboard during agent execution — only on merge', async () => {
    const slow = makeAgent({
      role: 'Slow',
      neurotype: 'skeptic',
      content: 'slow',
      delayMs: 30,
    });
    const fast = makeAgent({
      role: 'Fast',
      neurotype: 'empiricist',
      content: 'fast',
    });
    const agents: Record<string, Agent> = { skeptic: slow, empiricist: fast };

    const board = emptyBoard();
    const promise = executeParallelBlock(
      [step('s', 'skeptic'), step('e', 'empiricist')],
      board,
      (s) => agents[s.neurotype]!,
      1,
    );

    // Wait until 'fast' has resolved but 'slow' is still pending. We can't
    // await that precisely without coupling to internals, but we CAN check
    // that the live board has zero turns at this point — the executor
    // appends only after both finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(board.turns).toHaveLength(0);
    expect(board.conflicts).toHaveLength(0);

    await promise;
  });
});

describe('executeParallelBlock — registration-order merge (AC3)', () => {
  it('registration order is preserved when fast agent is declared second', async () => {
    const skeptic = makeAgent({
      role: 'Skeptic',
      neurotype: 'skeptic',
      content: 'skeptic',
      delayMs: 30,
    });
    const empiricist = makeAgent({
      role: 'Empiricist',
      neurotype: 'empiricist',
      content: 'empiricist',
      delayMs: 0,
    });

    const agents: Record<string, Agent> = { skeptic, empiricist };
    const board = emptyBoard();

    const result = await executeParallelBlock(
      [step('s', 'skeptic'), step('e', 'empiricist')],
      board,
      (s) => agents[s.neurotype]!,
      1,
    );

    // Skeptic declared first MUST appear first in result.turns despite
    // finishing later.
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]!.agent).toBe('Skeptic');
    expect(result.turns[1]!.agent).toBe('Empiricist');
  });

  it('preserves order across four siblings with shuffled completion times', async () => {
    const a = makeAgent({ role: 'A', neurotype: 'na', content: 'a', delayMs: 30 });
    const b = makeAgent({ role: 'B', neurotype: 'nb', content: 'b', delayMs: 5 });
    const c = makeAgent({ role: 'C', neurotype: 'nc', content: 'c', delayMs: 20 });
    const d = makeAgent({ role: 'D', neurotype: 'nd', content: 'd', delayMs: 10 });
    const agents: Record<string, Agent> = { na: a, nb: b, nc: c, nd: d };

    const result = await executeParallelBlock(
      [
        step('a', 'na'),
        step('b', 'nb'),
        step('c', 'nc'),
        step('d', 'nd'),
      ],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
    );

    expect(result.turns.map((t) => t.agent)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('merges conflicts from siblings in registration order', async () => {
    const skeptic = makeAgent({
      role: 'Skeptic',
      neurotype: 'skeptic',
      content: 'skeptic',
      delayMs: 20,
      pushConflict: {
        between: ['skeptic', 'proposer'],
        description: 'first conflict',
        resolved: false,
      },
    });
    const devils = makeAgent({
      role: 'Devil',
      neurotype: 'devils-advocate',
      content: 'devil',
      delayMs: 0,
      pushConflict: {
        between: ['devil', 'proposer'],
        description: 'second conflict',
        resolved: false,
      },
    });

    const agents: Record<string, Agent> = {
      skeptic,
      'devils-advocate': devils,
    };

    const result = await executeParallelBlock(
      [step('s', 'skeptic'), step('d', 'devils-advocate')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
    );

    expect(result.conflicts.map((c) => c.description)).toEqual([
      'first conflict',
      'second conflict',
    ]);
  });
});

describe('executeParallelBlock — block-level timeout (AC4)', () => {
  it('aborts with ParallelBlockTimeoutError naming the slow agent', async () => {
    const fast = makeAgent({ role: 'Fast', neurotype: 'fast', content: 'f' });
    const slow = makeAgent({
      role: 'Slow',
      neurotype: 'slow',
      content: 'never seen',
      delayMs: 200,
    });
    const agents: Record<string, Agent> = { fast, slow };

    const promise = executeParallelBlock(
      [step('f', 'fast'), step('s', 'slow')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
      { timeoutMs: 25 },
    );

    await expect(promise).rejects.toBeInstanceOf(ParallelBlockTimeoutError);
    await expect(promise).rejects.toMatchObject({
      slowSteps: ['s'],
      message: expect.stringContaining('"s"'),
    });
  });

  it('names ALL slow agents when multiple exceed the timeout', async () => {
    const a = makeAgent({ role: 'A', neurotype: 'na', content: 'a' });
    const b = makeAgent({ role: 'B', neurotype: 'nb', content: 'b', delayMs: 200 });
    const c = makeAgent({ role: 'C', neurotype: 'nc', content: 'c', delayMs: 200 });
    const agents: Record<string, Agent> = { na: a, nb: b, nc: c };

    const promise = executeParallelBlock(
      [step('a', 'na'), step('b', 'nb'), step('c', 'nc')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
      { timeoutMs: 25 },
    );

    await expect(promise).rejects.toMatchObject({
      slowSteps: ['b', 'c'],
    });
  });

  it('does not mutate the live blackboard on timeout (no partial commits)', async () => {
    const fast = makeAgent({ role: 'Fast', neurotype: 'fast', content: 'f' });
    const slow = makeAgent({
      role: 'Slow',
      neurotype: 'slow',
      content: 's',
      delayMs: 200,
    });
    const agents: Record<string, Agent> = { fast, slow };
    const board = emptyBoard();

    await expect(
      executeParallelBlock(
        [step('f', 'fast'), step('s', 'slow')],
        board,
        (st) => agents[st.neurotype]!,
        1,
        { timeoutMs: 25 },
      ),
    ).rejects.toBeInstanceOf(ParallelBlockTimeoutError);

    expect(board.turns).toHaveLength(0);
    expect(board.conflicts).toHaveLength(0);
  });

  it('completes successfully when every sibling finishes within timeout', async () => {
    const a = makeAgent({ role: 'A', neurotype: 'na', content: 'a' });
    const b = makeAgent({ role: 'B', neurotype: 'nb', content: 'b', delayMs: 5 });
    const agents: Record<string, Agent> = { na: a, nb: b };

    const result = await executeParallelBlock(
      [step('a', 'na'), step('b', 'nb')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
      { timeoutMs: 200 },
    );
    expect(result.turns).toHaveLength(2);
  });
});

describe('executeParallelBlock — parallel_group annotation (AC5)', () => {
  it('every produced turn carries the same parallel_group UUID', async () => {
    const a = makeAgent({ role: 'A', neurotype: 'na', content: 'a' });
    const b = makeAgent({ role: 'B', neurotype: 'nb', content: 'b' });
    const c = makeAgent({ role: 'C', neurotype: 'nc', content: 'c' });
    const d = makeAgent({ role: 'D', neurotype: 'nd', content: 'd' });
    const agents: Record<string, Agent> = { na: a, nb: b, nc: c, nd: d };

    const result = await executeParallelBlock(
      [
        step('a', 'na'),
        step('b', 'nb'),
        step('c', 'nc'),
        step('d', 'nd'),
      ],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
    );

    const groups = result.turns.map((t) => t.parallel_group);
    expect(groups).toHaveLength(4);
    expect(new Set(groups).size).toBe(1);
    expect(result.parallelGroup).toBe(groups[0]);
    // RFC 4122 v4 UUID shape — `randomUUID()` is the source.
    expect(result.parallelGroup).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('two consecutive blocks produce distinct parallel_group UUIDs', async () => {
    const make = (id: string) =>
      makeAgent({ role: id.toUpperCase(), neurotype: id, content: id });
    const agents: Record<string, Agent> = {
      a1: make('a1'),
      b1: make('b1'),
      a2: make('a2'),
      b2: make('b2'),
    };

    const r1 = await executeParallelBlock(
      [step('a1', 'a1'), step('b1', 'b1')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
    );
    const r2 = await executeParallelBlock(
      [step('a2', 'a2'), step('b2', 'b2')],
      emptyBoard(),
      (s) => agents[s.neurotype]!,
      1,
    );

    expect(r1.parallelGroup).not.toBe(r2.parallelGroup);
  });
});

describe('executeParallelBlock — edge cases', () => {
  it('returns empty result with a fresh group UUID when steps is empty', async () => {
    const result = await executeParallelBlock(
      [],
      emptyBoard(),
      () => {
        throw new Error('should not be called');
      },
      1,
    );
    expect(result.turns).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.parallelGroup).toBeTruthy();
  });

  it('propagates a non-timeout sibling error with the offending step ID', async () => {
    const ok = makeAgent({ role: 'Ok', neurotype: 'ok', content: 'ok' });
    const bad: Agent = {
      role: 'Bad',
      neurotype: 'bad',
      modelName: 'mock',
      generate: async () => {
        throw new Error('boom');
      },
    };
    const agents: Record<string, Agent> = { ok, bad };

    await expect(
      executeParallelBlock(
        [step('o', 'ok'), step('b', 'bad')],
        emptyBoard(),
        (s) => agents[s.neurotype]!,
        1,
      ),
    ).rejects.toThrow(/sibling "b" failed: boom/);
  });

  it('records word_count consistent with the sequential path', async () => {
    const a = makeAgent({
      role: 'A',
      neurotype: 'na',
      content: '  one  two   three ',
    });
    const result = await executeParallelBlock(
      [step('a', 'na')],
      emptyBoard(),
      () => a,
      1,
    );
    expect(result.turns[0]!.word_count).toBe(3);
  });
});
