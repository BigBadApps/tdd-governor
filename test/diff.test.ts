import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff.js';

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
