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
