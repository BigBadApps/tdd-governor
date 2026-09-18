import type { FileDiff } from '../diff.js';
import type { Finding, GateResult, LedgerRecord, TestResult } from '../types.js';

function latestTestsFor(file: string, records: LedgerRecord[]): TestResult[] {
  for (let i = records.length - 1; i >= 0; i--) {
    const tests = records[i]!.tests.filter((t) => t.file === file);
    if (tests.length > 0) return tests;
  }
  return [];
}

// ponytail: spans inferred from declaration lines of the last run (spec gap G8); parse test ASTs if spans drift.
function testsTouched(tests: TestResult[], addedLines: number[]): TestResult[] {
  const sorted = [...tests].sort((a, b) => a.line! - b.line!);
  const ids = new Set<string>();
  for (const line of addedLines) {
    let owner: TestResult | undefined;
    for (const t of sorted) {
      if (t.line! <= line) owner = t;
      else break;
    }
    if (owner) ids.add(owner.id);
  }
  return sorted.filter((t) => ids.has(t.id));
}

export function redBeforeGreen(input: {
  diff: FileDiff[];
  isTestFile: (path: string) => boolean;
  records: LedgerRecord[];
  sinceIso: string;
}): GateResult {
  const findings: Finding[] = [];
  let block = false;
  let undecided = false;
  const windowed = input.records.filter((r) => r.at >= input.sinceIso);

  for (const f of input.diff) {
    if (!input.isTestFile(f.path) || f.status === 'deleted' || f.added.length === 0) continue;

    const tests = latestTestsFor(f.path, input.records);
    if (tests.length === 0) {
      block = true;
      findings.push({ file: f.path, message: 'test file changed but has no recorded test run: run the tests first' });
      continue;
    }

    let inScope: TestResult[];
    if (f.status === 'added') {
      inScope = tests;
    } else if (tests.some((t) => t.line === undefined)) {
      undecided = true;
      findings.push({ file: f.path, message: 'tests have no line locations: set includeTaskLocation: true in the test config' });
      continue;
    } else {
      inScope = testsTouched(tests, f.added.map((a) => a.line));
    }

    for (const test of inScope) {
      const fails = windowed.flatMap((r) => r.tests.filter((x) => x.id === test.id && x.status === 'fail'));
      if (fails.some((x) => x.failureKind === 'assertion')) continue;
      const where = { file: test.file, ...(test.line !== undefined && { line: test.line }) };
      if (fails.some((x) => x.failureKind === 'unknown')) {
        undecided = true;
        findings.push({ ...where, message: `${test.id}: only unclassified failures recorded` });
        continue;
      }
      block = true;
      const kinds = [...new Set(fails.map((x) => x.failureKind))].join(', ');
      findings.push({
        ...where,
        message:
          fails.length === 0
            ? `${test.id}: never seen failing: run it red (failing assertion) before implementing`
            : `${test.id}: only failed with ${kinds}: not a valid red; stub the implementation so the assertion fails`,
      });
    }
  }

  return { gate: 'red-before-green', status: block ? 'BLOCK' : undecided ? 'UNDECIDED' : 'PASS', findings };
}
