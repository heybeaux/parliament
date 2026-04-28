#!/usr/bin/env node
/**
 * Parliament CLI — entry point.
 *
 * This file is the executable. It delegates to cli.ts so the program
 * factory remains importable by tests without triggering process.argv parsing.
 */

import { main } from './cli.js';

main().catch((err: unknown) => {
  process.stderr.write(`Parliament error: ${String(err)}\n`);
  process.exit(1);
});
