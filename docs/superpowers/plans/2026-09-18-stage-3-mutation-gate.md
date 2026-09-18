# TDD Governor Stage 3 — Diff-Scoped Mutation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `git push` is blocked when a mutant on a changed source line survives the test suite (or isn't covered by it at all).

**Architecture:** A runner-neutral `Mutant` type sits between tools and the gate. `stryker.ts` runs Stryker restricted to changed files and parses its JSON report into `Mutant[]`. The pure `mutation()` gate intersects mutants with changed lines. `governor gate push` computes the push diff, and `install` adds a `pre-push` hook. The vitest reporter gets an off switch so Stryker's internal test runs don't write ledger records.

**Tech Stack:** Stage 1–2 stack, plus `@stryker-mutator/core` 10.x and `@stryker-mutator/vitest-runner` 10.x (dev deps of the governor for its integration test; dev deps of each client).

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` (§4.4, §8 Stage 3)

**Prerequisite:** Stage 2 merged.

## Global Constraints

- All Stage 1–2 constraints apply.
- Stryker's report is read from `reports/mutation/mutation.json`, and **the old report is deleted before every run**. A stale report must never be read as fresh. Track A had exactly this bug.
- The gate passes `--reporters json,clear-text` on the command line, so client Stryker configs don't need to enable the json reporter.
- Stryker runs with env `GOVERNOR_DISABLE_REPORTER=1`, and the vitest reporter no-ops when that is set.
- Block on `Survived` and `NoCoverage` only, and only on changed lines. No global score threshold.
- `mutation.enabled: false` → the gate returns `PASS` with the finding `warning: mutation gate disabled in .governor/config.json`.

## File Structure

```
src/mutation/types.ts               # Mutant
src/mutation/stryker.ts             # parseStrykerReport(json) → Mutant[] | Error ; runStryker(...)
src/gates/mutation.ts               # mutation({ mutants, changed }) → GateResult
src/git.ts                          # + pushBase(), changedLines()
src/adapters/vitest/reporter.ts     # + GOVERNOR_DISABLE_REPORTER no-op
src/cli.ts                          # + gate push; install adds pre-push
test/mutation/stryker-parse.test.ts
test/gates/mutation.test.ts
test/git.test.ts
test/stryker.integration.test.ts
test/fixtures/mutation-project/{package.json,stryker.config.json,vitest.config.ts,src/clamp.ts,tests/clamp.test.ts}
```

---

### Task 1: `Mutant` type, Stryker report parser, mutation gate

**Files:**
- Create: `src/mutation/types.ts`, `src/mutation/stryker.ts` (parser only in this task), `src/gates/mutation.ts`
- Test: `test/mutation/stryker-parse.test.ts`, `test/gates/mutation.test.ts`

**Interfaces:**
- Produces:
```ts
// src/mutation/types.ts
export interface Mutant {
  file: string;               // repo-relative
  startLine: number;
  endLine: number;
  status: 'survived' | 'no_coverage' | 'killed' | 'other';
  mutator: string;
  replacement: string;
}
// src/mutation/stryker.ts
export function parseStrykerReport(json: unknown): { ok: true; mutants: Mutant[] } | { ok: false; error: string };
// src/gates/mutation.ts
export function mutation(input: { mutants: Mutant[]; changed: Map<string, Set<number>> }): GateResult;
```

Stryker's report follows the mutation-testing-report-schema: `{ files: { [path]: { mutants: [{ mutatorName, replacement?, status, location: { start: { line }, end: { line } } }] } } }`. Paths are relative to the Stryker project root (the client repo root).

- [ ] **Step 1: Write the failing tests**

`test/mutation/stryker-parse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseStrykerReport } from '../../src/mutation/stryker.js';

const report = {
  schemaVersion: '2',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/clamp.ts': {
      language: 'typescript',
      source: '...',
      mutants: [
        { id: '1', mutatorName: 'EqualityOperator', replacement: 'x <= lo', status: 'Survived', location: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } } },
        { id: '2', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 1, column: 50 }, end: { line: 5, column: 2 } } },
        { id: '3', mutatorName: 'ConditionalExpression', status: 'NoCoverage', location: { start: { line: 3, column: 7 }, end: { line: 3, column: 13 } } },
        { id: '4', mutatorName: 'StringLiteral', replacement: '""', status: 'Timeout', location: { start: { line: 4, column: 1 }, end: { line: 4, column: 3 } } },
      ],
    },
  },
};

