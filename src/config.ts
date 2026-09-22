import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// No defaults for globs: wrong globs silently check nothing (spec §5).
export const ConfigSchema = z
  .object({
    adapter: z.enum(['vitest', 'pytest']),
    // Monorepo: the folder (relative to the git root) whose test runner the governor drives. Globs stay repo-relative.
    packageRoot: z
      .string()
      .min(1)
      .refine((p) => !p.includes('\\'), "use '/' as the separator, like the globs")
      .refine((p) => !path.isAbsolute(p) && !path.posix.normalize(p).startsWith('..'), 'must be a folder inside the repo')
      .optional(),
    testGlobs: z.array(z.string().min(1)).min(1),
    sourceGlobs: z.array(z.string().min(1)).min(1),
    mutation: z.object({ enabled: z.boolean(), timeoutMs: z.number().int().positive() }),
    runTimeoutMs: z.number().int().positive(),
  })
  .strict();

export type GovernorConfig = z.infer<typeof ConfigSchema>;

// Where the test runner lives, and how its package-relative paths map to the repo-relative paths git diffs use.
export function packageOf(root: string, config: GovernorConfig) {
  const rel = path.posix.normalize(config.packageRoot ?? '.').replace(/\/$/, '');
  return {
    rel,
    dir: path.join(root, rel),
    toRepo: (p: string) => (rel === '.' ? p : path.posix.join(rel, p)),
    toPackage: (p: string) => (rel === '.' ? p : path.posix.relative(rel, p)),
  };
}

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
  if (parsed.data.packageRoot !== undefined) {
    // The text check above cannot see symlinks: compare real paths so the gates never run outside the repo.
    let rel: string;
    try {
      rel = path.relative(realpathSync(root), realpathSync(packageOf(root, parsed.data).dir));
    } catch {
      return { ok: false, error: `.governor/config.json invalid: packageRoot: folder '${parsed.data.packageRoot}' not found` };
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: `.governor/config.json invalid: packageRoot: must be a folder inside the repo` };
    }
  }
  return { ok: true, config: parsed.data };
}
