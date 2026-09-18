# TDD Governor Stage 1 — Evidence Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every vitest run in a client repo appends one correctly classified record to `.governor/ledger.jsonl`, and `governor run` wraps that.

**Architecture:** A custom vitest reporter (`onTestRunEnd`) turns vitest's `TestModule`/`TestCase` objects into a `LedgerRecord`, classifies each failure with a pure `classify()`, and appends one JSON line through `ledger.ts`. Config is Zod-validated. The CLI's `run` command spawns vitest with a run id and then confirms the reporter actually wrote that record.

**Tech Stack:** Node 22, TypeScript 5 strict (NodeNext ESM), vitest 3.2 (peer + dev), zod 3, picomatch 4.

**Spec:** `docs/superpowers/specs/2026-09-18-tdd-governor-design.md` (§2, §3, §5, §6, §7)

## Global Constraints

- Node ≥ 22. ESM only (`"type": "module"`), `module`/`moduleResolution: NodeNext`, relative imports end in `.js`.
- TypeScript `strict: true`. No `any`: use `unknown` + narrowing.
- Nothing fails open: a missing reporter, config, or output yields `GATE_UNAVAILABLE` / non-zero exit, never success.
- Classification never regex-scans free-form stdout. It uses structured error fields only (`name`, `message` of vitest `TestError`).
- vitest reporter hook is `onTestRunEnd(testModules, unhandledErrors, reason)`. Verified against vitest 3.2.7 on 2026-09-18. `onFinished` is deprecated. Do not use it.
- Test id format: `` `${repoRelativeFile} > ${testCase.fullName}` `` (vitest `fullName` already joins the describe chain with ` > `).
- Ledger path: `<root>/.governor/ledger.jsonl`, overridable by env `GOVERNOR_LEDGER_PATH` (tests use this).
- Run id: env `GOVERNOR_RUN_ID` if set, else `crypto.randomUUID()`.
- Commit message trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Verification gate before claiming the stage done: `npx tsc --noEmit && npm test && npm run build`.

## File Structure

```
package.json                         # bin: governor, exports: ./vitest-reporter
tsconfig.json
vitest.config.ts                     # governor's own tests; excludes test/fixtures/**
.gitignore
src/types.ts                         # FailureKind, TestResult, LedgerRecord, GateStatus, GateResult, Finding
src/classify.ts                      # classify(error) → FailureKind
src/ledger.ts                        # LedgerRecordSchema, appendRecord, readLedger, ledgerPath
src/config.ts                        # ConfigSchema, loadConfig
src/adapters/vitest/reporter.ts      # GovernorReporter (default export) + buildRecord (pure)
src/adapters/vitest/run.ts           # runVitest(root, timeoutMs, extraArgs?) → RunOutcome
src/cli.ts                           # `governor run`
test/classify.test.ts
test/ledger.test.ts
test/config.test.ts
test/reporter.integration.test.ts    # real vitest against the fixture project
test/cli-run.integration.test.ts
test/fixtures/sample-project/vitest.config.ts
test/fixtures/sample-project/cases.test.ts
test/fixtures/sample-project/import-error.test.ts
test/fixtures/sample-project/math.ts
test/fixtures/no-reporter/vitest.config.ts
test/fixtures/no-reporter/ok.test.ts
```

---

