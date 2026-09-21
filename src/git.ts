import { execFileSync } from 'node:child_process';
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

export function pushBase(root: string, base = 'main'): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']).trim();
  } catch {
    return git(root, ['merge-base', 'HEAD', base]).trim();
  }
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
