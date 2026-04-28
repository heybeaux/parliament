/**
 * display.ts — Colored terminal output for Parliament deliberation results.
 *
 * Role colors:
 *   Proposer    → blue
 *   Skeptic     → red
 *   Synthesizer → green
 *   RedAgent    → magenta
 *   Sentry      → yellow
 *   (fallback)  → white
 */

import pc from 'picocolors';
import type { DeliberationResult, Turn } from '@parliament/core';

/** Maps a Turn's agent role name to a terminal color function. */
function colorForRole(role: string): (s: string) => string {
  switch (role.toLowerCase()) {
    case 'proposer':
      return pc.blue;
    case 'skeptic':
      return pc.red;
    case 'synthesizer':
      return pc.green;
    case 'redagent':
      return pc.magenta;
    case 'sentry':
      return pc.yellow;
    default:
      return pc.white;
  }
}

/**
 * Formats a single turn header as: `[ROLE | neurotype | model]`
 * with the header text colored by role.
 */
export function formatTurnHeader(turn: Turn): string {
  const color = colorForRole(turn.agent);
  const header = `[${turn.agent.toUpperCase()} | ${turn.neurotype} | ${turn.model || 'unknown'}]`;
  return color(header);
}

/**
 * Prints a single Turn to stdout with role-colored header.
 */
export function printTurn(turn: Turn): void {
  process.stdout.write(formatTurnHeader(turn) + '\n');
  process.stdout.write(turn.content + '\n\n');
}

/**
 * Prints all turns, then the final synthesis or split summary,
 * followed by the residue score and termination reason.
 */
export function printResult(result: DeliberationResult): void {
  const divider = '─'.repeat(60) + '\n';

  process.stdout.write(`\n${pc.bold(`Parliament Deliberation: "${result.topic}"`)}\n`);
  process.stdout.write(divider);

  // Print transcript turn by turn.
  for (const turn of result.turns) {
    printTurn(turn);
  }

  process.stdout.write(divider);

  // Final outcome.
  if (result.synthesis !== null) {
    process.stdout.write(pc.green(pc.bold('SYNTHESIS')) + '\n');
    process.stdout.write(result.synthesis + '\n\n');
  } else if (result.split !== null) {
    process.stdout.write(pc.red(pc.bold('UNRESOLVED SPLIT')) + '\n');
    if (result.split.irreconcilable) {
      process.stdout.write(pc.red('(irreconcilable positions)\n'));
    }
    for (const [role, position] of Object.entries(result.split.positions)) {
      const color = colorForRole(role);
      process.stdout.write(color(`[${role.toUpperCase()}]`) + ' ' + position + '\n');
    }
    process.stdout.write('\n');
  }

  // Footer stats.
  const residuePct = (result.residueScore * 100).toFixed(1);
  process.stdout.write(`Residue score:        ${residuePct}%\n`);
  process.stdout.write(`Termination reason:   ${result.terminationReason}\n`);
  process.stdout.write(`Total rounds:         ${result.totalRounds}\n`);
  process.stdout.write(`Resolved:             ${result.resolved ? 'yes' : 'no'}\n`);
}
