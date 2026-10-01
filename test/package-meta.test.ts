import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('open-source metadata', () => {
  it('declares the MIT license in package.json', () => {
    expect(pkg.license).toBe('MIT');
  });

  it('ships an MIT LICENSE file naming the copyright holder', () => {
    const text = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    expect(text).toMatch(/^MIT License/);
    expect(text).toMatch(/Copyright \(c\) 2026 BigBadApps/);
  });

  it('points package.json at the public repository', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/BigBadApps/tdd-governor.git' });
    expect(pkg.bugs).toEqual({ url: 'https://github.com/BigBadApps/tdd-governor/issues' });
  });

  it.each(['SECURITY.md', 'CONTRIBUTING.md', '.github/dependabot.yml', '.github/pull_request_template.md'])(
    'has %s',
    (file) => {
      expect(existsSync(path.join(root, file))).toBe(true);
    },
  );

  it('keeps Dependabot off major version bumps of npm packages', () => {
    const text = readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
    expect(text).toContain('version-update:semver-major');
  });
});

describe('npm package', () => {
  const packed: string[] = (
    JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0].files as Array<{ path: string }>
  ).map((f) => f.path);

  it('is publishable', () => {
    expect(pkg.private).not.toBe(true);
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
  });

  it('ships the built cli, reporter, template, license and readme, and nothing else', () => {
    for (const f of [
      'dist/cli.js',
      'dist/adapters/vitest/reporter.js',
      'templates/governor-ci.yml',
      'python/tdd_governor_pytest.py',
      'python/pyproject.toml',
      'LICENSE',
      'README.md',
    ]) {
      expect(packed).toContain(f);
    }
    const extra = packed.filter((f) => !/^(dist\/|templates\/|python\/|LICENSE$|README\.md$|package\.json$)/.test(f));
    expect(extra).toEqual([]);
    expect(packed.some((f) => f.includes('__pycache__'))).toBe(false);
  });

  it('declares the bin path the way npm publishes it, so `npm publish` has nothing to correct', () => {
    expect(pkg.bin).toEqual({ governor: 'dist/cli.js' });
  });

  it('builds before packing, so a publish cannot ship a stale dist', () => {
    expect(pkg.scripts.prepack).toBe('npm run build');
  });
});

describe('publish workflow', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('runs only when a release is published', () => {
    expect(workflow).toMatch(/^on:\n  release:\n    types: \[published\]$/m);
  });

  it('publishes with provenance through OIDC, not a stored token', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toMatch(/^\s+- run: npm publish$/m);
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('tests before it publishes', () => {
    expect(workflow.indexOf('npm test')).toBeGreaterThan(-1);
    expect(workflow.indexOf('npm test')).toBeLessThan(workflow.indexOf('npm publish'));
  });

  it('pins every action to a commit sha', () => {
    const uses = [...workflow.matchAll(/^\s+- uses: (.+)$/gm)].map((m) => m[1]!.split('#')[0]!.trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('readme install', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

  it('installs from npm and imports the reporter by package name', () => {
    expect(readme).toContain('npm install --save-dev tdd-governor');
    expect(readme).toContain("from 'tdd-governor/vitest-reporter'");
  });
});
