import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmpDirs: string[] = [];
const governorRoot = path.resolve(__dirname, '..');
const cli = path.join(governorRoot, 'dist', 'cli.js');

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-e2e-'));
  tmpDirs.push(root);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  g('init', '-b', 'main', '-q');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'e2e');
  symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'node_modules'));
  mkdirSync(path.join(root, '.governor'));
  writeFileSync(path.join(root, '.governor', 'config.json'), JSON.stringify({
    adapter: 'vitest', testGlobs: ['tests/**/*.test.ts'], sourceGlobs: ['src/**/*.ts'],
    mutation: { enabled: false, timeoutMs: 300000 }, runTimeoutMs: 120000,
  }));
  writeFileSync(path.join(root, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    `import GovernorReporter from ${JSON.stringify(path.join(governorRoot, 'dist/adapters/vitest/reporter.js'))};`,
    "export default defineConfig({ test: { include: ['tests/**/*.test.ts'], includeTaskLocation: true, reporters: ['default', new GovernorReporter()] } });",
  ].join('\n'));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-q', '--no-verify', '-m', 'init');
  execFileSync('node', [cli, 'install'], { cwd: root, stdio: 'pipe' });
  return root;
}

const write = (root: string, rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};
const commit = (root: string, env: Record<string, string> = {}) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  return spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
};
const runTests = (root: string) => spawnSync('node', [cli, 'run'], { cwd: root, encoding: 'utf8' });

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: governorRoot, stdio: 'pipe' });
});

afterAll(() => {
  tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('governor outside a git repo', () => {
  const outside = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gov-e2e-'));
    tmpDirs.push(dir);
    return dir;
  };

  it('prints usage for an unknown command', () => {
    const res = spawnSync('node', [cli], { cwd: outside(), encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/usage: governor/);
  });

  it('reports a clean error for a real command', () => {
    const res = spawnSync('node', [cli, 'run'], { cwd: outside(), encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/not a git repository/);
    expect(res.stderr).not.toMatch(/at .*\.js/);
  });
});

describe('governor gate commit (e2e)', () => {
  it('does not blame an existing test for a describe block appended after it (G8)', () => {
    const root = makeRepo();
    const imports = "import { describe, expect, it } from 'vitest';\nimport { add } from '../src/add';\n";
    const adds = "it('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n";
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(root, 'tests/add.test.ts', imports + adds);
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'existing test'], { cwd: root });
    write(root, 'src/mul.ts', 'export const mul = (a: number, b: number) => 0;\n');
    write(root, 'tests/add.test.ts', imports + "import { mul } from '../src/mul';\n" + adds
      + "\ndescribe('mul', () => {\n  it('multiplies', () => {\n    expect(mul(2, 3)).toBe(6);\n  });\n});\n");
    expect(runTests(root).status).toBe(1); // red, for an assertion
    write(root, 'src/mul.ts', 'export const mul = (a: number, b: number) => a * b;\n');
    const res = commit(root);
    expect(res.stderr + res.stdout).not.toMatch(/adds: never seen failing/);
    expect(res.status).toBe(0);
  });

  it('passes a genuine test-first commit', () => {
    const root = makeRepo();
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => 0;\n');
    write(root, 'tests/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n");
    expect(runTests(root).status).toBe(1); // red, for an assertion
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    const res = commit(root);
    expect(res.stderr + res.stdout).toMatch(/\[PASS\] red-before-green/);
    expect(res.status).toBe(0);
  });

  it('blocks a test that was never seen red', () => {
    const root = makeRepo();
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(root, 'tests/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n");
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/never seen failing/);
  });

  it('points a blocked agent at the primer', () => {
    const root = makeRepo();
    write(root, 'src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(root, 'tests/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n");
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/read \.governor\/PRIMER\.md/);
  });

  it('blocks an added .skip', () => {
    const root = makeRepo();
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit.skip('later', () => {});\n");
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/adds skip\/only\/todo/);
  });

  it('lets an override through and records it in the ledger', () => {
    const root = makeRepo();
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit.skip('later', () => {});\n");
    const res = commit(root, { GOVERNOR_OVERRIDE: 'e2e override' });
    expect(res.status).toBe(0);
    const ledger = execFileSync('cat', [path.join(root, '.governor', 'ledger.jsonl')], { encoding: 'utf8' });
    expect(ledger).toMatch(/"reason":"e2e override"/);
  });

  it('ignores failing tests in a sibling worktree nested under the root', () => {
    const root = makeRepo();
    write(root, 'vitest.config.ts', [
      "import { defineConfig } from 'vitest/config';",
      `import GovernorReporter from ${JSON.stringify(path.join(governorRoot, 'dist/adapters/vitest/reporter.js'))};`,
      "export default defineConfig({ test: { includeTaskLocation: true, reporters: ['default', new GovernorReporter()] } });",
    ].join('\n'));
    write(root, '.gitignore', 'node_modules\n.worktrees\n');
    write(root, 'tests/ok.test.ts', "import { expect, it } from 'vitest';\nit('ok', () => {\n  expect(1).toBe(1);\n});\n");
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'scan everything'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '-q', '.worktrees/sib', '-b', 'sib'], { cwd: root });
    write(root, '.worktrees/sib/tests/wip.test.ts', "import { expect, it } from 'vitest';\nit('wip', () => {\n  expect(1).toBe(2);\n});\n");
    write(root, 'docs/notes.md', 'notes\n');
    const res = commit(root);
    expect(res.stderr + res.stdout).not.toMatch(/wip/);
    expect(res.status).toBe(0);
  });
});
