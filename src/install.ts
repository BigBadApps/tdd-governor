import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { PRIMER } from './primer.js';

const MARKER = '# tdd-governor';
export const PRIMER_FILE = '.governor/PRIMER.md';
export const CLI_PATH_FILE = '.governor/cli-path';

// The hook file may be tracked (core.hooksPath), so it must hold no machine-specific path: it reads one
// written by install. A clone without the governor gets a notice, not a block — CI still runs `gate ci`.
const hookScript = (command: string) => `#!/bin/sh
${MARKER}
cli="\${GOVERNOR_CLI:-$(cat "$(git rev-parse --show-toplevel)/${CLI_PATH_FILE}" 2>/dev/null)}"
# A linked worktree has no pointer of its own: fall back to the main working tree's.
[ -f "$cli" ] || cli=$(cat "$(git rev-parse --path-format=absolute --git-common-dir)/../${CLI_PATH_FILE}" 2>/dev/null)
if [ ! -f "$cli" ]; then
  echo "governor: not installed on this machine, skipping ${command} (run: governor install)" >&2
  exit 0
fi
exec node "$cli" ${command}
`;

export function installHooks(
  root: string,
  cliPath: string,
  hooks: Array<{ name: string; command: string }>,
  packageRel = '.',
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
    writeFileSync(file, hookScript(command));
    chmodSync(file, 0o755);
    messages.push(`installed ${name} → governor ${command}`);
  }

  const pointer = path.join(root, CLI_PATH_FILE);
  mkdirSync(path.dirname(pointer), { recursive: true });
  writeFileSync(pointer, `${cliPath}\n`);
  messages.push(`wrote ${CLI_PATH_FILE}: this machine's governor, kept out of the tracked hook`);

  const primer = path.join(root, PRIMER_FILE);
  mkdirSync(path.dirname(primer), { recursive: true });
  writeFileSync(primer, PRIMER);
  messages.push(`wrote ${PRIMER_FILE}: point your agents at it (for example from AGENTS.md or CLAUDE.md)`);

  const gitignore = path.join(root, '.gitignore');
  const entries = [CLI_PATH_FILE, '.governor/ledger.jsonl', ...(packageRel === '.' ? [] : [`${packageRel}/.governor/ledger.jsonl`])];
  for (const entry of entries) {
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (current.split('\n').includes(entry)) continue;
    writeFileSync(gitignore, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`);
    messages.push(`added ${entry} to .gitignore`);
  }
  return { ok, messages };
}
