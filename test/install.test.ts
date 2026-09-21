import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHooks } from '../src/install.js';

const repo = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-install-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
};
const hooks = [{ name: 'pre-commit', command: 'gate commit' }];

describe('installHooks agent primer', () => {
  it('writes .governor/PRIMER.md saying what counts as a red and how to get one', () => {
    const root = repo();
    const { messages } = installHooks(root, '/x/cli.js', hooks);
    const file = path.join(root, '.governor', 'PRIMER.md');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/AssertionError/);
    expect(text).toMatch(/stub/i);
    expect(text).toMatch(/GOVERNOR_OVERRIDE/);
    expect(messages.join('\n')).toMatch(/PRIMER\.md/);
  });

  it('refreshes a stale primer on reinstall', () => {
    const root = repo();
    installHooks(root, '/x/cli.js', hooks);
    const file = path.join(root, '.governor', 'PRIMER.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'old text\n');
    installHooks(root, '/x/cli.js', hooks);
    expect(readFileSync(file, 'utf8')).not.toBe('old text\n');
  });
});
