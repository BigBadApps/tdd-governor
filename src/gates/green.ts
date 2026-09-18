import type { Finding, GateResult, RunOutcome } from '../types.js';

export function green(outcome: RunOutcome): GateResult {
  if (outcome.kind === 'unavailable') {
    return { gate: 'green', status: 'GATE_UNAVAILABLE', findings: [{ file: '(runner)', message: outcome.reason }] };
  }
  const { record } = outcome;
  const findings: Finding[] = [
    ...record.collectionErrors.map((e) => ({ file: e.file, message: `collection error: ${e.message}` })),
    ...record.tests
      .filter((t) => t.status === 'fail')
      .slice(0, 20)
      .map((t) => ({ file: t.file, ...(t.line !== undefined && { line: t.line }), message: `failing: ${t.id}: ${t.message ?? ''}` })),
  ];
  if (record.exitCode !== 0 && findings.length === 0) {
    findings.push({ file: '(runner)', message: `test run exited with exit code ${record.exitCode}` });
  }
  if (record.tests.length === 0 && findings.length === 0) {
    findings.push({ file: '(runner)', message: 'test run executed no tests (suite emptied or passWithNoTests)' });
  }
  return { gate: 'green', status: findings.length > 0 ? 'BLOCK' : 'PASS', findings };
}
