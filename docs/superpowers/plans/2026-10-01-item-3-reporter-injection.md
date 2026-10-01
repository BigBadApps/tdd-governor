# Item 3: The Governor Injects Its Own Vitest Reporter (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `governor run` and every gate record evidence even when the client's vitest config does not load the reporter, and `install` warns when plain `vitest run` will not record reds.

**Architecture:** `runVitest` passes `--reporter=default --reporter=<governor's own reporter file> --includeTaskLocation` on the vitest command line. CLI reporters replace config reporters, so a client that also wires the reporter in its config still gets exactly one record per run. `install` then checks the vitest config text for the reporter and prints a warning plus the fix when it is absent. It never edits the client's config.

**Tech Stack:** Node 22, TypeScript (strict, ESM), vitest 3.2.x (CLI flags `--reporter`, `--includeTaskLocation`).

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` (§3 Evidence recording). Overview: `docs/superpowers/plans/2026-10-01-overview-items-1-2-3.md`.

## Global Constraints

- Fail closed: if vitest runs and no record with this run's `runId` appears, the outcome is `unavailable` and never a pass.
- Gates stay pure (`src/gates/*`: no fs, child_process, process.env).
- Strict TS, no `any`, ESM with `.js` relative imports.
- Never edit a client's vitest/vite config file. Detect and advise only.
- Exactly one ledger record per run, including when the client config loads the reporter too.
- The governor's own pre-commit hook governs you. Never use `--no-verify` or `GOVERNOR_OVERRIDE`. Rebuild `dist/` (`npm run build`) after changing `src/`, before committing, because the hook runs the built CLI.

## File Structure

```
src/adapters/vitest/run.ts          # inject reporter + includeTaskLocation
src/primer.ts                       # reporterWarning(); primer recommends `governor run`
src/cli.ts                          # install prints reporterWarning for the vitest adapter
test/cli-run.integration.test.ts    # injection behaviour against real vitest
test/install.test.ts                # reporterWarning + primer wording
README.md, templates/governor-ci.yml  # reporter becomes optional for gates
```

---

### Task 1: `runVitest` injects the reporter

**Files:**
- Modify: `src/adapters/vitest/run.ts`
- Test: `test/cli-run.integration.test.ts`

**Interfaces:**
- Produces: `runVitest(root: string, timeoutMs: number, extraArgs?: string[]): RunOutcome`. The signature is unchanged. It now records without client reporter config.
- Exports `GOVERNOR_REPORTER: string`, the absolute path of the reporter file it injects. Item 2 and Item 1 rely on runs always recording.

- [ ] **Step 1: Write the failing tests**

In `test/cli-run.integration.test.ts`, delete the test `'is unavailable when the reporter is not configured'`. Add these inside `describe('runVitest', ...)`, and add `readLedger` to the imports (`import { readLedger } from '../src/ledger.js';`):

```ts
  it('records a run when the vitest config does not load the reporter', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-nr-')), 'l.jsonl');
    const outcome = runVitest(path.resolve(__dirname, 'fixtures/no-reporter'), 60_000);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.tests).toHaveLength(1);
      expect(outcome.record.tests[0]!.line).toBe(3); // includeTaskLocation was injected too
    }
  });

  it('writes exactly one record when the config also loads the reporter', () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-dup-')), 'l.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = ledger;
    const outcome = runVitest(fixture, 60_000);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(readLedger(ledger).records.filter((r) => r.runId === outcome.record.runId)).toHaveLength(1);
  });

  it('is unavailable when the reporter writes nothing', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-off-')), 'l.jsonl');
    process.env.GOVERNOR_DISABLE_REPORTER = '1';
    try {
      const outcome = runVitest(path.resolve(__dirname, 'fixtures/no-reporter'), 60_000);
      expect(outcome).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/no ledger record/) });
    } finally {
      delete process.env.GOVERNOR_DISABLE_REPORTER;
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli-run.integration.test.ts`
Expected: FAIL on `records a run when the vitest config does not load the reporter`, with outcome `unavailable` because no reporter was configured. The other two may pass already. That's fine: they guard the new code.

- [ ] **Step 3: Implement**

In `src/adapters/vitest/run.ts`, add the imports and constant, and change the spawn args and the missing-record reason:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The governor passes its own reporter on the command line, so gates record evidence whether or not the
// client's vitest config loads it. CLI reporters replace config reporters: still one record per run.
// reporter.ts is the fallback for this repo's tests, which run from src/ before the build.
const here = path.dirname(fileURLToPath(import.meta.url));
export const GOVERNOR_REPORTER = ['reporter.js', 'reporter.ts'].map((f) => path.join(here, f)).find((f) => existsSync(f))!;
```

```ts
  const res = spawnSync(
    'npx',
    ['--no-install', 'vitest', 'run', '--root', root, '--reporter=default', `--reporter=${GOVERNOR_REPORTER}`, '--includeTaskLocation', ...skipSiblings, ...extraArgs],
    { cwd: root, env: childEnv(runId), stdio: 'inherit', timeout: timeoutMs },
  );
```

```ts
  if (!record) {
    return { kind: 'unavailable', reason: 'vitest ran but the governor reporter wrote no ledger record (is GOVERNOR_DISABLE_REPORTER set?)' };
  }
```

**If the duplicate-record test fails** (vitest merged the CLI and config reporters instead of replacing them), don't remove the test. Make the reporter idempotent per run instead: in `src/adapters/vitest/reporter.ts` `onTestRunEnd`, after computing `runId`, return early when `readLedger(ledgerPath(this.root)).records.some((r) => r.runId === runId)`. Record the observed vitest behaviour as a deviation in the PR body.

- [ ] **Step 4: Run to verify pass, plus the e2e suites that drive `runVitest`**

Run: `npx vitest run test/cli-run.integration.test.ts test/e2e.commit.test.ts test/e2e.ci.test.ts`
Expected: PASS.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/adapters/vitest/run.ts test/cli-run.integration.test.ts
git commit -m "feat: gates record evidence without a configured reporter

The governor passes its own reporter and includeTaskLocation on the vitest
command line, so a missing config entry no longer makes every gate
GATE_UNAVAILABLE.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 2: `install` warns when plain `vitest run` won't record, and the primer points at `governor run`

**Files:**
- Modify: `src/primer.ts`, `src/cli.ts`
- Test: `test/install.test.ts`

**Interfaces:**
- Consumes: `findVitestConfig(packageDir, existsSync)` (existing, `src/primer.ts`).
- Produces: `reporterWarning(configFile: string | undefined, content: string | undefined): string | undefined` in `src/primer.ts`. It returns `undefined` when `content` contains `vitest-reporter` (the package export name) or `adapters/vitest/reporter` (a direct path, as this repo and the e2e fixtures use). Otherwise it returns a warning string.

- [ ] **Step 1: Write the failing tests** (append to `test/install.test.ts`; add `reporterWarning, renderPrimer` to an import from `'../src/primer.js'`)

```ts
describe('reporterWarning', () => {
  it('is silent when the config loads the reporter by package name', () => {
    expect(reporterWarning('vitest.config.ts', "import R from 'tdd-governor/vitest-reporter';")).toBeUndefined();
  });

  it('is silent when the config loads the reporter by path', () => {
    expect(reporterWarning('vitest.config.ts', "import R from '../dist/adapters/vitest/reporter.js';")).toBeUndefined();
  });

  it('names the config and the fix when the reporter is missing', () => {
    const w = reporterWarning('frontend/vite.config.ts', 'export default {}');
    expect(w).toMatch(/frontend\/vite\.config\.ts/);
    expect(w).toMatch(/governor run/);
    expect(w).toMatch(/tdd-governor\/vitest-reporter/);
  });

  it('warns when no vitest config was found', () => {
    expect(reporterWarning(undefined, undefined)).toMatch(/no vitest config/);
  });
});

describe('primer', () => {
  it('tells agents that `governor run` always records', () => {
    expect(renderPrimer('vitest.config.ts')).toContain('npx governor run -- <test files>');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/install.test.ts`
Expected: FAIL, `reporterWarning` is not exported.

- [ ] **Step 3: Implement**

In `src/primer.ts`, append:

```ts
// install's advice when plain `vitest run` will not record: gates still work (they inject the reporter),
// but an agent's own red runs would leave no evidence.
export function reporterWarning(configFile: string | undefined, content: string | undefined): string | undefined {
  if (content !== undefined && /vitest-reporter|adapters\/vitest\/reporter/.test(content)) return undefined;
  const where = configFile ? `${configFile} does not load the governor reporter` : 'no vitest config found';
  return `warning: ${where}, so a plain \`vitest run\` records no evidence. Run tests with \`npx governor run -- <test files>\`, or add \`new GovernorReporter()\` from 'tdd-governor/vitest-reporter' to test.reporters (README, Reporter).`;
}
```

In `renderPrimer`, replace the paragraph that starts `A test failure that is an \`expect(...)\` failure` (through `there before trusting a red run). You never write the ledger yourself.`) with:

```ts
A test failure that is an \`expect(...)\` failure (\`AssertionError\`), recorded in \`.governor/ledger.jsonl\`.
\`npx governor run -- <test files>\` always records. A plain \`vitest run\` records only when the governor's
reporter is wired into ${reporterLine}
there before trusting a plain run). You never write the ledger yourself.
```

Keep `reporterLine` as it is.

In `src/cli.ts`, in the `install` branch, after `messages.forEach(...)`:

```ts
    if (loaded.config.adapter === 'vitest') {
      const pkg = packageOf(root, loaded.config);
      const found = findVitestConfig(pkg.dir, existsSync);
      const warning = reporterWarning(
        found && (pkg.rel === '.' ? found : path.posix.join(pkg.rel, found)),
        found && readFileSync(path.join(pkg.dir, found), 'utf8'),
      );
      if (warning) console.log(`governor: ${warning}`);
    }
```

Add `readFileSync` to the `node:fs` import and `import { findVitestConfig, reporterWarning } from './primer.js';`. The warning doesn't change the exit code.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/primer.ts src/cli.ts test/install.test.ts
git commit -m "feat: install warns when plain vitest runs will not record

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 3: Docs say the reporter is optional for gates

**Files:**
- Modify: `README.md` (section "2. Reporter"), `templates/governor-ci.yml` (setup step 2)
- Test: `test/ci-template.test.ts`, `test/package-meta.test.ts` (run only; edit only if an assertion quotes text you changed)

- [ ] **Step 1: README**

Replace the README "### 2. Reporter" section body with:

````md
The governor passes its own vitest reporter on the command line whenever it runs tests (`governor run`, every gate), so the gates work without any vitest config change.

To also record the test runs you or your agent start with plain `vitest run`, wire the reporter into your vitest config:

```ts
import GovernorReporter from 'tdd-governor/vitest-reporter';

export default defineConfig({
  test: {
    includeTaskLocation: true, // the governor needs a line number for each test
    reporters: ['default', new GovernorReporter()],
  },
});
```

Without it, record red runs with `npx governor run -- <test files>`. `governor install` warns when the config doesn't load the reporter.
````

In "## Usage", the `governor run` line stays.

- [ ] **Step 2: CI template**

In `templates/governor-ci.yml`, replace setup step 2 (`#   2. The client's vitest.config.ts must resolve the reporter from GOVERNOR_HOME.`) with:

```yaml
#   2. Nothing to add to vitest.config.ts: the governor passes its own reporter. If the
#      config imports 'tdd-governor/vitest-reporter', keep tdd-governor in devDependencies
#      so `npm ci` can resolve it.
```

- [ ] **Step 3: Full gate**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all pass. If `test/ci-template.test.ts` or `test/package-meta.test.ts` asserts the old wording, update that assertion to the new wording. Don't drop the assertion.

- [ ] **Step 4: Commit**

```bash
git add README.md templates/governor-ci.yml test/ci-template.test.ts test/package-meta.test.ts
git commit -m "docs: the reporter is optional for gates

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

## Acceptance (report each with evidence)

1. `runVitest` on `test/fixtures/no-reporter` returns `completed` with line numbers (test).
2. One record per run when the config also has the reporter (test). Report whether vitest replaced or merged the reporters.
3. `GOVERNOR_DISABLE_REPORTER=1` gives `unavailable` (test).
4. `install` prints the warning in a temp repo whose vitest config lacks the reporter. Paste the output (live-observed).
5. Full gate output: `npx tsc --noEmit && npm test && npm run build`, with test counts.
