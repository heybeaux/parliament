import type { ModelAdapter } from './adapters/base.js';
import type { DebateResult, Turn, Conflict } from './types.js';
import { printTurn, printSummary, saveTranscript } from './transcript.js';
import { buildBatchSchedule, type ScheduledTurn } from './scheduler/index.js';

export interface AgentDefinition {
  /** Display name, e.g. "Proposer", "Skeptic". */
  name: string;
  /** Cognitive stance label, e.g. "structured", "critical". */
  neurotype: string;
  /** Model identifier, e.g. "llama3.2", "mistral". */
  model: string;
  /** Adapter used to call the model. */
  adapter: ModelAdapter;
  /** Optional system prompt injected before each turn. */
  systemPrompt?: string;
}

export interface DebateOptions {
  topic: string;
  agents: AgentDefinition[];
  maxRounds?: number;
  /** Directory in which to write the JSON transcript (default: "transcripts"). */
  transcriptsDir?: string;
  /**
   * Optional hook to detect conflicts between two consecutive turns.
   * Return a Conflict object if a conflict is detected, or null otherwise.
   */
  detectConflict?: (prev: Turn, curr: Turn) => Conflict | null;
}

/**
 * Well-known dependency graph for standard Parliament roles.
 * Any role not listed here is assumed to have no dependencies.
 */
const PARLIAMENT_DEPS: Record<string, string[]> = {
  Proposer: [],
  Skeptic: ['Proposer'],
  Synthesizer: ['Skeptic'],
  RedAgent: ['Proposer'],
  Sentry: ['Skeptic'],
};

/**
 * Returns the roles an agent depends on, using the Parliament dependency map.
 * Falls back to no dependencies for unrecognised roles.
 */
function depsForRole(name: string): string[] {
  return PARLIAMENT_DEPS[name] ?? [];
}

/**
 * Converts a list of AgentDefinitions into ScheduledTurns so the scheduler
 * can determine an execution order that minimises model swaps.
 */
function toScheduledTurns(agents: AgentDefinition[]): ScheduledTurn[] {
  const knownNames = new Set(agents.map((a) => a.name));
  return agents.map((agent) => ({
    role: agent.name,
    model: agent.model,
    // The Agent interface is only needed by the scheduler for identity; the
    // actual generation still goes through agent.adapter below.
    agent: {
      role: agent.name,
      neurotype: agent.neurotype,
      modelName: agent.model,
      generate: async () => ({ content: '', truncated: false }),
    },
    // Only include deps that are actually present in this debate's agent list.
    dependsOn: depsForRole(agent.name).filter((dep) => knownNames.has(dep)),
  }));
}

/**
 * Builds a prompt that summarises the debate so far and asks the agent
 * for its response.
 */
function buildPrompt(topic: string, history: Turn[], agentName: string): string {
  const historyText = history
    .map((t) => `[${t.agent}]: ${t.content}`)
    .join('\n\n');

  const preamble = history.length === 0
    ? `You are participating in a structured debate on the following topic:\n\n"${topic}"\n\nYou are ${agentName}. Please provide your opening position.`
    : `You are participating in a structured debate on the following topic:\n\n"${topic}"\n\nDebate so far:\n\n${historyText}\n\nYou are ${agentName}. Please respond to the above.`;

  return preamble;
}

/**
 * Runs an adversarial multi-agent debate and produces structured output.
 *
 * Streaming behaviour:
 *   Each turn is printed to stdout immediately as it is generated.
 *
 * Persistence:
 *   A JSON transcript is written to `transcriptsDir` after the debate ends.
 *
 * @returns The complete DebateResult for the debate.
 */
export async function runDebate(options: DebateOptions): Promise<DebateResult> {
  const {
    topic,
    agents,
    maxRounds = 3,
    transcriptsDir = 'transcripts',
    detectConflict,
  } = options;

  const turns: Turn[] = [];
  const conflicts: Conflict[] = [];

  // Build a model-aware schedule once — the order is the same every round.
  const scheduledTurns = toScheduledTurns(agents);
  const schedule = buildBatchSchedule(scheduledTurns);

  // Flatten the schedule to a single ordered list of AgentDefinitions so the
  // per-round loop is straightforward.  Agents with model names attached use
  // the scheduler's order; any remainder fall back to the original order.
  const agentByName = new Map(agents.map((a) => [a.name, a]));
  const orderedAgents = schedule.batches
    .flat()
    .map((st) => agentByName.get(st.role))
    .filter((a): a is AgentDefinition => a !== undefined);

  for (let round = 0; round < maxRounds; round++) {
    for (const agent of orderedAgents) {
      const prompt = buildPrompt(topic, turns, agent.name);
      const content = await agent.adapter.generate(prompt, agent.systemPrompt);

      const turn: Turn = {
        agent: agent.name,
        neurotype: agent.neurotype,
        model: agent.model,
        content,
        timestamp: new Date().toISOString(),
        // osi_score is left undefined until a scoring pass is implemented.
      };

      // Print to stdout as soon as the turn is ready.
      printTurn(turn);
      turns.push(turn);

      // Detect conflicts between this turn and the previous one.
      if (detectConflict && turns.length >= 2) {
        const prev = turns[turns.length - 2];
        const conflict = detectConflict(prev, turn);
        if (conflict !== null) {
          conflicts.push(conflict);
        }
      }
    }
  }

  const unresolved = conflicts.filter((c) => !c.resolved);
  const residue = unresolved.map(
    (c) => `${c.between.join(' vs ')}: ${c.description}`,
  );

  const result: DebateResult = {
    topic,
    turns,
    conflicts,
    residue,
    resolved: unresolved.length === 0,
    total_rounds: maxRounds,
    termination_reason: 'max_rounds',
  };

  // Print summary (unresolved conflicts + residue) to stdout.
  printSummary(result);

  // Persist the JSON transcript.
  const filepath = saveTranscript(result, transcriptsDir);
  process.stdout.write(`\n[transcript saved → ${filepath}]\n`);

  return result;
}
