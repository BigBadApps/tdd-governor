import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readLedger } from '../src/ledger.js';
import type { LedgerRecord } from '../src/types.js';

const repo = path.resolve(__dirname, '..');
const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');
const fixture = path.join(repo, 'test/fixtures/pytest-project');
const F = 'test_cases.py';
let record: LedgerRecord;

beforeAll(() => {
  expect(existsSync(python), `python env missing at ${python}; see Stage 4 Task 2 Step 1`).toBe(true);
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-py-')), 'ledger.jsonl');
  const res = spawnSync(python, ['-m', 'pytest', '-p', 'tdd_governor_pytest', '-q', fixture], {
    cwd: fixture,
    env: { ...process.env, PYTHONPATH: path.join(repo, 'python'), GOVERNOR_LEDGER_PATH: ledger, GOVERNOR_RUN_ID: 'py-run' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(res.status).not.toBe(0);
  const { records, corrupt } = readLedger(ledger);
  expect(corrupt).toBe(0); // the plugin's output must satisfy the TS schema
  expect(records).toHaveLength(1);
  record = records[0]!;
});

const byId = (id: string) => record.tests.find((t) => t.id === id);

describe('tdd_governor_pytest against real pytest', () => {
  it('writes run metadata', () => {
    expect(record).toMatchObject({ runId: 'py-run', adapter: 'pytest', v: 1 });
    expect(record.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('classifies an assertion red with git-relative path and line', () => {
    expect(byId(`${F} > test_adds`)).toMatchObject({ file: F, line: 8, status: 'fail', failureKind: 'assertion' });
  });

  it('classifies TypeError as runtime_error and timeouts as timeout', () => {
    expect(byId(`${F} > test_calls_missing_function`)?.failureKind).toBe('runtime_error');
    expect(byId(`${F} > test_times_out`)?.failureKind).toBe('timeout');
  });

  it('records passes, skips, and class-scoped ids', () => {
    expect(byId(`${F} > test_passes`)?.status).toBe('pass');
    expect(byId(`${F} > test_skipped`)?.status).toBe('skip');
    expect(byId(`${F} > TestGroup > test_in_class`)?.status).toBe('fail');
  });

  it('records the import failure as a collection error', () => {
    expect(record.collectionErrors).toEqual([
      { file: 'test_import_error.py', message: expect.stringMatching(/does_not_exist/) },
    ]);
  });
});
