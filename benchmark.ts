import { redBeforeGreen } from './src/gates/red-before-green.js';
import type { LedgerRecord, TestResult } from './src/types.js';

const start = performance.now();

const records: LedgerRecord[] = [];
// Generate 1000 records, each with 1000 tests
for (let i = 0; i < 1000; i++) {
  const tests: TestResult[] = [];
  for (let j = 0; j < 1000; j++) {
    tests.push({
      id: `test-${j}`,
      file: `file-0.ts`, // all in file-0
      status: i % 2 === 0 ? 'fail' : 'pass',
      failureKind: i % 2 === 0 ? 'unknown' : undefined,
      line: j,
    });
  }
  records.push({
    at: `2023-01-01T00:00:00.000Z`,
    adapter: 'vitest',
    tests,
    collectionErrors: [],
  });
}

const diff = [
  {
    path: 'file-0.ts',
    status: 'modified' as const,
    added: Array.from({length: 1000}).map((_, i) => ({line: i, text: 'a'})),
    deleted: []
  }
];

const input = {
  diff,
  isTestFile: () => true,
  records,
  sinceIso: '2022-01-01T00:00:00.000Z',
};

const setupTime = performance.now() - start;

const runStart = performance.now();
redBeforeGreen(input);
const runTime = performance.now() - runStart;

console.log(`Setup time: ${setupTime.toFixed(2)}ms`);
console.log(`Run time: ${runTime.toFixed(2)}ms`);
