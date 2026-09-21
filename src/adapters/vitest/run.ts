import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { nestedWorktrees } from '../../git.js';
import { ledgerPath, readLedger } from '../../ledger.js';
import type { RunOutcome } from '../../types.js';

// git exports these into hooks (absolute, and always in linked worktrees). If the
// user's tests shell out to git they would hit the real repo, so never forward them.
const GIT_REPO_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

function childEnv(runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GOVERNOR_RUN_ID: runId };
  for (const k of GIT_REPO_VARS) delete env[k];
  return env;
}

export function runVitest(root: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const runId = randomUUID();
  // A sibling worktree under the root holds another checkout's unfinished tests; they are not this run's to judge.
  const skipSiblings = nestedWorktrees(root).flatMap((rel) => ['--exclude', `${rel}/**`]);
  const res = spawnSync('npx', ['--no-install', 'vitest', 'run', '--root', root, ...skipSiblings, ...extraArgs], {
    cwd: root,
    env: childEnv(runId),
    stdio: 'inherit',
    timeout: timeoutMs,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { kind: 'unavailable', reason: `vitest timed out after ${timeoutMs}ms` };
  }
  if (res.error) return { kind: 'unavailable', reason: `could not start vitest: ${res.error.message}` };
  if (res.signal) return { kind: 'unavailable', reason: `vitest killed by ${res.signal}` };

  const record = readLedger(ledgerPath(root)).records.find((r) => r.runId === runId);
  if (!record) {
    return {
      kind: 'unavailable',
      reason: "vitest ran but wrote no ledger record: add 'tdd-governor/vitest-reporter' to test.reporters and set includeTaskLocation: true",
    };
  }
  return { kind: 'completed', record };
}
