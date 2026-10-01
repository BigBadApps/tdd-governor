// Written to .governor/PRIMER.md by `governor install`. Agents that hit a block read this instead of the governor's source.
// configFile: the vitest/vite config install found the reporter should be wired into (repo-relative, package-scoped
// for a monorepo), or undefined when none was found — then the wording stays generic rather than naming a guess.
export function renderPrimer(configFile: string | undefined): string {
  const reporterLine = configFile
    ? `\`test.reporters\` in \`${configFile}\` (the governor's \`install\` does not add this for you; check it is`
    : "`test.reporters` in your vitest config (a `vitest.config.*`, or `test` in `vite.config.*` for a Vite\nproject; the governor's `install` does not add this for you; check it is";
  return `# TDD governor: what agents need to know

This repo's git hooks run the governor. Every commit needs three gates green:

- **green**: the whole test suite passes.
- **red-before-green**: every new or changed test was seen failing on an assertion first.
- **diff-audit**: no added skip/only/todo, no net loss of assertions.

## What counts as a red

A test failure that is an \`expect(...)\` failure (\`AssertionError\`), recorded in \`.governor/ledger.jsonl\`.
\`npx governor run -- <test files>\` always records. A plain \`vitest run\` records only when the governor's
reporter is wired into ${reporterLine}
there before trusting a plain run). You never write the ledger yourself.

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
- A merge commit is gated only on what the merge itself changes (conflict resolution); tests the merged branch brought in were gated on that branch.

## Excuses that do not work

When a gate blocks you, these thoughts mean stop and get the missing red instead:

- **"It's too simple to test."** Simple code breaks too, and the gate does not grade difficulty. Write the test.
- **"I'll add the test after."** If the code already works, a test written afterward may pass on its first run and leave no recorded red. Write the stub first, then the test, then the real code.
- **"I tested it manually."** Manual checks leave no ledger line and cannot be repeated. The gate only reads the ledger.
- **"The test is obviously right."** A test you never saw fail might assert nothing. The red is the proof.
- **"I'll break the code for a moment to record a red."** That proves the break, not the test. See the workflow above.
- **"I'll skip or weaken this one test."** \`.skip\`, \`.only\`, \`.todo\` and lost assertions are blocked. Fix the test instead.
- **"Only the governor is wrong."** Sometimes it is, but you decide that with evidence, not by feeling. See the override questions below.
- **"Just this once."** The override is recorded in the ledger, and CI ignores it.

## Never bypass

Do not use \`git commit --no-verify\` or \`GOVERNOR_OVERRIDE\`. An override is recorded in the ledger.
If a block looks wrong, stop and tell the human what the governor printed.

## Asking the human for an override

The human decides overrides and may not read code. Answer these three questions in plain words, with the
evidence for each:

1. **Is the governor wrong here?** A false alarm caused by how the governor works (for example a merge
   bringing in tests whose reds live in another worktree's ledger), not work that skipped a step.
2. **Is there real proof each flagged test failed before it passed?** An actual ledger line, per test.
   "I'm sure it did" is not proof.
3. **Has the governor bug been written down to fix?** An issue or note naming the false alarm.

If any answer is no or unknown, do not ask for an override. Get the missing red instead, or report the
gap. Never edit or copy ledger lines to fill it.
`;
}

// Vitest resolves its own config first; a Vite project (test in vite.config.*) is the fallback.
const CANDIDATES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];

export function findVitestConfig(packageDir: string, existsSync: (p: string) => boolean): string | undefined {
  return CANDIDATES.find((name) => existsSync(`${packageDir}/${name}`));
}

// install's advice when plain `vitest run` will not record: gates still work (they inject the reporter),
// but an agent's own red runs would leave no evidence.
export function reporterWarning(configFile: string | undefined, content: string | undefined): string | undefined {
  if (content !== undefined && /vitest-reporter|adapters\/vitest\/reporter|tdd-governor-cli-path/.test(content)) return undefined;
  const where = configFile ? `${configFile} does not load the governor reporter` : 'no vitest config found';
  return `warning: ${where}, so a plain \`vitest run\` records no evidence. Run tests with \`npx governor run -- <test files>\`, or add \`new GovernorReporter()\` from 'tdd-governor/vitest-reporter' to test.reporters (README, Reporter).`;
}


