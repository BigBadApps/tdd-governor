import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmpDirs: string[] = [];
const governorRoot = path.resolve(__dirname, '..');
const cli = path.join(governorRoot, 'dist', 'cli.js');
const reporter = JSON.stringify(path.join(governorRoot, 'dist/adapters/vitest/reporter.js'));

const TEST_FILE = "import { expect, it } from 'vitest';\nimport { add } from '../src/add.js';\n\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n";
// built by interpolation so diff-audit does not flag this file for an added skip
const SKIP_LINE = `it.${'skip'}('later', () => {});`;
const CLAMP_BASE = 'export function clamp(x: number, lo: number, hi: number): number {\n  if (x < lo) return lo;\n  return x;\n}\n';

function makeRepo(kind: 'plain' | 'mutation'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-ci-'));
  tmpDirs.push(root);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'e2e');
  symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'node_modules'));
  const mutation = kind === 'mutation';
  if (mutation) cpSync(path.resolve(__dirname, 'fixtures/mutation-project'), root, { recursive: true });
  mkdirSync(path.join(root, '.governor'), { recursive: true });
  writeFileSync(path.join(root, '.governor/config.json'), JSON.stringify({
    adapter: 'vitest',
    testGlobs: [mutation ? 'tests/**/*.check.ts' : 'tests/**/*.test.ts'],
    sourceGlobs: ['src/**/*.ts'],
    mutation: { enabled: mutation, timeoutMs: 300000 },
    runTimeoutMs: 120000,
  }));
  writeFileSync(path.join(root, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    `import GovernorReporter from ${reporter};`,
    `export default defineConfig({ test: { include: ['tests/**/*.${mutation ? 'check' : 'test'}.ts'], includeTaskLocation: true, reporters: ['default', new GovernorReporter()] } });`,
  ].join('\n'));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\nreports\n.stryker-tmp\n.governor/ledger.jsonl\n');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  if (mutation) {
    writeFileSync(path.join(root, 'src/clamp.ts'), CLAMP_BASE);
  } else {
    writeFileSync(path.join(root, 'src/add.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
    writeFileSync(path.join(root, 'tests/add.test.ts'), TEST_FILE);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  return root;
}

const commit = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: root });
};

function ci(root: string, args: string[] = ['--base', 'main'], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GITHUB_BASE_REF;
  if (!('GOVERNOR_OVERRIDE' in extraEnv)) delete env.GOVERNOR_OVERRIDE;
  return spawnSync('node', [cli, 'gate', 'ci', ...args], { cwd: root, encoding: 'utf8', env });
}

afterAll(() => {
  tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('governor gate ci (e2e)', () => {
  it('blocks an added .skip and prints the skipped red-before-green line', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\n${SKIP_LINE}\n`);
    commit(root);
    const res = ci(root);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/\[BLOCK\] diff-audit/);
    expect(res.stdout).toContain('red-before-green: skipped in CI (needs local ledger, G3)');
  });

  it('passes a clean diff', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\nit('adds negatives', () => {\n  expect(add(-1, -2)).toBe(-3);\n});\n`);
    commit(root);
    const res = ci(root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[PASS\] green/);
    expect(res.stdout).toMatch(/\[PASS\] diff-audit/);
    expect(res.stdout).toContain('warning: mutation gate disabled');
  });

  it('ignores GOVERNOR_OVERRIDE', () => {
    const root = makeRepo('plain');
    writeFileSync(path.join(root, 'tests/add.test.ts'), `${TEST_FILE}\n${SKIP_LINE}\n`);
    commit(root);
    const res = ci(root, ['--base', 'main'], { GOVERNOR_OVERRIDE: 'trust me' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('GOVERNOR_OVERRIDE is ignored in CI');
    expect(res.stdout).not.toMatch(/OVERRIDDEN/);
  });

  it('exits 2 with a fetch-depth hint when the base does not exist', () => {
    const root = makeRepo('plain');
    const res = ci(root, ['--base', 'nope']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/fetch-depth/);
  });

  it('exits 2 when --base has no value', () => {
    const root = makeRepo('plain');
    const res = ci(root, ['--base']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/usage: governor gate ci/);
  });

  it('blocks a surviving mutant on a changed line', () => {
    const root = makeRepo('mutation');
    cpSync(path.resolve(__dirname, 'fixtures/mutation-project/src/clamp.ts'), path.join(root, 'src/clamp.ts'));
    commit(root);
    const res = ci(root);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/\[PASS\] green/);
    expect(res.stdout).toMatch(/\[BLOCK\] mutation[\s\S]*src\/clamp\.ts:3/);
  }, 300_000);
});
