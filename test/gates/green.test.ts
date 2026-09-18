import { describe, expect, it } from 'vitest';
import { green } from '../../src/gates/green.js';
import type { LedgerRecord } from '../../src/types.js';

const rec = (over: Partial<LedgerRecord>): LedgerRecord => ({
  v: 1, runId: 'r', at: '2026-09-18T00:00:00.000Z', head: 'h', adapter: 'vitest',
  exitCode: 0, collectionErrors: [], tests: [], ...over,
});

describe('green gate', () => {
  it('passes a clean run', () => {
    expect(green({ kind: 'completed', record: rec({}) })).toEqual({ gate: 'green', status: 'PASS', findings: [] });
  });

  it('blocks on failing tests and names them', () => {
    const r = green({
      kind: 'completed',
      record: rec({
        exitCode: 1,
        tests: [{ id: 't.test.ts > adds', file: 't.test.ts', line: 4, status: 'fail', failureKind: 'assertion', message: 'expected 1 to be 2' }],
      }),
    });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: 't.test.ts', line: 4, message: 'failing: t.test.ts > adds: expected 1 to be 2' }]);
  });

  it('blocks on collection errors even with exit code 0', () => {
    const r = green({ kind: 'completed', record: rec({ collectionErrors: [{ file: 'x.test.ts', message: 'Cannot find module' }] }) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]).toEqual({ file: 'x.test.ts', message: 'collection error: Cannot find module' });
  });

  it('blocks on non-zero exit with no failing tests listed', () => {
    const r = green({ kind: 'completed', record: rec({ exitCode: 1 }) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/exit code 1/);
  });

  it('is unavailable when the run is unavailable', () => {
    expect(green({ kind: 'unavailable', reason: 'no reporter' })).toEqual({
      gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '(runner)', message: 'no reporter' }],
    });
  });
});
