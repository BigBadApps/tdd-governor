import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileDiff } from './diff.js';
import { git } from './git.js';

// Client post-checkout hooks (LFS, husky) must not fire for a checkout the governor makes and throws away.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

// A throwaway worktree of HEAD with `revert`'s files put back to `baseSha` (files the diff added are removed).
// The caller's checkout is never touched. Dependencies are linked from `root`, not installed.
export function withBaseWorktree<T>(root: string, baseSha: string, revert: FileDiff[], linkDirs: string[], fn: (worktree: string) => T): T {
  const parent = mkdtempSync(path.join(tmpdir(), 'governor-base-'));
  const wt = path.join(parent, 'wt');
  git(root, [...NO_HOOKS, 'worktree', 'add', '--detach', '--quiet', wt, 'HEAD']);
  try {
    for (const f of revert) {
      if (f.status === 'added') rmSync(path.join(wt, f.path), { force: true });
      else git(wt, [...NO_HOOKS, 'checkout', baseSha, '--', f.path]);
    }
    for (const rel of linkDirs) {
      const from = path.join(root, rel);
      const to = path.join(wt, rel);
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to);
    }
    return fn(wt);
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    rmSync(parent, { recursive: true, force: true });
  }
}
