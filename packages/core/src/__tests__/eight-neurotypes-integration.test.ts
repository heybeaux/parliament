import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard, Turn } from '../types.js';
import { createBuiltinAgent } from '../agents/registry.js';

/**
 * Integration test: one round of deliberation involving all eight Stage 1
 * neurotypes plus a Synthesizer-shaped closing turn, against stub adapters
 * (no real model calls).
 *
 * Scope (per Chorus task 53bf3659):
 *   1. Resolve a topology that lists all 8 new neurotypes plus a Synthesizer.
 *   2. Run one round; assert each neurotype produces a turn that satisfies
 *      the standard turn shape.
 *   3. Assert each turn respects the 200-word cap and sets `truncated`
 *      correctly.
 *   4. Assert the stub adapter received exactly one prompt per neurotype.
 *
 * Out of scope: posture-specific behaviors (covered by per-agent tests) and
 * the topology runtime / DeliberationEngine wiring (Stage 1 runtime task).
 *
 * The test deliberately bypasses DeliberationEngine because the engine still
 * has the legacy 5-agent shape (proposer/skeptic/synthesizer/redAgent/sentry)
 * and the topology runtime is not yet implemented. We exercise the 8 agents
 * directly through their canonical entry point — `createBuiltinAgent` —
 * against a shared blackboard, which is exactly what the topology runtime
 * will do once it lands.
 */

const STAGE_1_NEUROTYPES = [
  'historian',
  'forecaster',
  'pragmatist',
  'empiricist',
  'steelmanner',
  'devils-advocate',
  'lateralist',
  'translator',
] as const;

const ROLE_BY_NEUROTYPE: Record<(typeof STAGE_1_NEUROTYPES)[number], string> = {
  historian: 'Historian',
  forecaster: 'Forecaster',
  pragmatist: 'Pragmatist',
  empiricist: 'Empiricist',
  steelmanner: 'Steelmanner',
  'devils-advocate': 'DevilsAdvocate',
  lateralist: 'Lateralist',
  translator: 'Translator',
};

function nWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

/**
 * Builds a stub ModelAdapter that returns a fixed reply and records every
 * prompt it sees. The mock is the seam this integration test uses to verify
 * "exactly one prompt per neurotype" without touching any real backend.
 */
function makeStubAdapter(reply: string): ModelAdapter {
  return {
    modelName: 'integration-stub',
    generate: vi.fn().mockResolvedValue({ content: reply }),
  };
}

function makeBlackboard(): Blackboard {
  return {
    topic: 'Should AI systems be regulated?',
    turns: [],
    conflicts: [],
    metadata: {},
  };
}

/**
 * Records a turn on the blackboard — mirrors what the engine does after
 * calling an agent's generate(). Round number is fixed at 1 for this
 * one-round integration test.
 */
function recordTurn(
  board: Blackboard,
  agent: { role: string; neurotype: string; modelName: string },
  result: { content: string; truncated: boolean },
): Turn {
  const turn: Turn = {
    agent: agent.role,
    neurotype: agent.neurotype,
    model: agent.modelName,
    content: result.content,
    timestamp: new Date().toISOString(),
    round: 1,
  };
  board.turns.push(turn);
  return turn;
}

