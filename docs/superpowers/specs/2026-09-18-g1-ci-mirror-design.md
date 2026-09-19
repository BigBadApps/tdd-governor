# G1 CI Mirror — Design

**Date:** 2026-09-18
**Closes:** spec §9 gap G1 (`git commit/push --no-verify` bypasses the local hooks)
**Parent spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md`
**Prerequisite:** Stage 3 merged (done).

## Goal

A pull request cannot merge with a diff that the local gates would have blocked, even when the author bypassed the hooks with `--no-verify`. CI re-runs the gates that can be computed from the PR diff alone.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Which gates run in CI? | `green`, `diff-audit`, `mutation`. `red-before-green` is skipped. | `red-before-green` needs the local ledger, which CI does not have. Re-deriving red evidence is G3 and a separate stage. |
| How does CI get the governor? | Checkout of `BigBadApps/tdd-governor` at a pinned SHA using a read-only secret, then build. | Both repos are private, so the default token cannot read the governor. No publishing step. |
| Are overrides honored in CI? | No. | An override is a local-ledger record; on a runner it would only be an env var that anyone with workflow access could set. |

## Design

### 1. `governor gate ci [--base <ref>]`

- **Base:** `--base <ref>`, else `origin/$GITHUB_BASE_REF`, else `main`. The base commit is `git merge-base HEAD <ref>`. The diff is `base..HEAD`, computed with the existing `pushDiff`.
- **Gates:** `green` (runs the tests via the adapter, as `gate commit` does), `diff-audit` on the PR diff, and `mutation` on the PR diff's changed source lines.
- **Shared code:** the mutation logic moves out of `gatePush` in `src/cli.ts` into one function used by both `gate push` and `gate ci`, so the two cannot drift. `gate push` behavior is unchanged.
- **Skipped gate is visible:** output includes `red-before-green: skipped in CI (needs local ledger, G3)`. It is a printed line, not a silent omission, and it does not affect the exit code.
- **Overrides:** `GOVERNOR_OVERRIDE` is ignored. If it is set, CI prints one line saying so and proceeds as if it were unset.
- **Exit codes:** 0 pass, 1 blocked, 2 usage or environment error (for example, no merge-base because the checkout was shallow). A shallow checkout is never a pass.
- **Config:** reads `.governor/config.json` exactly as the other gates do. If `mutation.enabled` is false, the mutation gate passes with the existing "disabled" warning.

### 2. Workflow template: `templates/governor-ci.yml`

A file clients copy to `.github/workflows/governor.yml`. It:

1. Triggers on `pull_request`.
2. Checks out the client repo with `fetch-depth: 0`.
3. Clones `BigBadApps/tdd-governor` into `$RUNNER_TEMP/governor`, authenticating with the secret `GOVERNOR_READ_TOKEN`, checks out a pinned SHA, and runs `npm ci && npm run build` there. It lives outside the workspace so the client's test runner cannot discover the governor's own tests.
4. Installs the client's dependencies (`npm ci`).
5. Runs `node $GOVERNOR_HOME/dist/cli.js gate ci` with `GOVERNOR_HOME=$RUNNER_TEMP/governor` and Node 22.

Bumping the pinned SHA is a manual edit.

### 3. Client change: reporter path

BigBadPlayground's `vitest.config.ts` imports the reporter from the absolute path `/Volumes/BigBadDrive_1/tdd-governor/dist/adapters/vitest/reporter.js`. On a runner that path does not exist and the config fails to load. The client changes the import to resolve from `process.env.GOVERNOR_HOME`, falling back to the current local path. This ships as a small Playground PR after the governor side lands. It also removes one instance of the absolute-path coupling deferred since Stage 2.

## Testing

- **Unit:** base resolution (`--base`, `GITHUB_BASE_REF`, `main` fallback, no merge-base gives exit 2).
- **e2e (temp repo, PR-style branch, no hooks installed):**
  - an added `.skip` blocks with exit 1
  - a clean diff passes with exit 0
  - a mutation survivor on a changed line blocks (reusing the `mutation-project` fixture)
  - the `red-before-green` skipped line is printed
  - `GOVERNOR_OVERRIDE` set to a valid reason still blocks, and the notice is printed
- **Regression:** the existing `e2e.push` and `e2e.commit` suites pass unchanged after the shared-code extraction.
- **Live (`live-observed`):** a BigBadPlayground PR that adds a `.skip` turns the workflow red; a clean PR turns it green.

## Out of scope

- Re-deriving red evidence in CI (G3).
- Publishing the governor as a package.
- Making the check required on `main`. That is a GitHub branch-protection setting the user configures.
- Adding the `GOVERNOR_READ_TOKEN` secret. The user creates it.
- The pytest adapter (Stage 4). `gate ci` on a pytest project reports `GATE_UNAVAILABLE` until Stage 4, like the other gates.

## Known limits

- Anyone who can edit `.github/workflows/` in a PR can weaken the workflow. Branch protection with required checks and a protected workflow file is the mitigation and is outside this design.
- The gate trusts the PR's own `.governor/config.json`. A PR that sets `mutation.enabled: false` disables the mutation gate for itself. Reading config from the base ref is a possible follow-up.
