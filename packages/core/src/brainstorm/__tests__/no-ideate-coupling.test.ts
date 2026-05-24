/**
 * Architectural lock — Brainstorm Section 2.5 / 12.1.
 *
 * Brainstorm is a distinct reasoning pattern from ideate. The bug this
 * change exists to fix is `/brainstorm` aliasing to `runIdeation()`. The
 * easiest way to silently regress is for someone to import `runIdeation`
 * (or call it transitively via `../ideate/orchestrator`) from the
 * brainstorm module. This test grep-asserts the source files to catch
 * that at CI time, before it can ship.
 *
 * The dedupe primitive IS intentional reuse — it lives in `../ideate/dedupe`
 * because that's where it shipped first, but it's general-purpose. The
 * positive check below confirms the orchestrator imports it (so if dedupe
 * ever moves, this test reminds us to update the import path explicitly,
 * not via a wildcard).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const brainstormDir = join(here, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip the __tests__ dir itself — test files reference the things
      // they're forbidding, which is fine.
      if (entry === '__tests__') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const brainstormSources = walk(brainstormDir);

describe('Brainstorm Architectural Locks', () => {
  it('should have at least one source file under brainstorm/', () => {
    // Sanity check: if the directory is empty the rest of these tests would
    // pass vacuously.
    expect(brainstormSources.length).toBeGreaterThan(0);
  });

  it('should not import or call runIdeation anywhere in the module', () => {
    const offenders: string[] = [];
    // Strip line and block comments so docstrings that mention runIdeation
    // by name (warning humans not to use it) don't trip the lock.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const file of brainstormSources) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // Match: `import { runIdeation }`, `import runIdeation`, or `runIdeation(`
      if (
        /\bimport\b[^;]*\brunIdeation\b/.test(src) ||
        /\brunIdeation\s*\(/.test(src)
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Brainstorm must not import or call runIdeation. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('should not import from ../ideate/orchestrator', () => {
    const offenders: string[] = [];
    for (const file of brainstormSources) {
      const src = readFileSync(file, 'utf8');
      // Match relative imports of the ideate orchestrator specifically.
      // Reuse of ../ideate/dedupe is allowed and asserted separately.
      if (/from\s+['"]\.\.\/ideate\/orchestrator(\.js)?['"]/.test(src)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Brainstorm must not import the ideate orchestrator. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // Positive check for Section 12.2 — confirms intentional reuse of the
  // dedupe primitive. Currently the orchestrator is a stub, so this test
  // tolerates the absence of the import and gets enforced once Section 5
  // lands. The check is gated on the orchestrator no longer throwing
  // "not yet implemented" — meaning real wiring exists.
  it('reuses runDedupePhase once the orchestrator is implemented', () => {
    const orchPath = join(brainstormDir, 'orchestrator.ts');
    const src = readFileSync(orchPath, 'utf8');
    const isStub = /runBrainstorm is not yet implemented/.test(src);
    if (isStub) {
      // Skip — Section 5 hasn't landed yet. This branch disappears when
      // the orchestrator is real, at which point the positive check
      // becomes load-bearing.
      return;
    }
    expect(
      /from\s+['"]\.\.\/ideate\/dedupe(\.js)?['"]/.test(src),
      'Orchestrator should import runDedupePhase from ../ideate/dedupe (intentional reuse)',
    ).toBe(true);
  });
});
