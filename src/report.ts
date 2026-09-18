import type { GateResult } from './types.js';

export type Decision =
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'override'; gates: string[]; reason: string }
  | { kind: 'bad-override' };

export function decide(results: GateResult[], override: string | undefined): Decision {
  const failing = results.filter((r) => r.status !== 'PASS').map((r) => r.gate);
  if (failing.length === 0) return { kind: 'pass' };
  if (override === undefined) return { kind: 'fail' };
  if (override.trim() === '') return { kind: 'bad-override' };
  return { kind: 'override', gates: failing, reason: override.trim() };
}

export function formatResults(results: GateResult[]): string {
  return results
    .flatMap((r) => [
      `[${r.status}] ${r.gate}`,
      ...r.findings.map((f) => `  ${f.file}${f.line !== undefined ? `:${f.line}` : ''}  ${f.message}`),
    ])
    .join('\n');
}
