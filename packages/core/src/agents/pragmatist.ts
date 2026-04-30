import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Epistemic posture: constraint-first. Asks "what does this cost,
 * who pays, what breaks first" — surfaces operational reality.
 *
 * STUB — implementation lands in the Pragmatist per-agent task.
 */
export class PragmatistAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Pragmatist', 'pragmatist', adapter);
  }
}
