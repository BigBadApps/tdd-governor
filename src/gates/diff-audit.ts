import type { DiffLine, FileDiff } from '../diff.js';
import type { Finding, GateResult } from '../types.js';

const SKIP = /\.(skip|only|todo|skipIf)\s*\(|\b(xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(/;
const ASSERTION = /\bexpect\s*\(|\bassert\b/g;
const EXPECT_N = /expect\.assertions\s*\(\s*(\d+)\s*\)/;
const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;

const countAssertions = (lines: DiffLine[]) => lines.reduce((n, l) => n + (l.text.match(ASSERTION)?.length ?? 0), 0);
const maxExpectN = (lines: DiffLine[]) => {
  const ns = lines.map((l) => EXPECT_N.exec(l.text)).filter((m) => m !== null).map((m) => Number(m[1]));
  return ns.length > 0 ? Math.max(...ns) : undefined;
};

export function diffAudit(input: { diff: FileDiff[]; isTestFile: (path: string) => boolean }): GateResult {
  const findings: Finding[] = [];
  let block = false;
  const blockAt = (f: Finding) => {
    block = true;
    findings.push(f);
  };

  for (const f of input.diff) {
    if (SNAPSHOT.test(f.path)) {
      findings.push({ file: f.path, message: 'warning: snapshot changed: review that the new snapshot is correct' });
      continue;
    }
    if (!input.isTestFile(f.path)) continue;
    if (f.status === 'deleted') {
      blockAt({ file: f.path, message: 'test file deleted' });
      continue;
    }
    for (const a of f.added) {
      if (SKIP.test(a.text)) blockAt({ file: f.path, line: a.line, message: `adds skip/only/todo: ${a.text.trim()}` });
    }
    const net = countAssertions(f.removed) - countAssertions(f.added);
    if (net > 0) blockAt({ file: f.path, message: `net removal of ${net} assertion${net === 1 ? '' : 's'}` });

    const before = maxExpectN(f.removed);
    const after = maxExpectN(f.added);
    if (before !== undefined && (after === undefined || after < before)) {
      blockAt({ file: f.path, message: `expect.assertions lowered from ${before} to ${after ?? 'none'}` });
    }
  }
  return { gate: 'diff-audit', status: block ? 'BLOCK' : 'PASS', findings };
}
