import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { classify } from '../../classify.js';
import { appendRecord, ledgerPath } from '../../ledger.js';
import type { LedgerRecord, TestResult } from '../../types.js';

interface ErrorLike {
  name?: string;
  message?: string;
}
interface CaseLike {
  fullName: string;
  location?: { line: number; column: number };
  result(): { state: string; errors?: ReadonlyArray<ErrorLike> };
}
export interface ModuleLike {
  moduleId: string;
  errors(): ReadonlyArray<ErrorLike>;
  children: { allTests(): Iterable<CaseLike> };
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0]!.slice(0, 300);

export function buildRecord(input: {
  root: string;
  runId: string;
  head: string;
  at: string;
  modules: ReadonlyArray<ModuleLike>;
  unhandledErrors: ReadonlyArray<ErrorLike>;
  reason: 'passed' | 'failed' | 'interrupted';
}): LedgerRecord {
  const tests: TestResult[] = [];
  const collectionErrors: LedgerRecord['collectionErrors'] = [];

  for (const mod of input.modules) {
    const file = path.relative(input.root, mod.moduleId);
    const moduleErrors = mod.errors();
    if (moduleErrors.length > 0) {
      collectionErrors.push({ file, message: firstLine(moduleErrors[0]!.message) });
    }
    for (const test of mod.children.allTests()) {
      const result = test.result();
      const status = result.state === 'passed' ? 'pass' : result.state === 'failed' ? 'fail' : 'skip';
      const entry: TestResult = { id: `${file} > ${test.fullName}`, file, status };
      if (test.location) entry.line = test.location.line;
      if (status === 'fail') {
        const err = result.errors?.[0];
        entry.failureKind = classify(err);
        entry.message = firstLine(err?.message);
      }
      tests.push(entry);
    }
  }
  for (const err of input.unhandledErrors) {
    collectionErrors.push({ file: '(unhandled)', message: firstLine(err.message) });
  }

  return {
    v: 1,
    runId: input.runId,
    at: input.at,
    head: input.head,
    adapter: 'vitest',
    exitCode: input.reason === 'passed' ? 0 : 1,
    collectionErrors,
    tests,
  };
}

function gitHead(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'none';
  }
}

export default class GovernorReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<ErrorLike>,
    reason: 'passed' | 'failed' | 'interrupted',
  ): void {
    const record = buildRecord({
      root: this.root,
      runId: process.env.GOVERNOR_RUN_ID ?? randomUUID(),
      head: gitHead(this.root),
      at: new Date().toISOString(),
      modules: testModules as unknown as ReadonlyArray<ModuleLike>,
      unhandledErrors,
      reason,
    });
    appendRecord(ledgerPath(this.root), record);
  }
}
