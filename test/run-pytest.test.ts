import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPytest } from '../src/adapters/pytest/run.js';
import { readLedger } from '../src/ledger.js';

describe('runPytest', () => {
  const repo = path.resolve(__dirname, '..');
  const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');
  const project = path.join(repo, 'test/fixtures/pytest-project');
  const conftestProject = path.join(repo, 'test/fixtures/pytest-conftest-project');

  it('records a run with no conftest wiring (the governor injects its plugin)', () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp-')), 'l.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = ledger;
    const outcome = runPytest(project, python, 60_000, ['-q', 'test_cases.py']);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.adapter).toBe('pytest');
      expect(readLedger(ledger).records.filter((r) => r.runId === outcome.record.runId)).toHaveLength(1);
    }
  });

  it('is unavailable when the plugin writes nothing', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp2-')), 'l.jsonl');
    process.env.GOVERNOR_DISABLE_REPORTER = '1';
    try {
      expect(runPytest(project, python, 60_000, ['-q', 'test_cases.py'])).toEqual({
        kind: 'unavailable',
        reason: expect.stringMatching(/no ledger record/),
      });
    } finally {
      delete process.env.GOVERNOR_DISABLE_REPORTER;
    }
  });

  it('writes exactly one record when the project also registers the plugin in conftest', () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp3-')), 'l.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = ledger;
    const outcome = runPytest(conftestProject, python, 60_000, ['-q', 'test_ok.py']);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.adapter).toBe('pytest');
      expect(readLedger(ledger).records.filter((r) => r.runId === outcome.record.runId)).toHaveLength(1);
    }
  });

  it('passes --rootdir to pin rootdir even without a pytest.ini', () => {
    const childProject = path.join(repo, 'test/fixtures/pytest-parent-project/child');
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'gov-rp4-')), 'l.jsonl');
    process.env.GOVERNOR_LEDGER_PATH = ledger;
    const outcome = runPytest(childProject, python, 60_000, ['-q', 'test_child.py']);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.tests[0]?.file).toBe('test_child.py');
    }
  });
});
