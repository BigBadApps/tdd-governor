import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { PRIMER } from './primer.js';

const MARKER = '# tdd-governor';
export const PRIMER_FILE = '.governor/PRIMER.md';

export function installHooks(
  root: string,
  cliPath: string,
  hooks: Array<{ name: string; command: string }>,
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  const hooksDir = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  mkdirSync(hooksDir, { recursive: true });

  for (const { name, command } of hooks) {
    const file = path.join(hooksDir, name);
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER)) {
      ok = false;
      messages.push(`refusing to overwrite existing ${name} hook at ${file}; add this line to it yourself: node "${cliPath}" ${command}`);
      continue;
    }
    writeFileSync(file, `#!/bin/sh\n${MARKER}\nexec node "${cliPath}" ${command}\n`);
    chmodSync(file, 0o755);
    messages.push(`installed ${name} → governor ${command}`);
  }

  const primer = path.join(root, PRIMER_FILE);
  mkdirSync(path.dirname(primer), { recursive: true });
  writeFileSync(primer, PRIMER);
  messages.push(`wrote ${PRIMER_FILE}: point your agents at it (for example from AGENTS.md or CLAUDE.md)`);

  const gitignore = path.join(root, '.gitignore');
  const entry = '.governor/ledger.jsonl';
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').includes(entry)) {
    writeFileSync(gitignore, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`);
    messages.push(`added ${entry} to .gitignore`);
  }
  return { ok, messages };
}
