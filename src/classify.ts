import type { FailureKind } from './types.js';

// Structured fields only; never scan free-form output (spec §3).
// The timeout check keys on vitest's own message prefix, which is emitted by the runner, not user code.
export function classify(error: { name?: string; message?: string } | undefined): FailureKind {
  if (!error) return 'unknown';
  if (error.name === 'AssertionError') return 'assertion';
  if (error.message?.startsWith('Test timed out in')) return 'timeout';
  if (error.name) return 'runtime_error';
  return 'unknown';
}
