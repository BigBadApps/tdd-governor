#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runVitest } from './adapters/vitest/run.js';
import { loadConfig } from './config.js';

const USAGE = 'usage: governor <run>';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'run') {
    const root = repoRoot();
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}`);
      return 2;
    }
    const outcome = runVitest(root, loaded.config.runTimeoutMs, rest);
    if (outcome.kind === 'unavailable') {
      console.error(`governor: GATE_UNAVAILABLE: ${outcome.reason}`);
      return 2;
    }
    const { tests, collectionErrors } = outcome.record;
    const failed = tests.filter((t) => t.status === 'fail').length;
    console.log(`governor: recorded run ${outcome.record.runId}: ${tests.length} tests, ${failed} failed, ${collectionErrors.length} collection errors`);
    return outcome.record.exitCode;
  }
  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
