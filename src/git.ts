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
