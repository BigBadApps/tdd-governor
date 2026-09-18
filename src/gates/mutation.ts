import type { Mutant } from '../mutation/types.js';
import type { Finding, GateResult } from '../types.js';

export function mutation(input: { mutants: Mutant[]; changed: Map<string, Set<number>> }): GateResult {
  const findings: Finding[] = [];
  for (const mu of input.mutants) {
    if (mu.status !== 'survived' && mu.status !== 'no_coverage') continue;
    const lines = input.changed.get(mu.file);
    if (!lines) continue;
    let hit: number | undefined;
    for (let l = mu.startLine; l <= mu.endLine; l++) {
      if (lines.has(l)) {
        hit = l;
        break;
      }
    }
    if (hit === undefined) continue;
    const label = mu.status === 'survived' ? 'survived' : 'not covered by any test';
    findings.push({ file: mu.file, line: hit, message: `${label}: ${mu.mutator} → ${mu.replacement}` });
  }
  return { gate: 'mutation', status: findings.length > 0 ? 'BLOCK' : 'PASS', findings };
}