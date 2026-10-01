import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ledgerPath, readLedger } from '../ledger.js';
import type { RunOutcome } from '../types.js';

// git exports these into hooks (absolute, and always in linked worktrees). If the
// user's tests shell out to git they would hit the real repo, so never forward them.
const GIT_REPO_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

export function runAndCollect(opts: {
  root: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  label: string;
  missingRecordHint: string;
}): RunOutcome {
  const runId = randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, GOVERNOR_RUN_ID: runId };
  for (const k of GIT_REPO_VARS) delete env[k];
  const res = spawnSync(opts.command, opts.args, { cwd: opts.root, env, stdio: 'inherit', timeout: opts.timeoutMs });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { kind: 'unavailable', reason: `${opts.label} timed out after ${opts.timeoutMs}ms` };
  }
  if (res.error) return { kind: 'unavailable', reason: `could not start ${opts.label}: ${res.error.message}` };
  if (res.signal) return { kind: 'unavailable', reason: `${opts.label} killed by ${res.signal}` };
  const record = readLedger(ledgerPath(opts.root)).records.find((r) => r.runId === runId);
  if (!record) return { kind: 'unavailable', reason: `${opts.label} ran but wrote no ledger record: ${opts.missingRecordHint}` };
  return { kind: 'completed', record };
}
