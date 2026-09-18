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

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      cur = { path: m ? m[2]! : '', status: 'modified', added: [], removed: [] };
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
      else if (raw.startsWith('+++ b/')) cur.path = raw.slice(6);
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
