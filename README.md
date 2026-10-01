# TDD Governor

Git-hook gate that blocks commits and pushes lacking real TDD evidence — a red run before the green one, no skipped/weakened tests, and (optionally) mutation coverage on changed lines.

It is deterministic: every verdict comes from recorded test runs and the git diff, not from a model's judgement. It works with any agent or human, because it lives in git hooks and CI rather than in an editor.

Requires Node 22+ and git. Vitest is the only implemented test adapter. MIT licensed.

## Install

```bash
npm install --save-dev tdd-governor
```

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

The governor passes its own vitest reporter on the command line whenever it runs tests (`governor run`, every gate), so the gates work without any vitest config change.

To also record the test runs you or your agent start with plain `vitest run`, wire the reporter into your vitest config:

```ts
import GovernorReporter from 'tdd-governor/vitest-reporter';

export default defineConfig({
  test: {
    includeTaskLocation: true, // the governor needs a line number for each test
    reporters: ['default', new GovernorReporter()],
  },
});
```

Without it, record red runs with `npx governor run -- <test files>`. `governor install` warns when the config doesn't load the reporter.

### 3. Hooks

```bash
npx governor install
```

Installs `pre-commit`, `pre-merge-commit` and `pre-push` hooks, writes `.governor/PRIMER.md`, and adds the ledger to `.gitignore`. It refuses to overwrite a hook it doesn't recognise as its own and prints the lines to add to it yourself.

The hook files hold no machine-specific path, so they are safe to track (for example under `core.hooksPath`). They read the CLI location from a pointer in the shared git directory (`tdd-governor-cli-path`), so every worktree sees it. A clone without the governor installed prints a notice and skips the hook rather than blocking; CI is the backstop.

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
| **red-at-base** | ci | Every test added or changed in the PR fails once the PR's source changes are reverted (run in a throwaway worktree). Passing at base blocks; an import or runtime failure at base passes with a warning (expected for tests of new code). Tests-only PRs are exempt. |
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

- CI does not read the local ledger. It re-derives red evidence with `red-at-base` instead, which no local process can forge.
- This repo's own [ci workflow](.github/workflows/ci.yml) gates itself with the build from the PR.

## Primer

`governor install` drops `.governor/PRIMER.md` for coding agents: what counts as a valid red, how to get one, and what to do when blocked. The commit gate points to it on failure. Reference it from your `AGENTS.md` or `CLAUDE.md`.

## Development

```bash
git clone https://github.com/BigBadApps/tdd-governor.git
cd tdd-governor && npm ci && npm run build && npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). This repo's own [vitest.config.ts](vitest.config.ts) loads the freshly built reporter from `dist/`.
