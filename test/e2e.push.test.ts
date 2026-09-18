import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const governorRoot = path.resolve(__dirname, '..');
const cli = path.join(governorRoot, 'dist', 'cli.js');

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: governorRoot, stdio: 'pipe' });
});

describe('governor gate push (e2e)', () => {
  it('blocks a push whose changed line has a surviving mutant', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gov-push-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    cpSync(path.resolve(__dirname, 'fixtures/mutation-project'), root, { recursive: true });
    symlinkSync(path.join(governorRoot, 'node_modules'), path.join(root, 'node_modules'));
    mkdirSync(path.join(root, '.governor'), { recursive: true });
    writeFileSync(path.join(root, '.governor/config.json'), JSON.stringify({
      adapter: 'vitest', testGlobs: ['tests/**/*.check.ts'], sourceGlobs: ['src/**/*.ts'],
      mutation: { enabled: true, timeoutMs: 300000 }, runTimeoutMs: 120000,
    }));
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\nreports\n.stryker-tmp\n');
    // Base commit: clamp without the upper bound.
    writeFileSync(path.join(root, 'src/clamp.ts'), 'export function clamp(x: number, lo: number, hi: number): number {\n  if (x < lo) return lo;\n  return x;\n}\n');
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'e@example.com');
    g('config', 'user.name', 'e');
    g('add', '-A');
    g('commit', '-q', '--no-verify', '-m', 'base');
    const remote = mkdtempSync(path.join(tmpdir(), 'gov-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    g('remote', 'add', 'origin', remote);
    g('push', '-q', '-u', 'origin', 'main');
    execFileSync('node', [cli, 'install'], { cwd: root });

    // Change: add the upper bound, without a test for it.
    cpSync(path.resolve(__dirname, 'fixtures/mutation-project/src/clamp.ts'), path.join(root, 'src/clamp.ts'));
    g('commit', '-q', '--no-verify', '-am', 'upper bound');

    const res = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: root, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/\[BLOCK\] mutation[\s\S]*src\/clamp\.ts:3/);
  }, 300_000);
});