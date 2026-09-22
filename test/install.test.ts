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

describe('installHooks writes portable hooks', () => {
  it('keeps the machine-specific cli path out of the hook file', () => {
    const root = repo();
    installHooks(root, '/x/cli.js', hooks);
    const hook = readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).not.toContain('/x/cli.js');
    expect(hook).toContain('# tdd-governor');
    expect(hook).toContain('gate commit');
  });

  it('records the cli path in the shared git directory, where every worktree sees it', () => {
    const root = repo();
    const { messages } = installHooks(root, '/x/cli.js', hooks);
    expect(readFileSync(path.join(root, '.git', 'tdd-governor-cli-path'), 'utf8').trim()).toBe('/x/cli.js');
    expect(existsSync(path.join(root, '.governor', 'cli-path'))).toBe(false);
    expect(messages.join('\n')).toMatch(/cli-path/);
  });
});

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
    expect(text).toMatch(/test\.reporters|vitest\.config/);
    expect(text).toMatch(/merge commit is gated only on what the merge itself changes/);
    expect(messages.join('\n')).toMatch(/PRIMER\.md/);
  });

  it('tells agents to escalate an override request with the three evidence questions', () => {
    const root = repo();
    installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toMatch(/Is the governor wrong here\?/);
    expect(text).toMatch(/proof each flagged test failed/);
    expect(text).toMatch(/governor bug been written down/);
    expect(text).toMatch(/any answer is no or unknown/i);
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

describe('installHooks refuses a foreign hook', () => {
  it('refuses to overwrite a foreign hook and suggests a portable snippet, not an absolute cli path', () => {
    const root = repo();
    const file = path.join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\necho mine\n');
    const { ok, messages } = installHooks(root, '/x/cli.js', hooks);
    expect(ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    const message = messages.join('\n');
    expect(message).toContain('refusing to overwrite existing pre-commit hook');
    expect(message).not.toContain('/x/cli.js');
    expect(message).toContain('tdd-governor-cli-path');
    expect(message).toContain('GOVERNOR_CLI');
    expect(message).toContain('gate commit');
  });
});
