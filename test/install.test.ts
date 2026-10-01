import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHooks } from '../src/install.js';
import { renderPrimer, reporterWarning } from '../src/primer.js';

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

describe('installHooks agent primer names the real config file', () => {
  it('names vite.config.js when that is the only vitest config present', () => {
    const root = repo();
    writeFileSync(path.join(root, 'vite.config.js'), 'export default {}\n');
    const { messages } = installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toContain('vite.config.js');
    expect(text).not.toContain('vitest.config.ts');
    expect(messages.join('\n')).not.toMatch(/vitest\.config\.ts/);
  });

  it('names vitest.config.ts when that is present', () => {
    const root = repo();
    writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {}\n');
    installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toContain('vitest.config.ts');
  });

  it('prefers a vitest config over a vite config in the same folder', () => {
    const root = repo();
    writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {}\n');
    writeFileSync(path.join(root, 'vite.config.js'), 'export default {}\n');
    installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toContain('vitest.config.ts');
    expect(text).not.toContain('vite.config.js');
  });

  it('looks inside packageRoot, not the repo root, for a monorepo package', () => {
    const root = repo();
    mkdirSync(path.join(root, 'frontend'));
    writeFileSync(path.join(root, 'frontend', 'vite.config.js'), 'export default {}\n');
    installHooks(root, '/x/cli.js', hooks, 'frontend');
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toContain('frontend/vite.config.js');
  });

  it('falls back to generic wording when no vitest config is found', () => {
    const root = repo();
    installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toMatch(/vitest\.config|vite\.config/);
    expect(text).not.toContain('vitest.config.ts` (the governor');
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
    expect(text).toMatch(/test\.reporters|vitest\.config|vite\.config/);
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

  it('answers the usual excuses for bypassing a block', () => {
    const root = repo();
    installHooks(root, '/x/cli.js', hooks);
    const text = readFileSync(path.join(root, '.governor', 'PRIMER.md'), 'utf8');
    expect(text).toMatch(/## Excuses that do not work/);
    expect(text).toMatch(/too simple to test/i);
    expect(text).toMatch(/I'll add the test after/i);
    expect(text).toMatch(/a test written afterward may pass on its first run/i);
    expect(text).toMatch(/I tested it manually/i);
    expect(text).toMatch(/The test is obviously right/i);
    expect(text).toMatch(/I'll break the code for a moment to record a red/i);
    expect(text).toMatch(/I'll skip or weaken this one test/i);
    expect(text).toMatch(/Only the governor is wrong/i);
    expect(text).toMatch(/Just this once/i);
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

  it('refuses a hand-written hook that merely mentions the governor in a comment', () => {
    // A real incident: a comment describing the governor's snippet made install rewrite the whole
    // hook, destroying a main-branch guard and a git-lfs delegate that lived in the same file.
    const root = repo();
    const file = path.join(root, '.git', 'hooks', 'pre-push');
    mkdirSync(path.dirname(file), { recursive: true });
    const mine = ["#!/bin/sh", "# tdd-governor's push gate is appended below; the guard above it is ours.", 'echo guard', ''].join('\n');
    writeFileSync(file, mine);
    const { ok, messages } = installHooks(root, '/x/cli.js', [{ name: 'pre-push', command: 'gate push' }]);
    expect(ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(mine);
    expect(messages.join('\n')).toContain('refusing to overwrite existing pre-push hook');
  });

  it('upgrades a hook it wrote itself, including one from an older version', () => {
    const root = repo();
    const file = path.join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n# tdd-governor\nexec node "/old/path/cli.js" gate commit\n');
    const { ok } = installHooks(root, '/x/cli.js', hooks);
    expect(ok).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('/old/path/cli.js');
  });

  it('suggests lines that succeed on a machine without the governor, like the generated hook', () => {
    const root = repo();
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho mine\n');
    const { messages } = installHooks(root, '/x/cli.js', hooks);
    const snippet = messages[0].split('yourself:\n')[1];

    const other = repo();
    const handWritten = path.join(other, 'hand-written-hook');
    writeFileSync(handWritten, `#!/bin/sh\necho mine\n${snippet}\n`);
    chmodSync(handWritten, 0o755);
    const run = spawnSync(handWritten, { cwd: other, encoding: 'utf8' });
    expect(run.status).toBe(0);
  });
});

describe('reporterWarning', () => {
  it('is silent when the config loads the reporter by package name', () => {
    expect(reporterWarning('vitest.config.ts', "import R from 'tdd-governor/vitest-reporter';")).toBeUndefined();
  });

  it('is silent when the config loads the reporter by path', () => {
    expect(reporterWarning('vitest.config.ts', "import R from '../dist/adapters/vitest/reporter.js';")).toBeUndefined();
  });

  it('is silent when the config finds the reporter through the install pointer', () => {
    const config = "const cli = readFileSync(path.join(gitDir, 'tdd-governor-cli-path'), 'utf8');\n"
      + "const reporter = path.join(path.dirname(cli), 'adapters', 'vitest', 'reporter.js');";
    expect(reporterWarning('frontend/vite.config.js', config)).toBeUndefined();
  });

  it('names the config and the fix when the reporter is missing', () => {
    const w = reporterWarning('frontend/vite.config.ts', 'export default {}');
    expect(w).toMatch(/frontend\/vite\.config\.ts/);
    expect(w).toMatch(/governor run/);
    expect(w).toMatch(/tdd-governor\/vitest-reporter/);
  });

  it('warns when no vitest config was found', () => {
    expect(reporterWarning(undefined, undefined)).toMatch(/no vitest config/);
  });
});

describe('primer', () => {
  it('tells agents that `governor run` always records', () => {
    expect(renderPrimer('vitest.config.ts')).toContain('npx governor run -- <test files>');
  });
});

