import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readLedger } from '../src/ledger.js';
import type { LedgerRecord } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