describe('parseStrykerReport', () => {
  it('normalises mutants', () => {
    const r = parseStrykerReport(report);
    expect(r).toEqual({
      ok: true,
      mutants: [
        { file: 'src/clamp.ts', startLine: 2, endLine: 2, status: 'survived', mutator: 'EqualityOperator', replacement: 'x <= lo' },
        { file: 'src/clamp.ts', startLine: 1, endLine: 5, status: 'killed', mutator: 'BlockStatement', replacement: '{}' },
        { file: 'src/clamp.ts', startLine: 3, endLine: 3, status: 'no_coverage', mutator: 'ConditionalExpression', replacement: '' },
        { file: 'src/clamp.ts', startLine: 4, endLine: 4, status: 'other', mutator: 'StringLiteral', replacement: '""' },
      ],
    });
  });

  it('rejects malformed reports', () => {
    expect(parseStrykerReport({ nope: true }).ok).toBe(false);
    expect(parseStrykerReport(null).ok).toBe(false);
  });
});
```

`test/gates/mutation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mutation } from '../../src/gates/mutation.js';
import type { Mutant } from '../../src/mutation/types.js';

const m = (over: Partial<Mutant>): Mutant => ({
  file: 'src/clamp.ts', startLine: 2, endLine: 2, status: 'survived', mutator: 'EqualityOperator', replacement: 'x <= lo', ...over,
});
const changed = new Map([['src/clamp.ts', new Set([2, 3])]]);

