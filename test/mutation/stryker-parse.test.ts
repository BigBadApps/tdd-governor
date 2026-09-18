import { describe, expect, it } from 'vitest';
import { parseStrykerReport } from '../../src/mutation/stryker.js';

const report = {
  schemaVersion: '2',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/clamp.ts': {
      language: 'typescript',
      source: '...',
      mutants: [
        { id: '1', mutatorName: 'EqualityOperator', replacement: 'x <= lo', status: 'Survived', location: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } } },
        { id: '2', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 1, column: 50 }, end: { line: 5, column: 2 } } },
        { id: '3', mutatorName: 'ConditionalExpression', status: 'NoCoverage', location: { start: { line: 3, column: 7 }, end: { line: 3, column: 13 } } },
        { id: '4', mutatorName: 'StringLiteral', replacement: '""', status: 'Timeout', location: { start: { line: 4, column: 1 }, end: { line: 4, column: 3 } } },
      ],
    },
  },
};

describe('parseStrykerReport', () => {
  it('normalises mutants', () => {
    const r = parseStrykerReport(report);
    expect(r).toEqual({
      ok: true,
      mutants: [
        { file: 'src/clamp.ts', startLine: 2, endLine: 2, status: 'survived', mutator: 'EqualityOperator', replacement: 'x <= lo' },
        { file: 'src/clamp.ts', startLine: 1, endLine: 5, status: 'killed', mutator: 'BlockStatement', replacement: '{}' },
        { file: 'src/clamp.ts', startLine: 3, endLine: 3, status: 'no_coverage', mutator: 'ConditionalExpression', replacement: '' },
        { file: 'src/clamp.ts', startLine: 4, endLine: 4, status: 'other', mutator: 'StringLiteral', replacement: '""' },
      ],
    });
  });

  it('rejects malformed reports', () => {
    expect(parseStrykerReport({ nope: true }).ok).toBe(false);
    expect(parseStrykerReport(null).ok).toBe(false);
  });
});