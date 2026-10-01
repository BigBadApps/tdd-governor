import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withBaseWorktree } from '../src/base-worktree.js';
import { pushDiff } from '../src/git.js';

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-bw-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'base\n');
  writeFileSync(path.join(root, 'src/gone.ts'), 'gone\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(root, 'src/a.ts'), 'head\n');
  writeFileSync(path.join(root, 'src/new.ts'), 'new\n');
  rmSync(path.join(root, 'src/gone.ts'));
  g('add', '-A');
  g('commit', '-q', '-m', 'feature');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules/marker'), 'dep\n');
  return { root, base, g };
}

describe('withBaseWorktree', () => {
  it('reverts the listed source files to base, links deps, and leaves the checkout alone', () => {
    const { root, base, g } = repo();
    const seen = withBaseWorktree(root, base, pushDiff(root, base), ['node_modules'], (wt) => ({
      wt,
      a: readFileSync(path.join(wt, 'src/a.ts'), 'utf8'),
      gone: readFileSync(path.join(wt, 'src/gone.ts'), 'utf8'),
      hasNew: existsSync(path.join(wt, 'src/new.ts')),
      dep: readFileSync(path.join(wt, 'node_modules/marker'), 'utf8'),
    }));
    expect(seen).toMatchObject({ a: 'base\n', gone: 'gone\n', hasNew: false, dep: 'dep\n' });
    expect(existsSync(seen.wt)).toBe(false);
    expect(g('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('head\n');
    expect(g('status', '--porcelain')).toBe('');
  });

  it('cleans up when the callback throws', () => {
    const { root, base, g } = repo();
    let wt = '';
    expect(() =>
      withBaseWorktree(root, base, [], [], (w) => {
        wt = w;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(wt)).toBe(false);
    expect(g('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('does not run the repo hooks', () => {
    const { root, base } = repo();
    const marker = path.join(root, 'hook-ran');
    writeFileSync(path.join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    withBaseWorktree(root, base, pushDiff(root, base), [], () => undefined);
    expect(existsSync(marker)).toBe(false);
  });
});