describe('mutation gate', () => {
  it('blocks a survivor on a changed line', () => {
    const r = mutation({ mutants: [m({})], changed });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: 'src/clamp.ts', line: 2, message: 'survived: EqualityOperator → x <= lo' }]);
  });

  it('blocks no-coverage on a changed line', () => {
    expect(mutation({ mutants: [m({ status: 'no_coverage', startLine: 3, endLine: 3 })], changed }).status).toBe('BLOCK');
  });

  it('counts a multi-line mutant that overlaps a changed line', () => {
    expect(mutation({ mutants: [m({ startLine: 1, endLine: 5 })], changed }).status).toBe('BLOCK');
  });

  it('ignores survivors on unchanged lines and killed mutants', () => {
    const r = mutation({ mutants: [m({ startLine: 9, endLine: 9 }), m({ status: 'killed' }), m({ status: 'other' })], changed });
    expect(r).toEqual({ gate: 'mutation', status: 'PASS', findings: [] });
  });

  it('ignores files with no changed lines', () => {
    expect(mutation({ mutants: [m({ file: 'src/other.ts' })], changed }).status).toBe('PASS');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mutation test/gates/mutation.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/mutation/types.ts`:
```ts
export interface Mutant {
  file: string;
  startLine: number;
  endLine: number;
  status: 'survived' | 'no_coverage' | 'killed' | 'other';
  mutator: string;
  replacement: string;
}
```

`src/mutation/stryker.ts` (parser part):
```ts
import { z } from 'zod';
import type { Mutant } from './types.js';

const ReportSchema = z.object({
  files: z.record(
    z.object({
      mutants: z.array(
        z.object({
          mutatorName: z.string(),
          replacement: z.string().optional(),
          status: z.string(),
          location: z.object({ start: z.object({ line: z.number() }), end: z.object({ line: z.number() }) }),
        }),
      ),
    }),
  ),
});

const STATUS: Record<string, Mutant['status']> = { Survived: 'survived', NoCoverage: 'no_coverage', Killed: 'killed' };

export function parseStrykerReport(json: unknown): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `unrecognised Stryker report: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const mutants = Object.entries(parsed.data.files).flatMap(([file, f]) =>
    f.mutants.map((mu) => ({
      file,
      startLine: mu.location.start.line,
      endLine: mu.location.end.line,
      status: STATUS[mu.status] ?? 'other',
      mutator: mu.mutatorName,
      replacement: mu.replacement ?? '',
    })),
  );
  return { ok: true, mutants };
}
```

`src/gates/mutation.ts`:
```ts
import type { Mutant } from '../mutation/types.js';
import type { Finding, GateResult } from '../types.js';

export function mutation(input: { mutants: Mutant[]; changed: Map<string, Set<number>> }): GateResult {
  const findings: Finding[] = [];
  for (const mu of input.mutants) {
    if (mu.status !== 'survived' && mu.status !== 'no_coverage') continue;
    const lines = input.changed.get(mu.file);
    if (!lines) continue;
    let hit: number | undefined;
    for (let l = mu.startLine; l <= mu.endLine; l++) {
      if (lines.has(l)) {
        hit = l;
        break;
      }
    }
    if (hit === undefined) continue;
    const label = mu.status === 'survived' ? 'survived' : 'not covered by any test';
    findings.push({ file: mu.file, line: hit, message: `${label}: ${mu.mutator} → ${mu.replacement}` });
  }
  return { gate: 'mutation', status: findings.length > 0 ? 'BLOCK' : 'PASS', findings };
}
```

The no-coverage message differs from the survived one. Update the no-coverage test assertion if you choose to assert on its message; the test above only checks status.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mutation test/gates/mutation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mutation src/gates/mutation.ts test/mutation test/gates/mutation.test.ts
git commit -m "feat: runner-neutral mutants, Stryker report parser, diff-scoped mutation gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Push diff helpers

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Produces:
  - `pushBase(root: string, base = 'main'): string`: `@{upstream}` sha if the branch has an upstream, else `merge-base HEAD <base>`.
  - `changedLines(diff: FileDiff[], include: (path: string) => boolean): Map<string, Set<number>>`: added line numbers per included, non-deleted file. Pure.
  - `pushDiff(root: string, baseSha: string): FileDiff[]`: parses `git diff -U0 --no-color --no-renames --no-ext-diff <baseSha>..HEAD`.

- [ ] **Step 1: Write the failing test**

`test/git.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../src/diff.js';
import { changedLines, pushBase, pushDiff } from '../src/git.js';

describe('changedLines', () => {
  it('collects added lines for included, non-deleted files', () => {
    const diff: FileDiff[] = [
      { path: 'src/a.ts', status: 'modified', added: [{ line: 2, text: 'x' }, { line: 5, text: 'y' }], removed: [] },
      { path: 'tests/a.test.ts', status: 'modified', added: [{ line: 1, text: 'z' }], removed: [] },
      { path: 'src/gone.ts', status: 'deleted', added: [], removed: [{ line: 1, text: 'q' }] },
    ];
    const map = changedLines(diff, (p) => p.startsWith('src/') && !p.endsWith('.test.ts'));
    expect([...map.entries()].map(([k, v]) => [k, [...v]])).toEqual([['src/a.ts', [2, 5]]]);
  });
});

describe('pushBase / pushDiff', () => {
  it('falls back to merge-base with main when there is no upstream', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
    g('commit', '-qam', 'change');
    expect(pushBase(root)).toBe(base);
    expect(pushDiff(root, base)[0]!.added).toEqual([{ line: 2, text: 'two' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL, `changedLines` / `pushBase` / `pushDiff` not exported.

- [ ] **Step 3: Implement (append to `src/git.ts`)**

```ts
export function pushBase(root: string, base = 'main'): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']).trim();
  } catch {
    return git(root, ['merge-base', 'HEAD', base]).trim();
  }
}

export function pushDiff(root: string, baseSha: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', `${baseSha}..HEAD`]));
}

export function changedLines(diff: FileDiff[], include: (path: string) => boolean): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of diff) {
    if (f.status === 'deleted' || f.added.length === 0 || !include(f.path)) continue;
    map.set(f.path, new Set(f.added.map((a) => a.line)));
  }
  return map;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/git.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: push base and changed-line helpers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Run Stryker for real, with the reporter switched off

**Files:**
- Modify: `src/mutation/stryker.ts` (add `runStryker`), `src/adapters/vitest/reporter.ts` (off switch), `package.json` (dev deps)
- Create: `test/fixtures/mutation-project/package.json`, `test/fixtures/mutation-project/stryker.config.json`, `test/fixtures/mutation-project/vitest.config.ts`, `test/fixtures/mutation-project/src/clamp.ts`, `test/fixtures/mutation-project/tests/clamp.test.ts`
- Test: `test/stryker.integration.test.ts`

**Interfaces:**
- Produces: `runStryker(root: string, files: string[], timeoutMs: number): { ok: true; mutants: Mutant[] } | { ok: false; error: string }`.
  - Deletes `<root>/reports/mutation/mutation.json` first.
  - Spawns `npx --no-install stryker run --mutate <files joined by ','> --reporters json,clear-text` in `root`, with `GOVERNOR_DISABLE_REPORTER=1`, `stdio: 'inherit'`, and the given timeout.
  - Timeout, spawn error, non-zero exit, or missing report → `{ ok: false }`. Otherwise it parses with `parseStrykerReport`.

