import { execFileSync } from 'node:child_process';
import path from 'node:path';

// One build before any worker starts: the e2e tests run dist/cli.js, and a build per test file
// rewrote it under the files running in parallel (see build-once.test.ts).
export default function build(): void {
  execFileSync('npm', ['run', 'build'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'pipe' });
}
