import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import * as git from '../src/git.js';
import * as config from '../src/config.js';
import * as install from '../src/install.js';
import * as vitestRun from '../src/adapters/vitest/run.js';
import * as pytestRun from '../src/adapters/pytest/run.js';
import * as report from '../src/report.js';
import * as baseWorktree from '../src/base-worktree.js';
import * as diffAudit from '../src/gates/diff-audit.js';
import * as green from '../src/gates/green.js';
import * as mutation from '../src/gates/mutation.js';
import * as redAtBase from '../src/gates/red-at-base.js';
import * as redBeforeGreen from '../src/gates/red-before-green.js';

vi.mock('../src/git.js');
vi.mock('../src/config.js');
vi.mock('../src/install.js');
vi.mock('../src/adapters/vitest/run.js');
vi.mock('../src/adapters/pytest/run.js');
vi.mock('../src/report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/report.js')>();
  return {
    ...actual,
    formatResults: vi.fn(),
    decide: vi.fn(),
  };
});

describe('main', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 2 and prints usage for unknown commands', () => {
    expect(main(['unknown'])).toBe(2);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });

  it('returns 2 and prints error if not in a git repository', () => {
    vi.mocked(git.repoRoot).mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(main(['run'])).toBe(2);
    expect(consoleError).toHaveBeenCalledWith('governor: not a git repository');
  });

  describe('run', () => {
    it('returns 2 if config is missing', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      vi.mocked(config.loadConfig).mockReturnValue({ ok: false, error: 'no config' });
      expect(main(['run'])).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('governor: no config');
    });

    it('returns 2 if test run is unavailable', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      const loadedConfig: any = { adapter: 'vitest', testGlobs: [], sourceGlobs: [], mutation: { enabled: false }, runTimeoutMs: 1 };
      vi.mocked(config.loadConfig).mockReturnValue({ ok: true, config: loadedConfig });
      vi.mocked(config.packageOf).mockReturnValue({ dir: '/root', rel: '.', toPackage: (p) => p, toRepo: (p) => p });
      vi.mocked(vitestRun.runVitest).mockReturnValue({ kind: 'unavailable', reason: 'offline' });

      expect(main(['run'])).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('governor: GATE_UNAVAILABLE: offline');
    });

    it('returns test runner exit code and logs when test run is completed', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      const loadedConfig: any = { adapter: 'vitest', testGlobs: [], sourceGlobs: [], mutation: { enabled: false }, runTimeoutMs: 1 };
      vi.mocked(config.loadConfig).mockReturnValue({ ok: true, config: loadedConfig });
      vi.mocked(config.packageOf).mockReturnValue({ dir: '/root', rel: '.', toPackage: (p) => p, toRepo: (p) => p });

      vi.mocked(vitestRun.runVitest).mockReturnValue({
        kind: 'completed',
        record: {
          v: 1, runId: 'id', at: 'now', adapter: 'vitest', exitCode: 123, head: 'head',
          tests: [
            { file: 'a.test.ts', id: 'a', line: 1, status: 'pass' },
            { file: 'a.test.ts', id: 'b', line: 2, status: 'fail' }
          ],
          collectionErrors: []
        }
      });

      expect(main(['run'])).toBe(123);
      expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('recorded run id: 2 tests, 1 failed, 0 collection errors'));
    });
  });

  describe('gate ci', () => {
    it('returns 2 if --base has no value', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      expect(main(['gate', 'ci', '--base'])).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('usage: governor gate ci [--base <ref>]');
    });
  });

  describe('install', () => {
    it('returns 2 and prints error if config is missing', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      vi.mocked(config.loadConfig).mockReturnValue({ ok: false, error: 'missing config' });
      expect(main(['install'])).toBe(2);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('governor: missing config'));
    });

    it('returns 0 if install is successful', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      const loadedConfig: any = { adapter: 'vitest', testGlobs: [], sourceGlobs: [], mutation: { enabled: false }, runTimeoutMs: 1 };
      vi.mocked(config.loadConfig).mockReturnValue({ ok: true, config: loadedConfig });
      vi.mocked(config.packageOf).mockReturnValue({ dir: '/root', rel: '.', toPackage: (p) => p, toRepo: (p) => p });
      vi.mocked(install.installHooks).mockReturnValue({ ok: true, messages: ['installed correctly'] });

      expect(main(['install'])).toBe(0);
      expect(consoleLog).toHaveBeenCalledWith('governor: installed correctly');
    });

    it('returns 1 if install is unsuccessful', () => {
      vi.mocked(git.repoRoot).mockReturnValue('/root');
      const loadedConfig: any = { adapter: 'vitest', testGlobs: [], sourceGlobs: [], mutation: { enabled: false }, runTimeoutMs: 1 };
      vi.mocked(config.loadConfig).mockReturnValue({ ok: true, config: loadedConfig });
      vi.mocked(config.packageOf).mockReturnValue({ dir: '/root', rel: '.', toPackage: (p) => p, toRepo: (p) => p });
      vi.mocked(install.installHooks).mockReturnValue({ ok: false, messages: ['failed to install'] });

      expect(main(['install'])).toBe(1);
      expect(consoleLog).toHaveBeenCalledWith('governor: failed to install');
    });
  });
});
