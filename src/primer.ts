// Written to .governor/PRIMER.md by `governor install`. Agents that hit a block read this instead of the governor's source.
export const PRIMER = `# TDD governor: what agents need to know

This repo's git hooks run the governor. Every commit needs three gates green:

- **green**: the whole test suite passes.
- **red-before-green**: every new or changed test was seen failing on an assertion first.
- **diff-audit**: no added skip/only/todo, no net loss of assertions.

## What counts as a red

A test failure that is an \`expect(...)\` failure (\`AssertionError\`), recorded in \`.governor/ledger.jsonl\`
by the governor's vitest reporter. Every \`vitest run\` is recorded automatically once it is wired into
\`test.reporters\` in \`vitest.config.ts\` (the governor's \`install\` does not add this for you; check it is
there before trusting a red run). You never write the ledger yourself.

These are NOT reds, and the commit will be blocked:

- a missing export (\`x is not a function\`, \`Cannot find module\`): the test never reached an assertion
- any error thrown inside the test (ENOENT, dereferencing undefined)
- a test that never failed at all

## Workflow that passes first time

1. Write the test.
2. Write a **stub** of the implementation: export every symbol the test imports, with the right signature
   and a wrong return value (\`return 0\`, \`return []\`).
3. Run the test file. Confirm each new test fails with an assertion error, not a crash.
4. Write the real implementation. Run again: green.
5. Commit.

Write the stub *before* the real code. Breaking working code afterwards to record a red proves nothing and
wastes a cycle.

## Details that block people

- A brand-new test file: every test in it needs its own assertion red. A stub that happens to return the
  expected value for one test leaves that test with no red; make the stub wrong for all of them.
- Editing a test also puts it in scope: it needs a red in the same evidence window.
- Evidence counts from the merge-base with \`main\` to now, per worktree (each worktree has its own ledger).
- A \`.skip\`, \`.only\` or \`.todo\` is blocked outright, and deleting assertions is blocked unless you add as many.

## Never bypass

Do not use \`git commit --no-verify\` or \`GOVERNOR_OVERRIDE\`. An override is recorded in the ledger.
If a block looks wrong, stop and tell the human what the governor printed.
`;
