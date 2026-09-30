import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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

  it('gates a merge only on what the merge adds', () => {
    const root = makeRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    g('checkout', '-q', '-b', 'feature');
    write(root, 'src/m.ts', 'export const m = 1;\n');
    write(root, 'tests/m.test.ts', "import { expect, it } from 'vitest';\nimport { m } from '../src/m';\nit('m1', () => {\n  expect(m).toBe(1);\n});\n");
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'feature work');

    g('checkout', '-q', 'main');
    write(root, 'src/unrelated.ts', 'export const u = 0;\n');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'unrelated main work');

    g('merge', '--no-commit', '--no-ff', 'feature');
    write(root, 'tests/m.test.ts', "import { expect, it } from 'vitest';\nimport { m } from '../src/m';\nit('m1', () => {\n  expect(m).toBe(1);\n});\nit('m2', () => {\n  expect(m).toBe(1);\n});\n");
    g('add', '-A');
    runTests(root);

    const failRes = spawnSync('git', ['commit', '-q', '--no-edit'], { cwd: root, encoding: 'utf8' });
    expect(failRes.status).toBe(1);
    expect(failRes.stderr + failRes.stdout).toMatch(/m2/);

    g('checkout', 'MERGE_HEAD', '--', 'tests/m.test.ts');
    runTests(root);
    const passRes = spawnSync('git', ['commit', '-q', '--no-edit'], { cwd: root, encoding: 'utf8' });
    expect(passRes.status).toBe(0);
    expect(passRes.stderr + passRes.stdout).toMatch(/\[PASS\] red-before-green/);
  });
});

describe('clean merges (pre-merge-commit)', () => {
  it('install writes a pre-merge-commit hook', () => {
    const root = makeRepo();
    const hookRel = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-merge-commit'], { cwd: root, encoding: 'utf8' }).trim();
    const hookPath = path.resolve(root, hookRel);
    expect(existsSync(hookPath)).toBe(true);
    const content = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
    expect(content).toContain('# tdd-governor');
    expect(content).toContain('gate commit --merge');
  });

  it("gates a clean merge and passes work TDD'd on the other branch", () => {
    const root = makeRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

    g('checkout', '-b', 'feature');
    write(root, 'src/m.ts', 'export const m = 1;\n');
    write(root, 'tests/m.test.ts', "import { expect, it } from 'vitest';\nimport { m } from '../src/m';\nit('m1', () => {\n  expect(m).toBe(1);\n});\n");
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'feature work without a red in this repo');

    g('checkout', 'main');
    write(root, 'src/unrelated.ts', 'export const u = 1;\n');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'unrelated main work');

    const mergeRes = spawnSync('git', ['merge', '--no-edit', 'feature'], { cwd: root, encoding: 'utf8' });
    expect(mergeRes.status).toBe(0);
    expect(mergeRes.stdout + mergeRes.stderr).toContain('[PASS] red-before-green');
  });

  it('blocks a clean merge whose result fails the suite', () => {
    const root = makeRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'base a and b');

    g('checkout', '-b', 'feature');
    write(root, 'src/a.ts', 'export const a = 2;\n');
    write(root, 'tests/ab.test.ts', "import { expect, it } from 'vitest';\nimport { a } from '../src/a';\nimport { b } from '../src/b';\nit('adds a and b', () => {\n  expect(a + b).toBe(3);\n});\n");
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'feature sets a=2 and tests a+b=3');

    g('checkout', 'main');
    write(root, 'src/b.ts', 'export const b = 2;\n');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'main sets b=2');

    const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const mergeRes = spawnSync('git', ['merge', '--no-edit', 'feature'], { cwd: root, encoding: 'utf8' });
    expect(mergeRes.status).not.toBe(0);
    expect(mergeRes.stdout + mergeRes.stderr).toContain('[BLOCK] green');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    expect(headSha).toBe(mainSha);
  });
});

