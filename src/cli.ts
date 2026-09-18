#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { runVitest } from './adapters/vitest/run.js';
import { loadConfig, type GovernorConfig } from './config.js';
import type { FileDiff } from './diff.js';
import { diffAudit } from './gates/diff-audit.js';
import { green } from './gates/green.js';
import { mutation } from './gates/mutation.js';
import { redBeforeGreen } from './gates/red-before-green.js';
import { changedLines, evidenceSince, pushBase, pushDiff, repoRoot, stagedDiff } from './git.js';
import { installHooks } from './install.js';
import { appendRecord, ledgerPath, readLedger } from './ledger.js';
import { runStryker } from './mutation/stryker.js';
import { decide, formatResults } from './report.js';
import type { GateResult, RunOutcome } from './types.js';

const USAGE = 'usage: governor <run | gate commit | gate push | install>';
const EXAMPLE_CONFIG = JSON.stringify(
  {
    adapter: 'vitest',
    testGlobs: ['tests/**/*.test.ts'],
    sourceGlobs: ['src/**/*.ts'],
    mutation: { enabled: true, timeoutMs: 300000 },
    runTimeoutMs: 120000,
  },
  null,
  2,
);

function runTests(config: GovernorConfig, root: string, extraArgs: string[] = []): RunOutcome {
  if (config.adapter === 'vitest') return runVitest(root, config.runTimeoutMs, extraArgs);
  return { kind: 'unavailable', reason: `adapter '${config.adapter}' is not implemented yet` };
}

function finish(root: string, config: GovernorConfig, results: GateResult[], override: string | undefined): number {
  console.log(formatResults(results));
  const decision = decide(results, override);
  switch (decision.kind) {
    case 'pass':
      return 0;
    case 'fail':
      console.log('\ngovernor: blocked. Fix the findings above, or set GOVERNOR_OVERRIDE="<reason>" (recorded in the ledger).');
      return 1;
    case 'bad-override':
      console.log('\ngovernor: GOVERNOR_OVERRIDE needs a non-empty reason.');
      return 1;
    case 'override':
      appendRecord(ledgerPath(root), {
        v: 1, runId: randomUUID(), at: new Date().toISOString(), head: 'override', adapter: config.adapter,
        exitCode: 0, collectionErrors: [], tests: [],
        override: { gate: decision.gates.join(','), reason: decision.reason },
      });
      console.log(`\ngovernor: OVERRIDDEN (${decision.gates.join(', ')}): ${decision.reason}`);
      return 0;
  }
}

function gateCommit(root: string): number {
  const loaded = loadConfig(root);
  if (!loaded.ok) {
    console.log(formatResults([{ gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '.governor/config.json', message: loaded.error }] }]));
    return 1;
  }
  const { config } = loaded;
  const isTestFile = picomatch(config.testGlobs);
  const diff = stagedDiff(root);
  let sinceIso: string;
  try {
    sinceIso = evidenceSince(root);
  } catch (e) {
    console.error(`governor: ${(e as Error).message}`);
    return 2;
  }
  const greenResult = green(runTests(config, root));
  const { records, corrupt } = readLedger(ledgerPath(root));
  if (corrupt > 0) console.log(`governor: skipped ${corrupt} corrupt ledger line(s)`);
  const results = [
    greenResult,
    redBeforeGreen({ diff, isTestFile, records, sinceIso }),
    diffAudit({ diff, isTestFile }),
  ];
  return finish(root, config, results, process.env.GOVERNOR_OVERRIDE);
}

const MUTATION_DISABLED: GateResult = {
  gate: 'mutation',
  status: 'PASS',
  findings: [{ file: '.governor/config.json', message: 'warning: mutation gate disabled in .governor/config.json' }],
};

function mutationGate(root: string, config: GovernorConfig, diff: FileDiff[]): GateResult {
  const isSource = picomatch(config.sourceGlobs);
  const isTest = picomatch(config.testGlobs);
  const changed = changedLines(diff, (p) => isSource(p) && !isTest(p));
  if (changed.size === 0) return { gate: 'mutation', status: 'PASS', findings: [] };

  const run = config.adapter === 'vitest'
    ? runStryker(root, [...changed.keys()], config.mutation.timeoutMs)
    : { ok: false as const, error: `mutation for adapter '${config.adapter}' is not implemented yet` };
  return run.ok
    ? mutation({ mutants: run.mutants, changed })
    : { gate: 'mutation', status: 'GATE_UNAVAILABLE', findings: [{ file: '(mutation)', message: run.error }] };
}

function gatePush(root: string): number {
  const loaded = loadConfig(root);
  if (!loaded.ok) {
    console.log(formatResults([{ gate: 'mutation', status: 'GATE_UNAVAILABLE', findings: [{ file: '.governor/config.json', message: loaded.error }] }]));
    return 1;
  }
  const { config } = loaded;
  if (!config.mutation.enabled) return finish(root, config, [MUTATION_DISABLED], process.env.GOVERNOR_OVERRIDE);
  let base: string;
  try {
    base = pushBase(root);
  } catch (e) {
    console.error(`governor: cannot determine push base: ${(e as Error).message}`);
    return 2;
  }
  return finish(root, config, [mutationGate(root, config, pushDiff(root, base))], process.env.GOVERNOR_OVERRIDE);
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const known = command === 'run' || command === 'install' || (command === 'gate' && (rest[0] === 'commit' || rest[0] === 'push'));
  if (!known) {
    console.error(USAGE);
    return 2;
  }
  let root: string;
  try {
    root = repoRoot();
  } catch {
    console.error('governor: not a git repository');
    return 2;
  }

  if (command === 'run') {
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}`);
      return 2;
    }
    const outcome = runTests(loaded.config, root, rest);
    if (outcome.kind === 'unavailable') {
      console.error(`governor: GATE_UNAVAILABLE: ${outcome.reason}`);
      return 2;
    }
    const { tests, collectionErrors } = outcome.record;
    const failed = tests.filter((t) => t.status === 'fail').length;
    console.log(`governor: recorded run ${outcome.record.runId}: ${tests.length} tests, ${failed} failed, ${collectionErrors.length} collection errors`);
    return outcome.record.exitCode;
  }

  if (command === 'gate' && (rest[0] === 'commit' || rest[0] === 'push')) return rest[0] === 'push' ? gatePush(root) : gateCommit(root);

  if (command === 'install') {
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}\nCreate .governor/config.json, for example:\n${EXAMPLE_CONFIG}`);
      return 2;
    }
    const cliPath = realpathSync(fileURLToPath(import.meta.url));
    const { ok, messages } = installHooks(root, cliPath, [
      { name: 'pre-commit', command: 'gate commit' },
      { name: 'pre-push', command: 'gate push' },
    ]);
    messages.forEach((m) => console.log(`governor: ${m}`));
    return ok ? 0 : 1;
  }

  return 2; // unreachable: `known` covers every command above
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
