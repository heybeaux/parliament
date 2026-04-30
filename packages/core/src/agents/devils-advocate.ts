import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Rhetorical posture: contrarian-to-consensus. Argues against whichever
 * position the room is converging toward, regardless of its own beliefs —
 * structural anti-groupthink.
 *
 * STUB — implementation lands in the Devil's Advocate per-agent task.
 */
export class DevilsAdvocateAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super("Devil's Advocate", 'devils-advocate', adapter);
  }
}
