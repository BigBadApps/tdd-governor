import { describe, expect, it } from 'vitest';
import { mergeScoped, parseUnifiedDiff, type FileDiff } from '../src/diff.js';

const modified = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@ export function a() {
-  return 1;
+  return 2;
@@ -10,0 +11,2 @@ more
+const x = 1;
+const y = 2;
`;

const added = `diff --git a/tests/new.test.ts b/tests/new.test.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/tests/new.test.ts
@@ -0,0 +1,2 @@
+import { it } from 'vitest';
+it('x', () => {});
`;

const deleted = `diff --git a/tests/old.test.ts b/tests/old.test.ts
deleted file mode 100644
index 444..000
--- a/tests/old.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-it('gone', () => {});
`;

const trickyRemoval = `diff --git a/doc.md b/doc.md
index 1..2 100644
--- a/doc.md
+++ b/doc.md
@@ -5 +4,0 @@
---- a heading rule
`;

describe('parseUnifiedDiff', () => {
  it('parses modified files with new-file line numbers for additions', () => {
    const [f] = parseUnifiedDiff(modified);
    expect(f).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      added: [
        { line: 3, text: '  return 2;' },
        { line: 11, text: 'const x = 1;' },
        { line: 12, text: 'const y = 2;' },
      ],
      removed: [{ line: 3, text: '  return 1;' }],
    });
  });

  it('detects added and deleted files', () => {
    const files = parseUnifiedDiff(added + deleted);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['tests/new.test.ts', 'added'],
      ['tests/old.test.ts', 'deleted'],
    ]);
    expect(files[0]!.added).toHaveLength(2);
    expect(files[1]!.removed).toEqual([{ line: 1, text: "it('gone', () => {});" }]);
  });

  it('does not mistake a removed line starting with --- for a header', () => {
    const [f] = parseUnifiedDiff(trickyRemoval);
    expect(f!.removed).toEqual([{ line: 5, text: '--- a heading rule' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

// Header shapes captured from real `git diff --cached -U0 --no-color --no-renames --no-ext-diff` (git default core.quotePath).
const spaced = 'diff --git a/s p.test.ts b/s p.test.ts\nindex 1..2 100644\n--- a/s p.test.ts\t\n+++ b/s p.test.ts\t\n@@ -1,0 +2 @@\n+expect(1)\n';
const quoted = 'diff --git "a/t\\303\\251st.test.ts" "b/t\\303\\251st.test.ts"\nindex 1..2 100644\n--- "a/t\\303\\251st.test.ts"\n+++ "b/t\\303\\251st.test.ts"\n@@ -1,0 +2 @@\n+expect(1)\n';
const escaped = 'diff --git "a/q\\"t.test.ts" "b/q\\"t.test.ts"\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ "b/q\\"t.test.ts"\n@@ -0,0 +1 @@\n+x\n';
const deletedBSlash = 'diff --git a/x b/y.test.ts b/x b/y.test.ts\ndeleted file mode 100644\nindex 1..0\n--- a/x b/y.test.ts\t\n+++ /dev/null\n@@ -1 +0,0 @@\n-it(\'a\', () => {})\n';

describe('parseUnifiedDiff paths', () => {
  it('drops the trailing tab git adds to paths with spaces', () => {
    expect(parseUnifiedDiff(spaced)[0]!.path).toBe('s p.test.ts');
  });

  it('unquotes octal-escaped non-ASCII paths', () => {
    expect(parseUnifiedDiff(quoted)[0]!.path).toBe('tést.test.ts');
  });

  it('unquotes backslash escapes', () => {
    expect(parseUnifiedDiff(escaped)[0]!.path).toBe('q"t.test.ts');
  });

  it('keeps the full path of a deleted file whose name contains " b/"', () => {
    expect(parseUnifiedDiff(deletedBSlash)[0]).toMatchObject({ path: 'x b/y.test.ts', status: 'deleted' });
  });

  it('throws on a header it cannot parse instead of emitting a wrong path', () => {
    expect(() => parseUnifiedDiff('diff --git a/x b/y\n')).toThrow(/unparseable diff header/);
  });
});

describe('mergeScoped', () => {
  it('drops a file that only the other parent changed (absent from theirs)', () => {
    const ours: FileDiff[] = [{ path: 'a.ts', status: 'modified', added: [{ line: 1, text: 'x' }], removed: [] }];
    const theirs: FileDiff[][] = [[]];
    expect(mergeScoped(ours, theirs)).toEqual([]);
  });

  it('keeps an added line that is new against both parents; drops one that only ours sees', () => {
    const ours: FileDiff[] = [{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 1, text: 'both' }, { line: 2, text: 'ours only' }],
      removed: [],
    }];
    const theirs: FileDiff[][] = [[{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 1, text: 'both' }],
      removed: [],
    }]];
    expect(mergeScoped(ours, theirs)).toEqual([{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 1, text: 'both' }],
      removed: [],
    }]);
  });

  it('treats a file the other branch created as not added', () => {
    const ours: FileDiff[] = [{ path: 'new.ts', status: 'added', added: [{ line: 1, text: 'x' }], removed: [] }];
    const theirs: FileDiff[][] = [[]];
    expect(mergeScoped(ours, theirs)).toEqual([]);
  });

  it('drops a removed line the other parent already removed; keeps one removed against both', () => {
    const ours: FileDiff[] = [{
      path: 'a.ts',
      status: 'modified',
      added: [],
      removed: [{ line: 1, text: 'already removed' }, { line: 2, text: 'removed both' }],
    }];
    const theirs: FileDiff[][] = [[{
      path: 'a.ts',
      status: 'modified',
      added: [],
      removed: [{ line: 10, text: 'removed both' }],
    }]];
    expect(mergeScoped(ours, theirs)).toEqual([{
      path: 'a.ts',
      status: 'modified',
      added: [],
      removed: [{ line: 2, text: 'removed both' }],
    }]);
  });

  it('octopus: with two theirs diffs, a line must be added in both to be kept', () => {
    const ours: FileDiff[] = [{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 1, text: 'all' }, { line: 2, text: 'two only' }],
      removed: [],
    }];
    const theirs: FileDiff[][] = [
      [{ path: 'a.ts', status: 'modified', added: [{ line: 1, text: 'all' }, { line: 2, text: 'two only' }], removed: [] }],
      [{ path: 'a.ts', status: 'modified', added: [{ line: 1, text: 'all' }], removed: [] }],
    ];
    expect(mergeScoped(ours, theirs)).toEqual([{
      path: 'a.ts',
      status: 'modified',
      added: [{ line: 1, text: 'all' }],
      removed: [],
    }]);
  });

  it('status is deleted only when deleted against every parent', () => {
    const oursDeleted: FileDiff[] = [{ path: 'a.ts', status: 'deleted', added: [], removed: [{ line: 1, text: 'x' }] }];
    const theirsModified: FileDiff[][] = [[{ path: 'a.ts', status: 'modified', added: [], removed: [{ line: 1, text: 'x' }] }]];
    expect(mergeScoped(oursDeleted, theirsModified)[0]?.status).toBe('modified');

    const theirsDeleted: FileDiff[][] = [[{ path: 'a.ts', status: 'deleted', added: [], removed: [{ line: 1, text: 'x' }] }]];
    expect(mergeScoped(oursDeleted, theirsDeleted)[0]?.status).toBe('deleted');
  });
});
