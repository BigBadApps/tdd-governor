# TDD Governor

Git-hook gate that blocks commits and pushes lacking real TDD evidence — a red run before the green one, no skipped/weakened tests, and (optionally) mutation coverage on changed lines.

## Install

```bash
npm install --save-dev tdd-governor
```

Add `.governor/config.json` at repo root:

```json
{
  "adapter": "vitest",
  "testGlobs": ["test/**/*.test.ts"],
  "sourceGlobs": ["src/**/*.ts"],
  "mutation": { "enabled": false, "timeoutMs": 300000 },
  "runTimeoutMs": 120000
}
```

- `adapter`: `vitest` (implemented) or `pytest` (not yet).
- `packageRoot`: optional, for monorepos — folder (relative to repo root) whose test runner the governor drives. Omit for repo-root packages.
- `testGlobs` / `sourceGlobs`: no defaults on purpose — wrong globs silently check nothing.
- `mutation.enabled`: turns on the push-time mutation gate (Stryker, vitest adapter only).

Then wire up git hooks:

```bash
npx governor install
```

Installs `pre-commit`, `pre-merge-commit`, and `pre-push` hooks that call this CLI. Refuses to overwrite a hook it doesn't recognize as its own.

## Usage

```bash
governor run [-- vitest args]   # run tests, record the outcome to the ledger
governor gate commit            # pre-commit: green + red-before-green + diff-audit
governor gate push               # pre-push: mutation gate (if enabled)
governor gate ci [--base <ref>]  # CI: green + diff-audit + mutation (no red-before-green — needs local ledger)
governor install                 # wire the hooks above into .git/hooks
```

Every `run` appends a `LedgerRecord` to `.governor/ledger.jsonl` — the evidence trail the commit gate reads back.

## Gates

| Gate | When | Checks |
|---|---|---|
| **green** | commit, ci | Latest recorded run has no failing tests, no collection errors, exit code 0. |
| **red-before-green** | commit | Every test added/changed in the diff has a *failing* run recorded in the ledger before its current *passing* one — no writing the test after the code already works. |
| **diff-audit** | commit, ci | Blocks new `.skip`/`.only`/`.todo`/`xit`/`pytest.mark.skip` etc., and diffs that touch test files but add zero assertions (or lower an `expect.assertions(n)` count). |
| **mutation** | push, ci (if `mutation.enabled`) | Runs Stryker on changed source lines; flags mutants that survived or aren't covered by any test. |

A gate that can't run (bad config, adapter unavailable, no push base) reports `GATE_UNAVAILABLE` rather than failing silently.

## Overriding a block

```bash
GOVERNOR_OVERRIDE="reason" git commit ...
```

Records the override (gate + reason) to the ledger instead of blocking. Ignored in CI (`gate ci` never honors it).

## Primer

`governor install` also drops `.governor/PRIMER.md` — read it for what counts as a valid red and how to get one; the commit gate points to it on failure.
