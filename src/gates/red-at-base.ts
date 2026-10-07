import type { Finding, GateResult, RunOutcome, TestResult } from '../types.js';

// CI's red evidence, re-derived rather than read from a ledger any local process can append to (spec §9 G3):
// each added or changed test must fail once the PR's source changes are reverted.
export function redAtBase(input: { scoped: TestResult[]; sourceChanged: boolean; base: RunOutcome }): GateResult {
  const gate = 'red-at-base' as const;
  if (input.scoped.length === 0) return { gate, status: 'PASS', findings: [] };
  if (!input.sourceChanged) {
    return { gate, status: 'PASS', findings: [{ file: '(diff)', message: 'warning: no source files changed: nothing to re-derive red evidence against' }] };
  }
  if (input.base.kind === 'unavailable') return { gate, status: 'GATE_UNAVAILABLE', findings: [{ file: '(base run)', message: input.base.reason }] };

  const { record } = input.base;
  const findings: Finding[] = [];
  let block = false;
  let undecided = false;
  const testResultsById = new Map(record.tests.map(t => [t.id, t]));
  for (const t of input.scoped) {
    const where = { file: t.file, ...(t.line !== undefined && { line: t.line }) };
    const result = testResultsById.get(t.id);
    if (result?.status === 'fail' && result.failureKind === 'assertion') continue;
    if (result?.status === 'pass') {
      block = true;
      findings.push({ ...where, message: `${t.id}: passes with this PR's source changes reverted, so it does not test them. Move tests of existing behaviour to a tests-only PR` });
    } else if (result?.status === 'fail') {
      findings.push({ ...where, message: `warning: ${t.id}: fails at base with ${result.failureKind ?? 'unknown'}, not an assertion (expected when it tests new code)` });
    } else if (!result && record.collectionErrors.some((e) => e.file === t.file)) {
      findings.push({ ...where, message: `warning: ${t.id}: its file does not import at base (expected when it tests new code)` });
    } else {
      undecided = true;
      findings.push({ ...where, message: `${t.id}: ${result ? 'skipped' : 'not run'} at base, so whether it tests this PR's changes is unknown` });
    }
  }
  return { gate, status: block ? 'BLOCK' : undecided ? 'UNDECIDED' : 'PASS', findings };
}
