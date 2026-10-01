# Item 2: pytest Adapter. Amendments to the Stage 4 Plan

> **For agentic workers:** Execute `docs/superpowers/plans/2026-09-18-stage-4-pytest-adapter.md` (the **base plan**) task by task, with the amendments below applied. **Where an amendment and the base plan disagree, the amendment wins.** The base plan was written on 2026-09-18. Since then `main` has gained `packageRoot` (monorepos), nested-worktree exclusion, `gate ci`, and (Item 3) reporter injection. The amendments realign the base plan with that code.

**Goal (unchanged):** pytest projects get the same commit, push and CI gates as vitest projects: every pytest run is recorded and classified, and the gates work unchanged on top.

**Prerequisite:** Item 3 (`docs/superpowers/plans/2026-10-01-item-3-reporter-injection.md`) is merged to `main`. Overview: `docs/superpowers/plans/2026-10-01-overview-items-1-2-3.md`.

## Amended Global Constraints

These replace or add to the base plan's Global Constraints.

- **[REPLACES "Plugin `file` paths are relative to the git toplevel"]** Plugin `file` paths are relative to pytest's **rootdir** (`config.rootpath`), and the default ledger is `<rootdir>/.governor/ledger.jsonl`. This mirrors the vitest reporter, which writes paths relative to vitest's root. `src/cli.ts` already maps package-relative ledger paths to repo paths (`toRepoRecords` via `packageOf`). Don't move that mapping into the plugin. Consequence: `packageRoot` must be the folder pytest uses as rootdir. If they differ, the run's record lands elsewhere and the gate reports `GATE_UNAVAILABLE` (fail closed). Document this in the README.
- **[ADD]** `pytest.python` resolves relative to the **package folder** (`packageRoot`, or the repo root when unset), the folder pytest runs in. Absolute paths are allowed.
- **[ADD]** Like Item 3, the governor injects its own plugin: `runPytest` passes `-p tdd_governor_pytest` and prepends the governor's `python/` folder to `PYTHONPATH`. A client's guarded `conftest.py` import is then only needed to record *plain* `pytest` runs. Exactly one record per run, even when both are active.
- **[ADD]** Child processes never inherit `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`. This is existing behaviour in `src/adapters/vitest/run.ts` `childEnv`, and the shared helper must keep it.
- **[ADD]** Nested linked worktrees under the package folder are excluded: vitest keeps `--exclude <rel>/**`, and pytest gets `--ignore=<rel>` per entry from `nestedWorktrees(root)`.
- **[ADD]** `python/` ships in the npm package (`package.json` `files`), so clients can `pip install -e node_modules/tdd-governor/python` and the injected `-p` works from an npm install.
- **[ADD]** This repo's CI (`.github/workflows/ci.yml`) must provision the Python test env, because the pytest/mutmut integration tests **fail** (not skip) without it.
- **[ADD]** The governor's own pre-commit hook governs you. No `--no-verify`, no `GOVERNOR_OVERRIDE`. Run `npm run build` before each commit that changes `src/`.
- **[ADD]** Model trailer: use your actual model name, not the base plan's `Claude Opus 5`.

## Amendments by task

### Task 1 (config field)

Don't paste the base plan's schema. It predates `packageRoot` and would delete it. Add to the **current** `ConfigSchema` in `src/config.ts`:

```ts
    pytest: z.object({ python: z.string().min(1) }).strict().optional(),
```

as a new key in the object, and chain after `.strict()`:

```ts
  .superRefine((c, ctx) => {
    if (c.adapter === 'pytest' && !c.pytest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pytest', 'python'], message: 'required when adapter is pytest' });
    }
  });
```

Keep every existing `packageRoot` refinement and the realpath check in `loadConfig`. The base plan's expected count ("PASS, 7 tests") is stale. Expected: all `test/config.test.ts` tests pass, including the existing `packageRoot` ones.

### Task 2 (plugin)

1. Add `test/fixtures/pytest-project/pytest.ini` with the single line `[pytest]`. This pins rootdir to the fixture folder, so pytest doesn't walk up into this repo.
2. In the plugin, replace the git-toplevel logic. `_Recorder.__init__` keeps `self.root = rootpath` only. `_rel` is `os.path.relpath(path, self.root)`. `head` uses `_git(self.root, "rev-parse", "HEAD")`. The default ledger is `self.root / ".governor" / "ledger.jsonl"`. Delete `git_root`.
3. In `test/pytest-plugin.integration.test.ts`, the expected paths become rootdir-relative: `const F = 'test_cases.py';`, and the collection error file is `'test_import_error.py'`. The base plan's `-p tdd_governor_pytest` + `PYTHONPATH` invocation stays.
4. Python env setup (Step 1) is unchanged: `.venv-py/` at the repo root. Python 3.14 is installed locally. That's fine (≥ 3.11).

