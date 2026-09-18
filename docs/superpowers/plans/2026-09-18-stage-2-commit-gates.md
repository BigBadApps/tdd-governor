# TDD Governor Stage 2 — Commit Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `git commit` in a governed repo is blocked unless the suite is green, every added or changed test was seen failing for a real assertion, and the diff doesn't weaken the suite.

**Architecture:** `diff.ts` parses `git diff --cached -U0` into per-file added/removed lines. Three pure gates (`green`, `redBeforeGreen`, `diffAudit`) turn diff + ledger + run outcome into `GateResult`s. `report.ts` formats them and decides the exit code, including `GOVERNOR_OVERRIDE`. `cli.ts` wires the I/O. `governor install` writes a `pre-commit` hook that calls the CLI by absolute path.

**Tech Stack:** Same as Stage 1, plus `picomatch` for globs.

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` (§4.1–4.3, §6, §7, §8 Stage 2)

**Prerequisite:** Stage 1 merged (`types.ts`, `classify.ts`, `ledger.ts`, `config.ts`, vitest reporter, `runVitest`, `cli.ts` with `run`).

## Global Constraints

- Everything in Stage 1's Global Constraints still applies.
- Gates are pure functions: no `fs`, `child_process`, or `process.env` inside `src/gates/`. All I/O lives in `cli.ts`, `git.ts`, and adapters.
- Only an all-`PASS` result (or a recorded override) exits 0. `BLOCK`, `UNDECIDED`, and `GATE_UNAVAILABLE` exit 1. Usage/config errors exit 2.
- A `PASS` result may carry findings. Those are warnings and are printed with a `warning:` prefix.
- Base branch is `main`. Evidence window starts at the merge-base of `HEAD` and `main`. With no `HEAD` yet (first commit), the window is all records.
- Hooks call the CLI by the absolute path of the `dist/cli.js` that ran `install`, so the governor repo can dogfood itself and clients don't need the bin on `PATH`.

## File Structure

```
src/diff.ts                        # parseUnifiedDiff → FileDiff[]
src/git.ts                         # git(), repoRoot(), stagedDiff(), evidenceSince()
src/gates/green.ts                 # green(outcome)
src/gates/red-before-green.ts      # redBeforeGreen({diff, isTestFile, records, sinceIso})
src/gates/diff-audit.ts            # diffAudit({diff, isTestFile})
src/report.ts                      # formatResults(), decide()
src/install.ts                     # installHooks(root, cliPath, hooks)
src/cli.ts                         # + `gate commit`, `install`; move repoRoot to git.ts
test/diff.test.ts
test/gates/green.test.ts
test/gates/red-before-green.test.ts
test/gates/diff-audit.test.ts
test/report.test.ts
test/e2e.commit.test.ts            # temp git repo, real hooks, real commits
```

---

### Task 1: Unified diff parser

**Files:**
- Create: `src/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DiffLine { line: number; text: string }   // line number in new file (added) or old file (removed)
export interface FileDiff {
  path: string;                                             // repo-relative, new path (old path when deleted)
  status: 'added' | 'deleted' | 'modified';
  added: DiffLine[];
  removed: DiffLine[];
}
export function parseUnifiedDiff(text: string): FileDiff[];
```
Input is the output of `git diff -U0 --no-color --no-renames --no-ext-diff`.

- [ ] **Step 1: Write the failing test**

`test/diff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff.js';

