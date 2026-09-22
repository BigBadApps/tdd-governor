import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../src/diff.js';
import { changedLines, ciBase, commitDiff, mergeHeads, nestedWorktrees, pushBase, pushDiff, stagedDiff } from '../src/git.js';

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

  // feature pushed once (upstream set), then main gains a commit touching b.ts.
  const pushedFeature = () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'gov-push-'));
    const remote = path.join(parent, 'remote.git');
    const root = path.join(parent, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    mkdirSync(root);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('remote', 'add', 'origin', remote);
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    writeFileSync(path.join(root, 'b.ts'), 'main\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    g('push', '-q', 'origin', 'main');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
    g('commit', '-qam', 'feature change');
    g('push', '-q', '-u', 'origin', 'feature');
    const upstream = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    writeFileSync(path.join(root, 'b.ts'), 'main\nreviewed on main\n');
    g('commit', '-qam', 'main change');
    g('push', '-q', 'origin', 'main');
    g('checkout', '-q', 'feature');
    return { root, g, upstream };
  };

  it('keeps the upstream base when main has not been merged in since the last push', () => {
    const { root, g, upstream } = pushedFeature();
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    g('commit', '-qam', 'more feature');
    expect(pushBase(root)).toBe(upstream);
  });

  it("excludes main's changes after main is merged into a pushed branch", () => {
    const { root, g } = pushedFeature();
    g('merge', '-q', '--no-edit', 'main');
    expect(pushDiff(root, pushBase(root)).map((f) => f.path)).toEqual(['a.ts']);
  });

  it('audits a push of main itself when main tracks a remote other than origin', () => {
    const { root, g } = pushedFeature();
    g('remote', 'rename', 'origin', 'upstream');
    g('checkout', '-q', 'main');
    g('branch', '-q', '-u', 'upstream/main');
    writeFileSync(path.join(root, 'a.ts'), 'one\nmain only\n');
    g('commit', '-qam', 'direct to main');
    expect(pushDiff(root, pushBase(root)).map((f) => f.path)).toEqual(['a.ts']);
  });

  it("excludes origin/main's changes when local main is stale", () => {
    const { root, g } = pushedFeature();
    g('branch', '-f', 'main', 'main~1'); // local main behind origin/main
    g('merge', '-q', '--no-edit', 'origin/main');
    expect(pushDiff(root, pushBase(root)).map((f) => f.path)).toEqual(['a.ts']);
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

describe('commitDiff / mergeHeads', () => {
  function mergeRepo() {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-merge-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'base\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'feature');
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'x.test.ts'), 'test\n');
    writeFileSync(path.join(root, 'a.ts'), 'base\nfeature\n');
    g('add', '.');
    g('commit', '-q', '-m', 'feature commit');
    const featureSha = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    writeFileSync(path.join(root, 'b.ts'), 'unrelated\n');
    g('add', '.');
    g('commit', '-q', '-m', 'unrelated');
    return { root, g, featureSha };
  }

  it('no merge in progress: commitDiff equals stagedDiff', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'base\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    writeFileSync(path.join(root, 'a.ts'), 'base\nchange\n');
    g('add', '.');
    expect(commitDiff(root)).toEqual(stagedDiff(root));
  });

  it('git merge --no-commit --no-ff feature where feature added tests/x.test.ts and changed a.ts: commitDiff is []', () => {
    const { root, g } = mergeRepo();
    g('merge', '--no-commit', '--no-ff', 'feature');
    expect(commitDiff(root)).toEqual([]);
  });

  it('same, then edit a.ts in the index during the merge: only that edit lines remain', () => {
    const { root, g } = mergeRepo();
    g('merge', '--no-commit', '--no-ff', 'feature');
    writeFileSync(path.join(root, 'a.ts'), 'base\nfeature\nresolution\n');
    g('add', 'a.ts');
    expect(commitDiff(root)).toEqual([{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 3, text: 'resolution' }],
      removed: [],
    }]);
  });

  it('merge in progress inside a linked worktree (git worktree add): mergeHeads finds the head', () => {
    const { root, g, featureSha } = mergeRepo();
    const wt = path.join(root, '.worktrees', 'linked');
    g('worktree', 'add', '-q', wt, '-b', 'wt-branch');
    const gWt = (...a: string[]) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
    gWt('merge', '--no-commit', '--no-ff', 'feature');
    expect(mergeHeads(wt)).toEqual([featureSha]);
  });
});