- [ ] **Step 1: Add dev dependencies**

```bash
npm install -D @stryker-mutator/core@^10 @stryker-mutator/vitest-runner@^10
```

- [ ] **Step 2: Create the fixture project**

The test in this fixture is deliberately weak: it runs `clamp` but never checks the upper bound, so the `>` mutant on the upper-bound branch survives.

`test/fixtures/mutation-project/package.json`:
```json
{ "name": "mutation-fixture", "private": true, "type": "module" }
```

`test/fixtures/mutation-project/stryker.config.json`:
```json
{
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.config.ts" },
  "coverageAnalysis": "perTest",
  "tempDirName": ".stryker-tmp"
}
```

`test/fixtures/mutation-project/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`test/fixtures/mutation-project/src/clamp.ts`:
```ts
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
```

`test/fixtures/mutation-project/tests/clamp.test.ts`:
```ts
import { expect, it } from 'vitest';
import { clamp } from '../src/clamp.js';

it('clamps low values', () => {
  expect(clamp(-5, 0, 10)).toBe(0);
});

it('keeps values in range', () => {
  expect(clamp(5, 0, 10)).toBe(5);
});
```

The fixture sits under `test/fixtures/`, which the governor's own `vitest.config.ts` already excludes. Stryker resolves its plugins from the governor's `node_modules` by walking up from the fixture.

- [ ] **Step 3: Write the failing integration test**

`test/stryker.integration.test.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutation } from '../src/gates/mutation.js';
import { runStryker } from '../src/mutation/stryker.js';

const fixture = path.resolve(__dirname, 'fixtures/mutation-project');

