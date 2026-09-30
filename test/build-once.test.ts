import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

// The e2e tests run dist/cli.js. Files run in parallel workers, so a build inside one file's
// beforeAll rewrites dist while another file is executing it (an empty or half-written cli.js
// exits 0 and fails the wrong assertion). Build once, before any worker starts.
describe('building dist for the e2e tests', () => {
  it('builds once in a vitest globalSetup', () => {
    expect(existsSync(path.join(root, 'test/global-build.ts'))).toBe(true);
    expect(read('vitest.config.ts')).toMatch(/globalSetup:\s*\[?\s*['"]\.?\/?test\/global-build\.ts['"]/);
  });

  it.each(['test/e2e.ci.test.ts', 'test/e2e.commit.test.ts', 'test/e2e.push.test.ts'])(
    'does not rebuild inside %s',
    (file) => {
      expect(read(file)).not.toMatch(/\[\s*'run'\s*,\s*'build'\s*\]/);
    },
  );
});