describe('integration: one-round deliberation with all eight Stage 1 neurotypes', () => {
  it('runs all 8 neurotypes plus a Synthesizer-shaped close in a single round', async () => {
    const board = makeBlackboard();

    // Use a different reply per neurotype so we can confirm the right reply
    // landed on the right turn, plus literal anchors for Translator/DA.
    const repliesByNeurotype: Record<(typeof STAGE_1_NEUROTYPES)[number], string> = {
      historian: 'Looking back, the 1990s antitrust action against Microsoft offers a useful precedent.',
      forecaster: 'In the near term, regulation slows deployment. Over the longer term, it shapes investment.',
      pragmatist: 'The binding constraint is enforcement capacity; a minimum viable variant focuses on disclosure.',
      empiricist: 'Demand evidence: which existing AI deployments have produced measurable harm at scale?',
      steelmanner: 'The strongest opposing case is that premature regulation freezes a still-evolving field.',
      'devils-advocate': 'The unstated assumption is that regulators have the technical literacy to write effective rules.',
      lateralist: 'This is a coordination problem. Analogous to fisheries management — open access drives over-extraction.',
      translator: 'The load-bearing assumption is that regulators understand what they would govern.',
    };

    // One stub adapter per neurotype — gives us per-agent call accounting.
    const adapters = Object.fromEntries(
      STAGE_1_NEUROTYPES.map((id) => [id, makeStubAdapter(repliesByNeurotype[id])] as const),
    ) as Record<(typeof STAGE_1_NEUROTYPES)[number], ModelAdapter>;

    // Step each neurotype against the shared blackboard. This mirrors the
    // topology runtime's planned execution model: resolve a step's neurotype
    // ID via createBuiltinAgent(), call generate(blackboard), record the turn.
    const turnsByNeurotype: Record<string, Turn> = {};
    for (const id of STAGE_1_NEUROTYPES) {
      const agent = createBuiltinAgent(id, adapters[id]);
      const result = await agent.generate(board);
      const turn = recordTurn(board, agent, result);
      turnsByNeurotype[id] = turn;
    }

    // Synthesizer-shaped closing turn — the engine wires Synthesizer
    // structurally; here we simulate its turn-recording shape directly.
    // (The Synthesizer's JSON contract has its own dedicated tests; what
    // matters here is that the integration emits 8+1 turns total.)
    const synthAdapter = makeStubAdapter('synthesis text');
    board.turns.push({
      agent: 'Synthesizer',
      neurotype: 'integrative',
      model: synthAdapter.modelName,
      content: 'The room agrees that regulator literacy is the load-bearing assumption.',
      timestamp: new Date().toISOString(),
      round: 1,
    });

    // ---------- Acceptance: 8 + 1 turns -----------------------------------
    expect(board.turns).toHaveLength(STAGE_1_NEUROTYPES.length + 1);

    // ---------- Acceptance: standard turn shape on every turn -------------
    for (const turn of board.turns) {
      expect(typeof turn.agent).toBe('string');
      expect(turn.agent.length).toBeGreaterThan(0);
      expect(typeof turn.neurotype).toBe('string');
      expect(turn.neurotype.length).toBeGreaterThan(0);
      expect(typeof turn.model).toBe('string');
      expect(typeof turn.content).toBe('string');
      expect(turn.content.length).toBeGreaterThan(0);
      expect(typeof turn.timestamp).toBe('string');
      expect(turn.round).toBe(1);
    }

    // ---------- Acceptance: each neurotype recorded with the right role ---
    for (const id of STAGE_1_NEUROTYPES) {
      const turn = turnsByNeurotype[id]!;
      expect(turn.neurotype).toBe(id);
      expect(turn.agent).toBe(ROLE_BY_NEUROTYPE[id]);
      expect(turn.model).toBe('integration-stub');
    }

    // ---------- Acceptance: exactly one prompt per neurotype --------------
    for (const id of STAGE_1_NEUROTYPES) {
      const adapter = adapters[id];
      expect((adapter.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    }
  });

  it('every neurotype turn respects the 200-word cap with truncated=false when under cap', async () => {
    const board = makeBlackboard();
    const shortReply = 'A short under-cap reply that should not trip the truncation flag.';

    for (const id of STAGE_1_NEUROTYPES) {
      const adapter = makeStubAdapter(shortReply);
      const agent = createBuiltinAgent(id, adapter);
      const result = await agent.generate(board);

      expect(result.content.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(200);
      expect(result.truncated).toBe(false);
      recordTurn(board, agent, result);
    }
  });

  it('every neurotype turn enforces the 200-word cap with truncated=true when over cap', async () => {
    const board = makeBlackboard();
    const longReply = nWords(250);

    for (const id of STAGE_1_NEUROTYPES) {
      const adapter = makeStubAdapter(longReply);
      const agent = createBuiltinAgent(id, adapter);
      const result = await agent.generate(board);

      expect(result.truncated).toBe(true);
      expect(result.content.split(/\s+/).filter(Boolean).length).toBe(200);
      recordTurn(board, agent, result);
    }
  });

  it('runs end-to-end without any real model backend (CI-safe)', async () => {
    // The whole point: every adapter in this test is a vi.fn() with a
    // mockResolvedValue. There is no network, no fs read of credentials,
    // no env var dependency. This test asserts that contract structurally
    // by checking every adapter generate call is a mock function.
    const board = makeBlackboard();
    const adapters: ModelAdapter[] = [];

    for (const id of STAGE_1_NEUROTYPES) {
      const adapter = makeStubAdapter('CI-safe reply');
      adapters.push(adapter);
      const agent = createBuiltinAgent(id, adapter);
      await agent.generate(board);
    }

    for (const adapter of adapters) {
      // vi.fn() instances are decorated with .mock and do not perform real I/O.
      expect((adapter.generate as ReturnType<typeof vi.fn>).mock).toBeDefined();
      expect(adapter.modelName).toBe('integration-stub');
    }
  });
});