### Task 3 (`runPytest`, dispatch)

Replace the base plan's Step 3 code with this shape. `runAndCollect` must not lose the git-var stripping or the reporter injection from Item 3.

`src/adapters/run-and-collect.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ledgerPath, readLedger } from '../ledger.js';
import type { RunOutcome } from '../types.js';

// git exports these into hooks (absolute, and always in linked worktrees). If the
// user's tests shell out to git they would hit the real repo, so never forward them.
const GIT_REPO_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

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
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, GOVERNOR_RUN_ID: runId };
  for (const k of GIT_REPO_VARS) delete env[k];
  const res = spawnSync(opts.command, opts.args, { cwd: opts.root, env, stdio: 'inherit', timeout: opts.timeoutMs });
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

`src/adapters/vitest/run.ts` delegates to it and keeps Item 3's `GOVERNOR_REPORTER` constant, the injected `--reporter=default --reporter=${GOVERNOR_REPORTER} --includeTaskLocation`, and the `nestedWorktrees` `--exclude` args. Its hint stays `'is GOVERNOR_DISABLE_REPORTER set?'`.

`src/adapters/pytest/run.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nestedWorktrees } from '../../git.js';
import type { RunOutcome } from '../../types.js';
import { runAndCollect } from '../run-and-collect.js';

// src/adapters/pytest and dist/adapters/pytest are both three levels below the package root.
const PLUGIN_DIR = fileURLToPath(new URL('../../../python', import.meta.url));

export function runPytest(root: string, python: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const ignores = nestedWorktrees(root).map((rel) => `--ignore=${rel}`);
  return runAndCollect({
    root,
    command: path.resolve(root, python),
    args: ['-m', 'pytest', '-p', 'tdd_governor_pytest', ...ignores, ...extraArgs],
    env: { PYTHONPATH: [PLUGIN_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    timeoutMs,
    label: 'pytest',
    missingRecordHint: 'is GOVERNOR_DISABLE_REPORTER set?',
  });
}
```

`src/cli.ts` `runTests` keeps the package mapping:

```ts
function runTests(config: GovernorConfig, root: string, extraArgs: string[] = []): RunOutcome {
  const pkg = packageOf(root, config);
  const outcome = config.adapter === 'vitest'
    ? runVitest(pkg.dir, config.runTimeoutMs, extraArgs)
    : runPytest(pkg.dir, config.pytest!.python, config.runTimeoutMs, extraArgs);
  return outcome.kind === 'completed' ? { kind: 'completed', record: toRepoRecords([outcome.record], pkg.toRepo)[0]! } : outcome;
}
```

**Replace the base plan's Step 1 tests** (the plugin is now injected, so "unavailable when the plugin is not loaded" no longer holds):

```ts
describe('runPytest', () => {
  const repo = path.resolve(__dirname, '..');
  const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');
  const project = path.join(repo, 'test/fixtures/pytest-project');

  it('records a run with no conftest wiring (the governor injects its plugin)', () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp-')), 'l.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = ledger;
    const outcome = runPytest(project, python, 60_000, ['-q', 'test_cases.py']);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.adapter).toBe('pytest');
      expect(readLedger(ledger).records.filter((r) => r.runId === outcome.record.runId)).toHaveLength(1);
    }
  });

  it('is unavailable when the plugin writes nothing', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp2-')), 'l.jsonl');
    process.env.GOVERNOR_DISABLE_REPORTER = '1';
    try {
      expect(runPytest(project, python, 60_000, ['-q', 'test_cases.py'])).toEqual({
        kind: 'unavailable',
        reason: expect.stringMatching(/no ledger record/),
      });
    } finally {
      delete process.env.GOVERNOR_DISABLE_REPORTER;
    }
  });
});
```

**Add one double-registration test.** Create `test/fixtures/pytest-conftest-project/` with `pytest.ini` (`[pytest]`), the guarded `conftest.py` from the base plan's Task 5, and a `test_ok.py` (`def test_ok():\n    assert 1 == 1\n`). Assert that `runPytest` on it, with `PYTHONPATH` already containing the plugin dir, yields exactly one record for the run's `runId`. If pytest double-registers, fix it in the plugin (for example, register the recorder only if `config.pluginmanager.has_plugin("tdd-governor-recorder")` is false). Don't fix it by removing the test.

**Add to Task 3:** in `package.json`, `"files": ["dist", "templates", "python"]`. In `test/package-meta.test.ts`, the "ships … and nothing else" test must now expect `python/tdd_governor_pytest.py` and `python/pyproject.toml`. Make sure `__pycache__` isn't shipped (the root `.gitignore` entry doesn't control `npm pack`, so check the `npm pack --dry-run` file list in that test).

### Task 4 (mutmut)

- Step 6: the code to change is now in `mutationGate` (not `gatePush`). Replace its non-vitest branch with:
  ```ts
  : runMutmut(pkg.dir, config.pytest!.python, [...changed.keys()].map(pkg.toPackage), config.mutation.timeoutMs);
  ```
  The returned mutants already go through the existing `pkg.toRepo` mapping.
- The decision point (mutmut line numbers) stands. **Stop and report to the orchestrator** if `show` diffs lack real line numbers.

### Task 4b (new): this repo's CI provisions Python

In `.github/workflows/ci.yml`, before `npm test`, add:

```yaml
      - uses: actions/setup-python@<pin a full commit SHA, like the other actions> # v5 or current
        with:
          python-version: '3.12'
      - run: python -m venv .venv-py && .venv-py/bin/pip install "pytest>=8" pytest-timeout "mutmut>=3.8,<4"
