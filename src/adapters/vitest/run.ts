import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ledgerPath, readLedger } from '../../ledger.js';
import type { RunOutcome } from '../../types.js';

export function runVitest(root: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const runId = randomUUID();
  const res = spawnSync('npx', ['--no-install', 'vitest', 'run', '--root', root, ...extraArgs], {
    cwd: root,
    env: { ...process.env, GOVERNOR_RUN_ID: runId },
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
