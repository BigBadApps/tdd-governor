import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/diff.js';
import { redBeforeGreen } from '../../src/gates/red-before-green.js';
import type { LedgerRecord, TestResult } from '../../src/types.js';

const F = 'tests/math.test.ts';
const isTestFile = (p: string) => p.endsWith('.test.ts');
const SINCE = '2026-09-18T00:00:00.000Z';

const run = (at: string, tests: TestResult[]): LedgerRecord => ({
  v: 1, runId: at, at, head: 'h', adapter: 'vitest', exitCode: 0, collectionErrors: [], tests,
});
const t = (name: string, line: number | undefined, status: TestResult['status'], failureKind?: TestResult['failureKind']): TestResult => ({
  id: `${F} > ${name}`, file: F, ...(line !== undefined && { line }), status, ...(failureKind && { failureKind }),
});
const modifiedAt = (...lines: number[]): FileDiff[] => [
  { path: F, status: 'modified', added: lines.map((line) => ({ line, text: 'x' })), removed: [] },
];

// G8: which test owns an added line. Layout below is the file as staged; `adds` spans lines 4-6.
const SOURCE = [
  "import { describe, it } from 'vitest';", //  1
  '', //                                        2
  "describe('math', () => {", //                3
  "  it('adds', () => {", //                    4
  '    expect(1 + 1).toBe(2);', //              5
  '  });', //                                   6
  '});', //                                     7
  '', //                                        8
  "describe('fresh', () => {", //               9
  "  it('multiplies', () => {", //             10
  '    expect(2 * 2).toBe(4);', //             11
  '  });', //                                  12
  '});', //                                    13
].join('\n');
const source = (p: string) => (p === F ? SOURCE : undefined);
const g8Records = [
  run('2026-09-18T02:00:00.000Z', [t('adds', 4, 'pass'), t('multiplies', 10, 'fail', 'assertion')]),
];

describe('redBeforeGreen test spans (G8)', () => {
  it('does not blame the last existing test for a describe block appended after it', () => {
    const r = redBeforeGreen({ diff: modifiedAt(8, 9, 10, 11, 12, 13), isTestFile, records: g8Records, sinceIso: SINCE, source });
    expect(r).toEqual({ gate: 'red-before-green', status: 'PASS', findings: [] });
  });

  it('blames only the test whose span holds an added line, its closing line included', () => {
    const records = [run('2026-09-18T02:00:00.000Z', [t('adds', 4, 'pass'), t('multiplies', 10, 'pass')])];
    const r = redBeforeGreen({ diff: modifiedAt(8, 9, 12), isTestFile, records, sinceIso: SINCE, source });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: F, line: 10, message: expect.stringMatching(/multiplies: never seen failing/) }]);
  });

  it('ends a one-line test on its own line', () => {
    const one = ["it('a', () => {});", '', "it('b', () => {});"].join('\n');
    const records = [run('2026-09-18T02:00:00.000Z', [t('a', 1, 'pass'), t('b', 3, 'fail', 'assertion')])];
    const r = redBeforeGreen({ diff: modifiedAt(2, 3), isTestFile, records, sinceIso: SINCE, source: () => one });
    expect(r.status).toBe('PASS');
  });
});

