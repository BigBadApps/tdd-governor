import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutation } from '../src/gates/mutation.js';
import { runStryker } from '../src/mutation/stryker.js';

const fixture = path.resolve(__dirname, 'fixtures/mutation-project');

describe('runStryker (real Stryker)', () => {
  it('finds the surviving upper-bound mutant, and the gate blocks it', () => {
    // Plant a stale report: it must be deleted, never read.
    mkdirSync(path.join(fixture, 'reports/mutation'), { recursive: true });
    writeFileSync(path.join(fixture, 'reports/mutation/mutation.json'), '{"files":{}}');

    const result = runStryker(fixture, ['src/clamp.ts'], 300_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mutants.length).toBeGreaterThan(0);
    expect(result.mutants.some((m) => m.startLine === 3 && m.status !== 'killed')).toBe(true);

    const gate = mutation({ mutants: result.mutants, changed: new Map([['src/clamp.ts', new Set([3])]]) });
    expect(gate.status).toBe('BLOCK');
  }, 300_000);

  it('fails closed when Stryker is not configured', () => {
    const result = runStryker(path.resolve(__dirname, 'fixtures/no-reporter'), ['ok.test.ts'], 60_000);
    expect(result.ok).toBe(false);
    expect(existsSync(path.resolve(__dirname, 'fixtures/no-reporter/reports/mutation/mutation.json'))).toBe(false);
  }, 60_000);
});