import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Epistemic posture: evidence-first. Demands data, citations, and
 * falsifiable claims; flags hand-waving.
 *
 * STUB — implementation lands in the Empiricist per-agent task.
 */
export class EmpiricistAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Empiricist', 'empiricist', adapter);
  }
}
