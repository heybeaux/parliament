/**
 * OSI Calibration Script
 *
 * Reads debate transcripts from /tmp/AIAlignment/data/open/*.txt, parses them
 * into Turn[] arrays, computes consecutive-turn Jaccard distances per agent,
 * then finds the threshold that best separates echo events from opinion-change
 * events using F1-score maximisation over a grid sweep.
 *
 * Transcript format (one turn per line):
 *   <agentname>: <content>
 *
 * Echo events are detected heuristically: turns ending with "Nothing to add."
 * or that are near-duplicates of the agent's immediately prior turn (Jaccard
 * similarity ≥ 0.85) are labelled as echo (label = 0).  All other turns where
 * an agent has a prior turn are labelled as opinion-change (label = 1).
 *
 * Usage:
 *   npx tsx scripts/calibrate-osi.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Turn {
  agent: string;
  content: string;
}

interface LabelledDistance {
  distance: number; // Jaccard distance to prior agent turn
  isChange: boolean; // true = opinion change, false = echo
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseTranscript(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const agent = line.slice(0, colonIdx).trim();
    const content = line.slice(colonIdx + 1).trim();
    if (agent && content) {
      turns.push({ agent, content });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Similarity helpers (mirrors packages/core/src/agents/utils.ts)
// ---------------------------------------------------------------------------

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionSize++;
  }

  const unionSize = wordsA.size + wordsB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// Labelling heuristics
// ---------------------------------------------------------------------------

const ECHO_SUFFIX_PATTERN = /nothing to add\.?\s*$/i;

/**
 * Label each consecutive agent-turn pair as echo (false) or change (true).
 * Heuristics:
 *   1. Turn ends with "Nothing to add." → echo.
 *   2. Jaccard similarity to prior turn ≥ 0.85 → echo.
 *   3. Otherwise → opinion change.
 */
function labelDistances(turns: Turn[]): LabelledDistance[] {
  const results: LabelledDistance[] = [];
  // Track last content per agent
  const lastContent = new Map<string, string>();

  for (const turn of turns) {
    const prior = lastContent.get(turn.agent);
    if (prior !== undefined) {
      const similarity = jaccardSimilarity(prior, turn.content);
      const distance = 1 - similarity;

      const isEchoByPhrase = ECHO_SUFFIX_PATTERN.test(turn.content);
      const isEchoBySimilarity = similarity >= 0.85;
      const isChange = !isEchoByPhrase && !isEchoBySimilarity;

      results.push({ distance, isChange });
    }
    lastContent.set(turn.agent, turn.content);
  }

  return results;
}

// ---------------------------------------------------------------------------
// F1 computation
// ---------------------------------------------------------------------------

function computeF1(
  labelled: LabelledDistance[],
  threshold: number,
): { precision: number; recall: number; f1: number } {
  // Predict "change" when distance >= threshold
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const { distance, isChange } of labelled) {
    const predicted = distance >= threshold;
    if (predicted && isChange) tp++;
    else if (predicted && !isChange) fp++;
    else if (!predicted && isChange) fn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const transcriptDir = '/tmp/AIAlignment/data/open';

const files = readdirSync(transcriptDir)
  .filter((f) => f.endsWith('.txt'))
  .sort();

console.log(`Reading ${files.length} transcript files from ${transcriptDir}\n`);

const allLabelled: LabelledDistance[] = [];
const perFileStats: { file: string; turns: number; pairs: number }[] = [];

for (const file of files) {
  const fullPath = join(transcriptDir, file);
  const text = readFileSync(fullPath, 'utf-8');
  const turns = parseTranscript(text);
  const labelled = labelDistances(turns);
  allLabelled.push(...labelled);
  perFileStats.push({ file, turns: turns.length, pairs: labelled.length });
}

// Print per-file stats
for (const { file, turns, pairs } of perFileStats) {
  console.log(`  ${file}: ${turns} turns, ${pairs} agent-to-agent pairs`);
}

const totalPairs = allLabelled.length;
const totalChanges = allLabelled.filter((l) => l.isChange).length;
const totalEchos = totalPairs - totalChanges;

console.log(`\nTotal pairs: ${totalPairs}`);
console.log(`  Opinion-change events: ${totalChanges}`);
console.log(`  Echo events:           ${totalEchos}`);

// Distribution of distances
const distances = allLabelled.map((l) => l.distance).sort((a, b) => a - b);
const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
const p50 = distances[Math.floor(distances.length * 0.5)]!;
const p25 = distances[Math.floor(distances.length * 0.25)]!;
const p75 = distances[Math.floor(distances.length * 0.75)]!;

console.log(`\nJaccard distance distribution:`);
console.log(`  mean=${mean.toFixed(3)}  p25=${p25.toFixed(3)}  p50=${p50.toFixed(3)}  p75=${p75.toFixed(3)}`);

// Grid sweep
console.log('\nThreshold sweep (F1 for opinion-change detection):');
console.log('  threshold  precision  recall     f1');

let bestThreshold = 0.15;
let bestF1 = 0;

for (let t = 5; t <= 35; t++) {
  const threshold = t / 100;
  const { precision, recall, f1 } = computeF1(allLabelled, threshold);
  const marker = f1 > bestF1 ? ' <-- best' : '';
  if (f1 > bestF1) {
    bestF1 = f1;
    bestThreshold = threshold;
  }
  console.log(
    `  ${threshold.toFixed(2)}       ${precision.toFixed(3)}      ${recall.toFixed(3)}      ${f1.toFixed(3)}${marker}`,
  );
}

// Final recommendation
const { precision, recall, f1 } = computeF1(allLabelled, bestThreshold);
console.log(`\n${'='.repeat(60)}`);
console.log(`RECOMMENDED OSI_CONVERGENCE_THRESHOLD = ${bestThreshold}`);
console.log(`  F1=${f1.toFixed(3)}  precision=${precision.toFixed(3)}  recall=${recall.toFixed(3)}`);
console.log(
  `\nRationale: Threshold ${bestThreshold} maximises F1 for separating`,
);
console.log(
  `opinion-change events from echo events across all ${files.length} debate`,
);
console.log(
  `transcripts (${totalPairs} consecutive agent-turn pairs). Echo events were`,
);
console.log(
  `identified by "Nothing to add." phrase markers and high Jaccard similarity`,
);
console.log(`(≥ 0.85) to the agent's immediately prior turn.`);
console.log(`${'='.repeat(60)}`);
