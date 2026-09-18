import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../src/diff.js';
import { changedLines, ciBase, pushBase, pushDiff } from '../src/git.js';

describe('ciBase', () => {
  function repo() {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-ci-base-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
    g('commit', '-qam', 'change');
    return { root, g, base };
  }

  it('uses the --base flag', () => {
    const { root, base } = repo();
    expect(ciBase(root, 'main', {})).toBe(base);
  });

  it('uses origin/$GITHUB_BASE_REF when there is no flag', () => {
    const { root, g, base } = repo();
    g('update-ref', 'refs/remotes/origin/develop', base);
    expect(ciBase(root, undefined, { GITHUB_BASE_REF: 'develop' })).toBe(base);
  });

  it('falls back to main', () => {
    const { root, base } = repo();
    expect(ciBase(root, undefined, {})).toBe(base);
  });

  it('throws a fetch-depth hint when the base ref does not exist', () => {
    const { root } = repo();
    expect(() => ciBase(root, 'nope', {})).toThrow(/fetch-depth/);
  });
});

describe('changedLines', () => {
  it('collects added lines for included, non-deleted files', () => {
    const diff: FileDiff[] = [
      { path: 'src/a.ts', status: 'modified', added: [{ line: 2, text: 'x' }, { line: 5, text: 'y' }], removed: [] },
      { path: 'tests/a.test.ts', status: 'modified', added: [{ line: 1, text: 'z' }], removed: [] },
      { path: 'src/gone.ts', status: 'deleted', added: [], removed: [{ line: 1, text: 'q' }] },
    ];
    const map = changedLines(diff, (p) => p.startsWith('src/') && !p.endsWith('.test.ts'));
    expect([...map.entries()].map(([k, v]) => [k, [...v]])).toEqual([['src/a.ts', [2, 5]]]);
  });
});

describe('pushBase / pushDiff', () => {
  it('falls back to merge-base with main when there is no upstream', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
    g('commit', '-qam', 'change');
    expect(pushBase(root)).toBe(base);
    expect(pushDiff(root, base)[0]!.added).toEqual([{ line: 2, text: 'two' }]);
  });
});