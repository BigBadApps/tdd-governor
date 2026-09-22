# Merge-Scoped Commit Diff Implementation Plan (issue #16)

**Goal:** A merge commit is gated only on the work done in the merge itself (conflict resolution), not on everything the merged branch brings in.

**Problem:** `gate commit` diffs the index against `HEAD` (first parent). On a merge, that diff contains the whole merged branch. Its tests were TDD'd in another worktree, whose ledger this worktree cannot see, so `red-before-green` reports them as "never seen failing" (BigBadPlayground PR #14: 17 findings, 14 with real reds in a sibling worktree's ledger). `diff-audit` has the same blind spot for skips and assertion removals the other branch made.

**Architecture:** When `MERGE_HEAD` exists, also diff the index against each merge head and keep only what is new relative to **every** parent. A pure `mergeScoped` in `src/diff.ts` does the intersection. `commitDiff` in `src/git.ts` replaces `stagedDiff` as the diff `gateCommit` feeds to both `redBeforeGreen` and `diffAudit`. Gates are unchanged.

**Why this and not a shared ledger:** a parent's version of a file already passed the gates when it was committed on its own branch. Git already records the parents; no cross-worktree state, no ledger copying (indistinguishable from forgery), works the same in every worktree.

## Global Constraints

- Branch `fix/merge-scoped-diff`, worktree `/Volumes/BigBadDrive_1/tdd-governor/.worktrees/merge-scoped-diff`. Baseline on `main` b359ef7: 129 tests, 19 files.
- The governor gates its own commits. Test-first: test, then a stub so the test fails on an **assertion**, run `npx vitest run <file>` (records the red), then implement.
- Never `--no-verify` or `GOVERNOR_OVERRIDE`. Never edit `.governor/ledger.jsonl`.
- Do not push, open PRs, or delete branches.
- Final gate per task: `npx tsc --noEmit && npm test && npm run build` exit 0.
- ESM; relative imports end in `.js`. Match the surrounding style: short comments, `ponytail:` comment on any deliberate simplification.

## Semantics of `mergeScoped(ours, theirs)`

`ours`: staged diff vs `HEAD`. `theirs`: one staged diff per merge head. Both use `git diff --cached -U0 <commit>`, so every **added** line is numbered in the index, identical across diffs.

For each file in `ours`:

