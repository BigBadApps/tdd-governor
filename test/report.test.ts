import { describe, expect, it } from 'vitest';
import { decide, formatResults } from '../src/report.js';
import type { GateResult } from '../src/types.js';

const pass: GateResult = { gate: 'green', status: 'PASS', findings: [] };
const blocked: GateResult = {
  gate: 'diff-audit', status: 'BLOCK',
  findings: [{ file: 'tests/a.test.ts', line: 3, message: "adds skip/only/todo: it.skip('x')" }],
};

describe('decide', () => {
  it('passes when all gates pass, ignoring any override', () => {
    expect(decide([pass], undefined)).toEqual({ kind: 'pass' });
    expect(decide([pass], 'why')).toEqual({ kind: 'pass' });
  });

  it('fails on any non-PASS status without override', () => {
    for (const status of ['BLOCK', 'UNDECIDED', 'GATE_UNAVAILABLE'] as const) {
      expect(decide([pass, { ...blocked, status }], undefined)).toEqual({ kind: 'fail' });
    }
  });

  it('rejects an empty override reason', () => {
    expect(decide([blocked], '   ')).toEqual({ kind: 'bad-override' });
  });

  it('records an override with the failing gate names', () => {
    expect(decide([pass, blocked], 'spike branch')).toEqual({ kind: 'override', gates: ['diff-audit'], reason: 'spike branch' });
  });
});

describe('formatResults', () => {
  it('prints gate headers and file:line findings', () => {
    expect(formatResults([pass, blocked])).toBe(
      "[PASS] green\n[BLOCK] diff-audit\n  tests/a.test.ts:3  adds skip/only/todo: it.skip('x')",
    );
  });
});
