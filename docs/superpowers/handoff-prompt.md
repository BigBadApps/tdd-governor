# Handoff prompt: TDD Governor implementation

Paste the prompt below into a fresh agent session (Claude Code or Antigravity).
**One stage per session.** Fill in the three `<...>` fields from the stage table, and
the agent does the rest. Run the stages in order. Each stage's findings doc is input to
the next.

## Stage table

| Stage | `<STAGE>` | `<PLAN>` | `<BRANCH>` | Touches other repos? |
|---|---|---|---|---|
| 1 | 1 | `docs/superpowers/plans/2026-09-18-stage-1-evidence-recording.md` | `feat/stage-1-evidence-recording` | No |
| 2 | 2 | `docs/superpowers/plans/2026-09-18-stage-2-commit-gates.md` | `feat/stage-2-commit-gates` | BigBadPlayground (Task 8) |
| 3 | 3 | `docs/superpowers/plans/2026-09-18-stage-3-mutation-gate.md` | `feat/stage-3-mutation-gate` | BigBadPlayground (Task 5) |
| 4 | 4 | `docs/superpowers/plans/2026-09-18-stage-4-pytest-adapter.md` | `feat/stage-4-pytest-adapter` | BigBadPhotos (Task 5) |

Stage 5 (Jev) has no plan yet. Its entry criterion is in spec §8. Don't hand it off.

---

```
You are implementing Stage <STAGE> of the TDD Evidence Governor, a pre-written plan in
the tdd-governor repo (/Volumes/BigBadDrive_1/tdd-governor). You have zero prior context.
Everything you need is below or in the referenced files.

## What this project is (one paragraph)

A Node/TypeScript CLI that stops coding agents from grading their own tests. A vitest
reporter / pytest plugin records every test run into .governor/ledger.jsonl with each
failure classified (assertion / runtime_error / collection_error / timeout / unknown).
Git hooks then block commits unless the suite is green, every added or changed test was
seen failing *for a real assertion* before it passed, and the diff doesn't weaken the
suite. Pushes are blocked when mutants survive on changed lines. Deterministic only; a
semantic tier (TypeSafe Jev) is deferred to Stage 5. Nothing fails open.

## Read in full before doing anything

1. The plan:      <PLAN>
2. The spec:      docs/superpowers/specs/2026-09-18-tdd-governor-design.md
3. Prior stage findings (Stages 2–4 only): docs/superpowers/specs/*-stage-<STAGE minus 1>-findings.md
   If the previous stage's findings doc does not exist, stop and tell me. The previous
   stage isn't finished.

The plan has literal code per step, TDD-style (failing test first). Its Global
Constraints section is binding. Spec §9 "Known gaps" (G1–G8) lists deliberate
limitations. Don't fix them unless the plan says to, and add any new gap you find there.

## Starting state

- Repo: /Volumes/BigBadDrive_1/tdd-governor. Branch `main`. There is NO git remote. Do
  not create one or a GitHub repo. That's my call.
- Branch off `main` → <BRANCH>. If that name exists, use the next free numeric suffix
  and say so. If the plan's changes already appear on `main`, stop and tell me.
- Plan checkboxes may already read [x]. Treat work as NOT done. Verify real state with
  `git log` / `git status` / the gate.
- Node ≥ 22 is required (`node -v`). Stage 4 also needs Python ≥ 3.11 (`python3 -V`).

## Workflow (follow exactly)

1. Isolated workspace: superpowers:using-git-worktrees.
2. Run the plan with superpowers:subagent-driven-development. One fresh subagent per
   task, in order (tasks depend on each other). Each subagent implements only its task,
   writes the failing test first, runs each step's command and confirms the stated
   Expected output, ends with the gate green, and commits with the plan's exact message.
3. Between tasks: mattpocock-skills:code-review (two-axis: Standards + Spec) against
   the branch's merge-base with `main`. Weigh feedback with
   superpowers:receiving-code-review. Clear MUST-fix findings before the next task.
4. After the last code task, run the full gate: `npx tsc --noEmit && npm test && npm run build`.
   All must pass.
5. Write the stage findings doc exactly as the plan's final task specifies. Every
   criterion is tagged `test` / `code-reasoned` / `live-observed` / `deferred`. Never write
   Pass for something only code-reasoned. Record real wall-clock numbers where asked.
6. Finish with superpowers:finishing-a-development-branch, choosing the **local merge**
   option: `git merge --no-ff <BRANCH>` into `main` (no squash). No push, no PR: there's
   no remote.

## Rules that the plans rely on (do not relitigate)

- **Real tool output beats the plan.** Several tasks run real vitest / pytest / Stryker /
  mutmut and assert on the result. If real output disagrees with the plan's code, fix the
  implementation from the observed output, **never** loosen a test expectation to fit.
  Record each such deviation in the findings doc.
- **Fail closed.** No `catch {}` that turns a missing tool, config, report, or timeout
  into success. Those become GATE_UNAVAILABLE / non-zero exit.
- **Gates are pure** (`src/gates/*`: no fs, child_process, or process.env).
- Strict TS, no `any`, ESM with `.js` relative imports.
- Commit after every task. Don't squash. Trailer: `Co-Authored-By: <your model name> <noreply@anthropic.com>`.
  The plans show `Claude Opus 5`; use your actual model name.
- **From Stage 2 Task 7 onward, this repo's own pre-commit hook governs you.** Never use
  `git commit --no-verify` or `GOVERNOR_OVERRIDE` in the tdd-governor repo unless a plan
  step literally shows it (temp-repo setup inside e2e tests does). If the hook blocks
  you, that's the product working: fix the cause. If you believe the block is a governor
  bug, stop and tell me with the hook output. Don't bypass it.
  After Stage 2, `dist/` must be rebuilt (`npm run build`) before the hook sees changes
  to the governor's own code.
- Commits in the governor repo run its full suite, including real Stryker/mutmut tests
  from Stage 3 on. Several minutes per commit is expected. Don't disable tests to speed
  it up.

## Client-repo tasks (Stages 2, 3, 4)

Those tasks modify another repo. For each one:
- Read that repo's CLAUDE.md / AGENTS.md first. Its rules (verification gate, commit
  trailer, branch naming) apply inside it.
- `git status` must be clean before you branch. If it isn't, stop and ask me. Never
  stash, reset, or commit someone else's work.
- Branch off that repo's `main`. BigBadPhotos is currently on
  `bbaf/bigbadphotos-ingest-killswitch`: do not modify that branch.
- Commit on your branch there. **Do not push, open PRs, or merge in client repos**
  without asking me first. They have GitHub remotes. Report the branch + SHAs instead.
  Exception: the Stage 3 plan's push acceptance probe needs a push. Ask me before
  running it, or run it against a local bare remote (`git init --bare` in the scratchpad)
  and say which you did.
- If a client's suite is already red on `main`, stop and report which tests fail.

## Stop and ask me when

- Stage 4 Task 4 decision point: mutmut output lacks real file line numbers.
- Any plan step's Expected result can't be reached without changing a test expectation
  or a spec rule.
- A client repo's working tree is dirty, or its baseline suite is red.
- You'd need to create a remote, push, open a PR, or merge outside tdd-governor's local `main`.

## Reporting

Report: branch name, per-task commit SHAs, local merge SHA, final gate output (test
counts), findings-doc path, client-repo branches + SHAs (if any), wall times measured,
every deviation from the plan's literal code and why, and any new Known Gap added to
spec §9.
```
