import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from '../diff.js';
import type { Mutant } from './types.js';

// `mutmut results` lines look like "    <mutant name>: <status>".
const RESULT_LINE = /^\s*(\S+):\s*(\w[\w ]*)\s*$/;
const STATUS: Record<string, Mutant['status']> = { survived: 'survived', 'no tests': 'no_coverage', killed: 'killed' };

export function parseMutmut(
  results: string,
  show: (name: string) => string,
  offsets?: Record<string, Record<string, number>>,
): Mutant[] {
  const mutants: Mutant[] = [];
  for (const line of results.split('\n')) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const status = STATUS[m[2]!.trim()] ?? 'other';
    if (status !== 'survived' && status !== 'no_coverage') {
      mutants.push({ file: '', startLine: 0, endLine: 0, status, mutator: m[1]!, replacement: '' });
      continue;
    }
    const diff = show(m[1]!);
    // mutmut diffs start with `--- <path>\n+++ <path>` without git's `diff --git a/<path> b/<path>`.
    // parseUnifiedDiff expects `diff --git a/... b/...`, so synthesize the header if missing.
    const fileMatch = /^---\s+(.+)$/m.exec(diff);
    const filePath = fileMatch ? fileMatch[1]!.trim() : '';
    const formattedDiff = filePath && !diff.includes('diff --git ') ? `diff --git a/${filePath} b/${filePath}\n${diff}` : diff;

    // mutmut 3.x diffs are function-relative. Resolve startLine using Python AST function offsets if provided.
    // Mutant key format: <module>.x_<func>__mutmut_<N> or <module>.xǁ<Class>ǁ<method>__mutmut_<N>
    // (\u01c1 is mutmut's CLASS_NAME_SEPARATOR)
    const funcMatch = /\.x(?:_([A-Za-z0-9_]+)|\u01c1([A-Za-z0-9_]+)\u01c1([A-Za-z0-9_]+))__mutmut_/.exec(m[1]!);
    const lookupKey = funcMatch ? (funcMatch[1] ?? `${funcMatch[2]}__${funcMatch[3]}`) : '';
    const fileOffsets = filePath && offsets ? offsets[filePath] ?? offsets[filePath.replace(/^\.\//, '')] : undefined;
    const funcStartLine = fileOffsets ? fileOffsets[lookupKey] : undefined;
    const lineOffset = funcStartLine !== undefined ? funcStartLine - 1 : 0;

    for (const f of parseUnifiedDiff(formattedDiff)) {
      const lines = f.removed.map((r) => r.line + lineOffset);
      if (lines.length === 0) continue;
      mutants.push({
        file: f.path,
        startLine: Math.min(...lines),
        endLine: Math.max(...lines),
        status,
        mutator: m[1]!,
        replacement: f.added.map((a) => a.text.trim()).join(' '),
      });
    }
  }
  return mutants;
}

export function getFunctionOffsets(
  root: string,
  python: string,
  files: string[],
): Record<string, Record<string, number>> {
  const pyCode = [
    'import ast, json, sys',
    'result = {}',
    'for path in sys.argv[1:]:',
    '    try:',
    '        with open(path, "r", encoding="utf-8") as f:',
    '            tree = ast.parse(f.read())',
    '        funcs = {}',
    '        for node in tree.body:',
    '            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):',
    '                start = node.decorator_list[0].lineno if node.decorator_list else node.lineno',
    '                funcs[node.name] = start',
    '            elif isinstance(node, ast.ClassDef):',
    '                for child in node.body:',
    '                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):',
    '                        start = child.decorator_list[0].lineno if child.decorator_list else child.lineno',
    '                        funcs[f"{node.name}__{child.name}"] = start',
    '        result[path] = funcs',
    '    except Exception:',
    '        pass',
    'print(json.dumps(result))',
  ].join('\n');
  const res = spawnSync(path.resolve(root, python), ['-c', pyCode, ...files], { cwd: root, encoding: 'utf8' });
  if (res.status === 0 && res.stdout) {
    try {
      return JSON.parse(res.stdout);
    } catch {
      return {};
    }
  }
  return {};
}

export function runMutmut(
  root: string,
  python: string,
  files: string[],
  timeoutMs: number,
): { ok: true; mutants: Mutant[] } | { ok: false; error: string } {
  rmSync(path.join(root, 'mutants'), { recursive: true, force: true }); // never read a previous run
  const mutmut = path.join(path.dirname(path.resolve(root, python)), 'mutmut');
  // macOS fork safety requires disabling ObjC initialize safety & OpenCL GPU acceleration across forks
  const env = {
    ...process.env,
    GOVERNOR_DISABLE_REPORTER: '1',
    OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES',
    OPENCV_OPENCL_DEVICE: 'disabled',
  };
  // mutmut module filter strips `src.` prefix from dotted names
  const globs = files.map((f) => f.replace(/\.py$/, '').replaceAll('/', '.').replace(/^src\./, '') + '*');
  const offsets = getFunctionOffsets(root, python, files);
  try {
    const run = spawnSync(mutmut, ['run', ...globs], { cwd: root, env, stdio: 'inherit', timeout: timeoutMs });
    if (run.error) return { ok: false, error: `mutmut did not run: ${run.error.message}` };
    if (run.signal) return { ok: false, error: `mutmut killed by ${run.signal}` };
    const results = spawnSync(mutmut, ['results', '--all', 'true'], { cwd: root, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (results.status !== 0) return { ok: false, error: `mutmut results failed: ${results.stderr || results.error?.message || 'non-zero exit'}` };
    const show = (name: string) => spawnSync(mutmut, ['show', name], { cwd: root, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).stdout ?? '';

    const mutants = parseMutmut(results.stdout, show, offsets);
    if (mutants.length === 0) return { ok: false, error: 'mutmut produced no mutants for the changed files' };
    return { ok: true, mutants };
  } finally {
    rmSync(path.join(root, 'mutants'), { recursive: true, force: true });
  }
}
