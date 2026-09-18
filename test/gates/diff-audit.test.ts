import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/diff.js';
import { diffAudit } from '../../src/gates/diff-audit.js';

const isTestFile = (p: string) => p.endsWith('.test.ts') || /(^|\/)test_[^/]*\.py$/.test(p);
const file = (path: string, added: string[], removed: string[] = [], status: FileDiff['status'] = 'modified'): FileDiff => ({
  path, status,
  added: added.map((text, i) => ({ line: i + 1, text })),
  removed: removed.map((text, i) => ({ line: i + 1, text })),
});
const audit = (...diff: FileDiff[]) => diffAudit({ diff, isTestFile });

describe('diffAudit', () => {
  it.each([
    ["  it.skip('x', () => {})"],
    ["  it.only('x', () => {})"],
    ["  describe.skip('x', () => {})"],
    ["  it.todo('x')"],
    ["  it.skipIf(true)('x', () => {})"],
    ["  xit('x', () => {})"],
    ['@pytest.mark.skip(reason="later")'],
    ['@pytest.mark.xfail'],
    ['    pytest.skip("nope")'],
  ])('blocks added skip/only/todo: %s', (line) => {
    const path = line.includes('pytest') ? 'tests/test_a.py' : 'tests/a.test.ts';
    const r = audit(file(path, [line]));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]).toMatchObject({ file: path, line: 1 });
  });

  it('ignores skip patterns in non-test files', () => {
    expect(audit(file('src/a.ts', ['list.skip(1)'])).status).toBe('PASS');
  });

  it('blocks net removal of assertions', () => {
    const r = audit(file('tests/a.test.ts', ['  expect(x).toBeDefined();'], ['  expect(x).toBe(1);', '  expect(y).toBe(2);']));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/net removal of 1 assertion/);
  });

  it('allows rewriting assertions one-for-one', () => {
    expect(audit(file('tests/a.test.ts', ['  expect(x).toBe(3);'], ['  expect(x).toBe(1);'])).status).toBe('PASS');
  });

  it('counts python assert statements', () => {
    expect(audit(file('tests/test_a.py', [], ['    assert x == 1'])).status).toBe('BLOCK');
  });

  it('blocks deleted test files', () => {
    const r = audit(file('tests/a.test.ts', [], ["it('x', () => {})"], 'deleted'));
    expect(r.status).toBe('BLOCK');
    expect(r.findings[0]!.message).toMatch(/deleted/);
  });

  it('blocks lowering or removing expect.assertions', () => {
    expect(audit(file('tests/a.test.ts', ['  expect.assertions(1);'], ['  expect.assertions(3);'])).status).toBe('BLOCK');
    expect(audit(file('tests/a.test.ts', [], ['  expect.assertions(2);'])).status).toBe('BLOCK');
    expect(audit(file('tests/a.test.ts', ['  expect.assertions(4);'], ['  expect.assertions(3);'])).status).toBe('PASS');
  });

  it('warns but passes on snapshot changes', () => {
    const r = audit(file('tests/__snapshots__/a.test.ts.snap', ['exports[`x`] = `2`;'], ['exports[`x`] = `1`;']));
    expect(r.status).toBe('PASS');
    expect(r.findings[0]!.message).toMatch(/^warning: snapshot changed/);
  });
});
