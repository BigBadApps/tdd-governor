import { it } from 'vitest';
// @ts-expect-error deliberate: module does not exist
import { missing } from './does-not-exist.js';

it('never runs', () => {
  missing();
});
