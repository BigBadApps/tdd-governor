import { describe, expect, it } from 'vitest';
import * as math from './math.js';

describe('math', () => {
  it('adds', () => {
    expect(math.add(2, 3)).toBe(5);
  });

  it('passes', () => {
    expect(1).toBe(1);
  });

  it('calls a missing function', () => {
    (math.notAFunction as unknown as () => void)();
  });

  it('times out', async () => {
    await new Promise((r) => setTimeout(r, 1_000));
  }, 50);

  it.skip('is skipped', () => {});
});
