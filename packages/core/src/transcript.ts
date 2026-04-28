import fs from 'node:fs';
import path from 'node:path';
import type { DebateResult, Turn, Conflict } from './types.js';

/**
 * Converts a debate topic into a filesystem-safe slug.
 * Lowercases, replaces spaces with underscores, strips non-alphanumeric chars
 * (keeping underscores).
 */
export function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Formats a Date as YYYYMMDD_HHMMSS (local time).
 */
export function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Writes a DebateResult as JSON to the transcripts/ directory.
 * The directory is created if it does not exist.
 *
 * @param result - Completed debate result.
 * @param transcriptsDir - Absolute or relative path to the transcripts directory.
 * @returns The path of the written file.
 */
export function saveTranscript(
  result: DebateResult,
  transcriptsDir = 'transcripts',
): string {
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const filename = `${formatTimestamp(new Date())}_${topicSlug(result.topic)}.json`;
  const filepath = path.join(transcriptsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf8');
  return filepath;
}

/**
 * Formats a single turn for the human-readable stdout feed.
 */
export function formatTurnHeader(turn: Turn): string {
  const osi = turn.osi_score != null ? ` | osi:${turn.osi_score}` : '';
  return `[${turn.agent} | ${turn.neurotype} | ${turn.model}${osi}]`;
}

/**
 * Prints a single turn to stdout as it arrives (streaming mode).
 * Called once per turn during the debate.
 */
export function printTurn(turn: Turn): void {
  process.stdout.write(`\n${formatTurnHeader(turn)}\n${turn.content}\n`);
}

/**
 * Prints the end-of-debate summary to stdout.
 * Surfaces unresolved conflicts and residue clearly.
 */
export function printSummary(result: DebateResult): void {
  const unresolved: Conflict[] = result.conflicts.filter((c) => !c.resolved);

  if (unresolved.length > 0 || result.residue.length > 0) {
    process.stdout.write('\n--- UNRESOLVED CONFLICTS ---\n');
    for (const conflict of unresolved) {
      const parties = conflict.between.join(' vs ');
      process.stdout.write(`\u2022 ${parties}: ${conflict.description}\n`);
    }
    for (const item of result.residue) {
      process.stdout.write(`\u2022 ${item}\n`);
    }
  }

  const status = result.resolved ? 'RESOLVED' : 'UNRESOLVED';
  process.stdout.write(
    `\n[debate ended — ${status} | rounds:${result.total_rounds} | reason:${result.termination_reason}]\n`,
  );
}
