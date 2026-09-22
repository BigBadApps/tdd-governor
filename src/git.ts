import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff, type FileDiff } from './diff.js';

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoRoot(cwd: string = process.cwd()): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function stagedDiff(root: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['diff', '--cached', '-U0', '--no-color', '--no-renames', '--no-ext-diff']));
}

// Index content of `file` (what the staged diff's added-line numbers refer to); undefined if not staged.
export function stagedFile(root: string, file: string): string | undefined {
  try {
    return git(root, ['show', `:${file}`]);
  } catch {
    return undefined;
  }
}

// Linked worktrees checked out inside `root`, as root-relative posix paths.
export function nestedWorktrees(root: string): string[] {
  const real = realpathSync(root);
  let out: string;
  try {
    out = git(root, ['worktree', 'list', '--porcelain']);
  } catch {
    return []; // not a repo (e.g. a Stryker sandbox copy): nothing nested to skip
  }
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.relative(real, l.slice('worktree '.length)))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
    .map((rel) => rel.split(path.sep).join('/'));
}

export function evidenceSince(root: string, base = 'main'): string {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return new Date(0).toISOString(); // first commit: all evidence counts
  }
  let mergeBase: string;
  try {
    mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  } catch {
    throw new Error(`no merge-base between HEAD and '${base}': the governor needs a '${base}' branch`);
  }
  return new Date(git(root, ['show', '-s', '--format=%cI', mergeBase]).trim()).toISOString();
}

const isAncestor = (root: string, a: string, b: string): boolean => {
  try {
    git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
};

// Newest merge-base of HEAD with `base` or `origin/<base>`, so a stale local main does not widen the diff.
function baseMergeBase(root: string, base: string): string {
  const bases = [base, `origin/${base}`].flatMap((ref) => {
    try {
      return [git(root, ['merge-base', 'HEAD', ref]).trim()];
    } catch {
      return [];
    }
  });
  if (bases.length === 0) return git(root, ['merge-base', 'HEAD', base]).trim(); // throws the usual error
  // A merge-base equal to HEAD means HEAD is the base branch itself (pushing main): it says nothing.
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const useful = bases.filter((b) => b !== head);
  if (useful.length === 0) return head;
  return useful.reduce((a, b) => (isAncestor(root, a, b) ? b : a));
}

// What this push adds: since the last push, unless main was merged in since then, in which case
// upstream..HEAD would carry main's already-reviewed commits, so diff against main instead.
export function pushBase(root: string, base = 'main'): string {
  const mergeBase = baseMergeBase(root, base);
  let upstream: string;
  try {
    upstream = git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']).trim();
  } catch {
    return mergeBase;
  }
  return isAncestor(root, mergeBase, upstream) ? upstream : mergeBase;
}

export function pushDiff(root: string, baseSha: string): FileDiff[] {
  return parseUnifiedDiff(git(root, ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', `${baseSha}..HEAD`]));
}

export function changedLines(diff: FileDiff[], include: (path: string) => boolean): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of diff) {
    if (f.status === 'deleted' || f.added.length === 0 || !include(f.path)) continue;
    map.set(f.path, new Set(f.added.map((a) => a.line)));
  }
  return map;
}

export function ciBase(root: string, flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const ref = flag ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'main');
  try {
    return git(root, ['merge-base', 'HEAD', ref]).trim();
  } catch {
    throw new Error(`no merge-base between HEAD and '${ref}': fetch full history (fetch-depth: 0) and make sure '${ref}' exists`);
  }
}
