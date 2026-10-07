export interface DiffLine {
  line: number;
  text: string;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  added: DiffLine[];
  removed: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

// Undo git's C-style path quoting ("t\303\251st.ts" -> tést.ts).
function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== '\\') {
      bytes.push(...Buffer.from(s[i]!, 'utf8'));
    } else if (/[0-7]/.test(s[i + 1]!)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[s[++i]!] ?? s.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// With --no-renames both sides name the same path, so the header is "<a> <b>" with equal halves.
// Splitting at the midpoint is exact even when the path contains " b/" or spaces.
// Anything else throws: a wrong or empty path would make every gate skip the file.
function headerPath(rest: string): string {
  const half = (rest.length - 1) / 2;
  const a = unquote(rest.slice(0, half));
  const b = unquote(rest.slice(half + 1));
  if (!a.startsWith('a/') || !b.startsWith('b/') || a.slice(2) !== b.slice(2) || a.length < 3) {
    throw new Error(`unparseable diff header: diff --git ${rest}`);
  }
  return a.slice(2);
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { path: headerPath(raw.slice('diff --git '.length)), status: 'modified', added: [], removed: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // Header lines only appear before the first hunk of a file.
      if (raw.startsWith('new file mode')) cur.status = 'added';
      else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
      continue;
    }
    if (raw.startsWith('+')) cur.added.push({ line: newLine++, text: raw.slice(1) });
    else if (raw.startsWith('-')) cur.removed.push({ line: oldLine++, text: raw.slice(1) });
    else if (raw.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
    // '\ No newline at end of file' and blank trailing lines: ignored
  }
  return files;
}

// Merge commit: keep only what is new against every parent. Added lines share the index's numbering across
// the diffs; removed lines are numbered per parent, so they are matched by text, each parent line used once.
export function mergeScoped(ours: FileDiff[], theirs: FileDiff[][]): FileDiff[] {
  return ours.flatMap((f) => {
    const others = theirs.map((d) => d.find((o) => o.path === f.path));
    if (others.some((o) => o === undefined)) return [];

    const othersAddedSets = others.map((o) => new Set(o!.added.map((b) => b.line)));
    const added = f.added.filter((a) => othersAddedSets.every((set) => set.has(a.line)));

    const unmatched = others.map((o) => o!.removed.map((b) => b.text));
    const removed = f.removed.filter((r) => {
      const at = unmatched.map((texts) => texts.indexOf(r.text));
      if (at.some((i) => i < 0)) return false;
      at.forEach((i, k) => unmatched[k]!.splice(i, 1));
      return true;
    });
    const status = others.every((o) => o!.status === f.status) ? f.status : 'modified';
    return added.length > 0 || removed.length > 0 || status === 'deleted' ? [{ path: f.path, status, added, removed }] : [];
  });
}
