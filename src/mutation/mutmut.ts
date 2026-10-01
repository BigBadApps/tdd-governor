import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from '../diff.js';
import type { Mutant } from './types.js';

// `mutmut results` lines look like "    <mutant name>: <status>".
const RESULT_LINE = /^\s*(\S+):\s*(\w[\w ]*)\s*$/;
const STATUS: Record<string, Mutant['status']> = { survived: 'survived', 'no tests': 'no_coverage', killed: 'killed' };

export function parseMutmut(results: string, show: (name: string) => string): Mutant[] {
  const mutants: Mutant[] = [];
  for (const line of results.split('\n')) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const status = STATUS[m[2]!.trim()] ?? 'other';
    if (status !== 'survived' && status !== 'no_coverage') {
      mutants.push({ file: '', startLine: 0, endLine: 0, status, mutator: m[1]!, replacement: '' });
      continue;
    }
    const diff = show(m[1]!);
    // mutmut diffs start with `--- <path>\n+++ <path>` without git's `diff --git a/<path> b/<path>`.
    // parseUnifiedDiff expects `diff --git a/... b/...`, so synthesize the header if missing.
    const fileMatch = /^---\s+(.+)$/m.exec(diff);
    const filePath = fileMatch ? fileMatch[1]!.trim() : '';
    const formattedDiff = filePath && !diff.includes('diff --git ') ? `diff --git a/${filePath} b/${filePath}\n${diff}` : diff;

    for (const f of parseUnifiedDiff(formattedDiff)) {
      const lines = f.removed.map((r) => r.line);
      if (lines.length === 0) continue;
      mutants.push({
        file: f.path,
        startLine: Math.min(...lines),
        endLine: Math.max(...lines),
        status,
        mutator: m[1]!,
        replacement: f.added.map((a) => a.text.trim()).join(' '),
      });
    }
  }
  return mutants;
}

export function runMutmut(
  root: string,
  python: string,
  files: string[],
  timeoutMs: number,
): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  rmSync(path.join(root, 'mutants'), { recursive: true, force: true }); // never read a previous run
  const mutmut = path.join(path.dirname(path.resolve(root, python)), 'mutmut');
  const env = { ...process.env, GOVERNOR_DISABLE_REPORTER: '1' };
  // mutmut module filter strips `src.` prefix from dotted names
  const globs = files.map((f) => f.replace(/\.py$/, '').replaceAll('/', '.').replace(/^src\./, '') + '*');
  const run = spawnSync(mutmut, ['run', ...globs], { cwd: root, env, stdio: 'inherit', timeout: timeoutMs });
  if (run.error) return { ok: false, error: `mutmut did not run: ${run.error.message}` };
  if (run.signal) return { ok: false, error: `mutmut killed by ${run.signal}` };
  const results = spawnSync(mutmut, ['results', '--all', 'true'], { cwd: root, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (results.status !== 0) return { ok: false, error: `mutmut results failed: ${results.stderr || results.error?.message || 'non-zero exit'}` };
  const show = (name: string) => spawnSync(mutmut, ['show', name], { cwd: root, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).stdout ?? '';

  const mutants = parseMutmut(results.stdout, show);
  if (mutants.length === 0) return { ok: false, error: 'mutmut produced no mutants for the changed files' };
  return { ok: true, mutants };
}
