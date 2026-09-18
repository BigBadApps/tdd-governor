import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Mutant } from './types.js';

const ReportSchema = z.object({
  files: z.record(
    z.object({
      mutants: z.array(
        z.object({
          mutatorName: z.string(),
          replacement: z.string().optional(),
          status: z.string(),
          location: z.object({ start: z.object({ line: z.number() }), end: z.object({ line: z.number() }) }),
        }),
      ),
    }),
  ),
});

const STATUS: Record<string, Mutant['status']> = { Survived: 'survived', NoCoverage: 'no_coverage', Killed: 'killed' };

export function parseStrykerReport(json: unknown): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `unrecognised Stryker report: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const mutants = Object.entries(parsed.data.files).flatMap(([file, f]) =>
    f.mutants.map((mu) => ({
      file,
      startLine: mu.location.start.line,
      endLine: mu.location.end.line,
      status: STATUS[mu.status] ?? 'other',
      mutator: mu.mutatorName,
      replacement: mu.replacement ?? '',
    })),
  );
  return { ok: true, mutants };
}

export function runStryker(
  root: string,
  files: string[],
  timeoutMs: number,
): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  const reportFile = path.join(root, 'reports', 'mutation', 'mutation.json');
  rmSync(reportFile, { force: true }); // never read a stale report
  const res = spawnSync('npx', ['--no-install', 'stryker', 'run', '--mutate', files.join(','), '--reporters', 'json,clear-text'], {
    cwd: root,
    env: { ...process.env, GOVERNOR_DISABLE_REPORTER: '1' },
    stdio: 'inherit',
    timeout: timeoutMs,
  });
  if (res.error) return { ok: false, error: `stryker did not run: ${res.error.message}` };
  if (res.signal) return { ok: false, error: `stryker killed by ${res.signal}` };
  if (res.status !== 0) return { ok: false, error: `stryker exited ${res.status}` };
  if (!existsSync(reportFile)) return { ok: false, error: 'stryker wrote no reports/mutation/mutation.json' };
  try {
    return parseStrykerReport(JSON.parse(readFileSync(reportFile, 'utf8')));
  } catch (e) {
    return { ok: false, error: `unreadable Stryker report: ${(e as Error).message}` };
  }
}