describe('redBeforeGreen', () => {
  it('passes when the changed test failed with an assertion in the window', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'assertion'), t('subs', 12, 'pass')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 12, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(6, 7), isTestFile, records, sinceIso: SINCE });
    expect(r).toEqual({ gate: 'red-before-green', status: 'PASS', findings: [] });
  });

  it('blocks a changed test that never failed', () => {
    const records = [run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 12, 'pass')])];
    const r = redBeforeGreen({ diff: modifiedAt(13), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings).toEqual([{ file: F, line: 12, message: expect.stringMatching(/subs: never seen failing/) }]);
  });

  it('blocks when the only red was a runtime_error (not a valid red)', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'runtime_error')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/only failed with runtime_error/);
  });

  it('ignores red evidence from before the window', () => {
    const records = [
      run('2026-09-17T23:00:00.000Z', [t('adds', 5, 'fail', 'assertion')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    expect(redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE }).status).toBe('BLOCK');
  });

  it('is undecided when the only red is unknown', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'unknown')])];
    expect(redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE }).status).toBe('UNDECIDED');
  });

  it('is undecided when tests lack line locations', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', undefined, 'fail', 'assertion')])];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('UNDECIDED');
    expect(r.findings[0]!.message).toMatch(/includeTaskLocation/);
  });

  it('treats edits above the first test as touching no test', () => {
    const records = [run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')])];
    expect(redBeforeGreen({ diff: modifiedAt(1, 2), isTestFile, records, sinceIso: SINCE }).status).toBe('PASS');
  });

  it('scopes every test in an added file', () => {
    const records = [run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'assertion'), t('subs', 12, 'pass')])];
    const diff: FileDiff[] = [{ path: F, status: 'added', added: [{ line: 1, text: 'x' }], removed: [] }];
    const r = redBeforeGreen({ diff, isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings.map((f) => f.message)).toEqual([expect.stringMatching(/subs: never seen failing/)]);
  });

  it('blocks a changed test file with no recorded runs', () => {
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records: [], sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/no recorded test run/);
  });

  it('ignores non-test and deleted files', () => {
    const diff: FileDiff[] = [
      { path: 'src/math.ts', status: 'modified', added: [{ line: 1, text: 'x' }], removed: [] },
      { path: F, status: 'deleted', added: [], removed: [{ line: 1, text: 'x' }] },
    ];
    expect(redBeforeGreen({ diff, isTestFile, records: [], sinceIso: SINCE }).status).toBe('PASS');
  });

  it('blocks when one file is BLOCK and another is UNDECIDED (BLOCK wins)', () => {
    const G = 'tests/other.test.ts';
    const records = [
      run('2026-09-18T02:00:00.000Z', [
        t('adds', 5, 'pass'),
        { id: `${G} > z`, file: G, line: 5, status: 'fail', failureKind: 'unknown' },
      ]),
    ];
    const diff: FileDiff[] = [
      ...modifiedAt(5),
      { path: G, status: 'modified', added: [{ line: 5, text: 'x' }], removed: [] },
    ];
    expect(redBeforeGreen({ diff, isTestFile, records, sinceIso: SINCE }).status).toBe('BLOCK');
  });

  it('takes the test layout from the most recent run that recorded the file', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 12, 'fail', 'assertion')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass'), t('subs', 20, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(15), isTestFile, records, sinceIso: SINCE });
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/adds: never seen failing/);
  });

  it('says how to get a valid red when the only failure was a missing export or thrown error', () => {
    const records = [
      run('2026-09-18T01:00:00.000Z', [t('adds', 5, 'fail', 'runtime_error')]),
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.findings[0]!.message).toMatch(/missing export or thrown error.*stub.*expect\(\)/);
  });

  it('names an import failure when the file never got past collection', () => {
    const records = [
      { ...run('2026-09-18T01:00:00.000Z', []), exitCode: 1, collectionErrors: [{ file: F, message: 'Cannot find module ../src/math' }] },
      run('2026-09-18T02:00:00.000Z', [t('adds', 5, 'pass')]),
    ];
    const r = redBeforeGreen({ diff: modifiedAt(5), isTestFile, records, sinceIso: SINCE });
    expect(r.findings[0]!.message).toMatch(/failed to import.*not a valid red.*stub/);
  });

  it('does not judge a removal-only edit to a test file (diff audit owns removals)', () => {
    const diff: FileDiff[] = [{ path: F, status: 'modified', added: [], removed: [{ line: 1, text: 'x' }] }];
    expect(redBeforeGreen({ diff, isTestFile, records: [], sinceIso: SINCE }).status).toBe('PASS');
  });
});
