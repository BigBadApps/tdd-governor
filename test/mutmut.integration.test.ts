import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutation } from '../src/gates/mutation.js';
import { parseMutmut, runMutmut } from '../src/mutation/mutmut.js';

const out = path.resolve(__dirname, 'fixtures/mutmut-output');
const repo = path.resolve(__dirname, '..');
const python = process.env.GOVERNOR_TEST_PYTHON ?? path.join(repo, '.venv-py/bin/python');

describe('parseMutmut (captured output)', () => {
  it('turns survivors into line-located mutants', () => {
    const results = readFileSync(path.join(out, 'results.txt'), 'utf8');
    const shows = Object.fromEntries(
      readdirSync(out)
        .filter((f) => f.startsWith('show-'))
        .map((f) => [f.slice(5, -5), readFileSync(path.join(out, f), 'utf8')]),
    );
    const mutants = parseMutmut(results, (name) => shows[name] ?? '');
    const survivors = mutants.filter((m) => m.status === 'survived');
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((m) => m.file === 'src/clamp.py')).toBe(true);
    expect(survivors.some((m) => m.startLine === 4)).toBe(true); // `if x > hi:` has no test
  });

  it('resolves function offsets when diff line numbers are function-relative', () => {
    const results = '    backend.scoring.x_score_exposure__mutmut_71: survived\n';
    const diff = [
      '# backend.scoring.x_score_exposure__mutmut_71: survived',
      '--- backend/scoring.py',
      '+++ backend/scoring.py',
      '@@ -18,7 +18,7 @@',
      '     if mean == 999.0:',
      '-        exposure_score = 0.5',
      '+        exposure_score = 1.5',
    ].join('\n');
    const offsets = { 'backend/scoring.py': { score_exposure: 210 } };
    const mutants = parseMutmut(results, () => diff, offsets);
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.file).toBe('backend/scoring.py');
    expect(mutants[0]?.startLine).toBe(228);
    expect(mutants[0]?.status).toBe('survived');
  });
});

describe('runMutmut (real mutmut)', () => {
  it('blocks the untested upper bound through the gate', () => {
    const root = path.resolve(__dirname, 'fixtures/mutmut-project');
    const run = runMutmut(root, python, ['src/clamp.py'], 300_000);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(mutation({ mutants: run.mutants, changed: new Map([['src/clamp.py', new Set([4])]]) }).status).toBe('BLOCK');
  }, 300_000);
});
