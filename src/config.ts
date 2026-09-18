import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// No defaults for globs: wrong globs silently check nothing (spec §5).
export const ConfigSchema = z
  .object({
    adapter: z.enum(['vitest', 'pytest']),
    testGlobs: z.array(z.string().min(1)).min(1),
    sourceGlobs: z.array(z.string().min(1)).min(1),
    mutation: z.object({ enabled: z.boolean(), timeoutMs: z.number().int().positive() }),
    runTimeoutMs: z.number().int().positive(),
  })
  .strict();

export type GovernorConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(root: string): { ok: true; config: GovernorConfig } | { ok: false; error: string } {
  const file = path.join(root, '.governor', 'config.json');
  if (!existsSync(file)) return { ok: false, error: `.governor/config.json not found in ${root}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `.governor/config.json is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `.governor/config.json invalid: ${issues}` };
  }
  return { ok: true, config: parsed.data };
}
