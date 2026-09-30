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
});