### Task 1: Scaffold, core types, classifier

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `src/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Produces: types in `src/types.ts` (exact code below). `classify(error: { name?: string; message?: string } | undefined): FailureKind`.

- [ ] **Step 1: Scaffold the package**

`package.json`:
```json
{
  "name": "tdd-governor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "governor": "./dist/cli.js" },
  "exports": {
    "./vitest-reporter": "./dist/adapters/vitest/reporter.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": { "vitest": "^3.2.0" },
  "peerDependenciesMeta": { "vitest": { "optional": true } },
  "dependencies": {
    "picomatch": "^4.0.2",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/picomatch": "^3.0.1",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**'],
    testTimeout: 60_000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
.governor/ledger.jsonl
reports/
.stryker-tmp/
```

Run: `npm install`
Expected: installs without errors.

- [ ] **Step 2: Write the core types**

`src/types.ts`:
```ts
export type FailureKind = 'assertion' | 'collection_error' | 'runtime_error' | 'timeout' | 'unknown';

export interface TestResult {
  id: string;
  file: string;
  line?: number;
  status: 'pass' | 'fail' | 'skip';
  failureKind?: FailureKind;
  message?: string;
}

export interface CollectionError {
  file: string;
  message: string;
}

export interface LedgerRecord {
  v: 1;
  runId: string;
  at: string;
  head: string;
  adapter: 'vitest' | 'pytest';
  exitCode: number;
  collectionErrors: CollectionError[];
  tests: TestResult[];
  override?: { gate: string; reason: string };
}

export type GateStatus = 'PASS' | 'BLOCK' | 'UNDECIDED' | 'GATE_UNAVAILABLE';

export type GateName = 'red-before-green' | 'diff-audit' | 'green' | 'mutation';

export interface Finding {
  file: string;
  line?: number;
  message: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  findings: Finding[];
}

// Outcome of asking an adapter to run the suite. Gates consume this; adapters produce it.
export type RunOutcome = { kind: 'completed'; record: LedgerRecord } | { kind: 'unavailable'; reason: string };
```

- [ ] **Step 3: Write the failing classifier test**

`test/classify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';

describe('classify', () => {
  it('treats AssertionError as assertion', () => {
    expect(classify({ name: 'AssertionError', message: 'expected 2 to be 3' })).toBe('assertion');
  });

  it('treats vitest timeout message as timeout', () => {
    expect(classify({ name: 'Error', message: 'Test timed out in 50ms.' })).toBe('timeout');
  });

  it('treats other named errors as runtime_error', () => {
    expect(classify({ name: 'TypeError', message: 'x is not a function' })).toBe('runtime_error');
    expect(classify({ name: 'ReferenceError', message: 'y is not defined' })).toBe('runtime_error');
  });

  it('does not treat a message mentioning an error name as that error', () => {
    expect(classify({ name: 'TypeError', message: 'AssertionError in text' })).toBe('runtime_error');
  });

  it('returns unknown when there is no error or no name', () => {
    expect(classify(undefined)).toBe('unknown');
    expect(classify({ message: 'no name' })).toBe('unknown');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL, cannot resolve `../src/classify.js`.

- [ ] **Step 5: Implement the classifier**

`src/classify.ts`:
```ts
import type { FailureKind } from './types.js';

// Structured fields only; never scan free-form output (spec §3).
// The timeout check keys on vitest's own message prefix, which is emitted by the runner, not user code.
export function classify(error: { name?: string; message?: string } | undefined): FailureKind {
  if (!error) return 'unknown';
  if (error.name === 'AssertionError') return 'assertion';
  if (error.message?.startsWith('Test timed out in')) return 'timeout';
  if (error.name) return 'runtime_error';
  return 'unknown';
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/types.ts src/classify.ts test/classify.test.ts
git commit -m "feat: scaffold package, core types, failure classifier

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Ledger

**Files:**
- Create: `src/ledger.ts`
- Test: `test/ledger.test.ts`

**Interfaces:**
- Consumes: `LedgerRecord` from `src/types.ts`.
- Produces:
  - `ledgerPath(root: string): string`: returns `process.env.GOVERNOR_LEDGER_PATH` if set, else `path.join(root, '.governor', 'ledger.jsonl')`.
  - `appendRecord(file: string, record: LedgerRecord): void`: creates parent dirs, appends one line.
  - `readLedger(file: string): { records: LedgerRecord[]; corrupt: number }`: a missing file gives `{ records: [], corrupt: 0 }`.
  - `LedgerRecordSchema` (zod).

- [ ] **Step 1: Write the failing test**

`test/ledger.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRecord, ledgerPath, readLedger } from '../src/ledger.js';
import type { LedgerRecord } from '../src/types.js';

const record = (runId: string): LedgerRecord => ({
  v: 1,
  runId,
  at: '2026-09-18T00:00:00.000Z',
  head: 'abc123',
  adapter: 'vitest',
  exitCode: 1,
  collectionErrors: [],
  tests: [{ id: 'a.test.ts > adds', file: 'a.test.ts', line: 3, status: 'fail', failureKind: 'assertion', message: 'expected 2 to be 3' }],
});

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'gov-ledger-')), 'nested', 'ledger.jsonl');

describe('ledger', () => {
  afterEach(() => {
    delete process.env.GOVERNOR_LEDGER_PATH;
  });

  it('round-trips appended records in order, creating parent dirs', () => {
    const file = tmp();
    appendRecord(file, record('r1'));
    appendRecord(file, record('r2'));
    const { records, corrupt } = readLedger(file);
    expect(records.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(records[0]).toEqual(record('r1'));
    expect(corrupt).toBe(0);
  });

  it('returns empty for a missing file', () => {
    expect(readLedger('/nonexistent/ledger.jsonl')).toEqual({ records: [], corrupt: 0 });
  });

  it('skips and counts corrupt or schema-invalid lines', () => {
    const file = tmp();
    appendRecord(file, record('r1'));
    writeFileSync(file, 'not json\n{"v":2}\n', { flag: 'a' });
    appendRecord(file, record('r3'));
    const { records, corrupt } = readLedger(file);
    expect(records.map((r) => r.runId)).toEqual(['r1', 'r3']);
    expect(corrupt).toBe(2);
  });

  it('resolves the default path and honours GOVERNOR_LEDGER_PATH', () => {
    expect(ledgerPath('/repo')).toBe('/repo/.governor/ledger.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = '/tmp/x.jsonl';
    expect(ledgerPath('/repo')).toBe('/tmp/x.jsonl');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ledger.test.ts`
Expected: FAIL, cannot resolve `../src/ledger.js`.

- [ ] **Step 3: Implement the ledger**

`src/ledger.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LedgerRecord } from './types.js';

const FailureKindSchema = z.enum(['assertion', 'collection_error', 'runtime_error', 'timeout', 'unknown']);

export const LedgerRecordSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  at: z.string(),
  head: z.string(),
  adapter: z.enum(['vitest', 'pytest']),
  exitCode: z.number().int(),
  collectionErrors: z.array(z.object({ file: z.string(), message: z.string() })),
  tests: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      line: z.number().int().optional(),
      status: z.enum(['pass', 'fail', 'skip']),
      failureKind: FailureKindSchema.optional(),
      message: z.string().optional(),
    }),
  ),
  override: z.object({ gate: z.string(), reason: z.string().min(1) }).optional(),
});

export function ledgerPath(root: string): string {
  return process.env.GOVERNOR_LEDGER_PATH ?? path.join(root, '.governor', 'ledger.jsonl');
}

export function appendRecord(file: string, record: LedgerRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n');
}

// Corrupt lines are skipped, never guessed at: dropping evidence can only cause a BLOCK, never a false PASS.
export function readLedger(file: string): { records: LedgerRecord[]; corrupt: number } {
  if (!existsSync(file)) return { records: [], corrupt: 0 };
  const records: LedgerRecord[] = [];
  let corrupt = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = LedgerRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ledger.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts test/ledger.test.ts
git commit -m "feat: append-only JSONL ledger with schema-validated reads

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Config

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `type GovernorConfig = z.infer<typeof ConfigSchema>`, with fields `adapter: 'vitest' | 'pytest'`, `testGlobs: string[]` (min 1), `sourceGlobs: string[]` (min 1), `mutation: { enabled: boolean; timeoutMs: number }`, `runTimeoutMs: number`.
  - `loadConfig(root: string): { ok: true; config: GovernorConfig } | { ok: false; error: string }`: reads `<root>/.governor/config.json`.

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const repoWith = (content: string | null) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-config-'));
  if (content !== null) {
    mkdirSync(path.join(root, '.governor'));
    writeFileSync(path.join(root, '.governor', 'config.json'), content);
  }
  return root;
};

const valid = {
  adapter: 'vitest',
  testGlobs: ['tests/**/*.test.ts'],
  sourceGlobs: ['src/**/*.ts'],
  mutation: { enabled: true, timeoutMs: 300000 },
  runTimeoutMs: 120000,
};

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const result = loadConfig(repoWith(JSON.stringify(valid)));
    expect(result).toEqual({ ok: true, config: valid });
  });

  it('fails when the file is missing', () => {
    const result = loadConfig(repoWith(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\.governor\/config\.json not found/);
  });

  it('fails on invalid JSON', () => {
    expect(loadConfig(repoWith('{nope')).ok).toBe(false);
  });

  it('fails on empty globs rather than defaulting', () => {
    const result = loadConfig(repoWith(JSON.stringify({ ...valid, testGlobs: [] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/testGlobs/);
  });

  it('fails on an unknown adapter', () => {
    expect(loadConfig(repoWith(JSON.stringify({ ...valid, adapter: 'jest' }))).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement config loading**

`src/config.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// No defaults for globs: wrong globs silently check nothing (spec §5).
export const ConfigSchema = z
  .object({
    adapter: z.enum(['vitest', 'pytest']),
    testGlobs: z.array(z.string().min(1)).min(1),
    sourceGlobs: z.array(z.string().min(1)).min(1),
    mutation: z.object({ enabled: z.boolean(), timeoutMs: z.number().int().positive() }),
    runTimeoutMs: z.number().int().positive(),
  })
  .strict();

export type GovernorConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(root: string): { ok: true; config: GovernorConfig } | { ok: false; error: string } {
  const file = path.join(root, '.governor', 'config.json');
  if (!existsSync(file)) return { ok: false, error: `.governor/config.json not found in ${root}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `.governor/config.json is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `.governor/config.json invalid: ${issues}` };
  }
  return { ok: true, config: parsed.data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: zod-validated governor config with no silent defaults

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: vitest reporter, verified against real vitest

**Files:**
- Create: `src/adapters/vitest/reporter.ts`
- Create: `test/fixtures/sample-project/vitest.config.ts`, `test/fixtures/sample-project/math.ts`, `test/fixtures/sample-project/cases.test.ts`, `test/fixtures/sample-project/import-error.test.ts`
- Test: `test/reporter.integration.test.ts`

**Interfaces:**
- Consumes: `classify`, `appendRecord`, `ledgerPath`, types.
- Produces:
  - `default export class GovernorReporter implements Reporter`. Clients register it as `reporters: ['default', 'tdd-governor/vitest-reporter']`. It must be the default export so vitest can load it by module path.
  - `buildRecord(input: { root: string; runId: string; head: string; at: string; modules: ModuleLike[]; unhandledErrors: ReadonlyArray<{ name?: string; message?: string }>; reason: 'passed' | 'failed' | 'interrupted' }): LedgerRecord`. Pure. `ModuleLike` is a structural subset of vitest's `TestModule`, declared in the file, so unit tests and Stage 4 don't depend on vitest internals.

- [ ] **Step 1: Create the fixture project**

These are deliberately failing tests. The governor's own `vitest.config.ts` excludes `test/fixtures/**`, so they only run when the integration test points vitest at this folder.

`test/fixtures/sample-project/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import GovernorReporter from '../../../src/adapters/vitest/reporter.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    includeTaskLocation: true,
    reporters: ['default', new GovernorReporter()],
  },
});
```

`test/fixtures/sample-project/math.ts`:
```ts
export function add(a: number, b: number): number {
  return a - b; // deliberately wrong: produces a valid red
}

export const notAFunction = 42;
```

`test/fixtures/sample-project/cases.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import * as math from './math.js';

describe('math', () => {
  it('adds', () => {
    expect(math.add(2, 3)).toBe(5);
  });

  it('passes', () => {
    expect(1).toBe(1);
  });

  it('calls a missing function', () => {
    (math.notAFunction as unknown as () => void)();
  });

  it('times out', async () => {
    await new Promise((r) => setTimeout(r, 1_000));
  }, 50);

  it.skip('is skipped', () => {});
});
```

`test/fixtures/sample-project/import-error.test.ts`:
```ts
import { it } from 'vitest';
// @ts-expect-error deliberate: module does not exist
import { missing } from './does-not-exist.js';

it('never runs', () => {
  missing();
});
```

- [ ] **Step 2: Write the failing integration test**

`test/reporter.integration.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readLedger } from '../src/ledger.js';
import type { LedgerRecord } from '../src/types.js';

const fixture = path.resolve(__dirname, 'fixtures/sample-project');
let record: LedgerRecord;

beforeAll(() => {
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rep-')), 'ledger.jsonl');
  const res = spawnSync('npx', ['--no-install', 'vitest', 'run', '--root', fixture], {
    env: { ...process.env, GOVERNOR_LEDGER_PATH: ledger, GOVERNOR_RUN_ID: 'fixture-run' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(res.status).toBe(1); // fixture suite fails on purpose
  const { records, corrupt } = readLedger(ledger);
  expect(corrupt).toBe(0);
  expect(records).toHaveLength(1);
  record = records[0]!;
});

const byName = (suffix: string) => record.tests.find((t) => t.id.endsWith(suffix));

describe('GovernorReporter against real vitest', () => {
  it('writes run metadata', () => {
    expect(record.runId).toBe('fixture-run');
    expect(record.adapter).toBe('vitest');
    expect(record.exitCode).toBe(1);
  });

  it('classifies a wrong return value as an assertion red', () => {
    expect(byName('math > adds')).toMatchObject({
      id: 'cases.test.ts > math > adds',
      file: 'cases.test.ts',
      status: 'fail',
      failureKind: 'assertion',
    });
    expect(byName('math > adds')?.line).toBeTypeOf('number');
  });

  it('records passes and skips', () => {
    expect(byName('math > passes')?.status).toBe('pass');
    expect(byName('math > is skipped')?.status).toBe('skip');
  });

  it('classifies calling a non-function as runtime_error', () => {
    expect(byName('calls a missing function')?.failureKind).toBe('runtime_error');
  });

  it('classifies a timeout', () => {
    expect(byName('times out')?.failureKind).toBe('timeout');
  });

  it('records the import failure as a collection error, not a test', () => {
    expect(record.collectionErrors).toHaveLength(1);
    expect(record.collectionErrors[0]!.file).toBe('import-error.test.ts');
    expect(record.tests.some((t) => t.file === 'import-error.test.ts')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/reporter.integration.test.ts`
Expected: FAIL. The fixture config cannot load the reporter module, so vitest errors and no ledger record is written (`records` has length 0).

- [ ] **Step 4: Implement the reporter**

`src/adapters/vitest/reporter.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { classify } from '../../classify.js';
import { appendRecord, ledgerPath } from '../../ledger.js';
import type { LedgerRecord, TestResult } from '../../types.js';

// Structural subset of vitest's TestModule/TestCase: keeps buildRecord testable without vitest internals.
interface ErrorLike {
  name?: string;
  message?: string;
}
interface CaseLike {
  fullName: string;
  location?: { line: number; column: number };
  result(): { state: string; errors?: ReadonlyArray<ErrorLike> };
}
export interface ModuleLike {
  moduleId: string;
  errors(): ReadonlyArray<ErrorLike>;
  children: { allTests(): Iterable<CaseLike> };
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0]!.slice(0, 300);

export function buildRecord(input: {
  root: string;
  runId: string;
  head: string;
  at: string;
  modules: ReadonlyArray<ModuleLike>;
  unhandledErrors: ReadonlyArray<ErrorLike>;
  reason: 'passed' | 'failed' | 'interrupted';
}): LedgerRecord {
  const tests: TestResult[] = [];
  const collectionErrors: LedgerRecord['collectionErrors'] = [];

  for (const mod of input.modules) {
    const file = path.relative(input.root, mod.moduleId);
    const moduleErrors = mod.errors();
    if (moduleErrors.length > 0) {
      collectionErrors.push({ file, message: firstLine(moduleErrors[0]!.message) });
    }
    for (const test of mod.children.allTests()) {
      const result = test.result();
      const status = result.state === 'passed' ? 'pass' : result.state === 'failed' ? 'fail' : 'skip';
      const entry: TestResult = { id: `${file} > ${test.fullName}`, file, status };
      if (test.location) entry.line = test.location.line;
      if (status === 'fail') {
        const err = result.errors?.[0];
        entry.failureKind = classify(err);
        entry.message = firstLine(err?.message);
      }
      tests.push(entry);
    }
  }
  for (const err of input.unhandledErrors) {
    collectionErrors.push({ file: '(unhandled)', message: firstLine(err.message) });
  }

  return {
    v: 1,
    runId: input.runId,
    at: input.at,
    head: input.head,
    adapter: 'vitest',
    exitCode: input.reason === 'passed' ? 0 : 1,
    collectionErrors,
    tests,
  };
}

function gitHead(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'none';
  }
}

export default class GovernorReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<ErrorLike>,
    reason: 'passed' | 'failed' | 'interrupted',
  ): void {
    const record = buildRecord({
      root: this.root,
      runId: process.env.GOVERNOR_RUN_ID ?? randomUUID(),
      head: gitHead(this.root),
      at: new Date().toISOString(),
      modules: testModules as unknown as ReadonlyArray<ModuleLike>,
      unhandledErrors,
      reason,
    });
    appendRecord(ledgerPath(this.root), record);
  }
}
```

Note on `as unknown as`: vitest's `TestModule` is structurally richer than `ModuleLike`, but its `children` type is a class, not an interface, so a direct assignment may not type-check. If `tsc` accepts `testModules` without the cast, remove the cast. Do not widen `ModuleLike` to `any`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/reporter.integration.test.ts`
Expected: PASS, 6 tests.

If `import-error.test.ts` shows up as a test instead of in `collectionErrors`, or the timeout is classified `runtime_error`, **stop and inspect the real record** (`cat` the tmp ledger). Fix the reporter or classifier from real data. Do not edit the test expectations to match. This is the stage's core evidence.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/vitest/reporter.ts test/fixtures test/reporter.integration.test.ts
git commit -m "feat: vitest reporter writes classified ledger records

Verified against real vitest runs over a fixture project with
assertion, runtime, timeout, skip and import-error cases.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `runVitest` and `governor run`

**Files:**
- Create: `src/adapters/vitest/run.ts`, `src/cli.ts`
- Create: `test/fixtures/no-reporter/vitest.config.ts`, `test/fixtures/no-reporter/ok.test.ts`
- Test: `test/cli-run.integration.test.ts`

**Interfaces:**
- Consumes: `ledgerPath`, `readLedger`, `loadConfig`, `LedgerRecord`.
- Produces:
  - `RunOutcome` (already in `src/types.ts` from Task 1)
  - `runVitest(root: string, timeoutMs: number, extraArgs?: string[]): RunOutcome`. Spawns `npx vitest run` with `GOVERNOR_RUN_ID=<uuid>`, output inherited, then finds that run id in the ledger. No record → `unavailable` ("reporter not configured").
  - `src/cli.ts` with `main(argv: string[]): number` exported, plus the bin entry. Stage 1 implements `run` only. Unknown commands print usage and return 2.

- [ ] **Step 1: Write the failing integration test**

`test/cli-run.integration.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runVitest } from '../src/adapters/vitest/run.js';

const fixture = path.resolve(__dirname, 'fixtures/sample-project');

afterEach(() => {
  delete process.env.GOVERNOR_LEDGER_PATH;
});

describe('runVitest', () => {
  it('returns the record the reporter wrote for this run', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-run-')), 'l.jsonl');
    const outcome = runVitest(fixture, 60_000);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.exitCode).toBe(1);
      expect(outcome.record.tests.length).toBeGreaterThan(0);
    }
  });

  it('is unavailable when the reporter is not configured', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-nr-')), 'l.jsonl');
    const outcome = runVitest(path.resolve(__dirname, 'fixtures/no-reporter'), 60_000);
    expect(outcome).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/reporter/) });
  });

  it('is unavailable on timeout', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-to-')), 'l.jsonl');
    const outcome = runVitest(fixture, 1);
    expect(outcome).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/timed out/) });
  });
});
```

Create the second fixture (a vitest project *without* the governor reporter):

`test/fixtures/no-reporter/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['*.test.ts'] } });
```

`test/fixtures/no-reporter/ok.test.ts`:
```ts
import { expect, it } from 'vitest';

it('ok', () => {
  expect(true).toBe(true);
});
```

Both fixtures sit inside the governor repo, so `npx --no-install vitest` resolves the governor's own vitest from `node_modules/.bin` by walking up. `--no-install` makes sure npx never downloads anything.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli-run.integration.test.ts`
Expected: FAIL, cannot resolve `../src/adapters/vitest/run.js`.

- [ ] **Step 3: Implement `runVitest`**

`src/adapters/vitest/run.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ledgerPath, readLedger } from '../../ledger.js';
import type { RunOutcome } from '../../types.js';

export function runVitest(root: string, timeoutMs: number, extraArgs: string[] = []): RunOutcome {
  const runId = randomUUID();
  const res = spawnSync('npx', ['--no-install', 'vitest', 'run', '--root', root, ...extraArgs], {
    cwd: root,
    env: { ...process.env, GOVERNOR_RUN_ID: runId },
    stdio: 'inherit',
    timeout: timeoutMs,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { kind: 'unavailable', reason: `vitest timed out after ${timeoutMs}ms` };
  }
  if (res.error) return { kind: 'unavailable', reason: `could not start vitest: ${res.error.message}` };
  if (res.signal) return { kind: 'unavailable', reason: `vitest killed by ${res.signal}` };

  const record = readLedger(ledgerPath(root)).records.find((r) => r.runId === runId);
  if (!record) {
    return {
      kind: 'unavailable',
      reason: "vitest ran but wrote no ledger record: add 'tdd-governor/vitest-reporter' to test.reporters and set includeTaskLocation: true",
    };
  }
  return { kind: 'completed', record };
}
```

- [ ] **Step 4: Implement the CLI `run` command**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runVitest } from './adapters/vitest/run.js';
import { loadConfig } from './config.js';

const USAGE = 'usage: governor <run>';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'run') {
    const root = repoRoot();
    const loaded = loadConfig(root);
    if (!loaded.ok) {
      console.error(`governor: ${loaded.error}`);
      return 2;
    }
    const outcome = runVitest(root, loaded.config.runTimeoutMs, rest);
    if (outcome.kind === 'unavailable') {
      console.error(`governor: GATE_UNAVAILABLE: ${outcome.reason}`);
      return 2;
    }
    const { tests, collectionErrors } = outcome.record;
    const failed = tests.filter((t) => t.status === 'fail').length;
    console.log(`governor: recorded run ${outcome.record.runId}: ${tests.length} tests, ${failed} failed, ${collectionErrors.length} collection errors`);
    return outcome.record.exitCode;
  }
  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cli-run.integration.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Full verification gate**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean, all tests pass (classify 5, ledger 4, config 5, reporter 6, cli-run 3), `dist/cli.js` and `dist/adapters/vitest/reporter.js` exist.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/vitest/run.ts src/cli.ts test/cli-run.integration.test.ts
git commit -m "feat: governor run spawns vitest and confirms the reporter recorded it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Stage 1 findings doc

**Files:**
- Create: `docs/superpowers/specs/2026-09-18-stage-1-findings.md`

- [ ] **Step 1: Write the findings doc**

Use this structure. Fill every row from what was actually observed. Each criterion states its verification method (`test` / `code-reasoned` / `live-observed` / `deferred`). Do not mark anything Pass on reasoning alone.

```markdown
# Stage 1 Findings — Evidence Recording

| Criterion | Result | Verified by |
|---|---|---|
| Assertion red classified `assertion` | | test: reporter.integration "classifies a wrong return value…" |
| TypeError classified `runtime_error` | | test: … |
| Timeout classified `timeout` | | test: … |
| Import failure recorded as collection error, not a test | | test: … |
| Test line numbers present with includeTaskLocation | | test: … |
| Missing reporter → unavailable, never success | | test: cli-run "is unavailable when…" |
| Corrupt ledger lines skipped + counted | | test: ledger |
| vitest API assumptions (onTestRunEnd, TestModule.errors(), location) | | live-observed: vitest <version> |

## Surprises / deviations from plan
## Carried forward
- Known gaps G1–G8 unchanged (spec §9).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-18-stage-1-findings.md
git commit -m "docs: stage 1 findings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