| Case | Result |
|---|---|
| File absent from some `theirs` diff (index equals that parent's version) | drop the file |
| Added line | keep only if the same line number is added in every `theirs` diff |
| Removed line | keep only if a removed line with the same text exists in every `theirs` diff (`ponytail:` text match, not a multiset) |
| Status | `added` / `deleted` only if every `theirs` diff has the same status; otherwise `modified` |
| Nothing left (no added, no removed, status not `deleted`) | drop the file |

No merge in progress: `commitDiff` returns `stagedDiff` unchanged.

## File Structure

| File | Change |
|---|---|
| `src/diff.ts` | add `mergeScoped` |
| `src/git.ts` | add `mergeHeads`, `commitDiff` |
| `src/cli.ts` | `gateCommit` uses `commitDiff` |
| `src/primer.ts` | one sentence on merge commits |
| `test/diff.test.ts` | unit tests for `mergeScoped` |
| `test/git.test.ts` | `commitDiff` against a real merge in progress |
| `test/e2e.commit.test.ts` | merge commit end to end |
| `test/install.test.ts` | primer sentence |

## Task 1: `mergeScoped` (pure)

Tests in `test/diff.test.ts`, new `describe('mergeScoped')`. Build `FileDiff` literals by hand.

1. drops a file that only the other parent changed (absent from `theirs`)
2. keeps an added line that is new against both parents; drops one that only `ours` sees
3. treats a file the other branch created as not added (it is `added` in `ours`, absent from `theirs`: dropped)
4. drops a removed line the other parent already removed (text not in `theirs.removed`); keeps one removed against both
5. octopus: with two `theirs` diffs, a line must be added in both to be kept
6. `status` is `deleted` only when deleted against every parent

Stub: `export function mergeScoped(ours: FileDiff[], _theirs: FileDiff[][]): FileDiff[] { return ours; }` so every test fails on an assertion. Then implement per the table. Reference shape:

```ts
// Merge commit: keep only what is new against every parent. Added lines share the index's numbering across
// the diffs; removed lines are numbered per parent, so they are matched by text.
export function mergeScoped(ours: FileDiff[], theirs: FileDiff[][]): FileDiff[] {
  return ours.flatMap((f) => {
    const others = theirs.map((d) => d.find((o) => o.path === f.path));
    if (others.some((o) => o === undefined)) return [];
    const added = f.added.filter((a) => others.every((o) => o!.added.some((b) => b.line === a.line)));
    const removed = f.removed.filter((r) => others.every((o) => o!.removed.some((b) => b.text === r.text)));
    const status = others.every((o) => o!.status === f.status) ? f.status : 'modified';
    return added.length > 0 || removed.length > 0 || status === 'deleted' ? [{ path: f.path, status, added, removed }] : [];
  });
}
```

Commit: `feat(diff): mergeScoped keeps only what a merge adds against every parent`

## Task 2: `commitDiff` and wiring

`src/git.ts`:

- `mergeHeads(root)`: read the file at `git rev-parse --git-path MERGE_HEAD` (resolve relative to `root`, as `installHooks` does for `hooks`); one sha per non-empty line; `[]` if the file does not exist. Must work in a linked worktree (the path is per-worktree).
- `commitDiff(root)`: `stagedDiff(root)` when `mergeHeads` is empty; otherwise `mergeScoped(stagedDiff(root), heads.map((h) => parseUnifiedDiff(git(root, ['diff', '--cached', '-U0', '--no-color', '--no-renames', '--no-ext-diff', h]))))`.

`src/cli.ts`: in `gateCommit`, `const diff = commitDiff(root);`. Nothing else changes.

Tests in `test/git.test.ts` (real repos in tmpdir, same helper style as the existing `pushBase` tests):

1. no merge in progress: `commitDiff` equals `stagedDiff`
2. `git merge --no-commit --no-ff feature` where `feature` added `tests/x.test.ts` and changed `a.ts`: `commitDiff` is `[]`
3. same, then edit `a.ts` in the index during the merge: only that edit's lines remain
4. merge in progress inside a linked worktree (`git worktree add`): `mergeHeads` finds the head

End-to-end tests, same commit, in `test/e2e.commit.test.ts` (reuse `makeRepo`, `write`, `runTests`):

5. **gates a merge only on what the merge adds** (one test, two commits attempted):
   - On branch `feature`: add `src/m.ts` + `tests/m.test.ts`, commit with `--no-verify` (this repo's ledger has no red for it, like a sibling worktree). On `main`: an unrelated commit with `--no-verify`, so the merge is not a fast-forward.
   - `git merge --no-commit --no-ff feature`. Add a second `it` with an `expect` to `tests/m.test.ts`, `git add -A`, `runTests(root)` (green, so no red for it). `git commit -q --no-edit`: expect exit 1, output names the new test.
   - `git checkout MERGE_HEAD -- tests/m.test.ts` (drop the extra test), `runTests(root)`, `git commit -q --no-edit`: expect exit 0 and `[PASS] red-before-green`.

**Stubs that make every new test fail on an assertion** (a stub returning `stagedDiff` would let test 1 pass and give it no red):

- `mergeHeads` returns `[]`.
- `commitDiff` returns `[{ path: 'stub', status: 'modified', added: [], removed: [] }]`.

Order: write tests 1 to 5, add both stubs, wire `commitDiff` into `gateCommit`, `npm run build` (the e2e runs `dist/`), run `npx vitest run test/git.test.ts test/e2e.commit.test.ts` and confirm each new test fails on an assertion (test 5 fails on its first `expect`, exit 0 instead of 1). Then implement, rebuild, all green.

Commit: `fix(commit): gate a merge commit only on what the merge itself adds (#16)`

## Task 3: primer

`src/primer.ts`, under "Details that block people", add: `- A merge commit is gated only on what the merge itself changes (conflict resolution); tests the merged branch brought in were gated on that branch.` Add one assertion to the primer test in `test/install.test.ts` (`/merge commit is gated only on what the merge itself changes/`). Red first, then text.

Commit: `docs(primer): say what a merge commit is gated on`

## Out of scope (report, do not fix)

- A merge with **no conflicts** runs the `pre-merge-commit` hook, not `pre-commit`. The governor installs only `pre-commit` and `pre-push`, so clean merges are not gated at all. Installing `pre-merge-commit` is a separate decision once this lands.
- Tests that are always skipped (for example `describe.skipIf(!hasGpu)`) can never produce a red. No "unverifiable" status yet.

## Done when

- 3 commits, each passing all three gates with no override.
- Full suite green: expect 140 tests (129 + 6 unit + 5 git/e2e; the primer change edits an existing test).
- A short findings note in the final report: each red's output line, the final test count, and anything in "Out of scope" that was observed.
