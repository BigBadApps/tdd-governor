import type { FileDiff } from '../diff.js';
import type { Finding, GateResult, LedgerRecord, TestResult } from '../types.js';

function latestTestsFor(file: string, records: LedgerRecord[]): TestResult[] {
  for (let i = records.length - 1; i >= 0; i--) {
    const tests = records[i]!.tests.filter((t) => t.file === file);
    if (tests.length > 0) return tests;
  }
  return [];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

// Last line of the test declared on 1-based `start`: the following lines indented deeper, plus a
// closing line at the same indent. Language-neutral for formatted code (TS braces, Python blocks).
function spanEnd(lines: string[], start: number): number {
  const declIndent = indentOf(lines[start - 1] ?? '');
  let end = start;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.trim() === '') continue;
    const indent = indentOf(text);
    if (indent > declIndent) end = i + 1;
    else {
      if (indent === declIndent && /^[)}\]]/.test(text.trimStart())) end = i + 1;
      break;
    }
  }
  return end;
}

// ponytail: declaration lines from the last run plus indentation spans from the staged text (spec gap G8);
// without source text an added line goes to the last test declared above it. Parse ASTs if a layout defeats indentation.
function testsTouched(tests: TestResult[], addedLines: number[], source: string | undefined): TestResult[] {
  const sorted = [...tests].sort((a, b) => a.line! - b.line!);
  const lines = source?.split('\n');
  const ids = new Set<string>();
  for (const line of addedLines) {
    let owner: TestResult | undefined;
    for (const t of sorted) {
      if (t.line! <= line) owner = t;
      else break;
    }
    if (owner && (!lines || line <= spanEnd(lines, owner.line!))) ids.add(owner.id);
  }
  return sorted.filter((t) => ids.has(t.id));
}

export function redBeforeGreen(input: {
  diff: FileDiff[];
  isTestFile: (path: string) => boolean;
  records: LedgerRecord[];
  sinceIso: string;
  source?: (path: string) => string | undefined;
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
      const failedToImport = windowed.some((r) => r.collectionErrors.some((e) => e.file === f.path));
      findings.push({
        file: f.path,
        message: failedToImport
          ? `${f.path}: failed to import every time it ran: not a valid red; stub the implementation (exports present, wrong values) so an expect() fails`
          : 'test file changed but has no recorded test run: run the tests first',
      });
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
      inScope = testsTouched(tests, f.added.map((a) => a.line), input.source?.(f.path));
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
      const kindSet = new Set(fails.map((x) => x.failureKind));
      const kinds = [...kindSet].join(', ');
      const failedToImport = windowed.some((r) => r.collectionErrors.some((e) => e.file === test.file));
      const stub = 'stub the implementation (exports present, wrong values) so an expect() fails';
      const onlyTimedOut = fails.length > 0 && kindSet.size === 1 && kindSet.has('timeout');
      findings.push({
        ...where,
        message:
          onlyTimedOut
            ? `${test.id}: only timed out: not a valid red; make it fail fast on an assertion instead`
            : fails.length > 0
            ? `${test.id}: only failed with ${kinds}: a missing export or thrown error is not a valid red; ${stub}`
            : failedToImport
              ? `${test.id}: never seen failing (the file failed to import, which is not a valid red): ${stub}`
              : `${test.id}: never seen failing: run it red (failing assertion) before implementing`,
      });
    }
  }

  return { gate: 'red-before-green', status: block ? 'BLOCK' : undecided ? 'UNDECIDED' : 'PASS', findings };
}
