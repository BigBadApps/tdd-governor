import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const template = readFileSync(path.resolve(__dirname, '../templates/governor-ci.yml'), 'utf8');

describe('governor-ci.yml template', () => {
  it.each([
    'fetch-depth: 0',
    'GOVERNOR_READ_TOKEN',
    'GOVERNOR_HOME',
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
