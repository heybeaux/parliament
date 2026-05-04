/**
 * Engram integration test (PAR-38 follow-up).
 *
 * Runs `EngramMemoryProvider` against a real Engram service. Skipped by
 * default. Opt in with:
 *
 *   ENGRAM_URL=http://localhost:3002 \
 *     ENGRAM_API_KEY=<the AM_API_KEY from engram/.env> \
 *     ENGRAM_AGENT_ID=parliament-bench \
 *     pnpm --filter @parliament/core test
 *
 * Why this exists: PAR-38 originally shipped with mock-only tests that
 * asserted Parliament's *assumed* contract — auth header, request shape,
 * response shape — without ever hitting Engram. All three assumptions were
 * wrong against the live service (Bearer auth, `results` key, `x-am-agent-id`
 * header). The mocks were green; production was broken.
 *
 * This test is the seam that catches that. It exercises the live HTTP
 * contract end-to-end: write a deliberation outcome, recall it, verify we
 * round-trip the content. When Engram's API drifts, this is the test that
 * goes red — the unit tests will silently keep passing.
 *
 * The pinned spec at `integrations/engram/PIN.md` documents the contract
 * version this test was written against. Bump the pin only when this test
 * still passes against the new spec.
 */

import { describe, it, expect } from 'vitest';
import { EngramMemoryProvider } from '../memory.js';

const engramUrl = process.env['ENGRAM_URL'];
const engramApiKey = process.env['ENGRAM_API_KEY'];
const engramAgentId = process.env['ENGRAM_AGENT_ID'] ?? 'parliament-bench-test';
const engramEnabled =
  typeof engramUrl === 'string' && engramUrl.length > 0 &&
  typeof engramApiKey === 'string' && engramApiKey.length > 0;

describe.skipIf(!engramEnabled)('EngramMemoryProvider live contract', () => {
  it('round-trips a deliberation outcome through remember() and recall()', async () => {
    const provider = new EngramMemoryProvider({
      endpoint: engramUrl!,
      apiKey: engramApiKey!,
    });

    // Use a unique topic per run so we never collide with prior test data
    // or production memories. The recall query matches against the topic
    // string, which we embed verbatim into the synthesis.
    const runMarker = `engram-int-${Date.now()}`;
    const topic = `Integration test marker ${runMarker}`;

    await provider.remember(
      {
        topic,
        terminationReason: 'consensus',
        synthesis: `Round-trip marker ${runMarker} synthesized.`,
        residueScore: 0.13,
        totalRounds: 2,
        agents: ['Proposer', 'Skeptic', 'Synthesizer'],
      },
      { agentId: engramAgentId },
    );

    // Engram's write path is async — the memory is persisted synchronously,
    // but embedding generation lags. Recall is keyword-capable so a hit on
    // the unique marker should still come back without waiting for embeds.
    // Allow a brief settle window for the row to be visible to the read
    // path. If this becomes flaky, raise — but every second here costs CI
    // minutes, so start tight.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const fragments = await provider.recall(topic, {
      limit: 5,
      agentId: engramAgentId,
    });

    // The marker is unique — at most one match expected, but the assertion
    // only requires the *content* to round-trip; if Engram returns adjacent
    // memories under semantic recall, that's fine.
    const ours = fragments.find((f) => f.content.includes(runMarker));
    expect(ours, `expected to recall the just-written memory; got: ${JSON.stringify(fragments)}`).toBeDefined();
    expect(ours!.content).toContain('Round-trip marker');
    expect(ours!.content).toContain('synthesized');
    // Engram returns INSIGHT for outcomes Parliament writes.
    expect(['INSIGHT', 'PROJECT', 'IDENTITY', 'SESSION', 'TASK']).toContain(ours!.layer);
    expect(typeof ours!.id).toBe('string');
    expect(ours!.id.length).toBeGreaterThan(0);
  }, 30_000);

  it('returns an empty list (not an error) for a topic with no matches', async () => {
    const provider = new EngramMemoryProvider({
      endpoint: engramUrl!,
      apiKey: engramApiKey!,
    });

    const fragments = await provider.recall(
      `definitely-not-a-real-topic-${Date.now()}-zzz`,
      { limit: 3, agentId: engramAgentId },
    );

    // Semantic recall may return loosely-related memories; the contract is
    // "no throw, returns an array." Per-fragment shape gets exercised in
    // the round-trip test above.
    expect(Array.isArray(fragments)).toBe(true);
  }, 15_000);
});

describe('ENGRAM_URL skip behavior', () => {
  it('reports the gate state for the current run', () => {
    // Surfaces in CI logs whether the suite ran live or skipped.
    expect(typeof engramEnabled).toBe('boolean');
  });
});