describe('runStryker (real Stryker)', () => {
  it('finds the surviving upper-bound mutant, and the gate blocks it', () => {
    // Plant a stale report: it must be deleted, never read.
    mkdirSync(path.join(fixture, 'reports/mutation'), { recursive: true });
    writeFileSync(path.join(fixture, 'reports/mutation/mutation.json'), '{"files":{}}');

    const result = runStryker(fixture, ['src/clamp.ts'], 300_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mutants.length).toBeGreaterThan(0);
    expect(result.mutants.some((m) => m.startLine === 3 && m.status !== 'killed')).toBe(true);

    const gate = mutation({ mutants: result.mutants, changed: new Map([['src/clamp.ts', new Set([3])]]) });
    expect(gate.status).toBe('BLOCK');
  }, 300_000);

  it('fails closed when Stryker is not configured', () => {
    const result = runStryker(path.resolve(__dirname, 'fixtures/no-reporter'), ['ok.test.ts'], 60_000);
    expect(result.ok).toBe(false);
    expect(existsSync(path.resolve(__dirname, 'fixtures/no-reporter/reports/mutation/mutation.json'))).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/stryker.integration.test.ts`
Expected: FAIL, `runStryker` is not exported.

- [ ] **Step 5: Implement `runStryker`**

Append to `src/mutation/stryker.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export function runStryker(
  root: string,
  files: string[],
  timeoutMs: number,
): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  const reportFile = path.join(root, 'reports', 'mutation', 'mutation.json');
  rmSync(reportFile, { force: true }); // never read a stale report
  const res = spawnSync('npx', ['--no-install', 'stryker', 'run', '--mutate', files.join(','), '--reporters', 'json,clear-text'], {
    cwd: root,
    env: { ...process.env, GOVERNOR_DISABLE_REPORTER: '1' },
    stdio: 'inherit',
    timeout: timeoutMs,
  });
  if (res.error) return { ok: false, error: `stryker did not run: ${res.error.message}` };
  if (res.signal) return { ok: false, error: `stryker killed by ${res.signal}` };
  if (res.status !== 0) return { ok: false, error: `stryker exited ${res.status}` };
  if (!existsSync(reportFile)) return { ok: false, error: 'stryker wrote no reports/mutation/mutation.json' };
  try {
    return parseStrykerReport(JSON.parse(readFileSync(reportFile, 'utf8')));
  } catch (e) {
    return { ok: false, error: `unreadable Stryker report: ${(e as Error).message}` };
  }
}
```
Merge the imports into the file's existing import block. Don't leave imports below code.

- [ ] **Step 6: Add the reporter off switch**

In `src/adapters/vitest/reporter.ts`, first line of `onTestRunEnd`:
```ts
    if (process.env.GOVERNOR_DISABLE_REPORTER) return; // Stryker's internal runs must not pollute the ledger
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/stryker.integration.test.ts`
Expected: PASS, 2 tests. The first may take 30–120s.

If the line-3 mutant is `Killed`, the fixture test is stronger than intended. Check that `tests/clamp.test.ts` exactly matches Step 2. Do not change the assertion.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/mutation/stryker.ts src/adapters/vitest/reporter.ts test/fixtures/mutation-project test/stryker.integration.test.ts
git commit -m "feat: run Stryker on changed files, never reading stale reports

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `governor gate push` and the pre-push hook

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/e2e.commit.test.ts` → no change. Add `test/e2e.push.test.ts`.

**Interfaces:**
- Consumes: `pushBase`, `pushDiff`, `changedLines`, `runStryker`, `mutation`, `finish` (existing in `cli.ts`).
- Produces: `governor gate push`. `install` now writes both hooks:
  `[{ name: 'pre-commit', command: 'gate commit' }, { name: 'pre-push', command: 'gate push' }]`.

- [ ] **Step 1: Write the failing e2e test**

`test/e2e.push.test.ts`:
```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const governorRoot = path.resolve(__dirname, '..');
const cli = path.join(governorRoot, 'dist', 'cli.js');

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: governorRoot, stdio: 'pipe' });
});

describe('governor gate push (e2e)', () => {
  it('blocks a push whose changed line has a surviving mutant', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-push-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    cpSync(path.resolve(__dirname, 'fixtures/mutation-project'), root, { recursive: true });
    symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'node_modules'));
    mkdirSync(path.join(root, '.governor'), { recursive: true });
    writeFileSync(path.join(root, '.governor/config.json'), JSON.stringify({
      adapter: 'vitest', testGlobs: ['tests/**/*.test.ts'], sourceGlobs: ['src/**/*.ts'],
      mutation: { enabled: true, timeoutMs: 300000 }, runTimeoutMs: 120000,
    }));
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\nreports\n.stryker-tmp\n');
    // Base commit: clamp without the upper bound.
    writeFileSync(path.join(root, 'src/clamp.ts'), 'export function clamp(x: number, lo: number, hi: number): number {\n  if (x < lo) return lo;\n  return x;\n}\n');
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'e@example.com');
    g('config', 'user.name', 'e');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'base');
    const remote = mkdtempSync(path.join(tmpdir(), 'gov-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    g('remote', 'add', 'origin', remote);
    g('push', '-q', '-u', 'origin', 'main');
    execFileSync('node', [cli, 'install'], { cwd: root });

    // Change: add the upper bound, without a test for it.
    cpSync(path.resolve(__dirname, 'fixtures/mutation-project/src/clamp.ts'), path.join(root, 'src/clamp.ts'));
    g('commit', '-q', '--no-verify', '-am', 'upper bound');

    const res = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: root, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/\[BLOCK\] mutation[\s\S]*src\/clamp\.ts:3/);
  }, 300_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/e2e.push.test.ts`
Expected: FAIL. The push succeeds (no pre-push hook) or `gate push` prints usage.

- [ ] **Step 3: Implement `gate push`**

In `src/cli.ts`:

1. Add imports: `import { mutation } from './gates/mutation.js';`, `import { runStryker } from './mutation/stryker.js';`, and extend the git import to `import { changedLines, evidenceSince, pushBase, pushDiff, repoRoot, stagedDiff } from './git.js';`.
2. Add the function:
```ts
function gatePush(root: string): number {
  const loaded = loadConfig(root);
  if (!loaded.ok) {
    console.log(formatResults([{ gate: 'mutation', status: 'GATE_UNAVAILABLE', findings: [{ file: '.governor/config.json', message: loaded.error }] }]));
    return 1;
  }
  const { config } = loaded;
  if (!config.mutation.enabled) {
    return finish(root, config, [{ gate: 'mutation', status: 'PASS', findings: [{ file: '.governor/config.json', message: 'warning: mutation gate disabled in .governor/config.json' }] }]);
  }
  const isSource = picomatch(config.sourceGlobs);
  const isTest = picomatch(config.testGlobs);
  let base: string;
  try {
    base = pushBase(root);
  } catch (e) {
    console.error(`governor: cannot determine push base: ${(e as Error).message}`);
    return 2;
  }
  const changed = changedLines(pushDiff(root, base), (p) => isSource(p) && !isTest(p));
  if (changed.size === 0) return finish(root, config, [{ gate: 'mutation', status: 'PASS', findings: [] }]);

  const run = config.adapter === 'vitest'
    ? runStryker(root, [...changed.keys()], config.mutation.timeoutMs)
    : { ok: false as const, error: `mutation for adapter '${config.adapter}' is not implemented yet` };
  const result = run.ok
    ? mutation({ mutants: run.mutants, changed })
    : { gate: 'mutation' as const, status: 'GATE_UNAVAILABLE' as const, findings: [{ file: '(mutation)', message: run.error }] };
  return finish(root, config, [result]);
}
```
3. In `main`: add `if (command === 'gate' && rest[0] === 'push') return gatePush(root);` next to the `gate commit` branch. Change the `installHooks` call's hook list to include `{ name: 'pre-push', command: 'gate push' }`. Update `USAGE` to `'usage: governor <run | gate commit | gate push | install>'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/e2e.push.test.ts test/e2e.commit.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification gate, then commit through the governor's own hooks**

```bash
npx tsc --noEmit && npm test && npm run build
node dist/cli.js install   # re-run: adds pre-push to the dogfood repo
git add src/cli.ts test/e2e.push.test.ts
git commit -m "feat: governor gate push with pre-push hook

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Onboard mutation in BigBadPlayground

Work in `/Volumes/BigBadDrive_1/BigBadPlayground` on a new branch off `main` (after Stage 2's onboarding is merged). Follow its CLAUDE.md (trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`).

**Files (BigBadPlayground):** `package.json`, `stryker.config.json`, `.gitignore`

- [ ] **Step 1: Install and configure**

```bash
git checkout main && git pull --ff-only && git checkout -b chore/tdd-governor-mutation
npm install -D @stryker-mutator/core@^10 @stryker-mutator/vitest-runner@^10
```

`stryker.config.json`:
```json
{
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.config.ts" },
  "coverageAnalysis": "perTest",
  "tempDirName": ".stryker-tmp",
  "ignorePatterns": [".next", "data", "public"]
}
```

Append to `.gitignore`: `reports/` and `.stryker-tmp/`.

```bash
node ../tdd-governor/dist/cli.js install
```
Expected: `installed pre-push → governor gate push`.

- [ ] **Step 2: Measure a full mutation run on one pure module**

```bash
time npx stryker run --mutate src/lab-runtime/resources.ts --reporters json,clear-text
```
Record the wall time and mutation score in the findings doc (`live-observed`). This sets expectations for push latency. If one module takes over 5 minutes, raise `mutation.timeoutMs` and note it.

- [ ] **Step 3: Verification gate**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: passes, `Generating static pages (5/5)`.

- [ ] **Step 4: Commit and push (live acceptance)**

```bash
git add package.json package-lock.json stryker.config.json .gitignore
git commit -m "chore: diff-scoped mutation gate on push

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push -u origin chore/tdd-governor-mutation
```
The push goes through `gate push`. No `src/` lines changed, so expect `[PASS] mutation`.

Then a deliberate probe on a throwaway branch: add an untested branch to a pure function in `src/lab-runtime/`, commit (with a valid red/green test for a *different* line, so the commit gate passes), and `git push`. Expected: `[BLOCK] mutation` naming the untested line. Delete the probe branch locally and remotely afterwards. Record the output as `live-observed`.

---

### Task 6: Stage 3 findings doc

**Files (tdd-governor):** `docs/superpowers/specs/<date>-stage-3-findings.md`

- [ ] **Step 1: Write it**

Required rows:
- Stale report is never read: `test` (stryker.integration)
- Survivor on changed line blocks push: `test` (e2e.push) + `live-observed` (BigBadPlayground probe)
- Unchanged-line survivors ignored: `test` (gate unit)
- Stryker missing/misconfigured → GATE_UNAVAILABLE: `test`
- Stryker's internal vitest runs don't write ledger records: check the ledger line count before and after a push. `live-observed`.
- Push wall time for a typical one-module change: `live-observed`, with the number.
- Carried forward: G1–G8. Note that G1 (CI mirror) is now unblocked: `governor gate commit` + `gate push` in a workflow file.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/*-stage-3-findings.md
git commit -m "docs: stage 3 findings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
