import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runVitest } from '../src/adapters/vitest/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
