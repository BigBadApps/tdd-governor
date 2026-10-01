import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nestedWorktrees } from '../../git.js';
import type { RunOutcome } from '../../types.js';
import { runAndCollect } from '../run-and-collect.js';

// src/adapters/pytest and dist/adapters/pytest are both three levels below the package root.
const PLUGIN_DIR = fileURLToPath(new URL('../../../python', import.meta.url));

export function runPytest(root: string, python: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const ignores = nestedWorktrees(root).map((rel) => `--ignore=${rel}`);
  return runAndCollect({
    root,
    command: path.resolve(root, python),
    args: ['-m', 'pytest', '-p', 'tdd_governor_pytest', '--continue-on-collection-errors', ...ignores, ...extraArgs],
    env: { PYTHONPATH: [PLUGIN_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    timeoutMs,
    label: 'pytest',
    missingRecordHint: 'is GOVERNOR_DISABLE_REPORTER set?',
  });
}
