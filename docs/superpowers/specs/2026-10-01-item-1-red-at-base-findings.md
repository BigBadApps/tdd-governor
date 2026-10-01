# Item 1 Findings — CI Re-derives Red Evidence (`red-at-base`)

| Criterion | Result | Verified by |
|---|---|---|
| Assertion red at base passes; pass at base blocks; weak red warns; tests-only exempt | Pass | test: `test/gates/red-at-base.test.ts` (pure gate behaviors) and `test/e2e.ci.test.ts` (end-to-end execution through `gate ci`) |
| Caller checkout and worktree list untouched; hooks not fired | Pass | test: `test/base-worktree.test.ts` (isolation, thrown cleanup, `core.hooksPath=/dev/null`) and `test/e2e.ci.test.ts` (`'leaves the checkout and worktree list untouched'`) |
| This PR's own CI run executed `red-at-base` on this repo | Pass | live-observed: PR #16 run `36922781330` executed `red-at-base` against base source and passed |
| CI wall time for `gate ci` on this PR vs previous merged PR | Observed | live-observed: PR #15 run `36917539338` (gate 51s, job 128s) vs PR #16 run `36922781330` (gate 75s, job 160s); gate delta +24s |
| pytest path through `red-at-base` (python resolved against checkout; isolated import path) | Pass | test: `test/e2e.ci.test.ts` (`'passes a pytest PR when package is imported via simulated editable install'`) verifies extraPythonPath prepends worktree source |
| Monorepo (`packageRoot`) path through `red-at-base` (isolated workspace dependencies) | Pass | test: `test/e2e.ci.test.ts` (`'passes when an app test imports a changed workspace package through its node_modules symlink'`) verifies worktree symlink re-pointing |
| Remaining G3 surface (local hooks trust the ledger) | Deferred | deferred: local hooks still read `.governor/ledger.jsonl`; CI derives proof independently. |

## Live CI Gate Output

- PR: https://github.com/BigBadApps/tdd-governor/pull/16
- CI Run URL: https://github.com/BigBadApps/tdd-governor/actions/runs/36922781330

```
[PASS] green
[PASS] red-at-base
  test/base-worktree.test.ts:33  warning: test/base-worktree.test.ts > withBaseWorktree > reverts the listed source files to base, links deps, and leaves the checkout alone: its file does not import at base (expected when it tests new code)
  test/base-worktree.test.ts:49  warning: test/base-worktree.test.ts > withBaseWorktree > cleans up when the callback throws: its file does not import at base (expected when it tests new code)
  test/base-worktree.test.ts:62  warning: test/base-worktree.test.ts > withBaseWorktree > does not run the repo hooks: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:16  warning: test/gates/red-at-base.test.ts > redAtBase > passes with no tests in scope: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:20  warning: test/gates/red-at-base.test.ts > redAtBase > passes a tests-only change with a warning: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:26  warning: test/gates/red-at-base.test.ts > redAtBase > passes a test that fails on an assertion at base: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:30  warning: test/gates/red-at-base.test.ts > redAtBase > blocks a test that passes at base: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:36  warning: test/gates/red-at-base.test.ts > redAtBase > passes a runtime-error red with a warning: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:42  warning: test/gates/red-at-base.test.ts > redAtBase > passes a file that does not import at base with a warning: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:48  warning: test/gates/red-at-base.test.ts > redAtBase > is undecided when the test was skipped or not run at base: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:53  warning: test/gates/red-at-base.test.ts > redAtBase > blocks over undecided when both occur: its file does not import at base (expected when it tests new code)
  test/gates/red-at-base.test.ts:58  warning: test/gates/red-at-base.test.ts > redAtBase > is unavailable when the base run is: its file does not import at base (expected when it tests new code)
  test/gates/red-before-green.test.ts:218  warning: test/gates/red-before-green.test.ts > scopeOf > takes every test of an added file: fails at base with runtime_error, not an assertion (expected when it tests new code)
  test/gates/red-before-green.test.ts:222  warning: test/gates/red-before-green.test.ts > scopeOf > takes only the tests whose span holds an added line: fails at base with runtime_error, not an assertion (expected when it tests new code)
  test/gates/red-before-green.test.ts:226  warning: test/gates/red-before-green.test.ts > scopeOf > is undefined when a test has no line: fails at base with runtime_error, not an assertion (expected when it tests new code)
[PASS] diff-audit
[PASS] mutation
  .governor/config.json  warning: mutation gate disabled in .governor/config.json
```

## CI Wall Time Comparison

- Previous merged PR #15 (run [36917539338](https://github.com/BigBadApps/tdd-governor/actions/runs/36917539338)):
  - Gate step: 51s
  - Job total: 2m 8s (128s)
- This PR #16 (run [36922781330](https://github.com/BigBadApps/tdd-governor/actions/runs/36922781330)):
  - Gate step: 75s
  - Job total: 2m 40s (160s)
- Delta: +24s overhead on the gate step for throwaway worktree creation, source reversion to merge-base, and running changed test files at base.

## Surprises / deviations from plan

1. **`test/e2e.ci.test.ts` isolation test pass-at-base block:**
   - The initial plan for `test/e2e.ci.test.ts` `'leaves the checkout and worktree list untouched'` checked that worktrees and checkout state remained clean after running `ci(root)`. However, it did not assert `res.stdout` matched `[PASS] red-at-base`.
   - When executed against base source in CI, `gate ci` at base did not leak worktrees either. Thus, the test passed at base, which `red-at-base` blocked because tests of unchanged behavior must not be in a PR with source changes.
   - Fixed by strengthening the test to assert `expect(res.stdout).toMatch(/\[PASS\] red-at-base/)`. At base, `red-at-base` is not in output, so the test fails at base with an assertion error and passes at HEAD.

2. **Review finding: Base run import isolation for npm workspaces & pytest editable installs:**
   - Review identified that symlinking `node_modules` wholesale into the base worktree resolves workspace package symlinks (e.g. `node_modules/@acme/lib -> ../../packages/lib`) into the checkout's HEAD source rather than the worktree's reverted source. Similarly, pytest editable installs (`pip install -e .` with `.pth` or `PYTHONPATH=<checkout>/src`) cause tests in the base worktree to import HEAD Python code.
   - Fixed for Node by constructing `node_modules` in the worktree linking checkout entries while re-pointing workspace symlinks targeting within the checkout to their counterpart inside the worktree (`linkDir` / `linkEntry` in `src/base-worktree.ts`).
   - Fixed for Python by accepting `extraPythonPath` in `runPytest` and prepending `<wt>/src` and `<wt>` to `PYTHONPATH` ahead of any existing paths so reverted worktree source takes precedence.

## Deferred

- Local hooks still trust `.governor/ledger.jsonl`. G3 is closed for CI via `red-at-base`, but local verification remains ledger-backed until local hook redesign.
