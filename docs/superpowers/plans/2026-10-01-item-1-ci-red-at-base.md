# Item 1: CI Re-derives Red Evidence (`red-at-base` gate). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close spec gap G3 in CI. `gate ci` proves that every added or changed test fails when the PR's source changes are reverted, without reading the forgeable local ledger.

**Architecture:** `gate ci` already runs the suite at HEAD (the green gate). It now also creates a throwaway git worktree at HEAD, puts the PR's changed **source** files back to the merge-base (deleting files the PR added, restoring ones it deleted), links `node_modules`, and runs only the changed test files there through the normal adapter. A new pure gate, `redAtBase`, compares the in-scope tests' base results. Assertion failure means proven. Passing at base means BLOCK (the test doesn't test the change). Import or runtime failure at base passes with a warning, because that's what a test of brand-new code does. The local hooks and ledger are unchanged.

**Tech Stack:** Node 22, TypeScript strict ESM, git worktrees, vitest (and pytest after Item 2).

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` §4 (gates), §9 G3 ("CI re-derives red evidence by running changed tests against the merge-base implementation"). Overview: `docs/superpowers/plans/2026-10-01-overview-items-1-2-3.md`.

**Prerequisites:** Items 3 and 2 merged to `main`. This plan relies on `runVitest` / `runPytest` always recording (injected reporter or plugin) and on `GovernorConfig.pytest`. If the real signatures on `main` differ from the ones quoted here, the code on `main` wins. Adapt and note the deviation.

## Why not signatures or hashes

A signed or hashed ledger doesn't help. The agent runs as the same user, on the same machine, as any signing key. Only a run the agent can't influence is proof, and CI is that run. This is why the design re-derives evidence rather than verifying recorded evidence.

## Product decisions baked in (orchestrator-approved defaults; don't change)

1. **Weak reds pass with a warning.** A test that fails at base with `runtime_error`, `collection_error`, `timeout` or `unknown`, or whose file fails to import at base, is accepted. Without this, every test of a new module would block. The mutation gate is the backstop against tautologies on new code.
2. **Tests-only PRs are exempt** (no changed source files means PASS with a warning). Characterization tests have nothing to fail against.
3. **A test that passes at base BLOCKs**, even in a mixed PR. The message tells the author to move tests of existing behaviour into a tests-only PR. CI never honors overrides. That's existing policy.
4. Skipped or not-run at base means `UNDECIDED` (which blocks in CI, like every non-PASS).

## Global Constraints

- Gates are pure (`src/gates/*`: no fs, child_process, process.env).
- Fail closed: any failure to create the worktree, revert files, or run the base suite becomes `GATE_UNAVAILABLE`, never PASS and never a crash.
- The caller's checkout is never modified. All base work happens in a worktree under `os.tmpdir()`, removed in `finally`.
- Git commands for the throwaway worktree run with `-c core.hooksPath=/dev/null`, so client `post-checkout` hooks (LFS, husky) don't fire.
- Strict TS, no `any`, ESM `.js` imports. Commit after every task. Never `--no-verify` / `GOVERNOR_OVERRIDE`. `npm run build` before committing `src/` changes.
- This repo's own CI runs `gate ci` on this PR, so the new gate gates its own PR. A red there is the product working. Fix the cause.

## File Structure

```
src/types.ts                     # GateName += 'red-at-base'
src/gates/red-before-green.ts    # export scopeOf (extracted, behaviour unchanged)
src/gates/red-at-base.ts         # pure gate
src/base-worktree.ts             # withBaseWorktree: throwaway worktree with source reverted to base
src/git.ts                       # headFile()
src/cli.ts                       # gateCi wires red-at-base
test/gates/red-before-green.test.ts, test/gates/red-at-base.test.ts, test/base-worktree.test.ts, test/e2e.ci.test.ts
README.md, templates/governor-ci.yml, .github/workflows/ci.yml, spec §9 G3, findings doc
```

---

### Task 1: Extract `scopeOf` from `redBeforeGreen`

**Files:**
- Modify: `src/gates/red-before-green.ts`
- Test: `test/gates/red-before-green.test.ts`

**Interfaces:**
- Produces: `scopeOf(f: FileDiff, tests: TestResult[], source: string | undefined): TestResult[] | undefined`. All tests for an added file. For a modified file, the tests whose span holds an added line. `undefined` when any test lacks a line number.

- [ ] **Step 1: Write the failing test** (append; add `scopeOf` to the import from `'../../src/gates/red-before-green.js'`, and import `FileDiff`/`TestResult` types if not already imported)

```ts
describe('scopeOf', () => {
  const t = (id: string, line?: number): TestResult => ({ id: `t.test.ts > ${id}`, file: 't.test.ts', status: 'pass', ...(line !== undefined && { line }) });
  const diff = (status: FileDiff['status'], lines: number[]): FileDiff => ({ path: 't.test.ts', status, added: lines.map((line) => ({ line, text: 'x' })), removed: [] });
  const source = "it('a', () => {\n  expect(1).toBe(1);\n});\n\nit('b', () => {\n  expect(2).toBe(2);\n});\n";

  it('takes every test of an added file', () => {
    expect(scopeOf(diff('added', [1]), [t('a', 1), t('b', 5)], source)?.map((x) => x.id)).toEqual(['t.test.ts > a', 't.test.ts > b']);
  });

  it('takes only the tests whose span holds an added line', () => {
    expect(scopeOf(diff('modified', [6]), [t('a', 1), t('b', 5)], source)?.map((x) => x.id)).toEqual(['t.test.ts > b']);
  });

  it('is undefined when a test has no line', () => {
    expect(scopeOf(diff('modified', [6]), [t('a'), t('b', 5)], source)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/gates/red-before-green.test.ts`
Expected: FAIL, `scopeOf` is not a function / not exported.

- [ ] **Step 3: Implement**

In `src/gates/red-before-green.ts`, add:

```ts
// Tests a diffed test file puts in scope: all of them for a new file, otherwise those whose span holds an added line.
// undefined when the run recorded no line locations, so which tests were touched cannot be told.
export function scopeOf(f: FileDiff, tests: TestResult[], source: string | undefined): TestResult[] | undefined {
  if (f.status === 'added') return tests;
  if (tests.some((t) => t.line === undefined)) return undefined;
  return testsTouched(tests, f.added.map((a) => a.line), source);
}
```

and in `redBeforeGreen` replace the `let inScope … else { inScope = testsTouched(…) }` block with:

```ts
    const inScope = scopeOf(f, tests, input.source?.(f.path));
    if (!inScope) {
      undecided = true;
      findings.push({ file: f.path, message: 'tests have no line locations: set includeTaskLocation: true in the test config' });
      continue;
    }
```

- [ ] **Step 4: Run to verify pass (new and existing tests)**

Run: `npx vitest run test/gates/red-before-green.test.ts`
Expected: PASS, with every pre-existing test unchanged.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/gates/red-before-green.ts test/gates/red-before-green.test.ts
git commit -m "refactor: export scopeOf from the red-before-green gate

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 2: The pure `redAtBase` gate

**Files:**
- Modify: `src/types.ts` (`GateName`)
- Create: `src/gates/red-at-base.ts`
- Test: `test/gates/red-at-base.test.ts`

**Interfaces:**
- Produces: `redAtBase(input: { scoped: TestResult[]; sourceChanged: boolean; base: RunOutcome }): GateResult` with `gate: 'red-at-base'`. Warnings are PASS findings whose message starts with `warning:` (the same convention as `MUTATION_DISABLED` in `src/cli.ts`).

- [ ] **Step 1: Write the failing tests**

`test/gates/red-at-base.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redAtBase } from '../../src/gates/red-at-base.js';
import type { LedgerRecord, RunOutcome, TestResult } from '../../src/types.js';

const F = 'tests/a.test.ts';
const head = (name: string): TestResult => ({ id: `${F} > ${name}`, file: F, line: 1, status: 'pass' });
const base = (tests: TestResult[], collectionErrors: LedgerRecord['collectionErrors'] = []): RunOutcome => ({
  kind: 'completed',
  record: { v: 1, runId: 'b', at: '2026-10-01T00:00:00.000Z', head: 'x', adapter: 'vitest', exitCode: 1, collectionErrors, tests },
});
const at = (name: string, status: TestResult['status'], failureKind?: TestResult['failureKind']): TestResult => ({
  id: `${F} > ${name}`, file: F, status, ...(failureKind && { failureKind }),
});

describe('redAtBase', () => {
  it('passes with no tests in scope', () => {
    expect(redAtBase({ scoped: [], sourceChanged: true, base: base([]) })).toEqual({ gate: 'red-at-base', status: 'PASS', findings: [] });
  });

  it('passes a tests-only change with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: false, base: base([]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*no source files changed/);
  });

  it('passes a test that fails on an assertion at base', () => {
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'fail', 'assertion')]) })).toMatchObject({ status: 'PASS', findings: [] });
  });

  it('blocks a test that passes at base', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'pass')]) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/passes with this PR's source changes reverted/);
  });

  it('passes a runtime-error red with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'fail', 'runtime_error')]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*runtime_error/);
  });

  it('passes a file that does not import at base with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([], [{ file: F, message: 'Cannot find module' }]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*does not import at base/);
  });

  it('is undecided when the test was skipped or not run at base', () => {
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'skip')]) }).status).toBe('UNDECIDED');
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([]) }).status).toBe('UNDECIDED');
  });

  it('blocks over undecided when both occur', () => {
    const r = redAtBase({ scoped: [head('a'), head('b')], sourceChanged: true, base: base([at('a', 'pass')]) });
    expect(r.status).toBe('BLOCK');
  });

  it('is unavailable when the base run is', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: { kind: 'unavailable', reason: 'boom' } });
    expect(r).toEqual({ gate: 'red-at-base', status: 'GATE_UNAVAILABLE', findings: [{ file: '(base run)', message: 'boom' }] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/gates/red-at-base.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement**

In `src/types.ts`:

```ts
export type GateName = 'red-before-green' | 'red-at-base' | 'diff-audit' | 'green' | 'mutation';
```

`src/gates/red-at-base.ts`:

```ts
import type { Finding, GateResult, RunOutcome, TestResult } from '../types.js';

// CI's red evidence, re-derived rather than read from a ledger any local process can append to (spec §9 G3):
// each added or changed test must fail once the PR's source changes are reverted.
export function redAtBase(input: { scoped: TestResult[]; sourceChanged: boolean; base: RunOutcome }): GateResult {
  const gate = 'red-at-base' as const;
  if (input.scoped.length === 0) return { gate, status: 'PASS', findings: [] };
  if (!input.sourceChanged) {
    return { gate, status: 'PASS', findings: [{ file: '(diff)', message: 'warning: no source files changed: nothing to re-derive red evidence against' }] };
  }
  if (input.base.kind === 'unavailable') return { gate, status: 'GATE_UNAVAILABLE', findings: [{ file: '(base run)', message: input.base.reason }] };

  const { record } = input.base;
  const findings: Finding[] = [];
  let block = false;
  let undecided = false;
  for (const t of input.scoped) {
    const where = { file: t.file, ...(t.line !== undefined && { line: t.line }) };
    const result = record.tests.find((x) => x.id === t.id);
    if (result?.status === 'fail' && result.failureKind === 'assertion') continue;
    if (result?.status === 'pass') {
      block = true;
      findings.push({ ...where, message: `${t.id}: passes with this PR's source changes reverted, so it does not test them. Move tests of existing behaviour to a tests-only PR` });
    } else if (result?.status === 'fail') {
      findings.push({ ...where, message: `warning: ${t.id}: fails at base with ${result.failureKind ?? 'unknown'}, not an assertion (expected when it tests new code)` });
    } else if (!result && record.collectionErrors.some((e) => e.file === t.file)) {
      findings.push({ ...where, message: `warning: ${t.id}: its file does not import at base (expected when it tests new code)` });
    } else {
      undecided = true;
      findings.push({ ...where, message: `${t.id}: ${result ? 'skipped' : 'not run'} at base, so whether it tests this PR's changes is unknown` });
    }
  }
  return { gate, status: block ? 'BLOCK' : undecided ? 'UNDECIDED' : 'PASS', findings };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/gates/red-at-base.test.ts && npx tsc --noEmit`
Expected: PASS, 9 tests. tsc is clean.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/types.ts src/gates/red-at-base.ts test/gates/red-at-base.test.ts
git commit -m "feat: red-at-base gate judges tests run against the base source

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 3: `withBaseWorktree`, a throwaway checkout with the source reverted

**Files:**
- Create: `src/base-worktree.ts`
- Test: `test/base-worktree.test.ts`

**Interfaces:**
- Consumes: `git(root, args)` from `src/git.ts`, `FileDiff` from `src/diff.ts`.
- Produces: `withBaseWorktree<T>(root: string, baseSha: string, revert: FileDiff[], linkDirs: string[], fn: (worktree: string) => T): T`. It creates a detached worktree of HEAD under `os.tmpdir()`. For each `revert` entry, an `added` file is deleted and anything else is checked out from `baseSha`. Each repo-relative `linkDirs` entry that exists in `root` and not in the worktree is symlinked in. The worktree and its temp dir are removed in `finally`, even when `fn` throws.

- [ ] **Step 1: Write the failing tests**

`test/base-worktree.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withBaseWorktree } from '../src/base-worktree.js';
import { pushDiff } from '../src/git.js';

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-bw-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'base\n');
  writeFileSync(path.join(root, 'src/gone.ts'), 'gone\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(root, 'src/a.ts'), 'head\n');
  writeFileSync(path.join(root, 'src/new.ts'), 'new\n');
  rmSync(path.join(root, 'src/gone.ts'));
  g('add', '-A');
  g('commit', '-q', '-m', 'feature');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules/marker'), 'dep\n');
  return { root, base, g };
}

describe('withBaseWorktree', () => {
  it('reverts the listed source files to base, links deps, and leaves the checkout alone', () => {
    const { root, base, g } = repo();
    const seen = withBaseWorktree(root, base, pushDiff(root, base), ['node_modules'], (wt) => ({
      wt,
      a: readFileSync(path.join(wt, 'src/a.ts'), 'utf8'),
      gone: readFileSync(path.join(wt, 'src/gone.ts'), 'utf8'),
      hasNew: existsSync(path.join(wt, 'src/new.ts')),
      dep: readFileSync(path.join(wt, 'node_modules/marker'), 'utf8'),
    }));
    expect(seen).toMatchObject({ a: 'base\n', gone: 'gone\n', hasNew: false, dep: 'dep\n' });
    expect(existsSync(seen.wt)).toBe(false);
    expect(g('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('head\n');
    expect(g('status', '--porcelain')).toBe('');
  });

  it('cleans up when the callback throws', () => {
    const { root, base, g } = repo();
    let wt = '';
    expect(() =>
      withBaseWorktree(root, base, [], [], (w) => {
        wt = w;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(wt)).toBe(false);
    expect(g('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('does not run the repo hooks', () => {
    const { root, base } = repo();
    const marker = path.join(root, 'hook-ran');
    writeFileSync(path.join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    withBaseWorktree(root, base, pushDiff(root, base), [], () => undefined);
    expect(existsSync(marker)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/base-worktree.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement**

`src/base-worktree.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileDiff } from './diff.js';
import { git } from './git.js';

// Client post-checkout hooks (LFS, husky) must not fire for a checkout the governor makes and throws away.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

// A throwaway worktree of HEAD with `revert`'s files put back to `baseSha` (files the diff added are removed).
// The caller's checkout is never touched. Dependencies are linked from `root`, not installed.
export function withBaseWorktree<T>(root: string, baseSha: string, revert: FileDiff[], linkDirs: string[], fn: (worktree: string) => T): T {
  const parent = mkdtempSync(path.join(tmpdir(), 'governor-base-'));
  const wt = path.join(parent, 'wt');
  git(root, [...NO_HOOKS, 'worktree', 'add', '--detach', '--quiet', wt, 'HEAD']);
  try {
    for (const f of revert) {
      if (f.status === 'added') rmSync(path.join(wt, f.path), { force: true });
      else git(wt, [...NO_HOOKS, 'checkout', baseSha, '--', f.path]);
    }
    for (const rel of linkDirs) {
      const from = path.join(root, rel);
      const to = path.join(wt, rel);
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to);
    }
    return fn(wt);
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    rmSync(parent, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/base-worktree.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/base-worktree.ts test/base-worktree.test.ts
git commit -m "feat: throwaway worktree with the PR's source reverted to base

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 4: Wire `red-at-base` into `gate ci`

**Files:**
- Modify: `src/git.ts` (add `headFile`), `src/cli.ts` (`gateCi`)
- Test: `test/e2e.ci.test.ts`

**Interfaces:**
- Consumes: `scopeOf` (Task 1), `redAtBase` (Task 2), `withBaseWorktree` (Task 3), `runTests`, `packageOf`, `ciBase`, `pushDiff`.
- Produces: `headFile(root: string, file: string): string | undefined` (`git show HEAD:<file>`, `undefined` on error). `gate ci` output contains `[<STATUS>] red-at-base`, and no longer prints `red-before-green: skipped in CI`.

- [ ] **Step 1: Write the failing e2e tests**

In `test/e2e.ci.test.ts`:

(a) In `'blocks an added .skip and prints the skipped red-before-green line'`, rename it to `'blocks an added .skip'` and replace the `toContain('red-before-green: skipped in CI …')` line with:

```ts
    expect(res.stdout).not.toContain('red-before-green: skipped in CI');
    expect(res.stdout).toMatch(/\[PASS\] red-at-base[\s\S]*warning: no source files changed/);
```

(b) Add these tests inside the `describe`:

```ts
  it('passes a test that fails on an assertion at base', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'src/add.ts'), 'export const add = (a: number, b: number, c = 0): number => a + b + c;\n');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\nit('adds three', () => {\n  expect(add(1, 2, 3)).toBe(6);\n});\n`);
    commit(root);
    const res = ci(root);
    expect(res.stdout).toMatch(/\[PASS\] red-at-base/);
    expect(res.stdout).not.toMatch(/warning: .*adds three/);
    expect(res.status).toBe(0);
  });

  it('passes a test of a new module with a weak-red warning', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'src/sub.ts'), 'export const sub = (a: number, b: number): number => a - b;\n');
    writeFileSync(path.join(root, 'tests/sub.test.ts'), "import { expect, it } from 'vitest';\nimport { sub } from '../src/sub.js';\n\nit('subtracts', () => {\n  expect(sub(3, 1)).toBe(2);\n});\n");
    commit(root);
    const res = ci(root);
    expect(res.stdout).toMatch(/\[PASS\] red-at-base[\s\S]*warning: .*subtracts/);
    expect(res.status).toBe(0);
  });

  it('blocks a test that passes without the PR source changes', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'src/other.ts'), 'export const other = 1;\n');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\nit('adds twos', () => {\n  expect(add(2, 2)).toBe(4);\n});\n`);
    commit(root);
    const res = ci(root);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/\[BLOCK\] red-at-base[\s\S]*adds twos: passes with this PR's source changes reverted/);
  });

  it('leaves the checkout and worktree list untouched', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'src/add.ts'), 'export const add = (a: number, b: number, c = 0): number => a + b + c;\n');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\nit('adds three', () => {\n  expect(add(1, 2, 3)).toBe(6);\n});\n`);
    commit(root);
    ci(root);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    expect(g('status', '--porcelain')).toBe('');
    expect(g('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run test/e2e.ci.test.ts`
Expected: FAIL. No `red-at-base` in the output, and the old skip line is still printed.

- [ ] **Step 3: Implement**

In `src/git.ts`, next to `stagedFile`:

```ts
// HEAD content of `file` (what a CI run's line numbers refer to); undefined if absent.
export function headFile(root: string, file: string): string | undefined {
  try {
    return git(root, ['show', `HEAD:${file}`]);
  } catch {
    return undefined;
  }
}
```

In `src/cli.ts`, add the imports (`withBaseWorktree` from `./base-worktree.js`, `redAtBase` from `./gates/red-at-base.js`, `scopeOf` alongside `redBeforeGreen`, `headFile` from `./git.js`) and this function:

```ts
// G3 in CI: every added/changed test must fail once the PR's source changes are reverted. Evidence comes from a
// run in a throwaway worktree, never from the ledger, which any local process can append to.
function redAtBaseGate(root: string, config: GovernorConfig, base: string, diff: FileDiff[], head: RunOutcome): GateResult {
  const isTest = picomatch(config.testGlobs);
  const isSource = picomatch(config.sourceGlobs);
  const sources = diff.filter((f) => isSource(f.path) && !isTest(f.path));
  const testDiffs = diff.filter((f) => isTest(f.path) && f.status !== 'deleted' && f.added.length > 0);
  if (testDiffs.length > 0 && head.kind === 'unavailable') {
    return { gate: 'red-at-base', status: 'GATE_UNAVAILABLE', findings: [{ file: '(runner)', message: `head run unavailable: ${head.reason}` }] };
  }
  const headTests = head.kind === 'completed' ? head.record.tests : [];
  const scoped = testDiffs.flatMap((f) => {
    const tests = headTests.filter((t) => t.file === f.path);
    return scopeOf(f, tests, headFile(root, f.path)) ?? tests; // no locations: every test in the file is in scope
  });
  if (scoped.length === 0 || sources.length === 0) return redAtBase({ scoped, sourceChanged: sources.length > 0, base: head });

  const pkg = packageOf(root, config);
  // The worktree has no venv: point pytest at the checkout's interpreter.
  const baseConfig: GovernorConfig = config.pytest ? { ...config, pytest: { python: path.resolve(pkg.dir, config.pytest.python) } } : config;
  const files = [...new Set(scoped.map((t) => pkg.toPackage(t.file)))];
  const links = [...new Set(['node_modules', path.posix.join(pkg.rel, 'node_modules')])];
  let outcome: RunOutcome;
  try {
    outcome = withBaseWorktree(root, base, sources, links, (wt) => runTests(baseConfig, wt, files));
  } catch (e) {
    outcome = { kind: 'unavailable', reason: `could not prepare the base worktree: ${(e as Error).message}` };
  }
  return redAtBase({ scoped, sourceChanged: true, base: outcome });
}
```

Rewrite `gateCi`'s body after the config load:

```ts
  let base: string;
  let diff: FileDiff[];
  try {
    base = ciBase(root, baseFlag);
    diff = pushDiff(root, base);
  } catch (e) {
    console.error(`governor: ${(e as Error).message}`);
    return 2;
  }
  if (process.env.GOVERNOR_OVERRIDE !== undefined) console.log('governor: GOVERNOR_OVERRIDE is ignored in CI');
  const isTestFile = picomatch(config.testGlobs);
  const head = runTests(config, root);
  const results = [
    green(head),
    redAtBaseGate(root, config, base, diff, head),
    diffAudit({ diff, isTestFile }),
    config.mutation.enabled ? mutationGate(root, config, diff) : MUTATION_DISABLED,
  ];
  return finish(root, config, results, undefined);
```

(Delete the `console.log('red-before-green: skipped in CI …')` line.)

If `config.pytest` doesn't exist on `main` (Item 2 not merged), stop. Item 2 is a prerequisite.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run test/e2e.ci.test.ts`
Expected: PASS, all tests including the pre-existing mutation case.

- [ ] **Step 5: Docs in the same task**

- `README.md`, "## Gates" table: add the row `| **red-at-base** | ci | Every test added or changed in the PR fails once the PR's source changes are reverted (run in a throwaway worktree). Passing at base blocks; an import or runtime failure at base passes with a warning (expected for tests of new code). Tests-only PRs are exempt. |`. In "## CI", replace the bullet `` `red-before-green` is skipped in CI because it needs the local ledger. The hooks are the only place it runs. `` with: `` CI does not read the local ledger. It re-derives red evidence with `red-at-base` instead, which no local process can forge. ``
- `.github/workflows/ci.yml`: replace the comment `# red-before-green is skipped in CI (it needs the local ledger); this runs green,` / `# diff-audit and, when enabled …` with `# Runs green, red-at-base (changed tests must fail against the base source), diff-audit` / `# and, when enabled in .governor/config.json, mutation.`
- `templates/governor-ci.yml`: no change is needed (it already uses `fetch-depth: 0`). Confirm.
- Spec `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` §9 G3 row: set **When** to `CI part done (2026-10, red-at-base)` and append to **Fix path**: `Done in CI: red-at-base. Remaining: local hooks still trust the ledger; a red that is only an import/runtime failure at base passes with a warning (mutation gate is the backstop); tests-only PRs are exempt.`

- [ ] **Step 6: Full gate and commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all pass. If `test/ci-template.test.ts` asserts the old comment text, update the assertion to the new text.

```bash
git add src/git.ts src/cli.ts test/e2e.ci.test.ts README.md .github/workflows/ci.yml docs/superpowers/specs/2026-09-18-tdd-governor-design.md test/ci-template.test.ts
git commit -m "feat: gate ci re-derives red evidence against the base source (G3)

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 5: Findings doc

**Files:** `docs/superpowers/specs/2026-10-01-item-1-red-at-base-findings.md`

- [ ] **Step 1: Write it.** Tag each row `test` / `code-reasoned` / `live-observed` / `deferred`. Never write Pass for something only code-reasoned.

Required rows:
- Assertion red at base passes; pass at base blocks; weak red warns; tests-only exempt: `test`
- Caller checkout and worktree list untouched; hooks not fired: `test`
- This PR's own CI run executed `red-at-base` on this repo. Paste the gate's output lines and the CI run URL: `live-observed`
- CI wall time for `gate ci` on this PR vs the previous merged PR's CI run (from `gh run list` / `gh run view`): `live-observed`, with numbers
- pytest path through `red-at-base` (python resolved against the checkout): `code-reasoned` unless you ran it. If you ran it, `live-observed`.
- Monorepo (`packageRoot`) path through `red-at-base`: `code-reasoned` or `live-observed`
- Remaining G3 surface (local hooks trust the ledger): `deferred`

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-item-1-red-at-base-findings.md
git commit -m "docs: item 1 red-at-base findings

Co-Authored-By: <your model> <noreply@anthropic.com>"
```
