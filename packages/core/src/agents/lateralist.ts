import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Rhetorical posture: analogy. Reframes the question through structural
 * analogies from unrelated domains; surfaces hidden isomorphisms.
 *
 * STUB — implementation lands in the Lateralist per-agent task.
 */
export class LateralistAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Lateralist', 'lateralist', adapter);
  }
}
