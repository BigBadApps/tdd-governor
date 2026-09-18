# TDD Governor Stage 4 — pytest Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BigBadPhotos (pytest) gets the same commit and push gates as BigBadPlayground: every pytest run is recorded and classified, and `gate commit` / `gate push` work unchanged on top.

**Architecture:** A single-file pytest plugin (`python/tdd_governor_pytest.py`) mirrors the vitest reporter. It writes one `LedgerRecord` per session in the same JSON shape. The TS side gains `runPytest` (sharing a `runAndCollect` helper with `runVitest`), a `pytest.python` config field, and a mutmut → `Mutant[]` adapter for the push gate. Gates don't change: they're already runner-neutral.

**Tech Stack:** Stages 1–3, plus Python ≥ 3.11, pytest ≥ 8, pytest-timeout, mutmut 3.x (3.8.0 current as of 2026-09-18).

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` (§2, §3, §4.2, §8 Stage 4)

**Prerequisite:** Stage 3 merged.

## Global Constraints

- All Stage 1–3 constraints apply.
- The plugin writes exactly the Stage 1 `LedgerRecord` shape (`v: 1`, same field names). `readLedger`'s Zod schema is the contract. The TS integration test reads plugin output through it.
- `at` must be ISO-8601 UTC with milliseconds and a `Z` suffix (`2026-09-18T01:00:00.000Z`), so string comparison against `evidenceSince` stays valid.
- Plugin `file` paths are relative to the **git toplevel**, not pytest's rootdir. They must match `git diff` paths.
- Test id: `` `${file} > ${domain with '.' replaced by ' > '}` `` where `domain` is `item.location[2]` (e.g. `TestScore.test_zero` → `TestScore > test_zero`).
- Classification: `AssertionError` → `assertion`. pytest-timeout (`Failed`, message starting `Timeout`) → `timeout`. Other `Failed` (`pytest.fail`) → `unknown`. Any other exception type → `runtime_error`. A setup (fixture) failure → `runtime_error`.
- The plugin no-ops when `GOVERNOR_DISABLE_REPORTER` is set (mutmut runs).
- Client repos load the plugin through a guarded import in their root `conftest.py`, so environments without the governor (CI, Docker) are unaffected.
- The governor's own Python test env lives at `.venv-py/` (gitignored). Integration tests use `process.env.GOVERNOR_TEST_PYTHON ?? '<repo>/.venv-py/bin/python'` and **fail** (not skip) if it's missing.

## File Structure

```
python/tdd_governor_pytest.py          # the plugin
python/pyproject.toml                  # so clients can `pip install -e ../tdd-governor/python`
src/config.ts                          # + pytest.python, required when adapter === 'pytest'
src/adapters/run-and-collect.ts        # shared spawn → find-record-by-runId
src/adapters/vitest/run.ts             # refactored onto run-and-collect
src/adapters/pytest/run.ts             # runPytest
src/mutation/mutmut.ts                 # runMutmut + parseMutmut → Mutant[]
src/cli.ts                             # adapter dispatch for run/gate commit/gate push
test/config.test.ts                    # + pytest cases
test/pytest-plugin.integration.test.ts
test/mutmut.integration.test.ts
test/fixtures/pytest-project/{test_cases.py,test_import_error.py,calc.py}
test/fixtures/mutmut-project/{pyproject.toml,src/clamp.py,tests/test_clamp.py}
```

---

### Task 1: pytest config field

**Files:**
- Modify: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `GovernorConfig` gains `pytest?: { python: string }` (a path relative to the repo root, or absolute). The schema rejects `adapter: 'pytest'` without `pytest.python`.

- [ ] **Step 1: Write the failing tests** (append to `test/config.test.ts`)

```ts
describe('loadConfig pytest', () => {
  it('requires pytest.python for the pytest adapter', () => {
    const result = loadConfig(repoWith(JSON.stringify({ ...valid, adapter: 'pytest' })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pytest\.python/);
  });

  it('accepts a pytest config with a python path', () => {
    const cfg = { ...valid, adapter: 'pytest', pytest: { python: '.venv/bin/python' } };
    expect(loadConfig(repoWith(JSON.stringify(cfg)))).toEqual({ ok: true, config: cfg });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL. The first new test fails because the config loads fine, and the second fails because `.strict()` rejects the `pytest` key.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace the schema with:
```ts
export const ConfigSchema = z
  .object({
    adapter: z.enum(['vitest', 'pytest']),
    testGlobs: z.array(z.string().min(1)).min(1),
    sourceGlobs: z.array(z.string().min(1)).min(1),
    mutation: z.object({ enabled: z.boolean(), timeoutMs: z.number().int().positive() }),
    runTimeoutMs: z.number().int().positive(),
    pytest: z.object({ python: z.string().min(1) }).strict().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.adapter === 'pytest' && !c.pytest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pytest', 'python'], message: 'required when adapter is pytest' });
    }
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: pytest.python config for the pytest adapter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The pytest plugin, verified against real pytest

**Files:**
- Create: `python/tdd_governor_pytest.py`, `python/pyproject.toml`
- Create: `test/fixtures/pytest-project/calc.py`, `test/fixtures/pytest-project/test_cases.py`, `test/fixtures/pytest-project/test_import_error.py`
- Test: `test/pytest-plugin.integration.test.ts`
- Modify: `.gitignore` (add `.venv-py/`, `__pycache__/`, `.pytest_cache/`, `mutants/`)

**Interfaces:**
- Produces: a pytest plugin module `tdd_governor_pytest` that appends one ledger record per session.

- [ ] **Step 1: Create the Python env**

```bash
python3 -m venv .venv-py
.venv-py/bin/pip install "pytest>=8" pytest-timeout "mutmut>=3.8,<4"
```

- [ ] **Step 2: Create the fixture project**

`test/fixtures/pytest-project/calc.py`:
```python
def add(a, b):
    return a - b  # deliberately wrong: valid red

not_a_function = 42
```

`test/fixtures/pytest-project/test_cases.py`:
```python
import time

import pytest

import calc


def test_adds():
    assert calc.add(2, 3) == 5


def test_passes():
    assert 1 == 1


def test_calls_missing_function():
    calc.not_a_function()


@pytest.mark.timeout(0.2)
def test_times_out():
    time.sleep(2)


@pytest.mark.skip(reason="fixture")
def test_skipped():
    pass


class TestGroup:
    def test_in_class(self):
        assert calc.add(1, 1) == 2
```

`test/fixtures/pytest-project/test_import_error.py`:
```python
from does_not_exist import missing  # deliberate collection error


def test_never_runs():
    missing()
```

- [ ] **Step 3: Write the failing integration test**

`test/pytest-plugin.integration.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readLedger } from '../src/ledger.js';
import type { LedgerRecord } from '../src/types.js';

const repo = path.resolve(__dirname, '..');
const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');
const fixture = path.join(repo, 'test/fixtures/pytest-project');
const F = 'test/fixtures/pytest-project/test_cases.py';
let record: LedgerRecord;

beforeAll(() => {
  expect(existsSync(python), `python env missing at ${python}; see Stage 4 Task 2 Step 1`).toBe(true);
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-py-')), 'ledger.jsonl');
  const res = spawnSync(python, ['-m', 'pytest', '-p', 'tdd_governor_pytest', '-q', fixture], {
    cwd: fixture,
    env: { ...process.env, PYTHONPATH: path.join(repo, 'python'), GOVERNOR_LEDGER_PATH: ledger, GOVERNOR_RUN_ID: 'py-run' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(res.status).not.toBe(0);
  const { records, corrupt } = readLedger(ledger);
  expect(corrupt).toBe(0); // the plugin's output must satisfy the TS schema
  expect(records).toHaveLength(1);
  record = records[0]!;
});

const byId = (id: string) => record.tests.find((t) => t.id === id);

describe('tdd_governor_pytest against real pytest', () => {
  it('writes run metadata', () => {
    expect(record).toMatchObject({ runId: 'py-run', adapter: 'pytest', v: 1 });
    expect(record.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('classifies an assertion red with git-relative path and line', () => {
    expect(byId(`${F} > test_adds`)).toMatchObject({ file: F, line: 8, status: 'fail', failureKind: 'assertion' });
  });

  it('classifies TypeError as runtime_error and timeouts as timeout', () => {
    expect(byId(`${F} > test_calls_missing_function`)?.failureKind).toBe('runtime_error');
    expect(byId(`${F} > test_times_out`)?.failureKind).toBe('timeout');
  });

  it('records passes, skips, and class-scoped ids', () => {
    expect(byId(`${F} > test_passes`)?.status).toBe('pass');
    expect(byId(`${F} > test_skipped`)?.status).toBe('skip');
    expect(byId(`${F} > TestGroup > test_in_class`)?.status).toBe('fail');
  });

  it('records the import failure as a collection error', () => {
    expect(record.collectionErrors).toEqual([
      { file: 'test/fixtures/pytest-project/test_import_error.py', message: expect.stringMatching(/does_not_exist/) },
    ]);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/pytest-plugin.integration.test.ts`
Expected: FAIL. pytest errors with `ImportError: No module named 'tdd_governor_pytest'`, and no record is written.

- [ ] **Step 5: Implement the plugin**

`python/tdd_governor_pytest.py`:
```python
"""tdd-governor pytest plugin: appends one ledger record per pytest session.

Enable it in a client's root conftest.py (guarded, so CI without the governor still works):

    try:
        import tdd_governor_pytest  # noqa: F401
        pytest_plugins = ["tdd_governor_pytest"]
    except ImportError:
        pass
"""
from __future__ import annotations

import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest


def classify(typename: str | None, message: str) -> str:
    # Mirrors src/classify.ts: structured exception type only, never scanned output.
    if typename == "AssertionError":
        return "assertion"
    if typename == "Failed":
        return "timeout" if message.startswith("Timeout") else "unknown"
    return "runtime_error" if typename else "unknown"


def _first_line(text: str | None) -> str:
    return (text or "").strip().split("\n")[0][:300]


def _git(root: Path, *args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


class _Recorder:
    def __init__(self, rootpath: Path) -> None:
        self.git_root = Path(_git(rootpath, "rev-parse", "--show-toplevel") or rootpath)
        self.tests: dict[str, dict] = {}
        self.collection_errors: list[dict] = []

    def _rel(self, path: Path) -> str:
        return os.path.relpath(path, self.git_root).replace(os.sep, "/")

    def pytest_collectreport(self, report):
        if report.failed:
            lines = [l for l in str(report.longrepr).splitlines() if l.strip()]
            path = getattr(report, "path", None) or Path(report.nodeid.split("::")[0] or ".")
            self.collection_errors.append({"file": self._rel(Path(path)), "message": _first_line(lines[-1] if lines else "")})

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_makereport(self, item, call):
        outcome = yield
        rep = outcome.get_result()
        if rep.when == "teardown" or (rep.when == "setup" and rep.passed):
            return
        file = self._rel(item.path)
        domain = item.location[2]
        entry = {"id": f"{file} > {domain.replace('.', ' > ')}", "file": file, "line": item.location[1] + 1}
        if rep.passed:
            entry["status"] = "pass"
        elif rep.skipped:
            entry["status"] = "skip"
        else:
            entry["status"] = "fail"
            excinfo = call.excinfo
            message = str(excinfo.value) if excinfo else rep.longreprtext
            entry["failureKind"] = "runtime_error" if rep.when == "setup" else classify(excinfo.typename if excinfo else None, message)
            entry["message"] = _first_line(message)
        self.tests[item.nodeid] = entry

    def pytest_sessionfinish(self, session, exitstatus):
        if os.environ.get("GOVERNOR_DISABLE_REPORTER"):
            return
        record = {
            "v": 1,
            "runId": os.environ.get("GOVERNOR_RUN_ID") or str(uuid.uuid4()),
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "head": _git(self.git_root, "rev-parse", "HEAD") or "none",
            "adapter": "pytest",
            "exitCode": int(exitstatus),
            "collectionErrors": self.collection_errors,
            "tests": list(self.tests.values()),
        }
        ledger = Path(os.environ.get("GOVERNOR_LEDGER_PATH") or self.git_root / ".governor" / "ledger.jsonl")
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")


def pytest_configure(config):
    config.pluginmanager.register(_Recorder(Path(str(config.rootpath))), "tdd-governor-recorder")
```

`python/pyproject.toml`:
```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "tdd-governor-pytest"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["pytest>=8"]

[tool.setuptools]
py-modules = ["tdd_governor_pytest"]
```

Append to `.gitignore`: `.venv-py/`, `__pycache__/`, `.pytest_cache/`, `mutants/`.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/pytest-plugin.integration.test.ts`
Expected: PASS, 5 tests.

If `line` is off by one, or collection errors carry the wrong path, inspect the tmp ledger and fix the plugin from the real record. Never edit the expectations to fit.

- [ ] **Step 7: Commit**

```bash
git add python .gitignore test/fixtures/pytest-project test/pytest-plugin.integration.test.ts
git commit -m "feat: pytest plugin writes classified ledger records

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `runPytest` and adapter dispatch

**Files:**
- Create: `src/adapters/run-and-collect.ts`, `src/adapters/pytest/run.ts`
- Modify: `src/adapters/vitest/run.ts` (use the shared helper), `src/cli.ts` (`runTests` dispatch)
- Test: `test/cli-run.integration.test.ts` (add a pytest case)

**Interfaces:**
- Produces:
  - `runAndCollect(opts: { root: string; command: string; args: string[]; env?: Record<string, string>; timeoutMs: number; label: string; missingRecordHint: string }): RunOutcome`. This is Stage 1's `runVitest` body, parameterised.
  - `runVitest(root, timeoutMs, extraArgs)`: same signature as before, now delegates.
  - `runPytest(root: string, python: string, timeoutMs: number, extraArgs?: string[]): RunOutcome`. Runs `<python> -m pytest ...extraArgs` in `root`. `python` resolves relative to `root`.

- [ ] **Step 1: Write the failing test** (append to `test/cli-run.integration.test.ts`)

```ts
import { runPytest } from '../src/adapters/pytest/run.js';

describe('runPytest', () => {
  const repo = path.resolve(__dirname, '..');
  const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');

  it('is unavailable when the plugin is not loaded', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp-')), 'l.jsonl');
    const outcome = runPytest(path.join(repo, 'test/fixtures/pytest-project'), python, 60_000, ['-q', 'test_cases.py']);
    expect(outcome).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/conftest/) });
  });

  it('returns the record when the plugin is loaded', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp2-')), 'l.jsonl');
    process.env.PYTHONPATH = path.join(repo, 'python');
    try {
      const outcome = runPytest(path.join(repo, 'test/fixtures/pytest-project'), python, 60_000, ['-q', '-p', 'tdd_governor_pytest', 'test_cases.py']);
      expect(outcome.kind).toBe('completed');
    } finally {
      delete process.env.PYTHONPATH;
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli-run.integration.test.ts`
Expected: FAIL, `../src/adapters/pytest/run.js` not found.

- [ ] **Step 3: Implement**

`src/adapters/run-and-collect.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ledgerPath, readLedger } from '../ledger.js';
import type { RunOutcome } from '../types.js';

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
  const res = spawnSync(opts.command, opts.args, {
    cwd: opts.root,
    env: { ...process.env, ...opts.env, GOVERNOR_RUN_ID: runId },
    stdio: 'inherit',
    timeout: opts.timeoutMs,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { kind: 'unavailable', reason: `${opts.label} timed out after ${opts.timeoutMs}ms` };
  }
  if (res.error) return { kind: 'unavailable', reason: `could not start ${opts.label}: ${res.error.message}` };
  if (res.signal) return { kind: 'unavailable', reason: `${opts.label} killed by ${res.signal}` };
  const record = readLedger(ledgerPath(opts.root)).records.find((r) => r.runId === runId);
  if (!record) return { kind: 'unavailable', reason: `${opts.label} ran but wrote no ledger record: ${opts.missingRecordHint}` };
  return { kind: 'completed', record };
}
```

`src/adapters/vitest/run.ts` (replace body):
```ts
import type { RunOutcome } from '../../types.js';
import { runAndCollect } from '../run-and-collect.js';

export function runVitest(root: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  return runAndCollect({
    root,
    command: 'npx',
    args: ['--no-install', 'vitest', 'run', '--root', root, ...extraArgs],
    timeoutMs,
    label: 'vitest',
    missingRecordHint: "add 'tdd-governor/vitest-reporter' to test.reporters and set includeTaskLocation: true",
  });
}
```

`src/adapters/pytest/run.ts`:
```ts
import path from 'node:path';
import type { RunOutcome } from '../../types.js';
import { runAndCollect } from '../run-and-collect.js';

export function runPytest(root: string, python: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  return runAndCollect({
    root,
    command: path.resolve(root, python),
    args: ['-m', 'pytest', ...extraArgs],
    timeoutMs,
    label: 'pytest',
    missingRecordHint: 'load the plugin from the root conftest.py (guarded import of tdd_governor_pytest) and pip install -e <tdd-governor>/python',
  });
}
```

In `src/cli.ts`, change `runTests`:
```ts
function runTests(config: GovernorConfig, root: string, extraArgs: string[] = []): RunOutcome {
  if (config.adapter === 'vitest') return runVitest(root, config.runTimeoutMs, extraArgs);
  return runPytest(root, config.pytest!.python, config.runTimeoutMs, extraArgs);
}
```
(`config.pytest` is guaranteed by the schema's `superRefine` when `adapter === 'pytest'`.) Add `import { runPytest } from './adapters/pytest/run.js';`.

- [ ] **Step 4: Run to verify pass, and confirm no vitest regression**

Run: `npx vitest run test/cli-run.integration.test.ts test/e2e.commit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters src/cli.ts test/cli-run.integration.test.ts
git commit -m "feat: pytest adapter via shared run-and-collect

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: mutmut → `Mutant[]` (real-output first)

mutmut 3.x names mutants per function (`module.x_func__mutmut_N`), and its line-level output isn't documented as a stable machine format. This task therefore **captures real output first** and builds the parser against it, the same approach as Stage 1's reporter.

**Files:**
- Create: `test/fixtures/mutmut-project/pyproject.toml`, `test/fixtures/mutmut-project/src/clamp.py`, `test/fixtures/mutmut-project/tests/test_clamp.py`
- Create: `src/mutation/mutmut.ts`, `test/fixtures/mutmut-output/` (captured real output), `test/mutmut.integration.test.ts`
- Modify: `src/cli.ts` (`gatePush` dispatch)

**Interfaces:**
- Produces: `runMutmut(root: string, python: string, files: string[], timeoutMs: number): { ok: true; mutants: Mutant[] } | { ok: false; error: string }`. Same contract as `runStryker`: fail closed, env `GOVERNOR_DISABLE_REPORTER=1`, and never read results from a previous run (delete `<root>/mutants/` first).

- [ ] **Step 1: Create the fixture (same weak-test shape as Stage 3)**

`test/fixtures/mutmut-project/pyproject.toml`:
```toml
[tool.mutmut]
paths_to_mutate = ["src/"]
tests_dir = ["tests/"]
```

`test/fixtures/mutmut-project/src/clamp.py`:
```python
def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x
```

`test/fixtures/mutmut-project/tests/test_clamp.py`:
```python
from src.clamp import clamp


def test_clamps_low():
    assert clamp(-5, 0, 10) == 0


def test_in_range():
    assert clamp(5, 0, 10) == 5
```

- [ ] **Step 2: Capture real mutmut output**

```bash
cd test/fixtures/mutmut-project
rm -rf mutants
GOVERNOR_DISABLE_REPORTER=1 ../../../.venv-py/bin/mutmut run
mkdir -p ../mutmut-output
../../../.venv-py/bin/mutmut results --all true > ../mutmut-output/results.txt || ../../../.venv-py/bin/mutmut results > ../mutmut-output/results.txt
```
Then, for **each surviving mutant name** in `results.txt`:
```bash
../../../.venv-py/bin/mutmut show <name> > ../mutmut-output/show-<name>.diff
```
Add `mutants/` inside the fixture to `.gitignore` (the root `mutants/` entry already covers it).

**Decision point.** Open the `show-*.diff` files.
- **If they are unified diffs with `@@ -N` hunk headers giving real line numbers in `src/clamp.py`**, continue with Step 3 as written (parse with the existing `parseUnifiedDiff`; a mutant's line range = its removed lines).
- **If they don't carry real file line numbers**, stop and report to the user with the captured files. The fallback (map each mutant to its function's line span via Python `ast`, from the `x_<func>__mutmut_N` name) changes the gate's precision from line level to function level. That's a user decision, not an implementer one.

- [ ] **Step 3: Write the failing parser test against the captured output**

`test/mutmut.integration.test.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutation } from '../src/gates/mutation.js';
import { parseMutmut, runMutmut } from '../src/mutation/mutmut.js';

const out = path.resolve(__dirname, 'fixtures/mutmut-output');
const repo = path.resolve(__dirname, '..');
const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');

describe('parseMutmut (captured output)', () => {
  it('turns survivors into line-located mutants', () => {
    const results = readFileSync(path.join(out, 'results.txt'), 'utf8');
    const shows = Object.fromEntries(
      readdirSync(out)
        .filter((f) => f.startsWith('show-'))
        .map((f) => [f.slice(5, -5), readFileSync(path.join(out, f), 'utf8')]),
    );
    const mutants = parseMutmut(results, (name) => shows[name] ?? '');
    const survivors = mutants.filter((m) => m.status === 'survived');
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((m) => m.file === 'src/clamp.py')).toBe(true);
    expect(survivors.some((m) => m.startLine === 4)).toBe(true); // `if x > hi:` has no test
  });
});

describe('runMutmut (real mutmut)', () => {
  it('blocks the untested upper bound through the gate', () => {
    const root = path.resolve(__dirname, 'fixtures/mutmut-project');
    const run = runMutmut(root, python, ['src/clamp.py'], 300_000);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(mutation({ mutants: run.mutants, changed: new Map([['src/clamp.py', new Set([4])]]) }).status).toBe('BLOCK');
  }, 300_000);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/mutmut.integration.test.ts`
Expected: FAIL, `../src/mutation/mutmut.js` not found.

- [ ] **Step 5: Implement**

`src/mutation/mutmut.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from '../diff.js';
import type { Mutant } from './types.js';

// `mutmut results` lines look like "    <mutant name>: <status>" (verify against test/fixtures/mutmut-output/results.txt).
const RESULT_LINE = /^\s*(\S+):\s*(\w[\w ]*)\s*$/;
const STATUS: Record<string, Mutant['status']> = { survived: 'survived', 'no tests': 'no_coverage', killed: 'killed' };

export function parseMutmut(results: string, show: (name: string) => string): Mutant[] {
  const mutants: Mutant[] = [];
  for (const line of results.split('\n')) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const status = STATUS[m[2]!.trim()] ?? 'other';
    if (status !== 'survived' && status !== 'no_coverage') {
      mutants.push({ file: '', startLine: 0, endLine: 0, status, mutator: m[1]!, replacement: '' });
      continue;
    }
    for (const f of parseUnifiedDiff(show(m[1]!))) {
      const lines = f.removed.map((r) => r.line);
      if (lines.length === 0) continue;
      mutants.push({
        file: f.path,
        startLine: Math.min(...lines),
        endLine: Math.max(...lines),
        status,
        mutator: m[1]!,
        replacement: f.added.map((a) => a.text.trim()).join(' '),
      });
    }
  }
  return mutants;
}

export function runMutmut(
  root: string,
  python: string,
  files: string[],
  timeoutMs: number,
): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  rmSync(path.join(root, 'mutants'), { recursive: true, force: true }); // never read a previous run
  const mutmut = path.join(path.dirname(path.resolve(root, python)), 'mutmut');
  const env = { ...process.env, GOVERNOR_DISABLE_REPORTER: '1' };
  const globs = files.map((f) => f.replace(/\.py$/, '').replaceAll('/', '.') + '*');
  const run = spawnSync(mutmut, ['run', ...globs], { cwd: root, env, stdio: 'inherit', timeout: timeoutMs });
  if (run.error) return { ok: false, error: `mutmut did not run: ${run.error.message}` };
  if (run.signal) return { ok: false, error: `mutmut killed by ${run.signal}` };
  const results = spawnSync(mutmut, ['results', '--all', 'true'], { cwd: root, env, encoding: 'utf8' });
  if (results.status !== 0) return { ok: false, error: `mutmut results failed: ${results.stderr}` };
  const show = (name: string) => spawnSync(mutmut, ['show', name], { cwd: root, env, encoding: 'utf8' }).stdout ?? '';
  const mutants = parseMutmut(results.stdout, show);
  if (mutants.length === 0) return { ok: false, error: 'mutmut produced no mutants for the changed files' };
  return { ok: true, mutants };
}
```

**Adjust to the captured output, not the other way round:** if `results.txt` uses a different line format, or `mutmut run` doesn't accept the module-glob arguments as written, change `RESULT_LINE`, `STATUS`, or the glob construction to match the real 3.x behaviour you captured in Step 2. Record each such adjustment in the Stage 4 findings doc.

- [ ] **Step 6: Wire into `gate push`**

In `src/cli.ts` `gatePush`, replace the non-vitest branch:
```ts
  const run = config.adapter === 'vitest'
    ? runStryker(root, [...changed.keys()], config.mutation.timeoutMs)
    : runMutmut(root, config.pytest!.python, [...changed.keys()], config.mutation.timeoutMs);
```
Add `import { runMutmut } from './mutation/mutmut.js';`.

- [ ] **Step 7: Run to verify pass, then the full gate**

```bash
npx vitest run test/mutmut.integration.test.ts
npx tsc --noEmit && npm test && npm run build
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/mutation/mutmut.ts src/cli.ts test/fixtures/mutmut-project test/fixtures/mutmut-output test/mutmut.integration.test.ts
git commit -m "feat: mutmut mutation adapter built from captured real output

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Onboard BigBadPhotos

Work in `/Volumes/BigBadDrive_1/BigBadPhotos`. It is currently on branch `bbaf/bigbadphotos-ingest-killswitch`. **Do not touch that branch.** Check `git status` is clean first. If it isn't, stop and ask the user. Then branch from `main`. Follow BigBadPhotos' own `CLAUDE.md`/`AGENTS.md` for its verification commands and commit trailer.

**Files (BigBadPhotos):**
- Create: `conftest.py` (repo root), `.governor/config.json`
- Modify: `.gitignore`, `requirements-dev.txt` (add `pytest-timeout`, `mutmut>=3.8,<4`), `pyproject.toml` or `setup.cfg` (mutmut `paths_to_mutate`: create `pyproject.toml` with only `[tool.mutmut]` if none exists)

- [ ] **Step 1: Branch and install**

```bash
cd /Volumes/BigBadDrive_1/BigBadPhotos
git status --short            # must be empty; otherwise stop and ask
git switch main && git pull --ff-only && git switch -c chore/tdd-governor
.venv/bin/pip install -e ../tdd-governor/python pytest-timeout "mutmut>=3.8,<4"
```

- [ ] **Step 2: Configure**

`conftest.py` (repo root):
```python
# Records every pytest run for tdd-governor when it's installed locally; a no-op elsewhere (CI, Docker).
try:
    import tdd_governor_pytest  # noqa: F401

    pytest_plugins = ["tdd_governor_pytest"]
except ImportError:
    pass
```

`.governor/config.json`:
```json
{
  "adapter": "pytest",
  "pytest": { "python": ".venv/bin/python" },
  "testGlobs": ["backend/tests/**/test_*.py", "tests/**/test_*.py"],
  "sourceGlobs": ["backend/**/*.py", "app.py"],
  "mutation": { "enabled": true, "timeoutMs": 600000 },
  "runTimeoutMs": 300000
}
```

`pyproject.toml` (create only if absent; otherwise add the section):
```toml
[tool.mutmut]
paths_to_mutate = ["backend/", "app.py"]
tests_dir = ["backend/tests/", "tests/"]
```

Append to `.gitignore`: `.governor/ledger.jsonl` (install also does this) and `mutants/`.

- [ ] **Step 3: Install hooks and record a baseline**

```bash
node ../tdd-governor/dist/cli.js install
node ../tdd-governor/dist/cli.js run
```
Expected: both hooks installed. `run` prints a recorded run with 0 collection errors.

If the baseline suite is **already red** on `main`, stop and report which tests fail. Don't commit onboarding on top of a red suite, and don't fix unrelated tests without the user's go-ahead.

- [ ] **Step 4: Live acceptance (same as Stages 2–3)**

1. Stage an added `@pytest.mark.skip` in `backend/tests/`, then `git commit`. Expected: diff-audit BLOCK. Revert.
2. Write a new test for an existing pure function in `backend/scoring.py` with a wrong expectation, run `.venv/bin/python -m pytest <file>` (red, assertion), fix it, commit. Expected: all gates PASS.
3. On a throwaway branch, add an untested branch to a pure function, commit (with valid red/green for a different line), and push to a scratch remote or `--dry-run` target. Expected: mutation BLOCK on the new line. Clean up the branch.

Record outputs and wall times as `live-observed`.

- [ ] **Step 5: Commit the onboarding (through the hook)**

```bash
git add conftest.py .governor/config.json .gitignore requirements-dev.txt pyproject.toml
git commit -m "chore: gate commits and pushes with tdd-governor"
```
(Add the trailer that BigBadPhotos' agent instructions specify.)

---

### Task 6: Stage 4 findings doc

**Files (tdd-governor):** `docs/superpowers/specs/<date>-stage-4-findings.md`

- [ ] **Step 1: Write it**

Required rows:
- Plugin output satisfies the TS ledger schema: `test` (pytest-plugin.integration, `corrupt === 0`)
- Assertion / runtime / timeout / skip / collection classification: `test`
- Plugin paths are git-relative and match diffs: `test` + `live-observed` (BigBadPhotos commit)
- Guarded conftest import is a no-op without the plugin: `live-observed` (run pytest in a venv without it)
- mutmut output format as actually observed, plus every parser adjustment made: `live-observed`
- Survivor on changed line blocks push in BigBadPhotos: `live-observed`
- Commit and push wall times in BigBadPhotos: `live-observed`, with numbers
- Carried forward: G1–G8. Stage 5 entry criterion: count of `UNDECIDED` findings and overrides in both ledgers so far.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/*-stage-4-findings.md
git commit -m "docs: stage 4 findings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
