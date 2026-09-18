import { expect, it } from 'vitest';

it('has no git repo-location vars leaked from the parent', () => {
  const leaked = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].filter((k) => process.env[k] !== undefined);
  expect(leaked).toEqual([]);
});