```

Pin the action by full commit SHA with a version comment, matching the file's existing style. Commit: `ci: provision the python test env`. The PR's CI run is the verification. Paste its result.

### Task 5 (BigBadPhotos onboarding): changed, read carefully

BigBadPhotos' main checkout is on `bbaf/bigbadphotos-ingest-killswitch` with an untracked `graphify-out/`. **Don't touch that checkout, its branch, or `graphify-out/`.**

1. Work in a separate worktree:
   ```bash
   cd /Volumes/BigBadDrive_1/BigBadPhotos
   git fetch origin
   git worktree add ../BigBadPhotos-governor -b chore/tdd-governor origin/main
   cd ../BigBadPhotos-governor
   ln -s ../BigBadPhotos/.venv .venv
   ```
   Read BigBadPhotos' `CLAUDE.md` / `AGENTS.md` first. Its rules apply.
2. **Do NOT run `governor install` in BigBadPhotos.** Hooks live in the shared git directory, so installing them would gate every branch and worktree, including the user's in-progress killswitch branch. That branch has no `.governor/config.json`, so its commits would be blocked. Hook installation is the user's call after merge.
3. Live acceptance runs the CLI directly instead of through hooks. Same scenarios as the base plan's Step 4:
   - `node /Volumes/BigBadDrive_1/tdd-governor/dist/cli.js run`: baseline. If the suite is red on `origin/main`, stop and report the failing tests.
   - Stage an added `@pytest.mark.skip`, then run `node …/dist/cli.js gate commit`. Expect diff-audit BLOCK. Unstage and revert.
   - New test with a wrong expectation: `.venv/bin/python -m pytest <file>` (red, assertion, recorded via the conftest import), fix, stage, `gate commit`. Expect all PASS. Commit normally (no hook is installed, which is expected).
   - Mutation: on a throwaway branch in the worktree, add an untested branch to a pure function, commit, then `node …/dist/cli.js gate ci --base origin/main` with `mutation.enabled: true`. Expect mutation BLOCK on the new line. Delete the throwaway branch.
4. `pip install` of `pytest-timeout`, `mutmut` and `-e /Volumes/BigBadDrive_1/tdd-governor/python` goes into the shared `.venv`. These are dev-only packages. List them in the report.
5. Commit the onboarding on `chore/tdd-governor` in the worktree (with BigBadPhotos' own trailer). **Don't push.** Report branch + SHA. Leave the worktree in place.

### Task 6 (findings doc)

Replace the row "Plugin paths are git-relative and match diffs" with "Plugin paths are rootdir-relative and map to repo paths via packageRoot: `test` + `live-observed`". Add rows:

- Injected plugin + conftest import give one record per run: `test`
- This repo's CI ran the pytest/mutmut integration tests: `live-observed` (CI run URL)
- Hooks were deliberately not installed in BigBadPhotos: `deferred` (user decision)
- Known limitation: `templates/governor-ci.yml` is Node-only, so pytest clients have no CI gate yet: `deferred`
- Known limitation: `.governor/PRIMER.md` wording is vitest-flavoured: `deferred`
