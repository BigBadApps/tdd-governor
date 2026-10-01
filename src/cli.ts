#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { runPytest } from './adapters/pytest/run.js';
import { runVitest } from './adapters/vitest/run.js';
import { loadConfig, packageOf, type GovernorConfig } from './config.js';
import type { FileDiff } from './diff.js';
import { diffAudit } from './gates/diff-audit.js';
import { green } from './gates/green.js';
import { mutation } from './gates/mutation.js';
import { redBeforeGreen } from './gates/red-before-green.js';
import { changedLines, ciBase, commitDiff, evidenceSince, pushBase, pushDiff, repoRoot, stagedFile } from './git.js';
import { installHooks, PRIMER_FILE } from './install.js';
import { appendRecord, ledgerPath, readLedger } from './ledger.js';
import { runMutmut } from './mutation/mutmut.js';
import { runStryker } from './mutation/stryker.js';
import { findVitestConfig, reporterWarning } from './primer.js';
import { decide, formatResults } from './report.js';
import type { GateResult, LedgerRecord, RunOutcome } from './types.js';

const USAGE = 'usage: governor <run | gate commit | gate push | gate ci | install>';
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

// The reporter writes paths relative to the package it ran in; gates compare them with repo-relative diff paths.
function toRepoRecords(records: LedgerRecord[], toRepo: (p: string) => string): LedgerRecord[] {
  return records.map((r) => ({
    ...r,
    tests: r.tests.map((t) => ({ ...t, file: toRepo(t.file), id: toRepo(t.file) + t.id.slice(t.file.length) })),
    collectionErrors: r.collectionErrors.map((e) => (e.file === '(unhandled)' ? e : { ...e, file: toRepo(e.file) })),
  }));
}

function packageLedger(root: string, config: GovernorConfig): { records: LedgerRecord[]; corrupt: number } {
  const pkg = packageOf(root, config);
  const { records, corrupt } = readLedger(ledgerPath(pkg.dir));
  return { records: toRepoRecords(records, pkg.toRepo), corrupt };
}

function runTests(config: GovernorConfig, root: string, extraArgs: string[] = []): RunOutcome {
  const pkg = packageOf(root, config);
  const outcome = config.adapter === 'vitest'
    ? runVitest(pkg.dir, config.runTimeoutMs, extraArgs)
    : runPytest(pkg.dir, config.pytest!.python, config.runTimeoutMs, extraArgs);
  return outcome.kind === 'completed' ? { kind: 'completed', record: toRepoRecords([outcome.record], pkg.toRepo)[0]! } : outcome;
}

function finish(root: string, config: GovernorConfig, results: GateResult[], override: string | undefined): number {
  console.log(formatResults(results));
  const decision = decide(results, override);
  switch (decision.kind) {
    case 'pass':
      return 0;
    case 'fail':
      console.log('\ngovernor: blocked. Fix the findings above, or set GOVERNOR_OVERRIDE="<reason>" (recorded in the ledger).');
      if (existsSync(path.join(root, PRIMER_FILE))) console.log(`governor: read ${PRIMER_FILE} for what counts as a valid red and how to get one.`);
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

function gateCommit(root: string, env?: NodeJS.ProcessEnv): number {
  const loaded = loadConfig(root);
  if (!loaded.ok) {
    console.log(formatResults([{ gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '.governor/config.json', message: loaded.error }] }]));
    return 1;
  }
  const { config } = loaded;
  const isTestFile = picomatch(config.testGlobs);
  const diff = commitDiff(root, env);
  let sinceIso: string;
  try {
    sinceIso = evidenceSince(root);
  } catch (e) {
    console.error(`governor: ${(e as Error).message}`);
    return 2;
  }
  const greenResult = green(runTests(config, root));
  const { records, corrupt } = packageLedger(root, config);
  if (corrupt > 0) console.log(`governor: skipped ${corrupt} corrupt ledger line(s)`);
  const results = [
    greenResult,
    redBeforeGreen({ diff, isTestFile, records, sinceIso, source: (p) => stagedFile(root, p) }),
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

  const pkg = packageOf(root, config);
  const run = config.adapter === 'vitest'
    ? runStryker(pkg.dir, [...changed.keys()].map(pkg.toPackage), config.mutation.timeoutMs)
    : runMutmut(pkg.dir, config.pytest!.python, [...changed.keys()].map(pkg.toPackage), config.mutation.timeoutMs);
  return run.ok
    ? mutation({ mutants: run.mutants.map((m) => ({ ...m, file: pkg.toRepo(m.file) })), changed })
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

function gateCi(root: string, baseFlag: string | undefined): number {
  const loaded = loadConfig(root);
  if (!loaded.ok) {
    console.log(formatResults([{ gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '.governor/config.json', message: loaded.error }] }]));
    return 1;
  }
  const { config } = loaded;
  let diff: FileDiff[];
  try {
    diff = pushDiff(root, ciBase(root, baseFlag));
  } catch (e) {
    console.error(`governor: ${(e as Error).message}`);
    return 2;
  }
  if (process.env.GOVERNOR_OVERRIDE !== undefined) console.log('governor: GOVERNOR_OVERRIDE is ignored in CI');
  console.log('red-before-green: skipped in CI (needs local ledger, G3)');
  const isTestFile = picomatch(config.testGlobs);
  const results = [
    green(runTests(config, root)),
    diffAudit({ diff, isTestFile }),
    config.mutation.enabled ? mutationGate(root, config, diff) : MUTATION_DISABLED,
  ];
  return finish(root, config, results, undefined);
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const known = command === 'run' || command === 'install' || (command === 'gate' && (rest[0] === 'commit' || rest[0] === 'push' || rest[0] === 'ci'));
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

  if (command === 'gate' && rest[0] === 'ci') {
    const i = rest.indexOf('--base');
    if (i !== -1 && !rest[i + 1]) {
      console.error('usage: governor gate ci [--base <ref>]');
      return 2;
    }
    return gateCi(root, i === -1 ? undefined : rest[i + 1]);
  }

  if (command === 'gate' && (rest[0] === 'commit' || rest[0] === 'push')) return rest[0] === 'push' ? gatePush(root) : gateCommit(root, rest.includes('--merge') ? process.env : undefined);

  if (command === 'install') {
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}\nCreate .governor/config.json, for example:\n${EXAMPLE_CONFIG}`);
      return 2;
    }
    const cliPath = realpathSync(fileURLToPath(import.meta.url));
    const { ok, messages } = installHooks(root, cliPath, [
      { name: 'pre-commit', command: 'gate commit' },
      { name: 'pre-merge-commit', command: 'gate commit --merge' },
      { name: 'pre-push', command: 'gate push' },
    ], packageOf(root, loaded.config).rel);
    messages.forEach((m) => console.log(`governor: ${m}`));
    if (loaded.config.adapter === 'vitest') {
      const pkg = packageOf(root, loaded.config);
      const found = findVitestConfig(pkg.dir, existsSync);
      const warning = reporterWarning(
        found && (pkg.rel === '.' ? found : path.posix.join(pkg.rel, found)),
        found && readFileSync(path.join(pkg.dir, found), 'utf8'),
      );
      if (warning) console.log(`governor: ${warning}`);
    }
    return ok ? 0 : 1;

  }

  return 2; // unreachable: `known` covers every command above
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
