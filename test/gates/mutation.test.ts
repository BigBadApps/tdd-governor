import { describe, expect, it } from 'vitest';
import { mutation } from '../../src/gates/mutation.js';
import type { Mutant } from '../../src/mutation/types.js';

const m = (over: Partial<Mutant>): Mutant => ({
  file: 'src/clamp.ts', startLine: 2, endLine: 2, status: 'survived', mutator: 'EqualityOperator', replacement: 'x <= lo', ...over,
});
const changed = new Map([['src/clamp.ts', new Set([2, 3])]]);

describe('mutation gate', () => {
  it('blocks a survivor on a changed line', () => {
    const r = mutation({ mutants: [m({})], changed });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: 'src/clamp.ts', line: 2, message: 'survived: EqualityOperator → x <= lo' }]);
  });

  it('blocks no-coverage on a changed line', () => {
    expect(mutation({ mutants: [m({ status: 'no_coverage', startLine: 3, endLine: 3 })], changed }).status).toBe('BLOCK');
  });

  it('counts a multi-line mutant that overlaps a changed line', () => {
    expect(mutation({ mutants: [m({ startLine: 1, endLine: 5 })], changed }).status).toBe('BLOCK');
  });

  it('ignores survivors on unchanged lines and killed mutants', () => {
    const r = mutation({ mutants: [m({ startLine: 9, endLine: 9 }), m({ status: 'killed' }), m({ status: 'other' })], changed });
    expect(r).toEqual({ gate: 'mutation', status: 'PASS', findings: [] });
  });

  it('ignores files with no changed lines', () => {
    expect(mutation({ mutants: [m({ file: 'src/other.ts' })], changed }).status).toBe('PASS');
  });
});