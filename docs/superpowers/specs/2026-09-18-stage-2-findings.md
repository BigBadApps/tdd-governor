# Stage 2 Findings — Commit Gates

| Criterion | Result | Verified by |
|---|---|---|
| Green gate blocks a failing or zero-executed-test run | Pass | test: green gate unit tests (`0ab3be2`) |
| Diff parser keeps exact paths for spaced, quoted, and ` b/` names | Pass | test: diff parser unit tests (`6174d62`) |
| Red-before-green blocks a test never seen failing; passes after a red assertion run | Pass | test: e2e.commit "blocks a test that was never seen red", "passes a genuine test-first commit" |
| Diff audit blocks added `.skip` / `.only` / `.todo` | Pass | test: e2e.commit "blocks an added .skip" |
| Override with reason lets a blocked commit through and is recorded in the ledger | Pass | test: e2e.commit "lets an override through and records it in the ledger" |
| Empty `GOVERNOR_OVERRIDE` is rejected, commit stays blocked | Pass | live-observed: probe Q5, exit 1, "needs a non-empty reason" |
| `install` refuses to overwrite a foreign pre-commit hook, exits 1 | Pass | live-observed: probe Q1 |
| `install` is idempotent; `.gitignore` entry not duplicated | Pass | live-observed: probe Q2 |
| Missing `.governor/config.json` → exit 2 with an example config | Pass | live-observed: probe Q3 |
| No `main` branch → exit 2 naming the missing branch, never a pass | Pass | live-observed: probe Q4 |
| Usage / non-repo errors are clean, no stack trace | Pass | test: e2e.commit "governor outside a git repo" |
| Dogfood: governor gates its own repo | Pass | live-observed: `d1da86c` committed through the hook (3 PASS); added `.skip` blocked by red-before-green and diff-audit, HEAD unmoved |
| BigBadPlayground blocks an added `.skip` | Pass | live-observed: 2 BLOCK (red-before-green, diff-audit), HEAD unmoved |
| BigBadPlayground passes a real test-first commit | Pass | live-observed: `governor run` recorded 1 failed test, implementation added, commit passed all 3 gates |
| Dogfood ledger has no pollution from fixture runs | Pass | live-observed: one record, 78 tests, 0 fails after full suite |

Environment for live-observed rows: vitest 3.2.7, darwin-arm64, node v22.22.3.

## Surprises / deviations from plan
- `main()` resolved `repoRoot()` before dispatching, so bad usage outside a repo threw a raw git error. Fixed in `554d3e0`, with tests.
- The e2e suite leaked `gov-e2e-*` temp repos on every run. Fixed in `554d3e0` with an `afterAll` cleanup.
- The subagent that built task 6 signed its commit with the wrong co-author. Amended before push.
- Dogfood `vitest.config.ts` loads the reporter only if `dist/` exists. Before the first build there is no reporter, so `governor run` reports it unavailable instead of passing.
- The hooks embed the absolute path of the governor's `dist/cli.js`, and the client `vitest.config.ts` imports the reporter from an absolute path. Moving or deleting the governor checkout breaks every onboarded repo.

## Deferred
- BigBadPlayground onboarding is a local branch (`chore/tdd-governor`, `e48e110`), not pushed or merged. `deferred`
- Absolute-path coupling between clients and the governor build. A published package or `npm link` would remove it. `deferred`
- Ledger evidence is windowed from the merge-base with `main`; repos whose trunk is not `main` are blocked outright (exit 2) rather than configurable. `deferred`

## Carried forward
- Known gaps G1–G8 unchanged (spec §9). G1 (`--no-verify` bypass) is next after Stage 3.
- Stage 3 (mutation gate, `gate push`) is next.
