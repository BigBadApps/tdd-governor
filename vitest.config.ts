import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Dogfood: record ledger evidence with our own built reporter. Before the first
// build there is none, so tests still run; `governor run` then reports the
// reporter as unavailable rather than passing.
const reporterFile = path.resolve(import.meta.dirname, 'dist/adapters/vitest/reporter.js');
const reporters: unknown[] = ['default'];
if (existsSync(reporterFile)) {
  const { default: GovernorReporter } = await import(reporterFile);
  reporters.push(new GovernorReporter());
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**'],
    testTimeout: 60_000,
    includeTaskLocation: true,
    reporters: reporters as never,
  },
});
