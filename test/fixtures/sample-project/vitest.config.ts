import { defineConfig } from 'vitest/config';
import GovernorReporter from '../../../src/adapters/vitest/reporter.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    includeTaskLocation: true,
    reporters: ['default', new GovernorReporter()],
  },
});
