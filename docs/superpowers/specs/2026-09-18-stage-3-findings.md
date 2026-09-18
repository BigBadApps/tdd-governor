# Stage 3 Findings — Mutation Gate

| Criterion | Result | Verified by |
|---|---|---|
| Stale report is never read | Pass | test: stryker.integration plants `{"files":{}}` before the run; the real result still finds the `clamp.ts:3` survivor (`40f5493`) |
| Survivor on a changed line blocks the push | Pass | test: e2e.push "blocks a push whose changed line has a surviving mutant" (`8182db9`) |
| Survivor on a changed line blocks the push, in a real repo | Pass | live-observed: BigBadPlayground probe, `[BLOCK] mutation` naming `resources.ts:68` (not covered, `ConditionalExpression → false`, `EqualityOperator → >=`); no branch reached the remote |
| No-coverage mutant on a changed line blocks | Pass | test: gate unit "blocks no-coverage on a changed line"; live-observed: same probe, `BlockStatement → {}` |
| Survivors on unchanged lines and killed mutants are ignored | Pass | test: gate unit "ignores survivors on unchanged lines and killed mutants" |
| Multi-line mutant overlapping a changed line counts | Pass | test: gate unit "counts a multi-line mutant that overlaps a changed line" |
| Stryker missing or misconfigured fails closed | Pass | test: stryker.integration "fails closed when Stryker is not configured" |
| Malformed Stryker report is rejected | Pass | test: stryker-parse "rejects malformed reports" |
| Mutation disabled in config passes with a warning | Pass | live-observed: `[PASS] mutation` + "mutation gate disabled" on the Stage 3 PR push |
| Stryker's inner vitest runs write no ledger records | Pass | live-observed: Playground ledger stayed at 8 lines across a blocked push (Stryker ran inside it) |
| Push wall time, typical one-module change | Pass | live-observed: 5.6s total for the blocked probe push (Stryker on `resources.ts`, 59 mutants); 4.8s for the standalone run |
| Mutation score on a real module | Info | live-observed: `resources.ts` 94.55% (52 killed, 3 survived) before the probe; 90.00% after adding one untested branch |
| Hooks work after the worktree is removed | Pass | live-observed: `install` re-run from the main checkout; commit and push both went through |

Environment for live-observed rows: vitest 3.2.7, Stryker 10, darwin-arm64, node v22.22.3.

## Surprises / deviations from plan
- Linked-worktree commits export absolute `GIT_DIR` / `GIT_INDEX_FILE` into the pre-commit hook. `runVitest` forwarded them, so the nested e2e suite's temp-repo git calls hit the real gitdir and corrupted the branch ref and `.git/config` (`core.bare=true`, `user.email=e2e@example.com`). Fixed in `c73fa64` by stripping `GIT_*` repo vars.
- The same corruption recurred when a `git rebase --exec` amend re-ran the hook on commits replayed from before that fix. Recovered from the untouched branch ref. Trailers were then fixed with `filter-branch`, which runs no hooks. Do not run hook-triggering history rewrites across commits that predate `c73fa64`.
- The subagent signed three commits with the wrong co-author (`big-pickle`). Rewritten before push.
- Fixtures and the e2e config use `*.check.ts` for the mutation-project tests, so the outer suite does not pick them up. Stryker's vitest runner honors the fixture's `include`.
- The hooks embed the absolute path of the governor's `dist/cli.js`. They pointed at the stage-3 worktree until `install` was re-run from the main checkout. A stale `dist/` in that path (left by the aborted rebase) made the first push fail with a usage error.
- The plan did not say to enable mutation in Playground. The probe cannot block otherwise, so `mutation.enabled: true` went into `.governor/config.json` in the same commit (`1407a00`).
- BigBadPlayground `tsc --noEmit` and `npm run build` already fail on `main`: `vitest.config.ts:9` imports the reporter by absolute path, giving two copies of vitest's types (TS2769). Existing tests and the hooks do not run either, so nothing noticed. Not fixed here.

## Deferred
- Playground type error above. Fix with a cast or a packaged reporter import. `deferred`
- Absolute-path coupling between clients and the governor build (still open from Stage 2). `deferred`
- Playground `chore/tdd-governor-mutation` (`1407a00`) is pushed but has no PR yet. `deferred`

## Carried forward
- Known gaps G1–G8 unchanged (spec §9). G1 (`--no-verify` bypass) is now unblocked: a CI workflow running `governor gate commit` and `governor gate push` against the PR diff.
- Stage 4 (pytest adapter) is next.
