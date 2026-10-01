import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nestedWorktrees } from '../../git.js';
import type { RunOutcome } from '../../types.js';
import { runAndCollect } from '../run-and-collect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOVERNOR_REPORTER = ['reporter.js', 'reporter.ts'].map((f) => path.join(here, f)).find((f) => existsSync(f))!;

export function runVitest(root: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const skipSiblings = nestedWorktrees(root).flatMap((rel) => ['--exclude', `${rel}/**`]);
  return runAndCollect({
    root,
    command: 'npx',
    args: ['--no-install', 'vitest', 'run', '--root', root, '--reporter=default', `--reporter=${GOVERNOR_REPORTER}`, '--includeTaskLocation', ...skipSiblings, ...extraArgs],
    timeoutMs,
    label: 'vitest',
    missingRecordHint: 'is GOVERNOR_DISABLE_REPORTER set?',
  });
}
