# Stage 1 Findings — Evidence Recording

| Criterion | Result | Verified by |
|---|---|---|
| Assertion red classified `assertion` | Pass | test: reporter.integration "classifies a wrong return value as an assertion red" |
| TypeError classified `runtime_error` | Pass | test: reporter.integration "classifies calling a non-function as runtime_error" |
| Timeout classified `timeout` | Pass | test: reporter.integration "classifies a timeout" |
| Import failure recorded as collection error, not a test | Pass | test: reporter.integration "records the import failure as a collection error, not a test" |
| Test line numbers present with includeTaskLocation | Pass | test: reporter.integration "classifies a wrong return value as an assertion red" |
| Missing reporter → unavailable, never success | Pass | test: cli-run "is unavailable when the reporter is not configured" |
| Corrupt ledger lines skipped + counted | Pass | test: ledger "skips and counts corrupt or schema-invalid lines" |
| vitest API assumptions (onTestRunEnd, TestModule.errors(), location) | Pass | live-observed: vitest 3.2.7 darwin-arm64 node-v22.22.3 |

## Surprises / deviations from plan
- In `test/reporter.integration.test.ts` and `test/cli-run.integration.test.ts`, ESM `__dirname` was defined via `path.dirname(fileURLToPath(import.meta.url))` to ensure robust path resolution in pure ESM NodeNext runtime without relying on Node/bundler global `__dirname`.
- All other implementations and tests matched the plan's literal code verbatim.
- Measured full gate wall time: 1.92s for full suite (23/23 tests passing across 5 test suites).

## Carried forward
- Known gaps G1–G8 unchanged (spec §9).