const modified = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@ export function a() {
-  return 1;
+  return 2;
@@ -10,0 +11,2 @@ more
+const x = 1;
+const y = 2;
`;

const added = `diff --git a/tests/new.test.ts b/tests/new.test.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/tests/new.test.ts
@@ -0,0 +1,2 @@
+import { it } from 'vitest';
+it('x', () => {});
`;

const deleted = `diff --git a/tests/old.test.ts b/tests/old.test.ts
deleted file mode 100644
index 444..000
--- a/tests/old.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-it('gone', () => {});
`;

const trickyRemoval = `diff --git a/doc.md b/doc.md
index 1..2 100644
--- a/doc.md
+++ b/doc.md
@@ -5 +4,0 @@
---- a heading rule
`;

describe('parseUnifiedDiff', () => {
  it('parses modified files with new-file line numbers for additions', () => {
    const [f] = parseUnifiedDiff(modified);
    expect(f).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      added: [
        { line: 3, text: '  return 2;' },
        { line: 11, text: 'const x = 1;' },
        { line: 12, text: 'const y = 2;' },
      ],
      removed: [{ line: 3, text: '  return 1;' }],
    });
  });

  it('detects added and deleted files', () => {
    const files = parseUnifiedDiff(added + deleted);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['tests/new.test.ts', 'added'],
      ['tests/old.test.ts', 'deleted'],
    ]);
    expect(files[0]!.added).toHaveLength(2);
    expect(files[1]!.removed).toEqual([{ line: 1, text: "it('gone', () => {});" }]);
  });

  it('does not mistake a removed line starting with --- for a header', () => {
    const [f] = parseUnifiedDiff(trickyRemoval);
    expect(f!.removed).toEqual([{ line: 5, text: '--- a heading rule' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/diff.test.ts`
Expected: FAIL, cannot resolve `../src/diff.js`.

- [ ] **Step 3: Implement the parser**

`src/diff.ts`:
```ts
export interface DiffLine {
  line: number;
  text: string;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  added: DiffLine[];
  removed: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      cur = { path: m ? m[2]! : '', status: 'modified', added: [], removed: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // Header lines only appear before the first hunk of a file.
      if (raw.startsWith('new file mode')) cur.status = 'added';
      else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (raw.startsWith('+++ b/')) cur.path = raw.slice(6);
      continue;
    }
    if (raw.startsWith('+')) cur.added.push({ line: newLine++, text: raw.slice(1) });
    else if (raw.startsWith('-')) cur.removed.push({ line: oldLine++, text: raw.slice(1) });
    else if (raw.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
    // '\ No newline at end of file' and blank trailing lines: ignored
  }
  return files;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/diff.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts test/diff.test.ts
git commit -m "feat: unified diff parser for -U0 git diffs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Green gate

**Files:**
- Create: `src/gates/green.ts`
- Test: `test/gates/green.test.ts`

**Interfaces:**
- Consumes: `RunOutcome`, `GateResult`, `LedgerRecord` from `src/types.ts`.
- Produces: `green(outcome: RunOutcome): GateResult`.

- [ ] **Step 1: Write the failing test**

`test/gates/green.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { green } from '../../src/gates/green.js';
import type { LedgerRecord } from '../../src/types.js';

const rec = (over: Partial<LedgerRecord>): LedgerRecord => ({
  v: 1, runId: 'r', at: '2026-09-18T00:00:00.000Z', head: 'h', adapter: 'vitest',
  exitCode: 0, collectionErrors: [], tests: [], ...over,
});

describe('green gate', () => {
  it('passes a clean run', () => {
    expect(green({ kind: 'completed', record: rec({}) })).toEqual({ gate: 'green', status: 'PASS', findings: [] });
  });

  it('blocks on failing tests and names them', () => {
    const r = green({
      kind: 'completed',
      record: rec({
        exitCode: 1,
        tests: [{ id: 't.test.ts > adds', file: 't.test.ts', line: 4, status: 'fail', failureKind: 'assertion', message: 'expected 1 to be 2' }],
      }),
    });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: 't.test.ts', line: 4, message: 'failing: t.test.ts > adds: expected 1 to be 2' }]);
  });

  it('blocks on collection errors even with exit code 0', () => {
    const r = green({ kind: 'completed', record: rec({ collectionErrors: [{ file: 'x.test.ts', message: 'Cannot find module' }] }) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]).toEqual({ file: 'x.test.ts', message: 'collection error: Cannot find module' });
  });

  it('blocks on non-zero exit with no failing tests listed', () => {
    const r = green({ kind: 'completed', record: rec({ exitCode: 1 }) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/exit code 1/);
  });

  it('is unavailable when the run is unavailable', () => {
    expect(green({ kind: 'unavailable', reason: 'no reporter' })).toEqual({
      gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '(runner)', message: 'no reporter' }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gates/green.test.ts`
Expected: FAIL, cannot resolve `../../src/gates/green.js`.

- [ ] **Step 3: Implement**

`src/gates/green.ts`:
```ts
import type { Finding, GateResult, RunOutcome } from '../types.js';

export function green(outcome: RunOutcome): GateResult {
  if (outcome.kind === 'unavailable') {
    return { gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '(runner)', message: outcome.reason }] };
  }
  const { record } = outcome;
  const findings: Finding[] = [
    ...record.collectionErrors.map((e) => ({ file: e.file, message: `collection error: ${e.message}` })),
    ...record.tests
      .filter((t) => t.status === 'fail')
      .slice(0, 20)
      .map((t) => ({ file: t.file, ...(t.line !== undefined && { line: t.line }), message: `failing: ${t.id}: ${t.message ?? ''}` })),
  ];
  if (record.exitCode !== 0 && findings.length === 0) {
    findings.push({ file: '(runner)', message: `test run exited with exit code ${record.exitCode}` });
  }
  return { gate: 'green', status: findings.length > 0 ? 'BLOCK' : 'PASS', findings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/gates/green.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gates/green.ts test/gates/green.test.ts
git commit -m "feat: green gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Red-before-green gate

**Files:**
- Create: `src/gates/red-before-green.ts`
- Test: `test/gates/red-before-green.test.ts`

**Interfaces:**
- Consumes: `FileDiff` (Task 1), `LedgerRecord`, `TestResult`, `GateResult`.
- Produces:
```ts
export function redBeforeGreen(input: {
  diff: FileDiff[];
  isTestFile: (path: string) => boolean;
  records: LedgerRecord[];   // chronological, oldest first (as readLedger returns them)
  sinceIso: string;          // evidence window start, ISO-8601 UTC
}): GateResult;
```

Rules (spec §4.1):
1. Only test files (per `isTestFile`) that are not deleted and have added lines are in scope.
2. Test layout comes from the **most recent** record containing tests for that file. No such record → BLOCK "never run".
3. `added` file → every test in it is in scope. `modified` file → the tests whose span contains an added line. A span runs from the test's `line` to the line before the next test's `line`. Any test without `line` → UNDECIDED for that file.
4. For each in-scope id, look at records with `at >= sinceIso`: any `fail` + `assertion` → OK. Else any `fail` + `unknown` → UNDECIDED. Else BLOCK (never failed, or only non-assertion failures).
5. Status: any BLOCK → `BLOCK`, else any UNDECIDED → `UNDECIDED`, else `PASS`.

- [ ] **Step 1: Write the failing test**

`test/gates/red-before-green.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/diff.js';
import { redBeforeGreen } from '../../src/gates/red-before-green.js';
import type { LedgerRecord, TestResult } from '../../src/types.js';

const F = 'tests/math.test.ts';
const isTestFile = (p: string) => p.endsWith('.test.ts');
const SINCE = '2026-09-18T00:00:00.000Z';

const run = (at: string, tests: TestResult[]): LedgerRecord => ({
  v: 1, runId: at, at, head: 'h', adapter: 'vitest', exitCode: 0, collectionErrors: [], tests,
});
const t = (name: string, line: number | undefined, status: TestResult['status'], failureKind?: TestResult['failureKind']): TestResult => ({
  id: `${F} > ${name}`, file: F, ...(line !== undefined && { line }), status, ...(failureKind && { failureKind }),
});
const modifiedAt = (...lines: number[]): FileDiff[] => [
  { path: F, status: 'modified', added: lines.map((line) => ({ line, text: 'x' })), removed: [] },
];

describe('redBeforeGreen', () => {
  it('passes when the changed test failed with an assertion in the window', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'assertion'), t('subs', 12, 'pass')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 12, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(6, 7), isTestFile, records, sinceIso: SINCE });
    expect(r).toEqual({ gate: 'red-before-green', status: 'PASS', findings: [] });
  });

  it('blocks a changed test that never failed', () => {
    const records = [run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 12, 'pass')])];
    const r = redBeforeGreen({ diff: modifiedAt(13), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: F, line: 12, message: expect.stringMatching(/subs: never seen failing/) }]);
  });

  it('blocks when the only red was a runtime_error (not a valid red)', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'runtime_error')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/only failed with runtime_error/);
  });

  it('ignores red evidence from before the window', () => {
    const records = [
      run('2026-09-17T23:00:00.000Z', [t('adds', 5, 'fail', 'assertion')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    expect(redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE }).status).toBe('BLOCK');
  });

  it('is undecided when the only red is unknown', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'unknown')])];
    expect(redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE }).status).toBe('UNDECIDED');
  });

  it('is undecided when tests lack line locations', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', undefined, 'fail', 'assertion')])];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('UNDECIDED');
    expect(r.findings[0]!.message).toMatch(/includeTaskLocation/);
  });

  it('treats edits above the first test as touching no test', () => {
    const records = [run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')])];
    expect(redBeforeGreen({ diff: modifiedAt(1, 2), isTestFile, records, sinceIso: SINCE }).status).toBe('PASS');
  });

  it('scopes every test in an added file', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'assertion'), t('subs', 12, 'pass')])];
    const diff: FileDiff[] = [{ path: F, status: 'added', added: [{ line: 1, text: 'x' }], removed: [] }];
    const r = redBeforeGreen({ diff, isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings.map((f) => f.message)).toEqual([expect.stringMatching(/subs: never seen failing/)]);
  });

  it('blocks a changed test file with no recorded runs', () => {
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records: [], sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/no recorded test run/);
  });

  it('ignores non-test and deleted files', () => {
    const diff: FileDiff[] = [
      { path: 'src/math.ts', status: 'modified', added: [{ line: 1, text: 'x' }], removed: [] },
      { path: F, status: 'deleted', added: [], removed: [{ line: 1, text: 'x' }] },
    ];
    expect(redBeforeGreen({ diff, isTestFile, records: [], sinceIso: SINCE }).status).toBe('PASS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gates/red-before-green.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement**

`src/gates/red-before-green.ts`:
```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/gates/red-before-green.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gates/red-before-green.ts test/gates/red-before-green.test.ts
git commit -m "feat: red-before-green gate over ledger evidence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Diff audit gate

**Files:**
- Create: `src/gates/diff-audit.ts`
- Test: `test/gates/diff-audit.test.ts`

**Interfaces:**
- Consumes: `FileDiff`, `GateResult`.
- Produces: `diffAudit(input: { diff: FileDiff[]; isTestFile: (path: string) => boolean }): GateResult`. Snapshot changes produce `warning:` findings with status `PASS`.

- [ ] **Step 1: Write the failing test**

`test/gates/diff-audit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/diff.js';
import { diffAudit } from '../../src/gates/diff-audit.js';

const isTestFile = (p: string) => p.endsWith('.test.ts') || /(^|\/)test_[^/]*\.py$/.test(p);
const file = (path: string, added: string[], removed: string[] = [], status: FileDiff['status'] = 'modified'): FileDiff => ({
  path, status,
  added: added.map((text, i) => ({ line: i + 1, text })),
  removed: removed.map((text, i) => ({ line: i + 1, text })),
});
const audit = (...diff: FileDiff[]) => diffAudit({ diff, isTestFile });

describe('diffAudit', () => {
  it.each([
    ["  it.skip('x', () => {})"],
    ["  it.only('x', () => {})"],
    ["  describe.skip('x', () => {})"],
    ["  it.todo('x')"],
    ["  it.skipIf(true)('x', () => {})"],
    ["  xit('x', () => {})"],
    ['@pytest.mark.skip(reason="later")'],
    ['@pytest.mark.xfail'],
    ['    pytest.skip("nope")'],
  ])('blocks added skip/only/todo: %s', (line) => {
    const path = line.includes('pytest') ? 'tests/test_a.py' : 'tests/a.test.ts';
    const r = audit(file(path, [line]));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]).toMatchObject({ file: path, line: 1 });
  });

  it('ignores skip patterns in non-test files', () => {
    expect(audit(file('src/a.ts', ['list.skip(1)'])).status).toBe('PASS');
  });

  it('blocks net removal of assertions', () => {
    const r = audit(file('tests/a.test.ts', ['  expect(x).toBeDefined();'], ['  expect(x).toBe(1);', '  expect(y).toBe(2);']));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/net removal of 1 assertion/);
  });

  it('allows rewriting assertions one-for-one', () => {
    expect(audit(file('tests/a.test.ts', ['  expect(x).toBe(3);'], ['  expect(x).toBe(1);'])).status).toBe('PASS');
  });

  it('counts python assert statements', () => {
    expect(audit(file('tests/test_a.py', [], ['    assert x == 1'])).status).toBe('BLOCK');
  });

  it('blocks deleted test files', () => {
    const r = audit(file('tests/a.test.ts', [], ["it('x', () => {})"], 'deleted'));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/deleted/);
  });

  it('blocks lowering or removing expect.assertions', () => {
    expect(audit(file('tests/a.test.ts', ['  expect.assertions(1);'], ['  expect.assertions(3);'])).status).toBe('BLOCK');
    expect(audit(file('tests/a.test.ts', [], ['  expect.assertions(2);'])).status).toBe('BLOCK');
    expect(audit(file('tests/a.test.ts', ['  expect.assertions(4);'], ['  expect.assertions(3);'])).status).toBe('PASS');
  });

  it('warns but passes on snapshot changes', () => {
    const r = audit(file('tests/__snapshots__/a.test.ts.snap', ['exports[`x`] = `2`;'], ['exports[`x`] = `1`;']));
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: snapshot changed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gates/diff-audit.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement**

`src/gates/diff-audit.ts`:
```ts
import type { DiffLine, FileDiff } from '../diff.js';
import type { Finding, GateResult } from '../types.js';

const SKIP = /\.(skip|only|todo|skipIf)\s*\(|\b(xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(/;
const ASSERTION = /\bexpect\s*\(|\bassert\b/g;
const EXPECT_N = /expect\.assertions\s*\(\s*(\d+)\s*\)/;
const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;

const countAssertions = (lines: DiffLine[]) => lines.reduce((n, l) => n + (l.text.match(ASSERTION)?.length ?? 0), 0);
const maxExpectN = (lines: DiffLine[]) => {
  const ns = lines.map((l) => EXPECT_N.exec(l.text)).filter((m) => m !== null).map((m) => Number(m[1]));
  return ns.length > 0 ? Math.max(...ns) : undefined;
};

export function diffAudit(input: { diff: FileDiff[]; isTestFile: (path: string) => boolean }): GateResult {
  const findings: Finding[] = [];
  let block = false;
  const blockAt = (f: Finding) => {
    block = true;
    findings.push(f);
  };

  for (const f of input.diff) {
    if (SNAPSHOT.test(f.path)) {
      findings.push({ file: f.path, message: 'warning: snapshot changed: review that the new snapshot is correct' });
      continue;
    }
    if (!input.isTestFile(f.path)) continue;
    if (f.status === 'deleted') {
      blockAt({ file: f.path, message: 'test file deleted' });
      continue;
    }
    for (const a of f.added) {
      if (SKIP.test(a.text)) blockAt({ file: f.path, line: a.line, message: `adds skip/only/todo: ${a.text.trim()}` });
    }
    const net = countAssertions(f.removed) - countAssertions(f.added);
    if (net > 0) blockAt({ file: f.path, message: `net removal of ${net} assertion${net === 1 ? '' : 's'}` });

    const before = maxExpectN(f.removed);
    const after = maxExpectN(f.added);
    if (before !== undefined && (after === undefined || after < before)) {
      blockAt({ file: f.path, message: `expect.assertions lowered from ${before} to ${after ?? 'none'}` });
    }
  }
  return { gate: 'diff-audit', status: block ? 'BLOCK' : 'PASS', findings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/gates/diff-audit.test.ts`
Expected: PASS, 17 tests (9 parameterised + 8).

- [ ] **Step 5: Commit**

```bash
git add src/gates/diff-audit.ts test/gates/diff-audit.test.ts
git commit -m "feat: deterministic diff audit for weakened tests

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Report and override decision

**Files:**
- Create: `src/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `GateResult`.
- Produces:
  - `formatResults(results: GateResult[]): string`: one header line per gate (`[PASS] green`), then indented findings (`  tests/a.test.ts:12  message`).
  - `decide(results: GateResult[], override: string | undefined): { kind: 'pass' } | { kind: 'fail' } | { kind: 'override'; gates: string[]; reason: string } | { kind: 'bad-override' }`.
    - All PASS → `pass` (override ignored).
    - Non-PASS and `override` undefined → `fail`.
    - Non-PASS and `override.trim() === ''` → `bad-override`.
    - Non-PASS and non-empty reason → `override` with the names of the non-PASS gates.

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decide, formatResults } from '../src/report.js';
import type { GateResult } from '../src/types.js';

const pass: GateResult = { gate: 'green', status: 'PASS', findings: [] };
const blocked: GateResult = {
  gate: 'diff-audit', status: 'BLOCK',
  findings: [{ file: 'tests/a.test.ts', line: 3, message: "adds skip/only/todo: it.skip('x')" }],
};

describe('decide', () => {
  it('passes when all gates pass, ignoring any override', () => {
    expect(decide([pass], undefined)).toEqual({ kind: 'pass' });
    expect(decide([pass], 'why')).toEqual({ kind: 'pass' });
  });

  it('fails on any non-PASS status without override', () => {
    for (const status of ['BLOCK', 'UNDECIDED', 'GATE_UNAVAILABLE'] as const) {
      expect(decide([pass, { ...blocked, status }], undefined)).toEqual({ kind: 'fail' });
    }
  });

  it('rejects an empty override reason', () => {
    expect(decide([blocked], '   ')).toEqual({ kind: 'bad-override' });
  });

  it('records an override with the failing gate names', () => {
    expect(decide([pass, blocked], 'spike branch')).toEqual({ kind: 'override', gates: ['diff-audit'], reason: 'spike branch' });
  });
});

describe('formatResults', () => {
  it('prints gate headers and file:line findings', () => {
    expect(formatResults([pass, blocked])).toBe(
      "[PASS] green\n[BLOCK] diff-audit\n  tests/a.test.ts:3  adds skip/only/todo: it.skip('x')",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL, cannot resolve `../src/report.js`.

- [ ] **Step 3: Implement**

`src/report.ts`:
```ts
import type { GateResult } from './types.js';

export type Decision =
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'override'; gates: string[]; reason: string }
  | { kind: 'bad-override' };

export function decide(results: GateResult[], override: string | undefined): Decision {
  const failing = results.filter((r) => r.status !== 'PASS').map((r) => r.gate);
  if (failing.length === 0) return { kind: 'pass' };
  if (override === undefined) return { kind: 'fail' };
  if (override.trim() === '') return { kind: 'bad-override' };
  return { kind: 'override', gates: failing, reason: override.trim() };
}

export function formatResults(results: GateResult[]): string {
  return results
    .flatMap((r) => [
      `[${r.status}] ${r.gate}`,
      ...r.findings.map((f) => `  ${f.file}${f.line !== undefined ? `:${f.line}` : ''}  ${f.message}`),
    ])
    .join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/report.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "feat: gate report formatting and override decision

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: git I/O, `gate commit`, `install`, and the e2e test

**Files:**
- Create: `src/git.ts`, `src/install.ts`, `test/e2e.commit.test.ts`
- Modify: `src/cli.ts` (replace the local `repoRoot` with the one from `git.ts`; add `gate commit` and `install`)

**Interfaces:**
- Consumes: everything above, plus `runVitest`, `loadConfig`, `readLedger`, `appendRecord`, `ledgerPath`.
- Produces:
  - `git(root: string, args: string[]): string`
  - `repoRoot(cwd?: string): string`
  - `stagedDiff(root: string): FileDiff[]`
  - `evidenceSince(root: string): string`: ISO time of the merge-base of `HEAD` and `main`. Returns `new Date(0).toISOString()` when `HEAD` doesn't exist. Throws with a clear message when `main` doesn't exist.
  - `installHooks(root: string, cliPath: string, hooks: Array<{ name: string; command: string }>): { ok: boolean; messages: string[] }`. Stage 2 passes `[{ name: 'pre-commit', command: 'gate commit' }]`. Stage 3 adds `pre-push`.
  - CLI: `governor gate commit`, `governor install`.

- [ ] **Step 1: Write the failing e2e test**

The e2e test builds a real temp repo whose `node_modules` symlinks to the governor's own, so vitest and the reporter resolve. It commits through real git hooks.

`test/e2e.commit.test.ts`:
```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const governorRoot = path.resolve(__dirname, '..');
const cli = path.join(governorRoot, 'dist', 'cli.js');

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-e2e-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  g('init', '-b', 'main', '-q');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'e2e');
  symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'node_modules'));
  mkdirSync(path.join(root, '.governor'));
  writeFileSync(path.join(root, '.governor', 'config.json'), JSON.stringify({
    adapter: 'vitest', testGlobs: ['tests/**/*.test.ts'], sourceGlobs: ['src/**/*.ts'],
    mutation: { enabled: false, timeoutMs: 300000 }, runTimeoutMs: 120000,
  }));
  writeFileSync(path.join(root, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    `import GovernorReporter from ${JSON.stringify(path.join(governorRoot, 'dist/adapters/vitest/reporter.js'))};`,
    "export default defineConfig({ test: { include: ['tests/**/*.test.ts'], includeTaskLocation: true, reporters: ['default', new GovernorReporter()] } });",
  ].join('\n'));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-q', '--no-verify', '-m', 'init');
  execFileSync('node', [cli, 'install'], { cwd: root, stdio: 'pipe' });
  return root;
}

const write = (root: string, rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};
const commit = (root: string, env: Record<string, string> = {}) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  return spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
};
const runTests = (root: string) => spawnSync('node', [cli, 'run'], { cwd: root, encoding: 'utf8' });

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: governorRoot, stdio: 'pipe' });
});

describe('governor gate commit (e2e)', () => {
  it('passes a genuine test-first commit', () => {
    const root = makeRepo();
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => 0;\n');
    write(root, 'tests/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n");
    expect(runTests(root).status).toBe(1); // red, for an assertion
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    const res = commit(root);
    expect(res.stderr + res.stdout).toMatch(/\[PASS\] red-before-green/);
    expect(res.status).toBe(0);
  });

  it('blocks a test that was never seen red', () => {
    const root = makeRepo();
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(root, 'tests/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n");
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/never seen failing/);
  });

  it('blocks an added .skip', () => {
    const root = makeRepo();
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit.skip('later', () => {});\n");
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/adds skip\/only\/todo/);
  });

  it('lets an override through and records it in the ledger', () => {
    const root = makeRepo();
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit.skip('later', () => {});\n");
    const res = commit(root, { GOVERNOR_OVERRIDE: 'e2e override' });
    expect(res.status).toBe(0);
    const ledger = execFileSync('cat', [path.join(root, '.governor', 'ledger.jsonl')], { encoding: 'utf8' });
    expect(ledger).toMatch(/"reason":"e2e override"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/e2e.commit.test.ts`
Expected: FAIL. `governor install` is an unknown command (usage, exit 2), so `makeRepo` throws.

- [ ] **Step 3: Implement `git.ts`**

`src/git.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { parseUnifiedDiff, type FileDiff } from './diff.js';

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoRoot(cwd: string = process.cwd()): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function stagedDiff(root: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['diff', '--cached', '-U0', '--no-color', '--no-renames', '--no-ext-diff']));
}

export function evidenceSince(root: string, base = 'main'): string {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return new Date(0).toISOString(); // first commit: all evidence counts
  }
  let mergeBase: string;
  try {
    mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  } catch {
    throw new Error(`no merge-base between HEAD and '${base}': the governor needs a '${base}' branch`);
  }
  return new Date(git(root, ['show', '-s', '--format=%cI', mergeBase]).trim()).toISOString();
}
```

- [ ] **Step 4: Implement `install.ts`**

`src/install.ts`:
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

const MARKER = '# tdd-governor';

export function installHooks(
  root: string,
  cliPath: string,
  hooks: Array<{ name: string; command: string }>,
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  const hooksDir = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  mkdirSync(hooksDir, { recursive: true });

  for (const { name, command } of hooks) {
    const file = path.join(hooksDir, name);
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER)) {
      ok = false;
      messages.push(`refusing to overwrite existing ${name} hook at ${file}; add this line to it yourself: node "${cliPath}" ${command}`);
      continue;
    }
    writeFileSync(file, `#!/bin/sh\n${MARKER}\nexec node "${cliPath}" ${command}\n`);
    chmodSync(file, 0o755);
    messages.push(`installed ${name} → governor ${command}`);
  }

  const gitignore = path.join(root, '.gitignore');
  const entry = '.governor/ledger.jsonl';
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').includes(entry)) {
    writeFileSync(gitignore, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`);
    messages.push(`added ${entry} to .gitignore`);
  }
  return { ok, messages };
}
```

- [ ] **Step 5: Extend `cli.ts`**

Replace `src/cli.ts` entirely:
```ts
#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { runVitest } from './adapters/vitest/run.js';
import { loadConfig, type GovernorConfig } from './config.js';
import { diffAudit } from './gates/diff-audit.js';
import { green } from './gates/green.js';
import { redBeforeGreen } from './gates/red-before-green.js';
import { evidenceSince, repoRoot, stagedDiff } from './git.js';
import { installHooks } from './install.js';
import { appendRecord, ledgerPath, readLedger } from './ledger.js';
import { decide, formatResults } from './report.js';
import type { GateResult, RunOutcome } from './types.js';

const USAGE = 'usage: governor <run | gate commit | install>';
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

function finish(root: string, config: GovernorConfig, results: GateResult[]): number {
  console.log(formatResults(results));
  const decision = decide(results, process.env.GOVERNOR_OVERRIDE);
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
  return finish(root, config, results);
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const root = repoRoot();

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

  if (command === 'gate' && rest[0] === 'commit') return gateCommit(root);

  if (command === 'install') {
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}\nCreate .governor/config.json, for example:\n${EXAMPLE_CONFIG}`);
      return 2;
    }
    const cliPath = realpathSync(fileURLToPath(import.meta.url));
    const { ok, messages } = installHooks(root, cliPath, [{ name: 'pre-commit', command: 'gate commit' }]);
    messages.forEach((m) => console.log(`governor: ${m}`));
    return ok ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `npx vitest run test/e2e.commit.test.ts`
Expected: PASS, 4 tests.

If "passes a genuine test-first commit" fails with `never seen failing`, print the temp repo's ledger and compare the test ids and `at` against `evidenceSince`. Fix from the evidence. Do not loosen the gate.

- [ ] **Step 7: Full verification gate**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/git.ts src/install.ts src/cli.ts test/e2e.commit.test.ts
git commit -m "feat: governor gate commit and install, with e2e over real hooks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Dogfood the governor on its own repo

**Files:**
- Create: `.governor/config.json`
- Modify: `vitest.config.ts` (add the reporter and `includeTaskLocation`)

- [ ] **Step 1: Configure**

`.governor/config.json`:
```json
{
  "adapter": "vitest",
  "testGlobs": ["test/**/*.test.ts"],
  "sourceGlobs": ["src/**/*.ts"],
  "mutation": { "enabled": true, "timeoutMs": 300000 },
  "runTimeoutMs": 300000
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import GovernorReporter from './src/adapters/vitest/reporter.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**'],
    testTimeout: 60_000,
    includeTaskLocation: true,
    reporters: ['default', new GovernorReporter()],
  },
});
```

`test/fixtures/**` is outside `testGlobs` on purpose. The deliberately failing fixture tests are never governed.

- [ ] **Step 2: Install and prove it blocks**

```bash
npm run build && node dist/cli.js install
```
Expected: `installed pre-commit → governor gate commit`.

Then prove a block: add `it.skip('probe', () => {});` to `test/report.test.ts`, `git add` it, run `git commit -m probe`.
Expected: `[BLOCK] diff-audit … adds skip/only/todo`. Revert the probe with `git checkout test/report.test.ts`.

- [ ] **Step 3: Commit through the gate (no `--no-verify`)**

```bash
git add .governor/config.json vitest.config.ts .gitignore
git commit -m "chore: governor governs its own repo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
Expected: the hook runs, all three gates are `[PASS]`, and the commit lands.

---

### Task 8: Onboard BigBadPlayground

Work in `/Volumes/BigBadDrive_1/BigBadPlayground` on a new branch. Follow its `CLAUDE.md`: branch off `main`, and the verification gate is `npx tsc --noEmit && npm test && npm run build`. Its commit trailer is `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` per that repo's CLAUDE.md.

**Files (BigBadPlayground):**
- Modify: `package.json` (devDependency), `vitest.config.ts`, `.gitignore`
- Create: `.governor/config.json`

- [ ] **Step 1: Branch and install**

```bash
cd /Volumes/BigBadDrive_1/BigBadPlayground
git checkout main && git pull --ff-only && git checkout -b chore/tdd-governor
npm install -D file:../tdd-governor
```

- [ ] **Step 2: Configure**

`.governor/config.json`:
```json
{
  "adapter": "vitest",
  "testGlobs": ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  "sourceGlobs": ["src/**/*.ts", "src/**/*.tsx"],
  "mutation": { "enabled": true, "timeoutMs": 600000 },
  "runTimeoutMs": 180000
}
```

`vitest.config.ts`: add `includeTaskLocation: true` and `reporters: ['default', 'tdd-governor/vitest-reporter']` inside `test`. Keep everything else as is.

- [ ] **Step 3: Install hooks and record a baseline**

```bash
node ../tdd-governor/dist/cli.js install
node ../tdd-governor/dist/cli.js run
```
Expected: hooks installed. `run` exits 0 and prints `recorded run …: N tests, 0 failed, 0 collection errors`.

- [ ] **Step 4: Verification gate**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: passes, and `npm run build` ends with `Generating static pages (5/5)`.

- [ ] **Step 5: Live-observe a block and a pass (acceptance for Stage 2)**

1. Add `it.skip('probe', () => {});` to any file in `tests/`, stage it, `git commit`. Expected: blocked by diff-audit. Revert.
2. Add a new test to `tests/lab-runtime/` for an existing pure function, with the expectation deliberately wrong. Run `npm test` (the reporter records the assertion red). Fix the expectation. Stage it and commit. Expected: all gates `[PASS]`.

Copy both outputs into the Stage 2 findings doc as `live-observed`.

- [ ] **Step 6: Commit the onboarding**

```bash
git add package.json package-lock.json vitest.config.ts .gitignore .governor/config.json
git commit -m "chore: gate commits with tdd-governor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
This commit itself goes through the new hook.

---

### Task 9: Stage 2 findings doc

**Files (tdd-governor):**
- Create: `docs/superpowers/specs/<date>-stage-2-findings.md`

- [ ] **Step 1: Write it**

Same table format as Stage 1. Required rows:
- Genuine test-first commit passes: `test` (e2e) + `live-observed` (BigBadPlayground)
- Never-red test blocked: `test` (e2e)
- Runtime-error-only red blocked: `test` (unit)
- Added `.skip` blocked: `test` (e2e) + `live-observed` (both repos)
- Override passes and is recorded: `test` (e2e)
- Missing config / missing reporter → blocked, never pass: `test`
- Wall time of `gate commit` in BigBadPlayground: `live-observed`, measured with `time git commit …`. Spec target is under 30s. Record the actual number, even if it misses.
- Carried forward: G1–G8, plus any new gap found.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/*-stage-2-findings.md
git commit -m "docs: stage 2 findings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
