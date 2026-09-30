# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/BigBadApps/tdd-governor/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it, and the version or commit.

You can expect an acknowledgement within a week. This is a small project maintained on a best-effort
basis, so there is no fixed fix deadline.

## Scope

The governor runs your test suite and, optionally, Stryker, from git hooks and CI. Reports about the
hooks executing unintended commands, the ledger being forged or bypassed in a way the gates do not
record, or the CI template leaking a token are in scope.

`GOVERNOR_OVERRIDE` and `git commit --no-verify` are deliberate escape hatches, not vulnerabilities.
The override is recorded in the ledger, and `gate ci` ignores it.
