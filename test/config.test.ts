import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const repoWith = (content: string | null) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gov-config-'));
  if (content !== null) {
    mkdirSync(path.join(root, '.governor'));
    writeFileSync(path.join(root, '.governor', 'config.json'), content);
  }
  return root;
};

const valid = {
  adapter: 'vitest',
  testGlobs: ['tests/**/*.test.ts'],
  sourceGlobs: ['src/**/*.ts'],
  mutation: { enabled: true, timeoutMs: 300000 },
  runTimeoutMs: 120000,
};

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const result = loadConfig(repoWith(JSON.stringify(valid)));
    expect(result).toEqual({ ok: true, config: valid });
  });

  it('fails when the file is missing', () => {
    const result = loadConfig(repoWith(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\.governor\/config\.json not found/);
  });

  it('fails on invalid JSON', () => {
    expect(loadConfig(repoWith('{nope')).ok).toBe(false);
  });

  it('fails on empty globs rather than defaulting', () => {
    const result = loadConfig(repoWith(JSON.stringify({ ...valid, testGlobs: [] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/testGlobs/);
  });

  it('fails on an unknown adapter', () => {
    expect(loadConfig(repoWith(JSON.stringify({ ...valid, adapter: 'jest' }))).ok).toBe(false);
  });
});
