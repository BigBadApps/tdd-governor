import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const template = readFileSync(path.resolve(__dirname, '../templates/governor-ci.yml'), 'utf8');

describe('governor-ci.yml template', () => {
  it.each([
    'fetch-depth: 0',
    'GOVERNOR_READ_TOKEN: ${{ secrets.GOVERNOR_READ_TOKEN }}',
    'GOVERNOR_HOME: ${{ runner.temp }}/governor',
    'permissions:',
    'contents: read',
    'gate ci',
    'node-version: 22',
    'pull_request',
  ])('contains %s', (needle) => {
    expect(template).toContain(needle);
  });

  it('has exactly one GOVERNOR_SHA placeholder in the checkout step', () => {
    expect(template.match(/checkout --quiet GOVERNOR_SHA/g)).toHaveLength(1);
  });
});

describe("the governor's own CI workflow", () => {
  const workflow = readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');

  it.each([
    'pull_request',
    'fetch-depth: 0', // gate ci needs a merge-base with the PR's base
    'node-version: 22',
    'npm test',
    'gate ci',
    'contents: read',
  ])('contains %s', (needle) => {
    expect(workflow).toContain(needle);
  });

  it('gates itself with the build under test, not a downloaded governor', () => {
    expect(workflow).toContain('node dist/cli.js gate ci');
    expect(workflow).not.toContain('GOVERNOR_READ_TOKEN');
  });
});
