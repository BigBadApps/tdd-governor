import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../src/diff.js';
import { changedLines, ciBase, nestedWorktrees, pushBase, pushDiff } from '../src/git.js';

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
    g('commit', '-qam', 'dev');
    const dev = g('rev-parse', 'HEAD');
    g('update-ref', 'refs/remotes/origin/develop', dev);
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    g('commit', '-qam', 'change');
    return { root, g, base, dev };
  }

  it('uses the --base flag', () => {
    const { root, base } = repo();
    expect(ciBase(root, 'main', { GITHUB_BASE_REF: 'develop' })).toBe(base);
  });

  it('uses origin/$GITHUB_BASE_REF when there is no flag', () => {
    const { root, dev } = repo();
    expect(ciBase(root, undefined, { GITHUB_BASE_REF: 'develop' })).toBe(dev);
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

describe('nestedWorktrees', () => {
  it('lists linked worktrees inside the root, not ones outside it', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'gov-wt-'));
    const root = path.join(parent, 'main');
    mkdirSync(root);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    g('worktree', 'add', '-q', '.worktrees/sib', '-b', 'sib');
    g('worktree', 'add', '-q', path.join(parent, 'outside'), '-b', 'out');
    expect(nestedWorktrees(root)).toEqual(['.worktrees/sib']);
  });
});