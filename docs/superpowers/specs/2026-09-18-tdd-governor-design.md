# TDD Evidence Governor — Design Spec

**Date:** 2026-09-18
**Status:** Approved design, pre-implementation
**Origin:** Refines `BigBadPlayground/docs/concepts/track_a_elite_coding_governor_specification.md` ("Track A")
**Clients:** BigBadPlayground (vitest, stages 1–3), BigBadPhotos (pytest, stage 4)

## 1. Purpose

Stop coding agents (Claude Code, Antigravity, Hermes, Codex — and humans) from
grading their own homework. The governor independently collects test evidence and
blocks commits/pushes that lack it:

- a new or changed test was never seen failing **for a real assertion** before it passed
  (the "import error counts as red" cheat),
- a diff weakens the test suite (`.skip`, `.only`, deleted assertions, deleted test files),
- the suite is not green,
- changed source lines survive mutation (tests execute the code but don't check it).

Principle: **deterministic evidence first; semantic judgment (Jev) only for the
residue, and only once calibrated on real data.** Nothing fails open.

### Non-goals

- Not an MCP tool the agent calls voluntarily with self-reported output (Track A's
  core flaw: the governed party supplied the evidence and chose when to be governed).
- No universal complexity caps, MC/DC mandates, or mandatory property tests.
- No local model training (Track A's "PyJev").
- No worktree auto-purge. The governor cannot clear a client's context window, and
  deleting a failed worktree destroys the evidence needed to debug it.
- No claimed accuracy/latency/cost figures until measured.

## 2. Architecture

Standalone TypeScript/Node CLI in its own repo (`/Volumes/BigBadDrive_1/tdd-governor`),
installed into client repos as a dev dependency. The pytest adapter shells out to
`pytest`. Its only Python is one small plugin file (`python/tdd_governor_pytest.py`)
that writes ledger records.

```
governor run            # run the suite via the adapter, append to ledger
governor gate commit    # fast gates: red-before-green, diff audit, green   (git pre-commit)
governor gate push      # slow gate: diff-scoped mutation                   (git pre-push)
governor install        # write git hooks; verify .governor/config.json exists and is valid
```

Enforcement is **git hooks** (agent-agnostic). Claude Code Stop/PreToolUse hooks may
call the same CLI for earlier feedback; they are optional and add no logic.

### Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `config.ts` | Load + Zod-validate `.governor/config.json` | zod |
| `adapters/types.ts` | `Adapter` interface, `TestRun`, `TestResult` | — |
| `adapters/vitest/` | Command builder, **custom vitest reporter** that writes ledger records, test-location mapping | vitest (peer) |
| `adapters/pytest/` | (Stage 4) pytest plugin writing ledger records, mutmut integration | — |
| `classify.ts` | Map a raw test failure to a `FailureKind` | adapter types |
| `ledger.ts` | Append/read `.governor/ledger.jsonl` | — |
| `git.ts` | Merge-base, staged diff, push diff, changed line ranges | `git` subprocess |
| `gates/*.ts` | One pure function per gate: `(inputs) → GateResult` | types only |
| `cli.ts` | Command dispatch, exit codes, human-readable output | all of the above |

Gates are pure: all I/O (git, ledger, subprocesses) happens in `cli.ts` and the
adapters, so gates are unit-tested with fixtures only.

### Core types

```ts
type FailureKind = 'assertion' | 'collection_error' | 'runtime_error' | 'timeout' | 'unknown';

interface TestResult {
  id: string;              // `${relativeFile} > ${fullName}` (describe chain joined by ' > ')
  file: string;            // repo-relative
  line?: number;           // test declaration line (requires includeTaskLocation)
  status: 'pass' | 'fail' | 'skip';
  failureKind?: FailureKind;
  message?: string;        // first line of the failure, truncated to 300 chars
}

interface LedgerRecord {
  v: 1;
  runId: string;           // random UUID
  at: string;              // ISO timestamp
  head: string;            // git HEAD sha at run time
  adapter: 'vitest' | 'pytest';
  exitCode: number;
  collectionErrors: { file: string; message: string }[];
  tests: TestResult[];
  override?: { gate: string; reason: string };  // written by GOVERNOR_OVERRIDE
}

type GateStatus = 'PASS' | 'BLOCK' | 'UNDECIDED' | 'GATE_UNAVAILABLE';

interface GateResult {
  gate: 'red-before-green' | 'diff-audit' | 'green' | 'mutation';
  status: GateStatus;
  findings: { file: string; line?: number; message: string }[];
}
```

Exit code is 0 **only** if every gate returns `PASS` (or an override was recorded).
`BLOCK`, `UNDECIDED`, and `GATE_UNAVAILABLE` all exit non-zero.

## 3. Evidence recording

The adapter ships a **custom vitest reporter** that the client adds to
`vitest.config.ts` (`reporters: ['default', 'tdd-governor/vitest-reporter']`,
`includeTaskLocation: true`). Every vitest run writes one ledger record, whoever
started it. `governor run` is a convenience wrapper, not a requirement.

Reporter hook: `onTestRunEnd(testModules, unhandledErrors, reason)`. Checked against
BigBadPlayground's installed vitest 3.2.7 on 2026-09-18 (`onFinished` is deprecated).
Stage 1's integration test against real vitest is the proof.

### Classification (`classify.ts`)

Deterministic, applied in order:

1. Error raised while collecting/importing the file (reported as a file-level error,
   no test executed) → `collection_error`
2. Error name `AssertionError`, or the error came from `expect` (vitest `AssertionError`
   / Chai assertion) → `assertion`
3. Test exceeded its timeout → `timeout`
4. Any other thrown error (`TypeError`, `ReferenceError`, custom errors) → `runtime_error`
5. Otherwise → `unknown`

Classification uses structured fields the reporter gives it (error name, task state).
It **never** regex-scans free-form stdout. That is how Track A misclassified a test
named "handles SyntaxError".

Ambiguity note: calling a not-yet-implemented function gives a `TypeError`
(`runtime_error`), not a valid red. This is deliberate. A valid red needs the
implementation stub to exist and return the wrong value. Document this in the
client onboarding notes.

## 4. Gates

### 4.1 Red-before-green (pre-commit)

- **Scope:** test ids whose *span* contains an added line of the staged diff. Test
  spans come from `TestResult.line` in the most recent ledger run: a test spans from
  its declaration line up to the line before the next test in the same file.
  Changes above the first test (imports, helpers) touch no test. New test files:
  every test in the file. A new test file that has no tests in the ledger → BLOCK
  ("never run").
- **PASS** per test: the ledger holds a record since the branch merge-base where that
  id has `status: 'fail'` and `failureKind: 'assertion'`.
- **BLOCK:** no failing record, or the only failures are `collection_error` /
  `runtime_error` / `timeout`.
- **UNDECIDED:** the only failures are `unknown`, or a changed test has no `line`
  (location missing). Stage 5 (Jev) fills this slot.
- Commits that change no test declarations: gate returns `PASS` with no findings.
- A renamed test is a new id and needs a fresh red (or an override). This is accepted friction.

### 4.2 Diff audit (pre-commit)

Operates on staged diff hunks in files matching `testGlobs`. Deterministic.

| Pattern | Result |
|---|---|
| Added `.skip(`, `.only(`, `.todo(`, `xit(`, `xdescribe(` (vitest); `@pytest.mark.skip`, `@pytest.mark.xfail`, `pytest.skip(` (pytest) | BLOCK |
| Net removal of `expect(` / `assert` occurrences in a file | BLOCK |
| Deleted test file | BLOCK |
| `expect.assertions(n)` lowered or removed | BLOCK |
| Snapshot file (`__snapshots__/`, `*.snap`) changed | warning finding, still PASS |

Semantic weakening (`toBe(42)` → `toBeGreaterThan(0)`) is out of scope until Stage 5.

### 4.3 Green (pre-commit)

Runs the suite through the adapter, which also writes a ledger record.
PASS only if exit code is 0 **and** there are zero collection errors. Added skips are
covered by 4.2, so this gate does not re-derive a skip baseline.

### 4.4 Mutation (pre-push)

- Stryker (`@stryker-mutator/core` + vitest runner) with `--mutate` limited to changed
  non-test files matching `sourceGlobs` in the push diff (`@{upstream}..HEAD`, or
  merge-base with `main` when there is no upstream).
- Read `reports/mutation/mutation.json` (the json reporter must be enabled in the
  client's Stryker config; `install` checks this).
- **BLOCK** on any mutant with status `Survived` or `NoCoverage` whose location
  overlaps a changed line. Finding text: `file:line`, mutator name, original → replacement.
- Other mutants (unchanged lines) are ignored. No global score threshold.
- Stryker missing, not configured, times out, or produces no report → `GATE_UNAVAILABLE`.
- No changed source files → PASS.

## 5. Config

`.governor/config.json` (committed in the client repo):

```json
{
  "adapter": "vitest",
  "testGlobs": ["src/**/*.test.ts", "src/**/*.test.tsx"],
  "sourceGlobs": ["src/**/*.ts", "src/**/*.tsx"],
  "mutation": { "enabled": true, "timeoutMs": 300000 },
  "runTimeoutMs": 120000
}
```

No defaults for globs: missing or invalid config → `GATE_UNAVAILABLE`. Wrong globs
would make every gate silently check nothing.

`.governor/ledger.jsonl` is gitignored (`install` adds the entry).

## 6. Error handling

1. A test runner's non-zero exit is data, not an error.
2. Reporter output missing/unparseable → `GATE_UNAVAILABLE`.
3. Every subprocess has a timeout. Timeout → `GATE_UNAVAILABLE`.
4. Corrupt ledger lines are skipped and counted in output. Safe because skipping can
   only remove evidence, which causes a BLOCK, never a PASS.
5. Not a git repo / no merge-base → hard error, clear message, non-zero exit.
6. `GOVERNOR_OVERRIDE="<reason>"` env var: all gates still run and print results,
   the exit is 0, and an override record (`gate`, `reason`) is appended to the ledger.
   An empty reason is rejected.

## 7. Testing the governor

- **Gates:** unit tests over fixture diffs, fixture ledgers, fixture Stryker reports.
- **Classifier + reporter:** integration tests run **real vitest** on
  `test/fixtures/sample-project/`. It contains deliberate cases: an assertion failure,
  an import error, a runtime TypeError, a timeout, a passing test. Classifier fixtures
  are captured from that real output, not hand-written.
- **E2E:** temp git repo → `governor install` → stage a commit that adds `.skip` →
  assert the commit is blocked. A second case: test-first flow (red run, then
  implement, then commit) → assert the commit passes.
- **Dogfood:** from the end of Stage 2 the governor gates its own repo.
- Each stage writes `docs/superpowers/specs/<date>-stage-N-findings.md`, using the
  BigBadPlayground verification labels: `test`, `code-reasoned`, `live-observed`,
  `deferred`. Nothing is marked Pass on reasoning alone.

## 8. Stages

| Stage | Scope | Exit criterion |
|---|---|---|
| 1 | Scaffold, core types, config, vitest reporter, classifier, ledger, `governor run` | Real vitest run on sample-project produces correct ledger record with correct `failureKind` per case |
| 2 | `git.ts`, gates 4.1–4.3, `gate commit`, `install`, override, dogfood, onboard BigBadPlayground | E2E tests pass. BigBadPlayground blocks an added `.skip` and passes a real test-first commit (`live-observed`). |
| 3 | Gate 4.4, `gate push`, BigBadPlayground Stryker config | Push with a surviving mutant on a changed line is blocked in BigBadPlayground (`live-observed`) |
| 4 | pytest adapter (plugin writing ledger records via `pytest_runtest_logreport` / collection hooks), mutmut for 4.4, pytest patterns for 4.2, onboard BigBadPhotos | Same Stage 2+3 criteria, observed in BigBadPhotos |
| 5 | Jev semantic tier: `UNDECIDED` resolution and semantic weakening. Separate spec. | **Entry:** ≥50 labeled `UNDECIDED` cases in ledgers |

Stage 5 design notes, to carry into its own spec:
- Use a single Jev **Choice** (`valid_red | import_or_syntax | env_or_fixture | wrong_test`),
  not Track A's product-of-Nouls formula (correlated questions multiplied, then averaged
  with a contrapositive).
- Thresholds are calibrated on the labeled ledger cases, not the concept's 0.90 / 0.30.
- A Jev service failure → `GATE_UNAVAILABLE`, never PASS.
- Construct the client lazily. A missing API key must not break deterministic gates.

## 9. Known gaps

Tracked deliberately. Each has a fix path; none is fixed in Stages 1–4 unless noted.

| # | Gap | Impact | Fix path | When |
|---|---|---|---|---|
| G1 | `git commit/push --no-verify` bypasses local hooks | Gates are skippable | CI workflow running `governor gate commit` + `gate push` against the PR diff | Small add-on after Stage 3 |
| G2 | Test edited after its red run keeps its stale red evidence (identity = file + name) | A weakened-after-red test passes 4.1 | Store a hash of the test body in `TestResult`; require red evidence matching the committed body | When observed in real use |
| G3 | Ledger is a local file. Any process with shell access can append fake red records. | Local evidence is feedback, not proof | CI re-derives red evidence by running changed tests against the merge-base implementation | With or after G1 |
| G4 | Jev deferred, so the `UNDECIDED` rate is unknown and may block often | Friction, more overrides | Stage 5. Until then, override reasons in the ledger measure the friction. | Stage 5 |
| G5 | ~~Runs outside `governor run` not recorded~~ | — | **Resolved in design:** vitest reporter / pytest plugin records every run | Stage 1 / 4 |
| G6 | Calling an unimplemented function is `runtime_error`, not a valid red | Agents must write a stub first | Documented in onboarding. Revisit if override logs show it's a common friction source. | Monitor |
| G7 | Green gate runs the working tree, not the staged snapshot. Unstaged fixes can make a broken commit pass. | False PASS on partial staging | Run in a temp worktree of the staged tree (`git stash --keep-index` is too risky) | When observed |
| G8 | Test spans are inferred from declaration lines, and line numbers come from the last run, not the staged content | Out-of-date spans after edits made since the last run | Parse test files for exact spans (TS: AST; pytest: `ast`) | When observed |

## 10. Track A disposition

| Track A element | Disposition | Reason |
|---|---|---|
| Deterministic-first tiering | Kept | Core insight |
| Red-phase validity check | Kept, redesigned | Evidence collected by governor, classified from structured reporter data |
| `audit_git_diff` | Kept, made deterministic | Regex over diff hunks. Jev only for semantic weakening in Stage 5. |
| Mutation testing | Kept, diff-scoped | Global 85% score replaced by survivors on changed lines |
| Three-band escalation | Kept (as `UNDECIDED`) | Jev fills it in Stage 5 |
| MCP server interface | Cut from v1 | Advisory and self-reported. Could return later as a read-only ledger/status view. |
| Supercov / MC/DC | Cut | Existence unverified. Mutation on changed lines covers the intent. |
| Complexity ≤10, no-sync-IO-in-loops | Cut | Universal caps block legitimate GPU/React code. Belongs in a linter config if wanted. |
| Mandatory property fuzzing | Cut | Useful per-module, not as a gate |
| Worktree quarantine/purge | Cut | Cannot purge client context. Purging destroys evidence. |
| PyJev local model | Cut | Research project. Revisit only if measured Jev latency/cost is a problem. |
| SWE-bench validation | Cut | Python-only, expensive, not the target stack |
| Metrics table (97–99%, ~12 ms, cost) | Removed | Unmeasured |
