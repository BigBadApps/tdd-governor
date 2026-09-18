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