describe('linked worktrees share the install', () => {
  const neverRed = "import { it } from 'vitest';\nit('never seen red', () => {});\n";

  it('gates a commit in a linked worktree, which has no pointer of its own', () => {
    const root = makeRepo();
    const wt = path.join(root, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt-branch'], { cwd: root });
    write(wt, 'tests/a.test.ts', neverRed);
    const res = commit(wt);
    expect(res.stderr + res.stdout).not.toMatch(/governor: not installed/);
    expect(res.status).not.toBe(0);
  });

  it('keeps the main worktree gated when install is run from a linked worktree', () => {
    const root = makeRepo();
    const wt = path.join(root, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt-branch'], { cwd: root });
    // As if the governor had only ever been installed from the worktree.
    rmSync(path.join(root, '.git', 'tdd-governor-cli-path'), { force: true });
    rmSync(path.join(root, '.governor', 'cli-path'), { force: true });
    execFileSync('node', [cli, 'install'], { cwd: wt, stdio: 'pipe' });
    write(root, 'tests/a.test.ts', neverRed);
    const res = commit(root);
    expect(res.stderr + res.stdout).not.toMatch(/governor: not installed/);
    expect(res.status).not.toBe(0);
  });
});

describe('a clone without the governor installed', () => {
  it('lets the commit through with a notice instead of blocking it', () => {
    const root = makeRepo();
    rmSync(path.join(root, '.git', 'tdd-governor-cli-path'));
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit('never seen red', () => {});\n");
    const res = commit(root);
    expect(res.stderr + res.stdout).toMatch(/governor: not installed/);
    expect(res.status).toBe(0);
  });
});

describe('monorepo (packageRoot)', () => {
  // Tests live in pkg/ with their own vitest config and node_modules; the git root is one level up.
  function makeMonorepo(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-mono-'));
    tmpDirs.push(root);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    g('init', '-b', 'main', '-q');
    g('config', 'user.email', 'e2e@example.com');
    g('config', 'user.name', 'e2e');
    mkdirSync(path.join(root, 'pkg'));
    symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'pkg', 'node_modules'));
    mkdirSync(path.join(root, '.governor'));
    writeFileSync(path.join(root, '.governor', 'config.json'), JSON.stringify({
      adapter: 'vitest', packageRoot: 'pkg', testGlobs: ['pkg/tests/**/*.test.ts'], sourceGlobs: ['pkg/src/**/*.ts'],
      mutation: { enabled: false, timeoutMs: 300000 }, runTimeoutMs: 120000,
    }));
    writeFileSync(path.join(root, 'pkg', 'vitest.config.ts'), [
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
  const addTest = "import { expect, it } from 'vitest';\nimport { add } from '../src/add';\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n";

  it('install ignores the package ledger', () => {
    const root = makeMonorepo();
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')).toContain('pkg/.governor/ledger.jsonl');
  });

  it('passes a test-first commit whose red was run directly inside the package', () => {
    const root = makeMonorepo();
    write(root, 'pkg/src/add.ts', 'export const add = (a: number, b: number) => 0;\n');
    write(root, 'pkg/tests/add.test.ts', addTest);
    spawnSync('npx', ['--no-install', 'vitest', 'run'], { cwd: path.join(root, 'pkg'), encoding: 'utf8' });
    write(root, 'pkg/src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    const res = commit(root);
    expect(res.stderr + res.stdout).toMatch(/\[PASS\] green/);
    expect(res.stderr + res.stdout).toMatch(/\[PASS\] red-before-green/);
    expect(res.status).toBe(0);
  });

  it('blocks a package test that was never seen red, naming its repo path', () => {
    const root = makeMonorepo();
    write(root, 'pkg/src/add.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(root, 'pkg/tests/add.test.ts', addTest);
    const res = commit(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/pkg\/tests\/add\.test\.ts[\s\S]*never seen failing/);
  });
});

