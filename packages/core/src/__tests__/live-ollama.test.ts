/**
 * Live-Ollama integration test.
 *
 * Runs the full DeliberationEngine against a real local Ollama instance —
 * NOT stubbed adapters. Skipped by default. Opt in with:
 *
 *   OLLAMA_AVAILABLE=true pnpm --filter @parliament/core test
 *
 * The test discovers the first locally-installed model from `ollama list`
 * (via `OLLAMA_BASE_URL`, default http://localhost:11434) and uses it for
 * every role. It does NOT assume specific model names — the only contract
 * is "the deliberation completes and the transcript is well-formed."
 *
 * Why this exists: the standard Vitest suites all stub `ModelAdapter`. That
 * means a regression in the Ollama HTTP contract (URL shape, request body,
 * streaming/non-streaming, response parsing) would slip through CI. This
 * test is the seam that catches that. Per task 701f8c6c AC2/AC3, it must
 * skip cleanly when OLLAMA_AVAILABLE is unset and produce a valid
 * DeliberationResult with at least 2 turns when run live.
 */

import { describe, it, expect } from 'vitest';
import { DeliberationEngine } from '../engine.js';
import { OllamaAdapter } from '../adapters/ollama.js';
import {
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
} from '../agents/index.js';

const liveOllamaEnabled = process.env['OLLAMA_AVAILABLE'] === 'true';

describe.skipIf(!liveOllamaEnabled)('live Ollama deliberation', () => {
  it('runs a full deliberation against a real Ollama instance and returns a valid transcript', async () => {
    const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';

    // Pick the first locally-installed model so the test isn't pinned to
    // any particular release. Listing failure means Ollama isn't actually
    // reachable — fail loudly rather than silently passing.
    const tagsRes = await fetch(`${baseUrl}/api/tags`);
    expect(tagsRes.ok).toBe(true);
    const tagsBody = (await tagsRes.json()) as {
      models?: Array<{ name: string }>;
    };
    const firstModel = tagsBody.models?.[0]?.name;
    expect(firstModel).toBeDefined();

    const adapter = new OllamaAdapter(firstModel!, baseUrl);
    const engine = new DeliberationEngine();

    const result = await engine.run('Should small teams adopt async-only standups?', {
      maxRounds: 2,
      redAgentInterval: 99, // suppress RedAgent for the smoke test
      confidenceThreshold: 0.7,
      agents: {
        proposer: new ProposerAgent(adapter),
        skeptic: new SkepticAgent(adapter),
        synthesizer: new SynthesizerAgent(adapter),
        redAgent: new RedAgent(adapter),
        sentry: new SentryAgent(adapter),
      },
    });

    expect(result.topic).toBe('Should small teams adopt async-only standups?');
    // AC3: at least 2 turns. Proposer + Skeptic (round 1) is the minimum
    // shape any non-empty deliberation produces.
    expect(result.turns.length).toBeGreaterThanOrEqual(2);
    for (const turn of result.turns) {
      expect(typeof turn.agent).toBe('string');
      expect(typeof turn.content).toBe('string');
      expect(turn.content.length).toBeGreaterThan(0);
      expect(turn.round).toBeGreaterThanOrEqual(1);
    }
    // Termination must resolve to one of the engine's known reasons.
    expect([
      'consensus',
      'max_rounds',
      'unresolved',
      'echo_loop',
    ]).toContain(result.terminationReason);
  }, 120_000); // generous timeout — first-token latency on a cold model is real
});

describe('OLLAMA_AVAILABLE skip behavior', () => {
  it('reports the gate state for the current run', () => {
    // Sanity check that lets us see in CI logs which mode the suite ran in.
    // Always passes; the assertion exists so the describe block surfaces.
    expect(typeof liveOllamaEnabled).toBe('boolean');
  });
});
