import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileDiff } from './diff.js';
import { git } from './git.js';

// Client post-checkout hooks (LFS, husky) must not fire for a checkout the governor makes and throws away.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

function linkEntry(root: string, wt: string, src: string, dst: string): void {
  if (existsSync(dst)) return;
  try {
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(src);
      const resolved = path.resolve(path.dirname(src), linkTarget);
      const relToRoot = path.relative(root, resolved);
      if (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
        // Workspace link pointing into checkout: re-target to the matching directory in wt
        symlinkSync(path.join(wt, relToRoot), dst);
        return;
      }
    }
  } catch {
    // If lstat or readlink fails, fall back to direct symlink
  }
  symlinkSync(src, dst);
}

function linkDir(root: string, wt: string, rel: string): void {
  const from = path.join(root, rel);
  const to = path.join(wt, rel);
  if (!existsSync(from) || existsSync(to)) return;

  if (path.basename(from) !== 'node_modules') {
    symlinkSync(from, to);
    return;
  }

  // Build a node_modules in the worktree linking to checkout entries, with workspace links re-pointed to wt.
  mkdirSync(to, { recursive: true });
  for (const dirent of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, dirent.name);
    const dst = path.join(to, dirent.name);
    if (dirent.name.startsWith('@') && (dirent.isDirectory() || dirent.isSymbolicLink())) {
      mkdirSync(dst, { recursive: true });
      for (const sub of readdirSync(src, { withFileTypes: true })) {
        linkEntry(root, wt, path.join(src, sub.name), path.join(dst, sub.name));
      }
    } else {
      linkEntry(root, wt, src, dst);
    }
  }
}

// A throwaway worktree of HEAD with `revert`'s files put back to `baseSha` (files the diff added are removed).
// The caller's checkout is never touched. Dependencies are linked from `root`, not installed.
export function withBaseWorktree<T>(root: string, baseSha: string, revert: FileDiff[], linkDirs: string[], fn: (worktree: string) => T): T {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'governor-base-')));
  const wt = path.join(parent, 'wt');
  try {
    git(root, [...NO_HOOKS, 'worktree', 'add', '--detach', '--quiet', wt, 'HEAD']);
    try {
      for (const f of revert) {
        if (f.status === 'added') rmSync(path.join(wt, f.path), { force: true });
        else git(wt, [...NO_HOOKS, 'checkout', baseSha, '--', f.path]);
      }
      for (const rel of linkDirs) {
        linkDir(root, wt, rel);
      }
      return fn(wt);
    } finally {
      try {
        git(root, ['worktree', 'remove', '--force', wt]);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  } catch (err) {
    rmSync(parent, { recursive: true, force: true });
    throw err;
  }
}
