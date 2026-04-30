import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Rhetorical posture: assumption-surfacing. Restates each agent's prior
 * turn in plain language and names the load-bearing premise — makes
 * implicit disagreements explicit.
 *
 * STUB — implementation lands in the Translator per-agent task.
 */
export class TranslatorAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Translator', 'translator', adapter);
  }
}
