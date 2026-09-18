import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';

describe('classify', () => {
  it('treats AssertionError as assertion', () => {
    expect(classify({ name: 'AssertionError', message: 'expected 2 to be 3' })).toBe('assertion');
  });

  it('treats vitest timeout message as timeout', () => {
    expect(classify({ name: 'Error', message: 'Test timed out in 50ms.' })).toBe('timeout');
  });

  it('treats other named errors as runtime_error', () => {
    expect(classify({ name: 'TypeError', message: 'x is not a function' })).toBe('runtime_error');
    expect(classify({ name: 'ReferenceError', message: 'y is not defined' })).toBe('runtime_error');
  });

  it('does not treat a message mentioning an error name as that error', () => {
    expect(classify({ name: 'TypeError', message: 'AssertionError in text' })).toBe('runtime_error');
  });

  it('returns unknown when there is no error or no name', () => {
    expect(classify(undefined)).toBe('unknown');
    expect(classify({ message: 'no name' })).toBe('unknown');
  });
});
