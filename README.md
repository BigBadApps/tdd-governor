# TDD Governor

Git-hook gate that blocks commits and pushes lacking real TDD evidence — a red run before the green one, no skipped/weakened tests, and (optionally) mutation coverage on changed lines.

It is deterministic: every verdict comes from recorded test runs and the git diff, not from a model's judgement. It works with any agent or human, because it lives in git hooks and CI rather than in an editor.

Requires Node 22+ and git. Vitest is the only implemented test adapter.

## Install

The package is not on npm yet. Build it from source:

```bash
git clone https://github.com/BigBadApps/tdd-governor.git
cd tdd-governor && npm ci && npm run build
```

Then, in the repo you want to govern:

### 1. Config

Add `.governor/config.json` at the repo root:

```json
{
  "adapter": "vitest",
  "testGlobs": ["test/**/*.test.ts"],
  "sourceGlobs": ["src/**/*.ts"],
  "mutation": { "enabled": false, "timeoutMs": 300000 },
  "runTimeoutMs": 120000
}
```

- `adapter`: `vitest` (implemented) or `pytest` (accepted by the schema, not implemented).
- `packageRoot`: optional, for monorepos — folder (relative to repo root) whose test runner the governor drives. Globs stay repo-relative. Omit for repo-root packages.
- `testGlobs` / `sourceGlobs`: no defaults on purpose — wrong globs silently check nothing.
- `mutation.enabled`: turns on the mutation gate (Stryker, vitest adapter only).
- Unknown keys are rejected.

### 2. Reporter

The governor learns what happened in a test run from a vitest reporter. **`install` does not add it for you.** In your vitest config set both:

```ts
import GovernorReporter from '/path/to/tdd-governor/dist/adapters/vitest/reporter.js';

export default defineConfig({
  test: {
    includeTaskLocation: true, // the governor needs a line number for each test
    reporters: ['default', new GovernorReporter()],
  },
});
```

Without the reporter, `governor run` reports `GATE_UNAVAILABLE` instead of passing. For a tracked config that must not hold a machine-specific path, read it from the pointer file `install` writes (`tdd-governor-cli-path` in the git directory); this repo's own [vitest.config.ts](vitest.config.ts) loads the built reporter from `dist/`.

### 3. Hooks

```bash
node /path/to/tdd-governor/dist/cli.js install
```

Installs `pre-commit`, `pre-merge-commit` and `pre-push` hooks, writes `.governor/PRIMER.md`, and adds the ledger to `.gitignore`. It refuses to overwrite a hook it doesn't recognise as its own and prints the lines to add to it yourself.

The hook files hold no machine-specific path, so they are safe to track (for example under `core.hooksPath`). They read the CLI location from a pointer in the shared git directory, so every worktree sees it. A clone without the governor installed prints a notice and skips the hook rather than blocking; CI is the backstop.

## Usage

```bash
governor run [-- vitest args]   # run tests, record the outcome to the ledger
governor gate commit            # pre-commit: green + red-before-green + diff-audit
governor gate push              # pre-push: mutation gate (if enabled)
governor gate ci [--base <ref>] # CI: green + diff-audit + mutation (no red-before-green)
governor install                # wire the hooks above into .git/hooks
```

`gate commit --merge` is what the `pre-merge-commit` hook runs.

Every test run through the reporter appends a record to `.governor/ledger.jsonl` — the evidence trail the commit gate reads back. The ledger is local to each worktree and gitignored. In a monorepo it lives under `packageRoot`.

## Gates

| Gate | When | Checks |
|---|---|---|
| **green** | commit, ci | Latest recorded run has no failing tests, no collection errors, exit code 0. |
| **red-before-green** | commit | Every test added or changed in the diff has a failing run recorded in the ledger before its current passing one. |
| **diff-audit** | commit, ci | Blocks new `.skip`/`.only`/`.todo`/`xit`/`pytest.mark.skip` etc., deleted test files, and diffs that remove assertions or lower an `expect.assertions(n)` count. Warns on changed snapshots. |
| **mutation** | push, ci (if `mutation.enabled`) | Runs Stryker on changed source lines; flags mutants that survived or aren't covered by any test. |

A gate that can't run (bad config, adapter unavailable, no push base) reports `GATE_UNAVAILABLE` rather than failing silently.

### What counts as a red

Only a failing `expect(...)` assertion. A missing export, `Cannot find module`, any error thrown inside the test, or a timeout is **not** a red. The workflow that passes first time:

1. Write the test.
2. Stub the implementation: export every symbol the test imports, with the right signature and a wrong return value.
3. Run the tests and confirm each new test fails on an assertion.
4. Write the real implementation, run again, commit.

Evidence counts from the merge-base with `main` to now. A merge commit is gated only on what the merge itself changes; tests the merged branch brought in were gated on that branch.

## Overriding a block

```bash
GOVERNOR_OVERRIDE="reason" git commit ...
```

Records the override (gate and reason) to the ledger instead of blocking. An empty reason is rejected, and CI never honors overrides.

## CI

[`templates/governor-ci.yml`](templates/governor-ci.yml) is a workflow to copy into a client repo; its header lists the setup steps. It runs `gate ci` on pull requests. Require the `governor / gate` check in branch protection to make it blocking.

Two limits to know about:

- `red-before-green` is skipped in CI because it needs the local ledger. The hooks are the only place it runs.
- This repo's own [ci workflow](.github/workflows/ci.yml) gates itself with the build from the PR.

## Primer

`governor install` drops `.governor/PRIMER.md` for coding agents: what counts as a valid red, how to get one, and what to do when blocked. The commit gate points to it on failure. Reference it from your `AGENTS.md` or `CLAUDE.md`.

## Development

```bash
npm ci
npm run build
npm test
```
