import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runVitest } from '../src/adapters/vitest/run.js';
import { readLedger } from '../src/ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, 'fixtures/sample-project');

const GIT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

afterEach(() => {
  delete process.env.GOVERNOR_LEDGER_PATH;
  for (const k of GIT_VARS) delete process.env[k];
});

describe('runVitest', () => {
  it('does not leak hook-injected git repo vars into the spawned test run', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-env-')), 'l.jsonl');
    for (const k of GIT_VARS) process.env[k] = '/nonexistent';
    const outcome = runVitest(path.resolve(__dirname, 'fixtures/env-probe'), 60_000);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') expect(outcome.record.exitCode).toBe(0);
  });

  it('returns the record the reporter wrote for this run', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-run-')), 'l.jsonl');
    const outcome = runVitest(fixture, 60_000);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.record.exitCode).toBe(1);
      expect(outcome.record.tests.length).toBeGreaterThan(0);
    }
  });

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

  it('is unavailable on timeout', () => {
    process.env.GOVERNOR_LEDGER_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'gov-to-')), 'l.jsonl');
    const outcome = runVitest(fixture, 1);
    expect(outcome).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/timed out/) });
  });
});
