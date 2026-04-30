import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Rhetorical posture: charity. Restates the strongest version of an
 * opposing position before attacking — counters Skeptic's tendency
 * toward strawmanning.
 *
 * STUB — implementation lands in the Steelmanner per-agent task.
 */
export class SteelmannerAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Steelmanner', 'steelmanner', adapter);
  }
}
