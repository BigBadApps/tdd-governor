import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const template = readFileSync(path.resolve(__dirname, '../templates/governor-ci.yml'), 'utf8');

describe('governor-ci.yml template', () => {
  it.each([
    'fetch-depth: 0',
    'GOVERNOR_HOME: ${{ runner.temp }}/governor',
    'permissions:',
    'contents: read',
    'gate ci',
    'node-version: 22',
    'pull_request',
  ])('contains %s', (needle) => {
    expect(template).toContain(needle);
  });

  it('clones the public repository without a secret', () => {
    expect(template).toContain('git clone --quiet https://github.com/BigBadApps/tdd-governor.git');
    expect(template).not.toContain('GOVERNOR_READ_TOKEN');
    expect(template).not.toContain('x-access-token');
  });

  it('has exactly one GOVERNOR_SHA placeholder in the checkout step', () => {
    expect(template.match(/checkout --quiet GOVERNOR_SHA/g)).toHaveLength(1);
  });
});

describe("the governor's own CI workflow", () => {
  // Comments are stripped so a requirement cannot be satisfied by prose about it.
  const workflow = readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const block = (key: string) => workflow.split(`\n${key}:\n`)[1]?.split(/\n(?=\S)/)[0] ?? '';

  it.each([
    'fetch-depth: 0', // gate ci needs a merge-base with the PR's base
    'node-version: 22',
    'contents: read',
  ])('contains %s', (needle) => {
    expect(workflow).toContain(needle);
  });

  it('runs on pull requests and nothing else', () => {
    // Another trigger leaves GITHUB_BASE_REF empty, and gate ci would then diff against main.
    expect(block('on').trim()).toBe('pull_request:');
  });

  it('runs the suite and the gate as steps, not as comments', () => {
    expect(workflow).toMatch(/^\s+- run: npm test$/m);
    expect(workflow).toMatch(/^\s+run: node dist\/cli\.js gate ci$/m);
  });

  it('gates itself with the build under test, not a downloaded governor', () => {
    expect(workflow).not.toContain('GOVERNOR_READ_TOKEN');
  });

  it('pins every action to a commit sha', () => {
    const uses = [...workflow.matchAll(/^\s+- uses: (.+)$/gm)].map((m) => m[1]!.split('#')[0]!.trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
