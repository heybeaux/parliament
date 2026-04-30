import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Temporal posture: "Look back." Brings prior incidents, base rates, and
 * historical analogues into the deliberation.
 *
 * STUB — implementation lands in the Historian per-agent task.
 */
export class HistorianAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Historian', 'historian', adapter);
  }
}
