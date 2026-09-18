import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runVitest } from '../src/adapters/vitest/run.js';

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
