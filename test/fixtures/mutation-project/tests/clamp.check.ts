import { expect, it } from 'vitest';
import { clamp } from '../src/clamp.js';

it('clamps low values', () => {
  expect(clamp(-5, 0, 10)).toBe(0);
});

it('keeps values in range', () => {
  expect(clamp(5, 0, 10)).toBe(5);
});