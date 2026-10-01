import { describe, expect, it } from 'vitest';
import { redAtBase } from '../../src/gates/red-at-base.js';
import type { LedgerRecord, RunOutcome, TestResult } from '../../src/types.js';

const F = 'tests/a.test.ts';
const head = (name: string): TestResult => ({ id: `${F} > ${name}`, file: F, line: 1, status: 'pass' });
const base = (tests: TestResult[], collectionErrors: LedgerRecord['collectionErrors'] = []): RunOutcome => ({
  kind: 'completed',
  record: { v: 1, runId: 'b', at: '2026-10-01T00:00:00.000Z', head: 'x', adapter: 'vitest', exitCode: 1, collectionErrors, tests },
});
const at = (name: string, status: TestResult['status'], failureKind?: TestResult['failureKind']): TestResult => ({
  id: `${F} > ${name}`, file: F, status, ...(failureKind && { failureKind }),
});

describe('redAtBase', () => {
  it('passes with no tests in scope', () => {
    expect(redAtBase({ scoped: [], sourceChanged: true, base: base([]) })).toEqual({ gate: 'red-at-base', status: 'PASS', findings: [] });
  });

  it('passes a tests-only change with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: false, base: base([]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*no source files changed/);
  });

  it('passes a test that fails on an assertion at base', () => {
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'fail', 'assertion')]) })).toMatchObject({ status: 'PASS', findings: [] });
  });

  it('blocks a test that passes at base', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'pass')]) });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/passes with this PR's source changes reverted/);
  });

  it('passes a runtime-error red with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'fail', 'runtime_error')]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*runtime_error/);
  });

  it('passes a file that does not import at base with a warning', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([], [{ file: F, message: 'Cannot find module' }]) });
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: .*does not import at base/);
  });

  it('is undecided when the test was skipped or not run at base', () => {
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([at('a', 'skip')]) }).status).toBe('UNDECIDED');
    expect(redAtBase({ scoped: [head('a')], sourceChanged: true, base: base([]) }).status).toBe('UNDECIDED');
  });

  it('blocks over undecided when both occur', () => {
    const r = redAtBase({ scoped: [head('a'), head('b')], sourceChanged: true, base: base([at('a', 'pass')]) });
    expect(r.status).toBe('BLOCK');
  });

  it('is unavailable when the base run is', () => {
    const r = redAtBase({ scoped: [head('a')], sourceChanged: true, base: { kind: 'unavailable', reason: 'boom' } });
    expect(r).toEqual({ gate: 'red-at-base', status: 'GATE_UNAVAILABLE', findings: [{ file: '(base run)', message: 'boom' }] });
  });
});
